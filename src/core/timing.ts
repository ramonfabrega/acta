// How Scribe stamps `t0` on a final. The vendor's times are to the second and
// not speech timing (docs/V0.md), so `t0` is Scribe's receipt of the first
// partial of that utterance and `t1` its receipt of the final. The first
// live meeting (docs/MEETING1.md, item 2) showed the stamp going stale: a
// final lost in an agent-socket gap left its first-partial time behind, and
// the next final inherited it (a one-word paragraph spanning 71 s). Three
// guards, all pure and tested:
//
// - partials of one peer arrive two to four times a second; a longer
//   silence between two partials starts a new stamp (`PARTIAL_GAP_MS`);
// - a stamp older than the words allow is dropped (`maxSpanMs`);
// - `t0` is never `t1` for text that has words.

/** Silence between two partials of one peer that means a new utterance began. */
export const PARTIAL_GAP_MS = 3000;

/** The longest a final's utterance can plausibly have lasted: slow speech plus endpointing. */
export function maxSpanMs(words: number): number {
  return 8000 + 600 * words;
}

/** With no usable partial stamp: a plausible start for `words` ending at `t1`. */
export function estimateT0(t1: number, words: number): number {
  return t1 - Math.max(800, 400 * words);
}

export type PartialStamp = { first: number; last: number };

/** The stamp after a partial at `now`: continued when recent, restarted after a silence. */
export function stampPartial(prev: PartialStamp | undefined, now: number): PartialStamp {
  if (!prev || now - prev.last > PARTIAL_GAP_MS) return { first: now, last: now };
  return { first: prev.first, last: Math.max(prev.last, now) };
}

/** `t0` for a final at `t1` with `words` words, given the peer's partial stamp. */
export function t0For(stamp: PartialStamp | undefined, t1: number, words: number): number {
  const estimate = estimateT0(t1, words);
  if (!stamp) return estimate;
  if (stamp.first >= t1) return estimate;
  if (t1 - stamp.first > maxSpanMs(words)) return estimate;
  return stamp.first;
}
