import { describe, expect, test } from "bun:test";
import { DEFAULT_ROW_RULE, parakeetWords, rowsFromWords, speechSeconds, whisperWords, type TimedWord, type TrackOwner } from "../../src/core/batch.ts";

const owner: TrackOwner = { speaker: "ana", userId: "u_1", peerId: "p1-abcdef", joinedAt: 1_000_000, track: "ana-p1abcdef.webm" };
const w = (word: string, start: number, end: number, conf: number | null = null): TimedWord => ({ w: word, start, end, conf });

describe("rowsFromWords", () => {
  test("a silence of gapS closes a row; t0/t1 are epoch ms from the owner's join", () => {
    const rows = rowsFromWords([w("hola", 1.0, 1.4), w("mundo", 1.5, 2.0), w("bueno", 3.2, 3.6)], owner, "e", "es");
    expect(rows.map((r) => r.text)).toEqual(["hola mundo", "bueno"]);
    expect(rows[0]).toMatchObject({ t0: 1_001_000, t1: 1_002_000, speaker: "ana", userId: "u_1", peerId: "p1-abcdef", lang: "es", final: true, engine: "e", track: owner.track });
    expect(rows[0]?.words).toEqual([{ w: "hola", t0: 1_001_000, t1: 1_001_400 }, { w: "mundo", t0: 1_001_500, t1: 1_002_000 }]);
  });

  test("sentence-final punctuation closes on a shorter gap; a plain word does not", () => {
    const rows = rowsFromWords([w("Sí.", 0, 0.3), w("Bueno", 0.8, 1.1), w("pues", 1.6, 1.9)], owner, "e", null);
    expect(rows.map((r) => r.text)).toEqual(["Sí.", "Bueno pues"]);
  });

  test("a monologue is capped near maxS even without a gap", () => {
    const words: TimedWord[] = [];
    for (let i = 0; i < 60; i++) words.push(w(`w${i}`, i * 0.5, i * 0.5 + 0.4));
    const rows = rowsFromWords(words, owner, "e", null);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.t1 - r.t0).toBeLessThanOrEqual((DEFAULT_ROW_RULE.maxS + 1) * 1000);
    expect(rows.flatMap((r) => r.words).length).toBe(60);
  });

  test("conf is the mean of the words' confidences, null when none; empty words are dropped; order is by time", () => {
    const rows = rowsFromWords([w("b", 1.0, 1.2, 0.5), w("a", 0.5, 0.9, 1.0), w("  ", 0.95, 0.96)], owner, "e", null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("a b");
    expect(rows[0]?.conf).toBe(0.75);
    expect(rowsFromWords([w("x", 0, 1)], owner, "e", null)[0]?.conf).toBeNull();
  });

  test("speechSeconds sums the spans", () => {
    expect(speechSeconds([{ t0: 0, t1: 1500 }, { t0: 5000, t1: 5500 }])).toBe(2);
  });
});

describe("whisperWords", () => {
  test("segment log-probability becomes e^lp per word; leading spaces are trimmed", () => {
    const words = whisperWords([{ avg_logprob: -0.5, words: [{ word: " Hola", start: 1, end: 1.5 }, { word: " ", start: 1.5, end: 1.5 }] }, { words: [{ word: "ya", start: 2, end: 1.9 }] }]);
    expect(words).toEqual([{ w: "Hola", start: 1, end: 1.5, conf: 0.6065 }, { w: "ya", start: 2, end: 2, conf: null }]);
  });
});

describe("parakeetWords", () => {
  test("sub-word pieces join into words at a leading space; punctuation attaches; confidence is the mean", () => {
    const out = {
      text: " Ya puso.",
      sentences: [{
        text: " Ya puso.", start: 48.96, end: 49.7,
        tokens: [
          { text: " Y", start: 48.96, end: 49.12, confidence: 0.8 },
          { text: "a", start: 49.12, end: 49.2, confidence: 1.0 },
          { text: " pus", start: 49.36, end: 49.44, confidence: 0.7 },
          { text: "o", start: 49.6, end: 49.68, confidence: 0.9 },
          { text: ".", start: 49.68, end: 49.7, confidence: 0.5 },
        ],
      }],
    };
    expect(parakeetWords(out)).toEqual([
      { w: "Ya", start: 48.96, end: 49.2, conf: 0.9 },
      { w: "puso.", start: 49.36, end: 49.7, conf: 0.7 },
    ]);
  });

  test("a sentence boundary ends the word even without a space", () => {
    const out = { text: "", sentences: [
      { text: "a", start: 0, end: 1, tokens: [{ text: "a", start: 0, end: 1 }] },
      { text: "b", start: 2, end: 3, tokens: [{ text: "b", start: 2, end: 3 }] },
    ] };
    expect(parakeetWords(out).map((x) => x.w)).toEqual(["a", "b"]);
    expect(parakeetWords(out)[0]?.conf).toBeNull();
  });
});
