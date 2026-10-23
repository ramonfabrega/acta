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
  description: "Follow a meeting's events socket: one line per frame (hello, started, participant, paragraph, book, ended); exits 0 on `ended`. The brain's manual fallback when Monitor is unavailable.",
  args: z.object({ id: z.string().describe("Meeting id (from `acta new`)") }),
  options: z.object({
    frames: z.boolean().optional().describe("Yield each frame as its object instead of a readable line (`--format jsonl` for one JSON object per frame)"),
  }),
  hint: "Frames are sparse (20-40 an hour). Reconnects with backoff after a drop; a late connect still receives `ended`.",
  async *run(c) {
    const it = follow(c.args.id);
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

export default cli;
