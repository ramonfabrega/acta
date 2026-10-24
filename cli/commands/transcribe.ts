// `acta transcribe <id> --engine whisper|parakeet`: the batch pass over the
// synced tracks (docs/BATCH.md). Whisper runs on Workers AI through the
// Worker, on the track already in R2; Parakeet runs here, through the MLX
// port, on the synced track decoded to 16 kHz mono. Both answer timed
// words; src/core/batch.ts turns them into rows with the live shape, and
// the rows land in `transcripts/<engine>.jsonl` next to `utterances.jsonl`,
// locally and in R2, with `<engine>.run.json` saying what the pass cost.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  ENGINE_IDS,
  ParakeetOutputSchema,
  parakeetWords,
  rowsFromWords,
  speechSeconds,
  whisperWords,
  type BatchRow,
  type Engine,
  type Run,
  type TrackOwner,
  type TrackRun,
} from "../../src/core/batch.ts";
import { ParticipantSchema } from "../../src/core/schemas.ts";
import { api } from "../client.ts";
import { meetingsRoot } from "./sync.ts";

/** Workers AI price page, checked 2026-10-23 (46.63 neurons per audio minute at $0.011 per 1,000). */
export const WHISPER_USD_PER_MIN = 0.000513;

const MetaSchema = z.object({
  id: z.string(),
  keywords: z.array(z.string()).default([]),
  participants: z.array(ParticipantSchema),
}).loose();

export type TranscribeOptions = {
  engine: Engine;
  /** Whisper: force the language (`es`); omitted, the model detects it per track. */
  language?: string | undefined;
  /** Whisper: leave the meeting's keywords out of the prompt. */
  noPrompt?: boolean | undefined;
  /** Whisper: tracks in flight at once. */
  concurrency: number;
  /** Do not PUT the files into R2. */
  local?: boolean | undefined;
  /** Only these tracks (file names under recordings/). */
  tracks?: string[] | undefined;
};

export type TrackResult =
  | { track: string; speaker: string; rows: number; words: number; speechS: number; durationS: number; ms: number; lang: string | null }
  | { track: string; speaker: string; error: string };

export type TranscribeSummary = {
  engine: string;
  dir: string;
  rows: number;
  tracks: number;
  failed: string[];
  ms: number;
  usd: number;
  peakRssMb: number | null;
  uploaded: string[];
};

/** `<speaker>-<peer8>.webm` → the participant whose peerId starts with peer8. Exported for tests. */
export function ownerOf(track: string, participants: z.infer<typeof ParticipantSchema>[]): TrackOwner | null {
  const m = /^(.+)-([0-9a-f]{8})\.webm$/i.exec(track);
  if (!m) return null;
  const peer8 = m[2] ?? "";
  const p = participants.find((x) => x.peerId.startsWith(peer8));
  if (!p) return null;
  return { speaker: p.speaker, userId: p.userId, peerId: p.peerId, joinedAt: p.joinedAt, track };
}

async function probeDuration(path: string): Promise<number> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const parsed = z.object({ format: z.object({ duration: z.coerce.number() }) }).safeParse(JSON.parse(out || "{}"));
  return parsed.success ? parsed.data.format.duration : 0;
}

async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await f(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

type Produced = { owner: TrackOwner; rows: BatchRow[]; run: TrackRun };

// --- whisper -------------------------------------------------------------------

async function whisperTrack(id: string, owner: TrackOwner, keywords: string[], o: TranscribeOptions, dir: string): Promise<Produced> {
  const answer = await api.transcribe(id, {
    track: owner.track,
    vadFilter: true,
    ...(o.language ? { language: o.language } : {}),
    ...(!o.noPrompt && keywords.length ? { initialPrompt: keywords.join(", ") } : {}),
  });
  const info = answer.output.transcription_info;
  const lang = info?.language ?? null;
  const rows = rowsFromWords(whisperWords(answer.output.segments), owner, ENGINE_IDS.whisper, lang);
  const durationS = info?.duration ?? (await probeDuration(join(dir, "recordings", owner.track)));
  return {
    owner,
    rows,
    run: {
      track: owner.track, speaker: owner.speaker, peerId: owner.peerId, durationS,
      speechS: info?.duration_after_vad ?? speechSeconds(rows), ms: answer.ms,
      rows: rows.length, words: rows.reduce((a, r) => a + r.words.length, 0), lang,
    },
  };
}

// --- parakeet ------------------------------------------------------------------

/** `ACTA_PARAKEET`, else `parakeet-mlx` on PATH (`uv tool install parakeet-mlx`), else through uvx. */
export function parakeetCommand(): string[] {
  const env = process.env.ACTA_PARAKEET?.trim();
  if (env) return env.split(/\s+/);
  return Bun.which("parakeet-mlx") ? ["parakeet-mlx"] : ["uvx", "--from", "parakeet-mlx", "parakeet-mlx"];
}

/** macOS `/usr/bin/time -l` prints `<bytes>  peak memory footprint`; exported for tests. */
export function peakFootprint(stderr: string): number | null {
  const m = /(\d+)\s+peak memory footprint/.exec(stderr) ?? /(\d+)\s+maximum resident set size/.exec(stderr);
  return m ? Number(m[1]) : null;
}

async function parakeetAll(owners: TrackOwner[], dir: string, log: (s: string) => void): Promise<{ produced: Produced[]; failed: { owner: TrackOwner; error: string }[]; peak: number | null; ms: number }> {
  const work = await mkdtemp(join(tmpdir(), "acta-parakeet-"));
  try {
    const wavs: { owner: TrackOwner; wav: string; durationS: number }[] = [];
    const failed: { owner: TrackOwner; error: string }[] = [];
    for (const owner of owners) {
      const src = join(dir, "recordings", owner.track);
      const wav = join(work, `${basename(owner.track, ".webm")}.wav`);
      const d = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { stdout: "ignore", stderr: "pipe" });
      const err = await new Response(d.stderr).text();
      if ((await d.exited) !== 0) { failed.push({ owner, error: `ffmpeg: ${err.trim().slice(0, 200)}` }); continue; }
      wavs.push({ owner, wav, durationS: await probeDuration(wav) });
      log(`decoded ${owner.track}`);
    }
    if (!wavs.length) return { produced: [], failed, peak: null, ms: 0 };
    const base = parakeetCommand();
    const timed = process.platform === "darwin" && Bun.which("/usr/bin/time") !== null;
    const cmd = [...(timed ? ["/usr/bin/time", "-l"] : []), ...base, ...wavs.map((w) => w.wav), "--output-format", "json", "--output-dir", work];
    log(`running ${base.join(" ")} on ${wavs.length} track(s)`);
    const t = Date.now();
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stderr, stdout] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text()]);
    const code = await p.exited;
    const ms = Date.now() - t;
    if (code !== 0) throw new Error(`${base[0]} exited ${code}: ${(stderr || stdout).trim().slice(-400)}`);
    const peak = timed ? peakFootprint(stderr) : null;
    const total = wavs.reduce((a, w) => a + w.durationS, 0) || 1;
    const produced: Produced[] = [];
    for (const w of wavs) {
      const outPath = join(work, `${basename(w.wav, ".wav")}.json`);
      const raw: unknown = await Bun.file(outPath).json().catch(() => null);
      const parsed = ParakeetOutputSchema.safeParse(raw);
      if (!parsed.success) { failed.push({ owner: w.owner, error: `no JSON for ${w.owner.track}: ${raw === null ? "file missing" : z.prettifyError(parsed.error)}` }); continue; }
      const rows = rowsFromWords(parakeetWords(parsed.data), w.owner, ENGINE_IDS.parakeet, null);
      produced.push({
        owner: w.owner, rows,
        run: {
          track: w.owner.track, speaker: w.owner.speaker, peerId: w.owner.peerId, durationS: w.durationS,
          speechS: speechSeconds(rows), ms: Math.round((ms * w.durationS) / total),
          rows: rows.length, words: rows.reduce((a, r) => a + r.words.length, 0), lang: null,
        },
      });
    }
    return { produced, failed, peak, ms };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// --- the verb --------------------------------------------------------------------

/** One row per track as it lands, then the summary. The local rows under `transcripts/` are the result; R2 gets a copy. */
export async function* transcribeMeeting(id: string, o: TranscribeOptions): AsyncGenerator<TrackResult, TranscribeSummary> {
  const dir = join(meetingsRoot(), id);
  const metaRaw: unknown = await Bun.file(join(dir, "meta.json")).json().catch(() => null);
  if (metaRaw === null) throw new Error(`no ${join(dir, "meta.json")}: run \`acta sync ${id}\` first`);
  const meta = MetaSchema.parse(metaRaw);
  const files = (await readdir(join(dir, "recordings")).catch(() => [])).filter((f) => f.endsWith(".webm")).sort();
  const wanted = o.tracks?.length ? files.filter((f) => o.tracks?.includes(f)) : files;
  if (!wanted.length) throw new Error(`no tracks under ${join(dir, "recordings")}: run \`acta sync ${id}\` first`);
  const owners: TrackOwner[] = [];
  const failed: string[] = [];
  const results: TrackResult[] = [];
  for (const f of wanted) {
    const owner = ownerOf(f, meta.participants);
    if (owner) owners.push(owner);
    else { failed.push(f); results.push({ track: f, speaker: "?", error: "no participant with this peer id in meta.json" }); }
  }
  for (const r of results) yield r;

  const log = (s: string) => process.stderr.write(`${s}\n`);
  const t = Date.now();
  const produced: Produced[] = [];
  let peak: number | null = null;
  let wallMs = 0;
  if (o.engine === "whisper") {
    const settled = await pool(owners, o.concurrency, async (owner) => {
      try {
        const p = await whisperTrack(id, owner, meta.keywords, o, dir);
        log(`${owner.track}: ${p.rows.length} rows in ${(p.run.ms / 1000).toFixed(0)} s`);
        return { ok: true as const, p };
      } catch (e) {
        return { ok: false as const, owner, error: e instanceof Error ? e.toString() : String(e) };
      }
    });
    wallMs = Date.now() - t;
    for (const s of settled) {
      if (s.ok) produced.push(s.p);
      else { failed.push(s.owner.track); yield { track: s.owner.track, speaker: s.owner.speaker, error: s.error }; }
    }
  } else {
    const r = await parakeetAll(owners, dir, log);
    wallMs = r.ms;
    peak = r.peak;
    produced.push(...r.produced);
    for (const f of r.failed) { failed.push(f.owner.track); yield { track: f.owner.track, speaker: f.owner.speaker, error: f.error }; }
  }
  for (const p of produced) {
    const { run } = p;
    yield { track: run.track, speaker: run.speaker, rows: run.rows, words: run.words, speechS: round1(run.speechS), durationS: round1(run.durationS), ms: run.ms, lang: run.lang };
  }

  const rows = produced.flatMap((p) => p.rows).sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const minutes = produced.reduce((a, p) => a + p.run.durationS, 0) / 60;
  const run: Run = {
    engine: ENGINE_IDS[o.engine],
    at: Date.now(),
    meetingId: id,
    options: o.engine === "whisper"
      ? { vadFilter: true, language: o.language ?? null, initialPrompt: !o.noPrompt && meta.keywords.length > 0, concurrency: o.concurrency }
      : { command: parakeetCommand().join(" "), perTrackMsApportionedByDuration: true },
    tracks: produced.map((p) => p.run),
    ms: wallMs,
    usd: o.engine === "whisper" ? round4(minutes * WHISPER_USD_PER_MIN) : 0,
    peakRssBytes: peak,
  };
  const outDir = join(dir, "transcripts");
  await mkdir(outDir, { recursive: true });
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const runJson = JSON.stringify(run, null, 2);
  await Bun.write(join(outDir, `${o.engine}.jsonl`), jsonl);
  await Bun.write(join(outDir, `${o.engine}.run.json`), runJson);
  const uploaded: string[] = [];
  if (!o.local && produced.length) {
    for (const [name, body, type] of [[`${o.engine}.jsonl`, jsonl, "application/x-ndjson"], [`${o.engine}.run.json`, runJson, "application/json"]] as const) {
      const a = await api.putTranscript(id, name, body, type);
      uploaded.push(a.key);
    }
  }
  return {
    engine: run.engine, dir: outDir, rows: rows.length, tracks: produced.length, failed, ms: wallMs, usd: run.usd,
    peakRssMb: peak === null ? null : Math.round(peak / 1024 / 1024), uploaded,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
