// The paragraph rule (docs/V0.md): finals in, closed paragraphs out. Pure and
// clock-free: every time is an argument, Scribe's own receipt clock in epoch ms.
//
// Speakers are compared by `userId`. A short final from someone else while
// another speaker holds the floor is a *candidate* aside, held until the
// floor-holder's next final shows whether they kept talking. The floor is the
// open paragraph's speaker, or, when nothing is open, whoever has live
// partials (a provisional floor: the opening sentence's final arrives long
// after a listener's "yes"). `partial()` is how Scribe reports partials, so
// neither the gap nor a candidate resolves early under a long utterance.
//
// A candidate is decided by what follows it, not by a short wall-clock bound:
// the floor-holder has the whole gap to go on (`continueWithinMs` equals
// `gapMs`). The first live meeting (docs/MEETING1.md) closed 34 one-to-three
// word interjections as paragraphs of their own because finals arrive a
// second or two after speech and a 1.5 s bound was never met.
import { z } from "zod";
import { paragraphId } from "./ids.ts";
import { AsideSchema, StoredUtteranceSchema, type Paragraph, type StoredUtterance } from "./schemas.ts";

export interface ParagraphOptions {
  gapMs: number;
  capMs: number;
  backchannelMaxWords: number;
  backchannelMaxMs: number;
  continueWithinMs: number;
}

export const DEFAULT_PARAGRAPH_OPTIONS: ParagraphOptions = {
  gapMs: 4000,
  capMs: 120_000,
  backchannelMaxWords: 5,
  backchannelMaxMs: 3000,
  continueWithinMs: 4000,
};

const OpenSchema = z.object({
  id: z.string().min(1),
  t0: z.number().int(),
  t1: z.number().int(),
  speaker: z.string().min(1),
  userId: z.string().min(1),
  /** Utterance texts and rendered asides, in order; joined by single spaces. */
  pieces: z.array(z.string()),
  utterances: z.array(z.number().int().nonnegative()),
  asides: z.array(AsideSchema),
  /** Seqs already inlined as asides: a candidate lands in the text once. */
  asideSeqs: z.array(z.number().int().nonnegative()).default([]),
  /** Gap clock: the floor-holder's last t1, or a later backchannel's t1. */
  gapFrom: z.number().int(),
});
type Open = z.infer<typeof OpenSchema>;

export const ParagraphsStateSchema = z.object({
  v: z.literal(1),
  open: OpenSchema.nullable(),
  candidates: z.array(StoredUtteranceSchema),
  /** Who holds the floor by partials since their last final: first and latest partial. */
  floor: z.object({ userId: z.string().default(""), since: z.number().int(), last: z.number().int() }).nullable(),
});
export type ParagraphsState = z.infer<typeof ParagraphsStateSchema>;

export interface Paragraphs {
  /** Feed one final, in t1 order. Returns the paragraphs it closed. */
  push(u: StoredUtterance): Paragraph[];
  /** A partial from `userId` arrived at `atMs`. Optional, but without it a long utterance can be split by the gap. */
  partial(userId: string, atMs: number): void;
  /** Close whatever is due at `nowMs` (gap, cap, unanswered candidates). */
  flush(nowMs: number): Paragraph[];
  /** Earliest time `flush` would close something, or null when idle. */
  nextDeadline(): number | null;
  state(): ParagraphsState;
  /** Load a persisted state; throws if it does not parse. */
  restore(state: unknown): void;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function createParagraphs(opts: Partial<ParagraphOptions> = {}): Paragraphs {
  const o: ParagraphOptions = { ...DEFAULT_PARAGRAPH_OPTIONS, ...opts };
  let s: ParagraphsState = { v: 1, open: null, candidates: [], floor: null };

  const isShort = (u: StoredUtterance) =>
    wordCount(u.text) <= o.backchannelMaxWords && u.t1 - u.t0 < o.backchannelMaxMs;

  const lastCandidate = () => s.candidates[s.candidates.length - 1];

  /** Open paragraph: the floor-holder must resume by then for the candidates to be asides. */
  const candidateDeadline = (): number | null => {
    const c = lastCandidate();
    return c ? c.t1 + o.continueWithinMs : null;
  };

  /** The floor-holder started speaking again in time to make the candidates asides. */
  const floorAnswered = (): boolean => {
    const d = candidateDeadline();
    return d !== null && s.floor !== null && s.floor.since <= d;
  };

  const closeDeadline = (p: Open): number => {
    const gapEnd = p.gapFrom + o.gapMs;
    const gap = s.floor !== null && s.floor.since <= gapEnd ? Math.max(p.gapFrom, s.floor.last) + o.gapMs : gapEnd;
    const due = Math.min(gap, p.t0 + o.capMs);
    // A held candidate is decided before its paragraph closes under it.
    const cd = candidateDeadline();
    return cd === null ? due : Math.max(due, cd);
  };

  /** Nothing open, candidates held under a provisional floor: it must not go quiet for gapMs. */
  const provisionalDeadline = (): number | null => {
    const c = lastCandidate();
    if (!c) return null;
    return Math.max(c.t1, s.floor?.last ?? c.t1) + o.gapMs;
  };

  const addAside = (p: Open, c: StoredUtterance): void => {
    if (p.asideSeqs.includes(c.seq) || p.utterances.includes(c.seq)) return;
    const text = c.text.trim();
    p.asides.push({ speaker: c.speaker, text, t0: c.t0 });
    p.asideSeqs.push(c.seq);
    p.pieces.push(`[${c.speaker}: ${text}]`);
    p.gapFrom = Math.max(p.gapFrom, c.t1);
  };

  /** Inline every held candidate, now resolved, and forget it. */
  const commitAsides = (p: Open): void => {
    for (const c of s.candidates) addAside(p, c);
    s.candidates = [];
  };

  // The floor-holder's final: candidates said in the pause before it go first,
  // ones that overlap it go after its text.
  const take = (p: Open, u: StoredUtterance): void => {
    const held = s.candidates;
    s.candidates = [];
    for (const c of held) if (c.t0 < u.t0) addAside(p, c);
    p.pieces.push(u.text.trim());
    p.utterances.push(u.seq);
    p.t1 = Math.max(p.t1, u.t1);
    p.gapFrom = Math.max(p.gapFrom, u.t1);
    for (const c of held) if (c.t0 >= u.t0) addAside(p, c);
    s.floor = null;
  };

  const openWith = (u: StoredUtterance): void => {
    const p: Open = {
      id: paragraphId(u.t0), t0: u.t0, t1: u.t1, speaker: u.speaker, userId: u.userId,
      pieces: [], utterances: [], asides: [], asideSeqs: [], gapFrom: u.t1,
    };
    s.open = p;
    take(p, u);
  };

  const close = (out: Paragraph[]): void => {
    const p = s.open;
    if (!p) return;
    out.push({
      id: p.id,
      t0: p.t0,
      t1: p.t1,
      speaker: p.speaker,
      userId: p.userId,
      text: p.pieces.join(" "),
      utterances: p.utterances,
      asides: p.asides,
    });
    s.open = null;
    s.floor = null;
  };

  /** Nobody continued: close the paragraph (if any) and replay the candidates as speech. */
  const rejectCandidates = (out: Paragraph[]): void => {
    const held = s.candidates;
    s.candidates = [];
    close(out);
    s.floor = null;
    for (const c of held) apply(c, out);
  };

  /** A provisional floor: someone else has partials newer than gapMs before this final. */
  const heldByOther = (u: StoredUtterance): boolean =>
    s.floor !== null && s.floor.userId !== u.userId && u.t1 - s.floor.last <= o.gapMs;

  // The rule itself, with timing already settled by `flushInto`.
  const apply = (u: StoredUtterance, out: Paragraph[]): void => {
    const p = s.open;
    if (!p) {
      if (s.candidates.length) {
        if (s.floor !== null && u.userId === s.floor.userId) return openWith(u);
        if (isShort(u)) return void s.candidates.push(u);
        rejectCandidates(out);
        return apply(u, out);
      }
      if (isShort(u) && heldByOther(u)) return void s.candidates.push(u);
      return openWith(u);
    }
    if (u.userId === p.userId) return take(p, u);
    if (isShort(u)) {
      s.candidates.push(u);
      p.gapFrom = Math.max(p.gapFrom, u.t1);
      return;
    }
    if (s.candidates.length) {
      rejectCandidates(out);
      return apply(u, out);
    }
    close(out);
    openWith(u);
  };

  const flushInto = (now: number, out: Paragraph[]): void => {
    for (;;) {
      const p = s.open;
      if (!p) {
        const pd = provisionalDeadline();
        if (pd === null || now < pd) return;
        rejectCandidates(out);
        continue;
      }
      const cd = candidateDeadline();
      if (cd !== null && now >= cd && !floorAnswered()) {
        rejectCandidates(out);
        continue;
      }
      if (now >= closeDeadline(p)) {
        commitAsides(p); // only reached when the floor-holder answered in time
        close(out);
        continue;
      }
      return;
    }
  };

  const hear = (userId: string, from: number, to: number): void => {
    const f = s.floor;
    if (f && f.userId === userId) {
      s.floor = { userId, since: Math.min(f.since, from), last: Math.max(f.last, to) };
      return;
    }
    if (s.open) {
      if (s.open.userId === userId) s.floor = { userId, since: from, last: to };
      return;
    }
    // Provisional floor: the first live speaker; another takes it only once
    // the holder has gone quiet and no candidate waits on them.
    if (!f || (!s.candidates.length && from - f.last > o.gapMs)) s.floor = { userId, since: from, last: to };
  };

  return {
    push(u) {
      if (!u.text.trim()) return [];
      const out: Paragraph[] = [];
      // The final is proof its speaker was talking from t0 to t1.
      if (s.open?.userId === u.userId || s.floor?.userId === u.userId) hear(u.userId, u.t0, u.t1);
      flushInto(u.t1, out);
      apply(u, out);
      return out;
    },
    partial(userId, atMs) {
      hear(userId, atMs, atMs);
    },
    flush(nowMs) {
      const out: Paragraph[] = [];
      flushInto(nowMs, out);
      return out;
    },
    nextDeadline() {
      if (!s.open) return provisionalDeadline();
      const due = closeDeadline(s.open);
      const cd = candidateDeadline();
      return cd !== null && !floorAnswered() ? Math.min(cd, due) : due;
    },
    state() {
      return ParagraphsStateSchema.parse(JSON.parse(JSON.stringify(s)));
    },
    restore(state) {
      s = ParagraphsStateSchema.parse(state);
    },
  };
}
