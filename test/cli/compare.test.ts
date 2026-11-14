/**
 * `acta compare`: the metrics on synthetic rows with hand-computed answers,
 * the file boundary (zod per line, errors naming file and line), and the verb
 * end to end on a temporary ACTA_HOME. No meeting data: every row is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../../cli/cli.ts";
import {
  agreement,
  agreements,
  compare,
  compareMeeting,
  engineSummary,
  normTokens,
  overlaps,
  parseJsonl,
  recall,
  review,
  speakerSummary,
  type CompareRow,
  type EngineSet,
} from "../../cli/commands/compare.ts";
import { UtteranceRowSchema } from "../../cli/client.ts";
import type { Run } from "../../src/core/batch.ts";

const row = (engine: string, peerId: string, speaker: string, t0: number, t1: number, text: string, conf: number | null): CompareRow =>
  ({ t0, t1, speaker, peerId, text, engine, conf });

const NOVA = "nova-3", WH = "whisper-large-v3-turbo", PK = "parakeet-tdt-0.6b-v3";

// ana is p1, ben is p2.
const L1 = row(NOVA, "p1", "ana", 10_000, 12_000, "hola mundo", 0.9);
const L2 = row(NOVA, "p1", "ana", 20_000, 22_000, "uno dos tres cuatro", 0.5);
const L3 = row(NOVA, "p2", "ben", 30_000, 31_000, "solo live", 0.99);
const W1 = row(WH, "p1", "ana", 8_500, 10_500, "Hola, mundo.", 0.8);
const W2 = row(WH, "p1", "ana", 19_000, 21_000, "uno dos", 0.7);
const W3 = row(WH, "p2", "ben", 50_000, 51_000, "only whisper", null);
const W4 = row(WH, "p1", "ana", 13_500, 14_000, "mundo", 0.6); // within L1's 2 s slack
const P1 = row(PK, "p1", "ana", 10_000, 12_000, "hola", 0.95);

const run = (over: Partial<Run>): Run => ({ engine: WH, at: 0, meetingId: "m", options: {}, tracks: [], ms: 0, usd: 0, peakRssBytes: null, ...over });

const live: EngineSet = { engine: NOVA, rows: [L1, L2, L3], run: null };
const whisper: EngineSet = { engine: WH, rows: [W1, W2, W3, W4], run: run({ ms: 1234, usd: 0.0123 }) };
const parakeet: EngineSet = { engine: PK, rows: [P1], run: run({ engine: PK, ms: 500, peakRssBytes: 3_000_000_000 }) };

describe("tokens", () => {
  test("normTokens strips accents, case, punctuation and apostrophes", () => {
    expect(normTokens("¡Hola, Ána! Don't—go… 2x")).toEqual(["hola", "ana", "dont", "go", "2x"]);
    expect(normTokens("  ... ")).toEqual([]);
  });

  test("recall is multiset |A ∩ B| / |A|", () => {
    expect(recall(["a", "a", "b"], ["a", "b", "c"])).toBeCloseTo(2 / 3, 10);
    expect(recall(["a", "a"], ["a", "a", "a"])).toBe(1);
    expect(recall(["x"], [])).toBe(0);
    expect(recall([], ["x"])).toBe(1);
  });

  test("overlaps needs the same peer and meets within the slack, symmetrically", () => {
    expect(overlaps(L1, W4)).toBe(true); // 13 500 <= 12 000 + 2 000
    expect(overlaps(W4, L1)).toBe(true);
    expect(overlaps(L1, row(WH, "p1", "ana", 14_001, 15_000, "x", null))).toBe(false);
    expect(overlaps(L1, row(WH, "p2", "ben", 10_000, 12_000, "x", null))).toBe(false);
    expect(overlaps(L1, W4, 0)).toBe(false);
  });
});

describe("summaries", () => {
  test("engineSummary: rows, tokens, speech seconds, run numbers or null", () => {
    expect(engineSummary(live)).toEqual({ engine: NOVA, rows: 3, words: 8, speechS: 5, wallMs: null, usd: null, peakRssMb: null });
    expect(engineSummary(whisper)).toEqual({ engine: WH, rows: 4, words: 7, speechS: 5.5, wallMs: 1234, usd: 0.0123, peakRssMb: null });
    expect(engineSummary(parakeet)).toEqual({ engine: PK, rows: 1, words: 1, speechS: 2, wallMs: 500, usd: 0, peakRssMb: 3000 });
  });

  test("speakerSummary: join order first, then name; engines in set order", () => {
    expect(speakerSummary([live, whisper], ["ben", "ana"])).toEqual([
      { speaker: "ben", engine: NOVA, rows: 1, words: 2, speechS: 1 },
      { speaker: "ben", engine: WH, rows: 1, words: 2, speechS: 1 },
      { speaker: "ana", engine: NOVA, rows: 2, words: 6, speechS: 4 },
      { speaker: "ana", engine: WH, rows: 3, words: 5, speechS: 4.5 },
    ]);
    expect(speakerSummary([live]).map((s) => s.speaker)).toEqual(["ana", "ben"]);
  });
});

describe("agreement", () => {
  test("live vs whisper: L1 1, L2 0.5, L3 unmatched; W3 unmatched", () => {
    expect(agreement(live, whisper)).toEqual({ a: NOVA, b: WH, pairs: 2, meanOverlap: 0.75, unmatchedA: 1, unmatchedB: 1 });
  });

  test("every pair in order, three engines", () => {
    expect(agreements([live, whisper, parakeet])).toEqual([
      { a: NOVA, b: WH, pairs: 2, meanOverlap: 0.75, unmatchedA: 1, unmatchedB: 1 },
      { a: NOVA, b: PK, pairs: 1, meanOverlap: 0.5, unmatchedA: 2, unmatchedB: 0 },
      { a: WH, b: PK, pairs: 2, meanOverlap: 0.25, unmatchedA: 2, unmatchedB: 0 },
    ]);
  });

  test("rows without tokens are left out; one engine has no pairs", () => {
    const blank: EngineSet = { engine: WH, rows: [row(WH, "p1", "ana", 10_000, 12_000, " … ", null)], run: null };
    expect(agreement(live, blank)).toEqual({ a: NOVA, b: WH, pairs: 0, meanOverlap: null, unmatchedA: 3, unmatchedB: 0 });
    expect(agreements([live])).toEqual([]);
  });
});

describe("review", () => {
  test("lowest overlap first (unmatched is 0), then lowest conf (null last), capped", () => {
    const r = review([live, whisper], 100);
    expect(r.map((x) => `${x.engine === NOVA ? "L" : "W"}:${x.text}`)).toEqual([
      "L:solo live", "W:only whisper", "L:uno dos tres cuatro", "W:mundo", "W:uno dos", "W:Hola, mundo.", "L:hola mundo",
    ]);
    expect(r[0]).toEqual({ t0: 30_000, speaker: "ben", engine: NOVA, conf: 0.99, overlap: 0, text: "solo live", other: null });
    expect(r[2]).toEqual({ t0: 20_000, speaker: "ana", engine: NOVA, conf: 0.5, overlap: 0.5, text: "uno dos tres cuatro", other: "uno dos" });
    expect(r[6]?.other).toBe("Hola, mundo. mundo"); // W1 then W4, by t0
    expect(review([live, whisper], 3).length).toBe(3);
    expect(review([live, whisper], 0)).toEqual([]);
  });

  test("the lowest score over the other engines wins, with that engine's text", () => {
    const l1 = review([live, whisper, parakeet], 100).find((x) => x.engine === NOVA && x.text === "hola mundo");
    expect(l1).toEqual({ t0: 10_000, speaker: "ana", engine: NOVA, conf: 0.9, overlap: 0.5, text: "hola mundo", other: "hola" });
  });

  test("one engine alone: overlap null, sorted by conf", () => {
    expect(review([live], 10).map((x) => [x.conf, x.overlap])).toEqual([[0.5, null], [0.9, null], [0.99, null]]);
  });

  test("compare puts the four parts together", () => {
    const c = compare([live, whisper], 2, ["ana"]);
    expect(Object.keys(c)).toEqual(["engines", "speakers", "agreement", "review"]);
    expect(c.engines.map((e) => e.engine)).toEqual([NOVA, WH]);
    expect(c.speakers[0]?.speaker).toBe("ana");
    expect(c.agreement.length).toBe(1);
    expect(c.review.length).toBe(2);
  });
});

describe("files", () => {
  const liveLine = (r: CompareRow) => JSON.stringify({ t0: r.t0, t1: r.t1, speaker: r.speaker, userId: `u_${r.speaker}`, peerId: r.peerId, text: r.text, lang: null, final: true, engine: r.engine, conf: r.conf });
  const batchLine = (r: CompareRow, engine = r.engine) => JSON.stringify({ ...JSON.parse(liveLine(r)), engine, words: [], track: `${r.speaker}-${r.peerId}.webm` });

  test("parseJsonl names the file and the line", () => {
    const text = `${liveLine(L1)}\n\n{"t0":1}\n`;
    expect(() => parseJsonl(text, UtteranceRowSchema, "u.jsonl")).toThrow(/u\.jsonl:3: /);
    expect(() => parseJsonl("nope", UtteranceRowSchema, "u.jsonl")).toThrow(/u\.jsonl:1: not JSON/);
    expect(parseJsonl(`${liveLine(L1)}\n`, UtteranceRowSchema, "u.jsonl").length).toBe(1);
  });

  let home = "";
  let prevHome: string | undefined;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "acta-compare-"));
    prevHome = process.env.ACTA_HOME;
    process.env.ACTA_HOME = home;
    const dir = join(home, "meetings", "m1");
    await mkdir(join(dir, "transcripts"), { recursive: true });
    await writeFile(join(dir, "utterances.jsonl"), [L1, L2, L3].map(liveLine).join("\n") + "\n");
    await writeFile(join(dir, "transcripts", "whisper.jsonl"), [W1, W2, W3, W4].map((r) => batchLine(r)).join("\n") + "\n");
    await writeFile(join(dir, "transcripts", "whisper.run.json"), JSON.stringify(run({ ms: 1234, usd: 0.0123 })));
    await writeFile(join(dir, "meta.json"), JSON.stringify({ participants: [{ speaker: "ben", peerId: "p2", joinedAt: 1 }, { speaker: "ana", peerId: "p1", joinedAt: 2 }] }));
    const bad = join(home, "meetings", "m2");
    await mkdir(join(bad, "transcripts"), { recursive: true });
    await writeFile(join(bad, "utterances.jsonl"), liveLine(L1) + "\n");
    await writeFile(join(bad, "transcripts", "parakeet.jsonl"), batchLine(P1) + "\n" + batchLine(P1, WH) + "\n");
  });
  afterAll(async () => {
    if (prevHome === undefined) delete process.env.ACTA_HOME; else process.env.ACTA_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  test("compareMeeting reads live, the passes present and meta", async () => {
    const c = await compareMeeting("m1", 20);
    expect(c.missing).toEqual(["parakeet"]);
    expect(c.engines).toEqual([engineSummary(live), engineSummary(whisper)]);
    expect(c.speakers.map((s) => s.speaker)).toEqual(["ben", "ben", "ana", "ana"]);
    expect(c.agreement).toEqual([agreement(live, whisper)]);
    expect(c.review).toEqual(review([live, whisper], 20));
  });

  test("a batch row with the wrong engine is an error naming the file and line", async () => {
    await expect(compareMeeting("m2", 20)).rejects.toThrow(/parakeet\.jsonl:2: .*parakeet-tdt-0\.6b-v3/);
  });

  async function serve(argv: string[]): Promise<{ out: string; code: number | null }> {
    let out = "";
    let code: number | null = null;
    await cli.serve(argv, { stdout: (s) => { out += s; }, exit: (c) => { code = c; }, env: { ...process.env } });
    return { out, code };
  }

  test("the verb answers JSON, and exits 1 telling the user to sync when nothing is there", async () => {
    const ok = await serve(["compare", "m1", "--limit", "2", "--json"]);
    expect(ok.code).toBeNull();
    const body: unknown = JSON.parse(ok.out);
    expect(body).toMatchObject({ engines: [{ engine: NOVA }, { engine: WH }], agreement: [{ a: NOVA, b: WH, pairs: 2 }] });
    expect(ok.out).toContain('"review"');

    const none = await serve(["compare", "nope"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("NO_LIVE_ROWS");
    expect(none.out).toContain("acta sync nope");
    expect(none.out).toContain("acta transcribe nope");
  });
});
