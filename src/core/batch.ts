// The batch pass (docs/BATCH.md): a second and third transcript of a meeting
// from the stored per-speaker tracks, in the row shape Scribe writes live,
// plus the word timings the live rows never had. Pure: engines hand in
// timed words, this module hands back rows. The CLI does the I/O.
import { z } from "zod";
import { UtteranceSchema } from "./schemas.ts";

export const ENGINES = ["whisper", "parakeet"] as const;
export const EngineSchema = z.enum(ENGINES);
export type Engine = z.infer<typeof EngineSchema>;

/** The `engine` field a batch row carries; the live rows say `nova-3`. */
export const ENGINE_IDS: Record<Engine, string> = {
  whisper: "whisper-large-v3-turbo",
  parakeet: "parakeet-tdt-0.6b-v3",
};

/** One word as an engine timed it, in seconds from the start of the track. */
export const TimedWordSchema = z.object({
  w: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  /** 0..1 when the engine gives one per word or per segment; null otherwise. */
  conf: z.number().nullable(),
});
export type TimedWord = z.infer<typeof TimedWordSchema>;

/** A word inside a row: epoch ms, like the row. */
export const RowWordSchema = z.object({ w: z.string(), t0: z.number().int(), t1: z.number().int() });

/**
 * A batch row: the live shape (`UtteranceSchema`) plus `words`, the field
 * the live rows do not have, and `track`, the file the words were read from.
 */
export const BatchRowSchema = UtteranceSchema.extend({
  words: z.array(RowWordSchema),
  track: z.string(),
});
export type BatchRow = z.infer<typeof BatchRowSchema>;

/** What `acta transcribe` records beside the rows: what the pass cost, per track. */
export const TrackRunSchema = z.object({
  track: z.string(),
  speaker: z.string(),
  peerId: z.string(),
  /** Track length in seconds (ffprobe or the engine's own duration). */
  durationS: z.number().nonnegative(),
  /** Seconds of speech the engine found (VAD or the span of its words). */
  speechS: z.number().nonnegative(),
  /** Wall time of this track's call, ms. */
  ms: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  lang: z.string().nullable(),
});
export type TrackRun = z.infer<typeof TrackRunSchema>;
export const RunSchema = z.object({
  engine: z.string(),
  at: z.number().int(),
  meetingId: z.string(),
  options: z.record(z.string(), z.unknown()),
  tracks: z.array(TrackRunSchema),
  /** Wall time of the whole pass, ms (tracks may run concurrently). */
  ms: z.number().int().nonnegative(),
  /** USD at the listed per-minute price times the audio minutes billed; 0 for a local engine. */
  usd: z.number().nonnegative(),
  /** Peak resident memory of a local engine, bytes; null for a remote one. */
  peakRssBytes: z.number().int().nonnegative().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/** The participant the track belongs to; `joinedAt` is the track's first sample (docs/BATCH.md). */
export type TrackOwner = { speaker: string; userId: string; peerId: string; joinedAt: number; track: string };

export type RowRule = {
  /** A silence this long between two words closes the row. */
  gapS: number;
  /** After sentence-final punctuation, a shorter silence closes it too. */
  sentenceGapS: number;
  /** A row never runs longer than this, so a monologue still splits. */
  maxS: number;
};
export const DEFAULT_ROW_RULE: RowRule = { gapS: 1.0, sentenceGapS: 0.4, maxS: 20 };

const SENTENCE_END = /[.!?…]["»)]?$/;

/**
 * Group timed words into rows. VAD and chunking make engine segments span
 * silences (one Whisper segment covered 49 s to 819 s of a track), so rows
 * are cut on the word timings themselves. `t0`/`t1` are epoch ms from the
 * owner's join; `conf` is the mean of the words' confidences when any.
 */
export function rowsFromWords(words: TimedWord[], owner: TrackOwner, engine: string, lang: string | null, rule: RowRule = DEFAULT_ROW_RULE): BatchRow[] {
  const sorted = [...words].filter((w) => w.w.trim().length > 0).sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of sorted) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      const first = cur[0];
      const closes = gap >= rule.gapS
        || (gap >= rule.sentenceGapS && SENTENCE_END.test(prev.w.trim()))
        || (first !== undefined && w.end - first.start > rule.maxS && gap > 0);
      if (closes) { groups.push(cur); cur = []; }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) => {
    const confs = g.map((w) => w.conf).filter((c): c is number => c !== null);
    const first = g[0];
    const last = g[g.length - 1];
    if (!first || !last) throw new Error("empty group");
    return {
      t0: Math.round(owner.joinedAt + first.start * 1000),
      t1: Math.round(owner.joinedAt + last.end * 1000),
      speaker: owner.speaker,
      userId: owner.userId,
      peerId: owner.peerId,
      text: g.map((w) => w.w.trim()).join(" "),
      lang,
      final: true,
      engine,
      conf: confs.length ? round4(confs.reduce((a, b) => a + b, 0) / confs.length) : null,
      words: g.map((w) => ({ w: w.w.trim(), t0: Math.round(owner.joinedAt + w.start * 1000), t1: Math.round(owner.joinedAt + w.end * 1000) })),
      track: owner.track,
    };
  });
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Seconds of speech a set of rows covers (their spans, not their gaps). */
export function speechSeconds(rows: { t0: number; t1: number }[]): number {
  return rows.reduce((a, r) => a + Math.max(0, r.t1 - r.t0), 0) / 1000;
}

// --- Whisper (Workers AI) --------------------------------------------------

export type WhisperSegmentLike = { avg_logprob?: number | undefined; words: { word: string; start: number; end: number }[] };

/** Whisper words carry no probability; the segment's mean log-probability stands in, as e^logprob. */
export function whisperWords(segments: WhisperSegmentLike[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const s of segments) {
    const conf = typeof s.avg_logprob === "number" ? round4(Math.min(1, Math.exp(s.avg_logprob))) : null;
    for (const w of s.words) {
      if (!w.word.trim()) continue;
      out.push({ w: w.word.trim(), start: w.start, end: Math.max(w.start, w.end), conf });
    }
  }
  return out;
}

// --- Parakeet (parakeet-mlx, local) ---------------------------------------

export const ParakeetTokenSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().nullable().optional(),
}).loose();
export const ParakeetSentenceSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().nullable().optional(),
  tokens: z.array(ParakeetTokenSchema).default([]),
}).loose();
/** `parakeet-mlx --output-format json`: one file per input, sentences of sub-word tokens. */
export const ParakeetOutputSchema = z.object({
  text: z.string(),
  sentences: z.array(ParakeetSentenceSchema).default([]),
}).loose();
export type ParakeetOutput = z.infer<typeof ParakeetOutputSchema>;

/**
 * Parakeet's tokens are sub-word pieces (" Y", "a", " pus", "o"); a piece
 * that starts with a space starts a word. Punctuation pieces attach to the
 * word before them. Word confidence is the mean over its pieces.
 */
export function parakeetWords(out: ParakeetOutput): TimedWord[] {
  const words: TimedWord[] = [];
  let cur: { text: string; start: number; end: number; confs: number[] } | null = null;
  const flush = () => {
    if (cur && cur.text.trim()) {
      words.push({ w: cur.text.trim(), start: cur.start, end: Math.max(cur.start, cur.end), conf: cur.confs.length ? round4(cur.confs.reduce((a, b) => a + b, 0) / cur.confs.length) : null });
    }
    cur = null;
  };
  for (const s of out.sentences) {
    for (const t of s.tokens) {
      const startsWord = t.text.startsWith(" ") || cur === null;
      if (startsWord) flush();
      if (cur === null) cur = { text: t.text, start: t.start, end: t.end, confs: [] };
      else { cur.text += t.text; cur.end = t.end; }
      if (typeof t.confidence === "number") cur.confs.push(t.confidence);
    }
    flush();
  }
  return words;
}
