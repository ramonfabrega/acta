import { describe, expect, test } from "bun:test";
import { PARTIAL_GAP_MS, estimateT0, maxSpanMs, stampPartial, t0For } from "../../src/core/timing.ts";

describe("timing", () => {
  test("the first partial opens the stamp and later ones extend it", () => {
    const a = stampPartial(undefined, 1000);
    expect(a).toEqual({ first: 1000, last: 1000 });
    const b = stampPartial(a, 1400);
    expect(b).toEqual({ first: 1000, last: 1400 });
    expect(stampPartial(b, 1300)).toEqual({ first: 1000, last: 1400 }); // out of order: never moves `last` back
  });

  test("a silence between partials starts a new utterance (a lost final left the old stamp behind)", () => {
    const old = stampPartial(undefined, 1000);
    expect(stampPartial(old, 1000 + PARTIAL_GAP_MS)).toEqual({ first: 1000, last: 1000 + PARTIAL_GAP_MS });
    expect(stampPartial(old, 1000 + PARTIAL_GAP_MS + 1)).toEqual({ first: 4001, last: 4001 });
  });

  test("t0 is the first partial when it is plausible", () => {
    expect(t0For({ first: 1000, last: 3200 }, 3500, 8)).toBe(1000);
  });

  test("t0 falls back to an estimate without a stamp, and never equals t1", () => {
    expect(t0For(undefined, 10_000, 1)).toBe(9200);
    expect(t0For(undefined, 10_000, 10)).toBe(6000);
    expect(t0For({ first: 10_000, last: 10_000 }, 10_000, 3)).toBe(estimateT0(10_000, 3));
    expect(t0For({ first: 10_500, last: 10_500 }, 10_000, 3)).toBe(estimateT0(10_000, 3));
  });

  test("a stale stamp (one-word paragraph spanning 71 s, meeting 1) is replaced by the estimate", () => {
    expect(maxSpanMs(1)).toBe(8600);
    expect(t0For({ first: 0, last: 200 }, 71_000, 1)).toBe(estimateT0(71_000, 1));
    expect(t0For({ first: 0, last: 200 }, 8000, 1)).toBe(0); // still within what one word allows
  });
});
