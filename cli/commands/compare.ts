// `acta compare <id>`: the live transcript against the batch passes, on the
// files `acta sync` and `acta transcribe` leave under ~/.acta/meetings/<id>/
// (docs/BATCH.md §"The verb"). Reads, never writes; nothing leaves the laptop.
//
// Inputs: `utterances.jsonl` (the live rows, required), and for each batch
// engine present `transcripts/<engine>.jsonl` (rows, `BatchRowSchema`) with
// `transcripts/<engine>.run.json` beside it (`RunSchema`, optional), and
// `meta.json` (optional; only orders speakers by `joinedAt`). Every line is
// parsed with zod; a bad line is an error naming the file and the line.
//
// The answer, every number derived from the rows by the pure functions below:
//
// - `engines[]`: one per engine present, in the order nova-3, whisper,
//   parakeet. `rows`; `words` = normalized tokens of the row texts (the same
//   tokenizer for every engine, so live rows without `words` count alike);
//   `speechS` = sum of row spans (t1 - t0) / 1000, one decimal; `wallMs`,
//   `usd`, `peakRssMb` (peak RSS bytes / 1e6, one decimal) from the run file,
//   null when there is none. The live engine's are always null: its cost is
//   the vendor's per-minute price on the bill, not something the rows hold.
// - `speakers[]`: per (speaker, engine): `rows`, `words`, `speechS`.
// - `agreement[]`: per pair of engines (a before b in the order above). Two
//   rows match when they carry the SAME `peerId` and their [t0, t1] overlap
//   once widened by SLACK_MS on each side (live rows are receipt time and lag
//   speech by 1 to 2 s; the widened test is symmetric). A row's overlap is
//   the recall of its normalized tokens in the concatenated text of every row
//   of the other engine it matches, on multisets: |A ∩ B| / |A|. `pairs` is
//   how many rows of a matched, `meanOverlap` their mean (4 decimals, null
//   when none), `unmatchedA`/`unmatchedB` the rows of each side that match
//   nothing on the other. Rows with no tokens are left out of every count.
// - `review[]`: the review page's sampling order. Every row of every engine
//   with tokens, scored against each other engine: `overlap` is its lowest
//   recall over the other engines, 0 when some other engine has no matching
//   row at all (one engine heard words the other did not), null when only one
//   engine is present; `other` is the matched text of the engine that gave
//   that lowest score (null when it was unmatched). Sorted by overlap
//   ascending (null last), then conf ascending (null last), then t0, then
//   engine order; capped at `--limit`.
//
// Normalization: NFD with combining marks stripped, lowercase, apostrophes
// dropped ("don't" = "dont"), every other non-letter, non-digit run a space.
// WER is out of scope: it needs a reference, and none exists until human
// rows (`engine: "human"`) do. Token recall is the agreement measure until then.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Errors } from "incur";
import { z } from "zod";
import { BatchRowSchema, ENGINE_IDS, ENGINES, RunSchema, speechSeconds, type Engine, type Run } from "../../src/core/batch.ts";
import { UtteranceRowSchema } from "../client.ts";
import { meetingsRoot } from "./sync.ts";

export const LIVE_ENGINE = "nova-3";
/** Widening of each interval, ms, before the overlap test. */
export const SLACK_MS = 2000;

/** What compare needs of a row, live or batch. */
export type CompareRow = { t0: number; t1: number; speaker: string; peerId: string; text: string; engine: string; conf: number | null };

/** The rows of one engine and what its run cost (null for the live rows or a pass without a run file). */
export type EngineSet = { engine: string; rows: CompareRow[]; run: Run | null };

export type EngineSummary = { engine: string; rows: number; words: number; speechS: number; wallMs: number | null; usd: number | null; peakRssMb: number | null };
export type SpeakerSummary = { speaker: string; engine: string; rows: number; words: number; speechS: number };
export type Agreement = { a: string; b: string; pairs: number; meanOverlap: number | null; unmatchedA: number; unmatchedB: number };
export type ReviewRow = { t0: number; speaker: string; engine: string; conf: number | null; overlap: number | null; text: string; other: string | null };
export type Comparison = { engines: EngineSummary[]; speakers: SpeakerSummary[]; agreement: Agreement[]; review: ReviewRow[] };

// --- pure ------------------------------------------------------------------

/** Normalized tokens: accents stripped, lowercase, punctuation gone. */
export function normTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

function bag(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Multiset recall of `a` in `b`: |a ∩ b| / |a|; 1 for an empty `a`. */
export function recall(a: string[], b: string[]): number {
  if (a.length === 0) return 1;
  const have = bag(b);
  let hit = 0;
  for (const t of a) {
    const n = have.get(t) ?? 0;
    if (n > 0) { hit++; have.set(t, n - 1); }
  }
  return hit / a.length;
}

/** Same peer, and the intervals meet once widened by `slack` on each side. Symmetric. */
export function overlaps(a: CompareRow, b: CompareRow, slack = SLACK_MS): boolean {
  return a.peerId === b.peerId && b.t0 <= a.t1 + slack && b.t1 >= a.t0 - slack;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const wordsOf = (rows: CompareRow[]) => rows.reduce((n, r) => n + normTokens(r.text).length, 0);
const hasTokens = (r: CompareRow) => normTokens(r.text).length > 0;

export function engineSummary(s: EngineSet): EngineSummary {
  return {
    engine: s.engine,
    rows: s.rows.length,
    words: wordsOf(s.rows),
    speechS: round(speechSeconds(s.rows), 1),
    wallMs: s.run?.ms ?? null,
    usd: s.run ? s.run.usd : null,
    peakRssMb: s.run?.peakRssBytes != null ? round(s.run.peakRssBytes / 1e6, 1) : null,
  };
}

/** Per (speaker, engine). Speakers in `order` first (meta's join order), the rest by name; engines in set order. */
export function speakerSummary(sets: EngineSet[], order: string[] = []): SpeakerSummary[] {
  const names = new Set<string>();
  for (const s of sets) for (const r of s.rows) names.add(r.speaker);
  const rank = (n: string) => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
  const speakers = [...names].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  const out: SpeakerSummary[] = [];
  for (const speaker of speakers) {
    for (const s of sets) {
      const rows = s.rows.filter((r) => r.speaker === speaker);
      if (rows.length === 0) continue;
      out.push({ speaker, engine: s.engine, rows: rows.length, words: wordsOf(rows), speechS: round(speechSeconds(rows), 1) });
    }
  }
  return out;
}

/** The rows of `b` a row matches, and its recall in their concatenated text; null when it matches none. */
export function scoreRow(row: CompareRow, b: CompareRow[], slack = SLACK_MS): { overlap: number; other: string } | null {
  const hits = b.filter((x) => hasTokens(x) && overlaps(row, x, slack));
  if (hits.length === 0) return null;
  const other = [...hits].sort((x, y) => x.t0 - y.t0 || x.t1 - y.t1).map((x) => x.text).join(" ");
  return { overlap: recall(normTokens(row.text), normTokens(other)), other };
}

export function agreement(a: EngineSet, b: EngineSet, slack = SLACK_MS): Agreement {
  const ra = a.rows.filter(hasTokens);
  const rb = b.rows.filter(hasTokens);
  const scores: number[] = [];
  let unmatchedA = 0;
  for (const r of ra) {
    const s = scoreRow(r, rb, slack);
    if (s) scores.push(s.overlap); else unmatchedA++;
  }
  const unmatchedB = rb.filter((r) => !ra.some((x) => overlaps(r, x, slack))).length;
  const meanOverlap = scores.length ? round(scores.reduce((x, y) => x + y, 0) / scores.length, 4) : null;
  return { a: a.engine, b: b.engine, pairs: scores.length, meanOverlap, unmatchedA, unmatchedB };
}

/** Every pair in set order: (0,1), (0,2), (1,2). */
export function agreements(sets: EngineSet[], slack = SLACK_MS): Agreement[] {
  const out: Agreement[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i], b = sets[j];
      if (a && b) out.push(agreement(a, b, slack));
    }
  }
  return out;
}

const nullsLast = (x: number | null, y: number | null) => (x === null ? (y === null ? 0 : 1) : y === null ? -1 : x - y);

/** The sampling order: lowest agreement first, then lowest confidence. See the file header. */
export function review(sets: EngineSet[], limit: number, slack = SLACK_MS): ReviewRow[] {
  const out: { row: ReviewRow; order: number }[] = [];
  sets.forEach((s, order) => {
    const others = sets.filter((o) => o !== s);
    for (const r of s.rows) {
      if (!hasTokens(r)) continue;
      let overlap: number | null = null;
      let other: string | null = null;
      for (const o of others) {
        const sc = scoreRow(r, o.rows, slack);
        const v = sc ? sc.overlap : 0;
        if (overlap === null || v < overlap) { overlap = v; other = sc ? sc.other : null; }
      }
      out.push({ row: { t0: r.t0, speaker: r.speaker, engine: s.engine, conf: r.conf, overlap: overlap === null ? null : round(overlap, 4), text: r.text, other }, order });
    }
  });
  out.sort((x, y) => nullsLast(x.row.overlap, y.row.overlap) || nullsLast(x.row.conf, y.row.conf) || x.row.t0 - y.row.t0 || x.order - y.order);
  return out.slice(0, Math.max(0, limit)).map((x) => x.row);
}

export function compare(sets: EngineSet[], limit: number, speakerOrder: string[] = []): Comparison {
  return {
    engines: sets.map(engineSummary),
    speakers: speakerSummary(sets, speakerOrder),
    agreement: agreements(sets),
    review: review(sets, limit),
  };
}

/** Parse JSONL with `schema`; a bad line throws naming the file and the 1-based line. Blank lines are skipped. */
export function parseJsonl<T>(text: string, schema: z.ZodType<T>, file: string): T[] {
  const out: T[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch (e) {
      throw new Errors.IncurError({ code: "BAD_LINE", message: `${file}:${i + 1}: not JSON (${e instanceof Error ? e.message : String(e)})` });
    }
    const r = schema.safeParse(raw);
    if (!r.success) throw new Errors.IncurError({ code: "BAD_LINE", message: `${file}:${i + 1}: ${z.prettifyError(r.error).replace(/\n/g, " ")}` });
    out.push(r.data);
  });
  return out;
}

// --- I/O -------------------------------------------------------------------

const MetaSchema = z.object({
  participants: z.array(z.object({ speaker: z.string(), peerId: z.string(), joinedAt: z.number() }).loose()).default([]),
}).loose();

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

function parseJson<T>(text: string, schema: z.ZodType<T>, file: string): T {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    throw new Errors.IncurError({ code: "BAD_FILE", message: `${file}: not JSON (${e instanceof Error ? e.message : String(e)})` });
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new Errors.IncurError({ code: "BAD_FILE", message: `${file}: ${z.prettifyError(r.error).replace(/\n/g, " ")}` });
  return r.data;
}

const toCompare = (r: CompareRow): CompareRow => ({ t0: r.t0, t1: r.t1, speaker: r.speaker, peerId: r.peerId, text: r.text, engine: r.engine, conf: r.conf });

/** Read a meeting directory into engine sets (live first, then each batch engine present) and the speakers' join order. */
export async function loadMeeting(dir: string, id: string): Promise<{ sets: EngineSet[]; speakerOrder: string[] }> {
  const livePath = join(dir, "utterances.jsonl");
  const live = await readText(livePath);
  if (live === null) {
    throw new Errors.IncurError({
      code: "NO_LIVE_ROWS",
      message: `${livePath} not found: run \`acta sync ${id}\`, then \`acta transcribe ${id} --engine whisper\` (or parakeet), and compare again`,
    });
  }
  const sets: EngineSet[] = [{ engine: LIVE_ENGINE, rows: parseJsonl(live, UtteranceRowSchema, livePath).map(toCompare), run: null }];
  for (const e of ENGINES) {
    const rowsPath = join(dir, "transcripts", `${e}.jsonl`);
    const text = await readText(rowsPath);
    if (text === null) continue;
    const expected = ENGINE_IDS[e];
    const schema = BatchRowSchema.refine((r) => r.engine === expected, { message: `engine must be ${expected}` });
    const rows = parseJsonl(text, schema, rowsPath).map(toCompare);
    const runPath = join(dir, "transcripts", `${e}.run.json`);
    const runText = await readText(runPath);
    sets.push({ engine: expected, rows, run: runText === null ? null : parseJson(runText, RunSchema, runPath) });
  }
  const metaPath = join(dir, "meta.json");
  const metaText = await readText(metaPath);
  const speakerOrder = metaText === null ? [] : [...parseJson(metaText, MetaSchema, metaPath).participants]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => p.speaker)
    .filter((s, i, all) => all.indexOf(s) === i);
  return { sets, speakerOrder };
}

/** `acta compare <id>`: the synced meeting under `meetingsRoot()`, compared. */
export async function compareMeeting(id: string, limit: number, root = meetingsRoot()): Promise<Comparison & { dir: string; missing: Engine[] }> {
  const dir = join(root, id);
  const { sets, speakerOrder } = await loadMeeting(dir, id);
  const present = new Set(sets.map((s) => s.engine));
  const missing = ENGINES.filter((e) => !present.has(ENGINE_IDS[e]));
  return { dir, missing, ...compare(sets, limit, speakerOrder) };
}
