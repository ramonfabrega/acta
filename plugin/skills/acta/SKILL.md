---
name: acta
description: Own a meeting with the acta CLI — mint a RealtimeKit room (`acta new`), be its brain (arm Monitor on the events socket, write the live book with `acta book put`), follow its events, export the book and transcript as Markdown, sync recordings to ~/.acta and run the doctor. Use when the user mentions acta, a meeting room, the book, Scribe, or asks to host, transcribe or take notes in a meeting.
---

# acta

The CLI for acta: a RealtimeKit room with per-speaker transcripts, a Durable
Object (Scribe) that turns them into a live **book**, and recordings copied
into R2. Run it as `acta` (after `bun link` in the repo) or
`bun cli/acta.ts` from the repo root. Every answer is data (TOON by
default; `--json`, `--format yaml|md|jsonl`); errors carry the server's
own message; exit 0 on success, 1 on any failure.

- `ACTA_URL`: the Worker (default `https://acta.ramonfabrega.com`).
- `ACTA_TOKEN`: the operator bearer; when unset the CLI reads
  `passage show tokens/cloudflare/personal/acta/acta-token`. Never print it.

## The brain

The session that runs `acta new` is the meeting's brain, on subscription,
never an API key. The acta plugin's hook answers `acta new` with the exact
Monitor call; without the hook, build it yourself from the `events` URL the
command answers and the token from passage:

```
Monitor({ ws: { url: "wss://acta.ramonfabrega.com/m/<id>/events?token=<ACTA_TOKEN>" },
          description: "acta <id> events", timeout_ms: 1800000 })
```

Arm it before anyone joins. Each frame is one notification (hello, started,
participant, paragraph, book, ended), twenty to forty an hour. Re-arm on
every expiry notice (every 30 minutes) until the `ended` frame; `acta tail
<id>` under /loop is the fallback when Monitor is unavailable. Read the book
before writing it (`acta book show`), write sections with `acta book put`,
and never put meeting data in the repo. The runbook is `docs/BRAIN.md`.
The sections below are the command table, generated from the CLI.

## acta book

The meeting's book: Markdown sections the brain writes and the room reads beside the video.

### acta book put

Replace one book section with Markdown from a file or stdin. The room sees the change at once; the events socket emits a `book` frame.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Meeting id |
| `section` | `string` | yes | One of summary, decisions, actions, notes (transcript is generated) |
| `file` | `string` | no | Markdown file; `-` or omitted reads stdin |

#### Examples

```sh
# From a file
acta book put <id> summary summary.md

# From stdin
acta book put <id> decisions -
```

> Sections are Markdown without their own H2.

### acta book show

Print the book as Markdown: every section, or one with --section.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Meeting id |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--section` | `string` |  | One of summary, decisions, actions, notes, transcript |

## acta copy

### acta copy

Copy a meeting's recording from RealtimeKit into R2 now: Scribe re-reads the recording record and fetches every track not already there. The webhook does this on its own after a meeting; this is the recovery when `acta doctor` lists a recording as not copied (vendor copies expire in seven days). `acta sync` is the other direction, R2 to ~/.acta.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Meeting id |

#### Examples

```sh
# Fetch what doctor listed
acta copy <id>
```

> Exit 1 when the meeting has no recording, the vendor lists no files yet, or a track failed to copy. `pending` rows are retried by Scribe's alarm.

## acta doctor

### acta doctor

Check the Worker, then list meetings ended without their recordings in R2 or live for more than 3 h. Exit 1 when anything is listed. `acta copy <id>` fetches a listed recording.

## acta export

### acta export

Export a meeting as Markdown (book + transcript) to stdout or a file.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Meeting id |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--out` | `string` |  | Write to this file instead of answering the Markdown |

> Never write an export inside the repo: meeting data does not enter it.

## acta meetings

### acta meetings

List meetings with their Scribe state (idle, live, ending, ended). Deploy only when `live` is 0.

## acta new

### acta new

Create a meeting. Answers the room URL to share by hand, the meeting id, and the events socket URL the brain arms Monitor on.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | `string` | yes | Meeting title (quote it) |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--keywords` | `string` |  | Comma-separated vocabulary for the transcriber: names and project words it cannot guess from sound. Up to 200 are accepted; ten to thirty well-chosen ones beat a long list |

#### Examples

```sh
# Mint a meeting
acta new "dev sync"

# With vocabulary for the transcriber
acta new "lore review" --keywords lore,acta,Scribe
```

> The session that runs this is the meeting's brain: arm Monitor on `<events>?token=<ACTA_TOKEN>` (ws source, 30-minute timeout, re-arm on expiry) and write the book with `acta book put`. docs/BRAIN.md is the runbook.

## acta sync

### acta sync

Copy a meeting's R2 files (or every meeting's) to ~/.acta/meetings/<id>/, skipping same-size files. One row per meeting as it lands.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | no | Meeting id; omitted syncs every listed meeting |

> ACTA_HOME overrides ~/.acta. Exit 1 when any meeting failed (the others still sync).

## acta tail

### acta tail

Follow a meeting's events socket: one line per frame (hello, started, participant, paragraph, book, ended); exits 0 on `ended`. The brain's manual fallback when Monitor is unavailable.

#### Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `string` | yes | Meeting id (from `acta new`) |

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--frames` | `boolean` |  | Yield each frame as its object instead of a readable line (`--format jsonl` for one JSON object per frame) |

> Frames are sparse (20-40 an hour). Reconnects with backoff after a drop; a late connect still receives `ended`.

## acta test

### acta test

End-to-end check with synthetic speakers: fresh meeting, WAV voices through headless Chromium, assertions on what Scribe stored. Exit 1 when a required check fails.

#### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--fixture` | `string` |  | Scripted dialogue (default test/synth/fixtures/two-speakers.json) |
| `--keep` | `boolean` |  | Do not end the meeting: answer the room URL and keep the bots in it until Ctrl-C |
| `--relayPort` | `number` | `0` | Port for the local relay the bots report to (0 = any free port) |
| `--audio` | `string` | `mic` | mic: Chromium fake mic plays the WAV; file: the page plays it via WebAudio as a custom track |
| `--bot` | `string` | `local` | Load the bot page from the local relay, or from the Worker's /synth/bot |
| `--timeout` | `number` | `180` | Give up waiting for `ended` this many seconds after launch (then POST /end) |

> Needs macOS `say`, ffmpeg/ffprobe and a Playwright Chromium (or ACTA_CHROME). Required checks: every speaker ≥1 final; attribution (text ↔ speaker); the backchannel is an aside; t1 order; utterances.jsonl in R2; `ended` without forcing. Extra checks (speaker change, overlap, lines heard) warn only. The run log is on stderr; the report is the answer.
