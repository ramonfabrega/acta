// The acta command table, on incur. Every command is declared here with its
// zod schemas, so `acta --help`, `acta --llms`, `acta --llms-full`, the MCP
// surface and `acta skills add` are generated from one source. The bodies
// live in cli/commands/*.ts and return data; incur renders it (TOON by
// default, `--json`, `--format yaml|md|jsonl`).
//
// This module only defines the CLI. `cli/acta.ts` serves it: Bun auto-starts
// a server for a default export with `fetch`, which an incur CLI has, so the
// entry file must not be the one that exports it.
import { Cli, z } from "incur";
import pkg from "../package.json";
import { BOOK_SECTIONS, BookSectionSchema, WritableBookSectionSchema } from "../src/core/schemas.ts";
import { DEFAULT_URL, PASSAGE_ENTRY } from "./client.ts";
import { putSection, showBook } from "./commands/book.ts";
import { copyRecording } from "./commands/copy.ts";
import { doctorReport } from "./commands/doctor.ts";
import { exportMeeting } from "./commands/export.ts";
import { listMeetings } from "./commands/meetings.ts";
import { createMeeting } from "./commands/new.ts";
import { syncMeetings } from "./commands/sync.ts";
import { follow, frameLine } from "./commands/tail.ts";
import { AUDIO_MODES, BOT_MODES, runTest } from "./commands/test.ts";
import { transcribeMeeting } from "./commands/transcribe.ts";
import { EngineSchema } from "../src/core/batch.ts";

export const DESCRIPTION =
  "Own the meeting: a RealtimeKit room with per-speaker transcripts, a Durable Object (Scribe) that turns them into a live book, and recordings copied into R2. " +
  "This CLI talks to the acta Worker. " +
  `Env: ACTA_URL is the Worker (default ${DEFAULT_URL}); ACTA_TOKEN is the operator bearer, read from \`passage show ${PASSAGE_ENTRY}\` when unset, and never printed. ` +
  "Exit 0 on success, 1 on any failure (API error with the server's message, failed check, bad arguments). " +
  "The session that runs `acta new` is the meeting's brain: it arms the harness Monitor on the events socket (docs/BRAIN.md).";

export const cli = Cli.create("acta", {
  version: pkg.version,
  description: DESCRIPTION,
  sync: {
    depth: 1,
    suggestions: [
      "create a meeting called dev sync and be its brain",
      "which acta meetings are live right now?",
      "sync every ended meeting to ~/.acta and run the doctor",
    ],
  },
});

cli.command("new", {
  description: "Create a meeting. Answers the room URL to share by hand, the meeting id, and the events socket URL the brain arms Monitor on.",
  args: z.object({ title: z.string().describe("Meeting title (quote it)") }),
  options: z.object({
    keywords: z.string().optional().describe("Comma-separated vocabulary for the transcriber: names and project words it cannot guess from sound. Up to 200 are accepted; ten to thirty well-chosen ones beat a long list"),
  }),
  // incur renders example values verbatim, so the quotes a shell needs are part of the value.
  examples: [
    { args: { title: '"dev sync"' }, description: "Mint a meeting" },
    { args: { title: '"lore review"' }, options: { keywords: "lore,acta,Scribe" }, description: "With vocabulary for the transcriber" },
  ],
  hint: "The session that runs this is the meeting's brain: arm Monitor on `<events>?token=<ACTA_TOKEN>` (ws source, 30-minute timeout, re-arm on expiry) and write the book with `acta book put`. docs/BRAIN.md is the runbook.",
  run: (c) => createMeeting(c.args.title, c.options.keywords),
});

cli.command("meetings", {
  description: "List meetings with their Scribe state (idle, live, ending, ended). Deploy only when `live` is 0.",
  run: () => listMeetings(),
});

cli.command("tail", {
  description: "Follow a meeting's events socket, the feed the brain's Monitor sees: hello, started, participant, agent, paragraphs (a digest, at most one a minute), book, ended; exits 0 on `ended`. The brain's manual fallback when Monitor is unavailable.",
  args: z.object({ id: z.string().describe("Meeting id (from `acta new`)") }),
  options: z.object({
    frames: z.boolean().optional().describe("Yield each frame as its object instead of readable lines (`--format jsonl` for one JSON object per frame)"),
    each: z.boolean().optional().describe("One `paragraph` frame per paragraph as it closes, instead of the one-a-minute `paragraphs` digest (for watching live)"),
  }),
  hint: "A digest is at most one frame a minute; `--each` is a line per paragraph as it closes (a few hundred an hour with three people). Reconnects with backoff after a drop; a late connect still receives `ended`.",
  async *run(c) {
    const it = follow(c.args.id, { each: c.options.each });
    for (;;) {
      const n = await it.next();
      if (n.done) return n.value.ok ? c.ok(undefined) : c.error({ code: "NO_SOCKET", message: n.value.reason, retryable: true });
      yield c.options.frames ? n.value : frameLine(n.value);
    }
  },
});

const book = Cli.create("book", {
  description: "The meeting's book: Markdown sections the brain writes and the room reads beside the video.",
});

book.command("put", {
  description: "Replace one book section with Markdown from a file or stdin. The room sees the change at once; the events socket emits a `book` frame.",
  args: z.object({
    id: z.string().describe("Meeting id"),
    section: WritableBookSectionSchema.describe(`One of ${WritableBookSectionSchema.options.join(", ")} (transcript is generated)`),
    file: z.string().optional().describe("Markdown file; `-` or omitted reads stdin"),
  }),
  examples: [
    { args: { id: "<id>", section: "summary", file: "summary.md" }, description: "From a file" },
    { args: { id: "<id>", section: "decisions", file: "-" }, description: "From stdin" },
  ],
  hint: "Sections are Markdown without their own H2.",
  run: (c) => putSection(c.args.id, c.args.section, c.args.file),
});

book.command("show", {
  description: "Print the book as Markdown: every section, or one with --section.",
  args: z.object({ id: z.string().describe("Meeting id") }),
  options: z.object({ section: BookSectionSchema.optional().describe(`One of ${BOOK_SECTIONS.join(", ")}`) }),
  run: (c) => showBook(c.args.id, c.options.section),
});

cli.command(book);

cli.command("export", {
  description: "Export a meeting as Markdown (book + transcript) to stdout or a file.",
  args: z.object({ id: z.string().describe("Meeting id") }),
  options: z.object({ out: z.string().optional().describe("Write to this file instead of answering the Markdown") }),
  alias: { out: "o" },
  hint: "Never write an export inside the repo: meeting data does not enter it.",
  run: (c) => exportMeeting(c.args.id, c.options.out),
});

cli.command("sync", {
  description: "Copy a meeting's R2 files (or every meeting's) to ~/.acta/meetings/<id>/, skipping same-size files. One row per meeting as it lands.",
  args: z.object({ id: z.string().optional().describe("Meeting id; omitted syncs every listed meeting") }),
  hint: "ACTA_HOME overrides ~/.acta. Exit 1 when any meeting failed (the others still sync).",
  async *run(c) {
    const it = syncMeetings(c.args.id);
    for (;;) {
      const n = await it.next();
      if (n.done) {
        const { root, failed } = n.value;
        if (failed.length) return c.error({ code: "SYNC_FAILED", message: `${failed.length} meeting(s) failed: ${failed.join(", ")}`, retryable: true });
        return c.ok(undefined, { cta: { description: `Synced under ${root}.`, commands: ["doctor"] } });
      }
      yield n.value;
    }
  },
});

cli.command("copy", {
  description:
    "Copy a meeting's recording from RealtimeKit into R2 now: Scribe re-reads the recording record and fetches every track not already there. " +
    "The webhook does this on its own after a meeting; this is the recovery when `acta doctor` lists a recording as not copied (vendor copies expire in seven days). " +
    "`acta sync` is the other direction, R2 to ~/.acta.",
  args: z.object({ id: z.string().describe("Meeting id") }),
  examples: [{ args: { id: "<id>" }, description: "Fetch what doctor listed" }],
  hint: "Exit 1 when the meeting has no recording, the vendor lists no files yet, or a track failed to copy. `pending` rows are retried by Scribe's alarm.",
  async *run(c) {
    const r = await copyRecording(c.args.id);
    yield r;
    if (r.files === 0) return c.error({ code: "NO_FILES", message: `recording ${r.recording.id} is ${r.recording.status} and lists no files yet`, retryable: true });
    if (r.failed.length) return c.error({ code: "COPY_FAILED", message: `${r.failed.length} file(s) failed: ${r.failed.join(", ")}`, retryable: true });
    return c.ok(undefined, { cta: { description: `${r.copied} of ${r.copies.length} in R2.`, commands: ["doctor", `sync ${c.args.id}`] } });
  },
});

cli.command("transcribe", {
  description:
    "The batch pass over a synced meeting's per-speaker tracks: a second transcript with word timings, in the live row shape with `engine` set, to transcripts/<engine>.jsonl under ~/.acta/meetings/<id>/ and in R2. " +
    "whisper runs on Workers AI through the Worker (the track is already in R2; metered, about $0.0005 per audio minute); parakeet runs locally through parakeet-mlx (free; `uv tool install parakeet-mlx`, ffmpeg).",
  args: z.object({ id: z.string().describe("Meeting id, already synced (`acta sync <id>`)") }),
  options: z.object({
    engine: EngineSchema.describe("whisper (Workers AI, remote) or parakeet (local, MLX)"),
    language: z.string().optional().describe("whisper: force the language (`es`); omitted, Whisper detects it per track"),
    noPrompt: z.boolean().optional().describe("whisper: leave the meeting's keywords out of the prompt"),
    concurrency: z.coerce.number().int().min(1).max(6).default(3).describe("whisper: tracks in flight at once"),
    local: z.boolean().optional().describe("Write the files locally only, no copy to R2"),
    track: z.string().optional().describe("Only this track (file name under recordings/, repeatable as a comma list)"),
  }),
  examples: [
    { args: { id: "<id>" }, options: { engine: "whisper", language: "es" }, description: "Whisper, Spanish, keywords as the prompt" },
    { args: { id: "<id>" }, options: { engine: "parakeet" }, description: "Parakeet on this machine" },
  ],
  hint: "One row per track as it lands, then the summary (rows, wall time, USD, peak memory for a local engine). Whisper runs with VAD on: a per-speaker track is mostly silence, and Whisper hallucinates on silence without it. Exit 1 when a track failed; the others still land. Then `acta compare <id>`.",
  async *run(c) {
    const it = transcribeMeeting(c.args.id, {
      engine: c.options.engine,
      language: c.options.language,
      noPrompt: c.options.noPrompt,
      concurrency: c.options.concurrency,
      local: c.options.local,
      tracks: c.options.track ? c.options.track.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    });
    for (;;) {
      const n = await it.next();
      if (n.done) {
        const s = n.value;
        yield s;
        if (s.failed.length) return c.error({ code: "TRACKS_FAILED", message: `${s.failed.length} track(s) failed: ${s.failed.join(", ")}`, retryable: true });
        return c.ok(undefined, { cta: { description: `${s.rows} rows from ${s.tracks} track(s) in ${s.dir}.`, commands: [`compare ${c.args.id}`] } });
      }
      yield n.value;
    }
  },
});

cli.command("doctor", {
  description: "Check the Worker, then list meetings ended without their recordings in R2 or live for more than 3 h. Exit 1 when anything is listed. `acta copy <id>` fetches a listed recording.",
  async *run(c) {
    const r = await doctorReport();
    yield r;
    if (!r.worker.ok) return c.error({ code: "WORKER_DOWN", message: `${r.worker.url} answered ok=false`, retryable: true });
    if (r.problems.length) return c.error({ code: "NEEDS_ATTENTION", message: `${r.problems.length} problem(s): ${r.problems.map((p) => `${p.id} ${p.problem}`).join("; ")}` });
    return c.ok(undefined);
  },
});

cli.command("test", {
  description: "End-to-end check with synthetic speakers: fresh meeting, WAV voices through headless Chromium, assertions on what Scribe stored. Exit 1 when a required check fails.",
  options: z.object({
    fixture: z.string().optional().describe("Scripted dialogue (default test/synth/fixtures/two-speakers.json)"),
    keep: z.boolean().optional().describe("Do not end the meeting: answer the room URL and keep the bots in it until Ctrl-C"),
    relayPort: z.coerce.number().int().min(0).default(0).describe("Port for the local relay the bots report to (0 = any free port)"),
    audio: z.enum(AUDIO_MODES).default("mic").describe("mic: Chromium fake mic plays the WAV; file: the page plays it via WebAudio as a custom track"),
    bot: z.enum(BOT_MODES).default("local").describe("Load the bot page from the local relay, or from the Worker's /synth/bot"),
    timeout: z.coerce.number().positive().default(180).describe("Give up waiting for `ended` this many seconds after launch (then POST /end)"),
  }),
  hint: "Needs macOS `say`, ffmpeg/ffprobe and a Playwright Chromium (or ACTA_CHROME). Required checks: every speaker ≥1 final; attribution (text ↔ speaker); the backchannel is an aside; t1 order; utterances.jsonl in R2; `ended` without forcing. Extra checks (speaker change, overlap, lines heard) warn only. The run log is on stderr; the report is the answer.",
  async *run(c) {
    const it = runTest({
      fixture: c.options.fixture,
      keep: c.options.keep === true,
      relayPort: c.options.relayPort,
      audio: c.options.audio,
      bot: c.options.bot,
      timeout: c.options.timeout,
    });
    for (;;) {
      const n = await it.next();
      if (n.done) {
        const { failed, meetingId } = n.value;
        return failed
          ? c.error({ code: "CHECKS_FAILED", message: `${failed} required check(s) failed · meeting ${meetingId}` })
          : c.ok(undefined, { cta: { description: `PASS · meeting ${meetingId}`, commands: [{ command: "export", args: { id: meetingId } }] } });
      }
      yield n.value;
    }
  },
});

cli.command("compare", {
  description:
    "Compare a synced meeting's transcripts: the live rows (utterances.jsonl, nova-3) against each batch pass in transcripts/ (whisper, parakeet). " +
    "Per engine and per speaker: rows, words, speech seconds; per engine, wall time, cost and peak memory from the run file; per pair of engines, token agreement on rows of the same peer that overlap in time; " +
    "and the review list, lowest agreement then lowest confidence first (the review page's sampling order). Reads ~/.acta only.",
  args: z.object({ id: z.string().describe("Meeting id (synced with `acta sync <id>`)") }),
  options: z.object({
    limit: z.coerce.number().int().min(0).default(20).describe("Rows in the review list"),
  }),
  examples: [{ args: { id: "<id>" }, options: { limit: 50 }, description: "A longer review list" }],
  hint: "Agreement is the recall of a row's normalized tokens in the text of the other engine's rows of the same peer whose [t0, t1] meet within 2 s; not WER (no reference yet). Missing batch passes are skipped; a missing utterances.jsonl is exit 1 (run `acta sync <id>` and `acta transcribe <id> --engine …`). ACTA_HOME overrides ~/.acta.",
  run: async (c) => (await import("./commands/compare.ts")).compareMeeting(c.args.id, c.options.limit),
});

export default cli;
