// `acta test`: synthetic speakers in a fresh meeting, end to end. Creates the
// meeting, joins one `human` per fixture speaker, plays each speaker's WAV
// through headless Chromium's fake mic, follows /events until `ended`, then
// asserts on what Scribe stored (docs/V0.md §Synthetic speakers).
//
// The run log goes to stderr as it happens; the report is the one structured
// value the generator yields, so an agent reads the checks as data.
import { join } from "node:path";
import { z } from "zod";
import { api, baseUrl, capabilityOf, events, relativeKey, type FileEntry, type UtteranceRow } from "../client.ts";
import type { EventFrame, Paragraph } from "../../src/core/schemas.ts";
import { slug } from "../../src/core/ids.ts";
import { loadFixture, synthesizeFixture, type Fixture, type FixtureLine } from "../../test/synth/voices.ts";
import { findChrome, launchSpeaker, type Speaker } from "../../test/synth/speaker.ts";
import { frameLine } from "./tail.ts";
import { bytes, clock } from "../fmt.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const DEFAULT_FIXTURE = join(ROOT, "test", "synth", "fixtures", "two-speakers.json");
const BOT_HTML = join(ROOT, "test", "synth", "bot.html");
/** After the WAVs end: time for the last finals to land before the bots leave. */
const TAIL_MS = 6000;
const JOIN_TIMEOUT_MS = 60_000;

export const AUDIO_MODES = ["mic", "file"] as const;
export const BOT_MODES = ["local", "remote"] as const;

export type TestOptions = {
  fixture: string | undefined;
  keep: boolean;
  relayPort: number;
  audio: (typeof AUDIO_MODES)[number];
  bot: (typeof BOT_MODES)[number];
  /** Seconds after launch before `ended` is forced with POST /end. */
  timeout: number;
};

// --- the relay: a local server the bots POST their events to -------------------

export const BotEventSchema = z.object({
  tag: z.string(),
  ev: z.string(),
  at: z.number(),
  ms: z.number(),
  data: z.unknown(),
});
export type BotEvent = z.infer<typeof BotEventSchema>;

type Go = { startAt: number; leaveAt: number | null };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};

function startRelay(port: number, wavs: Record<string, string>, onEvent: (e: BotEvent) => void) {
  const seen: BotEvent[] = [];
  let go: Go | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method === "GET" && url.pathname === "/bot") {
        return new Response(Bun.file(BOT_HTML), { headers: { ...CORS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (req.method === "GET" && url.pathname.startsWith("/wav/")) {
        const wav = wavs[url.pathname.slice(5)];
        return wav ? new Response(Bun.file(wav), { headers: { ...CORS, "content-type": "audio/wav" } }) : new Response("no such tag", { status: 404, headers: CORS });
      }
      if (req.method === "GET" && url.pathname === "/go") {
        return go ? Response.json(go, { headers: CORS }) : new Response(null, { status: 204, headers: CORS });
      }
      if (req.method === "POST" && url.pathname === "/relay") {
        let raw: unknown;
        try { raw = JSON.parse(await req.text()); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
        const e = BotEventSchema.safeParse(raw);
        if (!e.success) return new Response("bad event", { status: 400, headers: CORS });
        seen.push(e.data);
        onEvent(e.data);
        return new Response(null, { status: 204, headers: CORS });
      }
      return new Response("not found", { status: 404, headers: CORS });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    seen,
    has: (tag: string, ev: string) => seen.some((e) => e.tag === tag && e.ev === ev),
    setGo: (g: Go) => { go = g; },
    stop: () => server.stop(true),
  };
}

// --- assertions (pure) ---------------------------------------------------------

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const tokens = (s: string): string[] => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

/** Fraction of `text`'s tokens found in `vocab` (0 when `text` has none). */
export function coverage(text: string, vocab: Set<string>): number {
  const t = tokens(text);
  if (t.length === 0) return 0;
  return t.filter((x) => vocab.has(x)).length / t.length;
}

export type Check = { name: string; level: "required" | "extra"; ok: boolean; detail: string };

export type Observed = {
  utterances: UtteranceRow[];
  paragraphs: Paragraph[];
  /** null when the run did not end the meeting (--keep). */
  files: FileEntry[] | null;
  /** Lines in R2's utterances.jsonl, when it could be read. */
  jsonlLines: number | null;
  ended: Extract<EventFrame, { type: "ended" }> | null;
  forcedEnd: boolean;
  meetingId: string;
  /** Paragraph ids the `paragraphs` digests carried, in order; null when the run did not follow the socket. */
  digested: string[] | null;
};

export function assess(f: Fixture, o: Observed): Check[] {
  const checks: Check[] = [];
  const tags = f.speakers.map((s) => slug(s.tag));
  const vocab = new Map(f.speakers.map((s) => [slug(s.tag), new Set(f.lines.filter((l) => l.who === s.tag).flatMap((l) => tokens(l.text)))]));
  const by = (tag: string) => o.utterances.filter((u) => u.speaker === tag);

  // 1. every speaker produced at least one final
  const counts = tags.map((t) => `${t} ${by(t).length}`);
  const strangers = [...new Set(o.utterances.map((u) => u.speaker).filter((s) => !tags.includes(s)))];
  checks.push({
    name: "finals per speaker", level: "required",
    ok: tags.every((t) => by(t).length > 0) && strangers.length === 0,
    detail: counts.join(", ") + (strangers.length ? `; unexpected speakers: ${strangers.join(", ")}` : ""),
  });

  // 2. attribution: each utterance's words belong to its speaker's script
  let matched = 0, unmatched = 0;
  const wrong: string[] = [];
  const matchedBy = new Map(tags.map((t) => [t, 0]));
  for (const u of o.utterances) {
    const scores = tags.map((t) => ({ t, s: coverage(u.text, vocab.get(t) ?? new Set()) })).sort((a, b) => b.s - a.s);
    const best = scores[0], second = scores[1];
    if (!best || best.s < 0.5 || (second && second.s === best.s)) { unmatched++; continue; }
    matched++;
    if (best.t !== u.speaker) wrong.push(`#${u.seq ?? "?"} "${u.text.slice(0, 40)}" is ${best.t}'s, stored as ${u.speaker}`);
    else matchedBy.set(best.t, (matchedBy.get(best.t) ?? 0) + 1);
  }
  const silent = tags.filter((t) => (matchedBy.get(t) ?? 0) === 0);
  checks.push({
    name: "attribution", level: "required",
    ok: wrong.length === 0 && silent.length === 0,
    detail: `${matched - wrong.length}/${matched} matched utterances right, ${unmatched} unmatched` +
      (wrong.length ? `; wrong: ${wrong.slice(0, 3).join("; ")}` : "") +
      (silent.length ? `; no recognisable speech from ${silent.join(", ")}` : ""),
  });

  // 3. backchannel lines are asides, never paragraphs of their own
  for (const l of f.lines.filter((x) => x.expect === "aside")) checks.push(asideCheck(l, o));

  // 4. utterances in t1 order (seq increasing when present)
  const disorder: string[] = [];
  o.utterances.forEach((u, i) => {
    const prev = o.utterances[i - 1];
    if (!prev) return;
    if (u.t1 < prev.t1) disorder.push(`#${i} t1 ${u.t1} < ${prev.t1}`);
    if (u.seq !== undefined && prev.seq !== undefined && u.seq <= prev.seq) disorder.push(`#${i} seq ${u.seq} <= ${prev.seq}`);
    if (u.t0 > u.t1) disorder.push(`#${i} t0 > t1`);
  });
  checks.push({ name: "t1 order", level: "required", ok: disorder.length === 0, detail: disorder.length ? disorder.slice(0, 3).join("; ") : `${o.utterances.length} utterances` });

  // 4b. the digests carried every paragraph exactly once, in order (the brain's feed)
  if (o.digested !== null) {
    const want = o.paragraphs.map((p) => p.id);
    const same = o.digested.length === want.length && o.digested.every((id, i) => id === want[i]);
    checks.push({
      name: "paragraphs digested", level: "required", ok: same,
      detail: same ? `${want.length} paragraphs over the digests` : `digests carried ${o.digested.length} ids, the API has ${want.length}${o.digested.length === want.length ? " (order or ids differ)" : ""}`,
    });
  }

  // 5. utterances.jsonl landed in R2 (only when the run ended the meeting)
  if (o.files !== null) {
    const entry = o.files.find((x) => relativeKey(o.meetingId, x.key) === "utterances.jsonl");
    const lines = o.jsonlLines;
    checks.push({
      name: "utterances.jsonl in R2", level: "required",
      ok: !!entry && (lines === null || lines === o.utterances.length),
      detail: entry ? `${entry.key} ${bytes(entry.size)}${lines === null ? "" : `, ${lines} lines vs ${o.utterances.length} from the API`}` : `not among ${o.files.length} files: ${o.files.map((x) => x.key).join(", ") || "(none)"}`,
    });
    checks.push({
      name: "ended", level: "required",
      ok: !!o.ended && !o.forcedEnd,
      detail: o.ended ? `${o.forcedEnd ? "only after POST /end; " : ""}reason=${o.ended.reason} utterances=${o.ended.utterances} paragraphs=${o.ended.paragraphs}` : "no `ended` frame",
    });
  }

  // extras: warn, do not fail (ASR and timing make them softer)
  for (const l of f.lines.filter((x) => x.expect === "change" || x.expect === "overlap")) {
    const who = slug(l.who);
    const lv = new Set(tokens(l.text));
    // the paragraph carries the line: at least half the line's words are in it
    const p = o.paragraphs.find((x) => x.speaker === who && share(l.text, x.text) >= 0.5);
    const u = by(who).some((x) => coverage(x.text, lv) >= 0.5);
    checks.push({
      name: `${l.expect} @${l.at}s`, level: "extra", ok: !!p && u,
      detail: p ? `${who}'s paragraph ${p.id} carries it` : u ? `heard, but no ${who} paragraph carries it` : `no ${who} utterance matches "${l.text.slice(0, 40)}"`,
    });
  }
  const heard = f.lines.filter((l) => {
    const text = by(slug(l.who)).map((u) => u.text).join(" ");
    return share(l.text, text) >= 0.5;
  }).length;
  checks.push({ name: "lines heard", level: "extra", ok: heard === f.lines.length, detail: `${heard}/${f.lines.length} fixture lines at least half transcribed` });
  return checks;
}

/** Fraction of `line`'s tokens present in `text`. */
function share(line: string, text: string): number {
  return coverage(line, new Set(tokens(text)));
}

function asideCheck(l: FixtureLine, o: Observed): Check {
  const who = slug(l.who);
  const lv = new Set(tokens(l.text));
  const name = `backchannel @${l.at}s is an aside`;
  const hit = o.paragraphs.flatMap((p) => p.asides.map((a) => ({ p, a }))).find((x) => x.a.speaker === who && coverage(x.a.text, lv) >= 0.5);
  const own = o.paragraphs.find((p) => p.speaker === who && coverage(p.text, lv) >= 0.5 && tokens(p.text).length <= lv.size + 1);
  const utt = o.utterances.find((u) => u.speaker === who && coverage(u.text, lv) >= 0.5 && tokens(u.text).length <= lv.size + 2);
  if (hit && !own) return { name, level: "required", ok: true, detail: `[${hit.a.speaker}: ${hit.a.text}] inside ${hit.p.speaker}'s ${hit.p.id}` };
  if (own) return { name, level: "required", ok: false, detail: `became paragraph ${own.id} ("${own.text.slice(0, 40)}")` };
  if (utt) return { name, level: "required", ok: false, detail: `utterance #${utt.seq ?? "?"} "${utt.text}" is in no paragraph's asides` };
  return { name, level: "required", ok: false, detail: `no ${who} utterance matches "${l.text}" (ASR dropped or merged it)` };
}

// --- the report (pure) ----------------------------------------------------------

export type Report = {
  meetingId: string;
  result: "PASS" | "FAIL";
  failed: number;
  checks: { check: string; result: "PASS" | "FAIL" | "warn"; detail: string }[];
  paragraphs: { at: string; speaker: string; text: string; asides: number }[];
  bots: { tag: string; joined: boolean; audioLateMs: number | null; clientFinals: number; errors: string }[];
};

export function report(meetingId: string, checks: Check[], paragraphs: Paragraph[], bot: BotEvent[], tags: string[]): Report {
  const failed = checks.filter((c) => c.level === "required" && !c.ok).length;
  return {
    meetingId,
    result: failed ? "FAIL" : "PASS",
    failed,
    checks: checks.map((c) => ({ check: c.name, result: c.ok ? "PASS" : c.level === "required" ? "FAIL" : "warn", detail: c.detail })),
    paragraphs: paragraphs.map((p) => {
      // `text` already carries the asides inline; count them rather than repeat them.
      const text = p.text.replace(/\s+/g, " ");
      return { at: clock(p.t0), speaker: p.speaker, text: text.length > 140 ? `${text.slice(0, 140)}…` : text, asides: p.asides.length };
    }),
    bots: tags.map((t) => {
      const mine = bot.filter((e) => e.tag === t);
      const on = mine.find((e) => e.ev === "audioOn");
      const late = on ? z.object({ lateMs: z.number() }).loose().safeParse(on.data) : null;
      return {
        tag: t,
        joined: mine.some((e) => e.ev === "joined"),
        audioLateMs: late?.success ? late.data.lateMs : null,
        clientFinals: mine.filter((e) => e.ev === "final").length,
        errors: mine.filter((e) => /fail|error|fatal|noGo/i.test(e.ev)).map((e) => e.ev).join(",") || "-",
      };
    }),
  };
}

// --- the run ----------------------------------------------------------------------

const t0 = Date.now();
const log = (s: string) => process.stderr.write(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}\n`);

async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(200);
  }
  return pred();
}

function botLine(e: BotEvent): string {
  const d = e.data === null || e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
  return `bot ${e.tag} ${e.ev}${d.length > 200 ? `${d.slice(0, 200)}…` : d}`;
}

export type Held = { room: string; meetingId: string; note: string };

/**
 * Yields the report once the meeting has ended (and, with --keep, a `room`
 * line, then holds until Ctrl-C). Returns how many required checks failed.
 */
export async function* runTest(opts: TestOptions): AsyncGenerator<Report | Held, { failed: number; meetingId: string }> {
  const timeoutMs = opts.timeout * 1000;
  const keep = opts.keep;

  const fixture = await loadFixture(opts.fixture ?? DEFAULT_FIXTURE);
  log(`fixture "${fixture.title}": ${fixture.speakers.length} speakers, ${fixture.lines.length} lines`);
  const audio = await synthesizeFixture(fixture);
  for (const w of audio.warnings) log(`warn ${w}`);
  log(`voices ready: ${audio.totalSec} s per speaker`);
  const chrome = await findChrome();
  const tags = fixture.speakers.map((s) => s.tag);

  const relay = startRelay(opts.relayPort, audio.wavs, (e) => log(botLine(e)));
  log(`relay ${relay.origin}`);

  const speakers: Speaker[] = [];
  const stopAll = async () => { await Promise.all(speakers.map((s) => s.stop())); };
  let meetingId: string | null = null;
  let endedFrame: Extract<EventFrame, { type: "ended" }> | null = null;
  let keepWaiting: (() => void) | null = null;
  const onSigint = () => {
    if (keepWaiting) { keepWaiting(); return; }
    log("interrupted: stopping speakers");
    void stopAll().then(async () => {
      if (meetingId && !endedFrame && !keep) await api.end(meetingId).catch(() => {});
      relay.stop();
      process.exit(130);
    });
  };
  process.on("SIGINT", onSigint);

  try {
    const m = await api.createMeeting(`${fixture.title} · acta test ${new Date().toISOString().slice(0, 16)}Z`, fixture.keywords);
    meetingId = m.id;
    log(`meeting ${m.id}`);
    const key = capabilityOf(m.url);

    let hello = false;
    const digested: string[] = [];
    const sock = events(m.id, {
      frame: (f) => {
        if (f.type === "hello") hello = true;
        if (f.type === "ended") endedFrame = f;
        if (f.type === "paragraphs") digested.push(...f.paragraphs.map((p) => p.id));
        log(`event ${frameLine(f)}`);
      },
      invalid: (raw, why) => log(`event unparsed (${why.replace(/\s+/g, " ")}): ${raw.slice(0, 200)}`),
      close: (code, reason) => log(`events socket closed ${code} ${reason}`),
    });
    if (!(await until(() => hello, 15_000))) throw new Error("events socket: no `hello` within 15 s");

    const botBase = opts.bot === "local" ? `${relay.origin}/bot` : `${baseUrl()}/synth/bot`;
    for (const s of fixture.speakers) {
      const j = await api.join(m.id, key, s.tag);
      if (j.speaker !== slug(s.tag)) log(`warn join ${s.tag} answered speaker=${j.speaker}`);
      const frag = new URLSearchParams({ authToken: j.token, tag: s.tag, relay: `${relay.origin}/relay`, audio: opts.audio });
      if (opts.audio === "file") frag.set("wav", `${relay.origin}/wav/${s.tag}`);
      const wav = audio.wavs[s.tag];
      if (!wav) throw new Error(`no WAV for ${s.tag}`);
      const sp = await launchSpeaker({ url: `${botBase}#${frag}`, wav, tag: s.tag, chrome });
      speakers.push(sp);
      log(`speaker ${s.tag} pid ${sp.pid} log ${sp.log}`);
    }
    const launchedAt = Date.now();

    const dead = () => relay.seen.find((e) => e.ev === "fatal" || e.ev === "joinFailed");
    await until(() => tags.every((t) => relay.has(t, "joined")) || dead() !== undefined, JOIN_TIMEOUT_MS);
    const died = dead();
    if (died) throw new Error(`bot ${died.tag} ${died.ev}: ${JSON.stringify(died.data).slice(0, 300)}`);
    if (!tags.every((t) => relay.has(t, "joined"))) {
      const missing = tags.filter((t) => !relay.has(t, "joined"));
      throw new Error(`not joined after ${JOIN_TIMEOUT_MS / 1000} s: ${missing.join(", ")} (Chromium logs: ${speakers.map((s) => s.log).join(" ")})`);
    }
    const startAt = Date.now() + 2000;
    const audioEnd = startAt + audio.totalSec * 1000;
    const leaveAt = keep ? null : audioEnd + TAIL_MS;
    relay.setGo({ startAt, leaveAt });
    log(`go: audio starts ${clock(startAt)}, ends ${clock(audioEnd)}${leaveAt ? `, bots leave ${clock(leaveAt)}` : ""}`);

    let forcedEnd = false;
    if (leaveAt !== null) {
      await until(() => tags.every((t) => relay.has(t, "left")), leaveAt - Date.now() + 15_000);
      await stopAll();
      log("speakers stopped; waiting for `ended`");
      await until(() => endedFrame !== null, Math.max(0, launchedAt + timeoutMs - Date.now()));
      if (!endedFrame) {
        log("no `ended` in time: POST /end");
        forcedEnd = true;
        await api.end(m.id);
        await until(() => endedFrame !== null, 30_000);
      }
    } else {
      await Bun.sleep(Math.max(0, audioEnd + TAIL_MS - Date.now()));
    }
    sock.close();

    const utterances = await api.utterances(m.id);
    const paragraphs = await api.paragraphs(m.id);
    let files: FileEntry[] | null = null;
    let jsonlLines: number | null = null;
    if (!keep) {
      for (let i = 0; i < 6; i++) {
        files = await api.files(m.id);
        if (files.some((x) => relativeKey(m.id, x.key) === "utterances.jsonl")) break;
        await Bun.sleep(2000);
      }
      if (files?.some((x) => relativeKey(m.id, x.key) === "utterances.jsonl")) {
        const text = await (await api.file(m.id, "utterances.jsonl")).text();
        jsonlLines = text.split("\n").filter((l) => l.trim()).length;
      }
    }

    const checks = assess(fixture, { utterances, paragraphs, files, jsonlLines, ended: endedFrame, forcedEnd, meetingId: m.id, digested });
    const rep = report(m.id, checks, paragraphs, relay.seen, tags);
    yield rep;

    if (keep) {
      yield { room: m.url, meetingId: m.id, note: "live with the bots in it; Ctrl-C stops them (the meeting ends 20 s after the last participant leaves)" };
      await new Promise<void>((r) => { keepWaiting = r; });
      keepWaiting = null;
    }
    return { failed: rep.failed, meetingId: m.id };
  } catch (e) {
    // A failed run must not leave a live meeting (the agent bills while it waits).
    await stopAll();
    if (meetingId && !endedFrame && !keep) {
      log(`run failed: ending meeting ${meetingId}`);
      await api.end(meetingId).catch((err) => log(`POST /end failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    throw e;
  } finally {
    await stopAll();
    relay.stop();
    process.off("SIGINT", onSigint);
  }
}
