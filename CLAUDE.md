# acta

Own the meeting: a RealtimeKit room with per-speaker transcripts, a Durable
Object that turns them into a live **book**, a brain that is a Claude Code
session on subscription, and recordings copied into our own R2 before the
vendor deletes them. Seeded 2026-10-23 after three days of design scouting.
Decision narrative and rejected alternatives: `docs/DESIGN.md`.
First-evening checklist: `docs/SPIKE.md`.

Start a session with `acta --llms` once the CLI exists; until then this file
and the two docs are the whole truth.

## Thesis

**The room is a commodity. The data shape is the product.** Every meeting
tool guesses speakers off one mixed signal; owning the room gives one track
per speaker and makes attribution a field, never an inference. Everything
downstream is layered like lore: the audio is the immutable raw source, the
transcript is a derived artifact (rebuild beats migrate: a better model
re-transcribes every stored meeting), the book is the wiki tier. The brain
reads text, never audio, and runs where the operator's subscription runs.

## Architecture

- **Room**: Cloudflare RealtimeKit. Prebuilt `RtkMeeting` (screen share,
  mute, chat), one `human` preset with `transcription_enabled`, one `agent`
  preset with `hidden_participant`. Meetings are created with
  `record_on_start`, `transcribe_on_end`, `summarize_on_end`,
  `ai_config.transcription = { language: "multi", keywords }`. The page is
  served by the Worker on the hostname in `wrangler.jsonc`, behind
  Cloudflare Access.
- **Scribe**: one Durable Object per meeting (SQLite). Holds the agent
  socket to `wss://api.realtime.cloudflare.com/agent-ws/v1`
  (`subscriptions=transcript,participant`, ping every 20 s, resume id kept),
  stores finals, closes paragraphs, owns the book, emits sparse events on
  `/m/<id>/events`, receives the RealtimeKit webhooks, starts the per-track
  recording on the first human join, and on the last leave closes the agent,
  writes `utterances.jsonl` to R2, and copies recordings and transcripts
  from their 7-day URLs into R2.
- **Book**: Markdown sections in Scribe, served at `/m/<id>/book`, rendered
  beside the video, pushed to the room over the same WebSocket the page
  already holds. v0: the brain writes, humans read. v1: comments and edits.
  The book is the home; chat tools, docs tools and Markdown are exports the
  operator runs when wanted. No chat integration in v1.
- **Brain**: a Claude Code session in THIS repo, on subscription. It arms the
  harness **Monitor** (`ws:` source) on the events socket and re-arms every
  30 minutes; each paragraph event is a notification; it writes the book
  through the CLI. `/loop` is the fallback when Monitor is unavailable.
  Metered models (AI Gateway) only where a session is too slow: live
  caption translation, utterance tagging. Neither is v1.
- **CLI** (`cli/`, incur): `acta new` (mints the meeting and prints the
  link to share by hand), `acta meetings`, `acta tail <id>`, `acta book put`,
  `acta export <id>` (Markdown; other targets later), `acta sync` (R2 →
  `~/.acta/meetings/<id>/`), `acta doctor`. Agent-first; `--llms` is
  generated from the command definitions. The session that runs `acta new`
  is the meeting's brain: it already holds the id when it arms Monitor.
- **lore**: a source adapter on lore's side reads `~/.acta/meetings`; one
  meeting indexes as one session-shaped unit, speaker as an authorship
  field. lore also supplies the day-one `keywords` from the entity names it
  indexes. lore never transcribes and never calls RealtimeKit.

## Hard constraints

- **The brain is in-sub.** A Claude Code session, never an API key in the
  notes loop. Workers AI and RealtimeKit bill as Cloudflare usage and are
  fine; a Cloudflare API token is not an LLM key.
- **Meeting data never enters the repo.** No audio, transcripts, books or
  keyword lists committed; `meetings/` and `keywords.json` are ignored. The
  repo is public.
- **The agent joins before anyone speaks** and leaves when the last human
  does. It bills as a participant and keeps the session alive otherwise.
- **Deploys wait for the meeting to end.** The agent socket's resume grace
  is 5 seconds; a redeploy mid-meeting loses words.
- **Vendor copies expire in seven days.** Recordings and transcripts are
  ours only once they sit in the R2 bucket. The webhook handler is the
  copy, not a cron.

## The paragraph rule

A paragraph closes on a real speaker change, a gap of about 4 s, or a cap
near 120 s so a monologue still flows. A final from another speaker of three
words or fewer and under about 2 s, while the floor-holder continues within
1.5 s, is a **backchannel**: it stays in the JSONL as its own utterance and
appears inline in the paragraph text as a bracketed aside, and it does not
close the turn. Events are sparse by design: twenty to forty per hour. The
harness suppresses a firehose.

## Data shape

One line per utterance, the contract between Scribe, the CLI, batch passes
and lore:

```json
{"t0":1761250000123,"t1":1761250003800,"speaker":"ana","userId":"u_…","text":"…","lang":"es","final":true,"engine":"nova-3","conf":null}
```

`engine` is a row property: a Whisper or Parakeet pass over the stored
tracks adds rows for the same instants, which is how models are compared on
a real meeting.

## Conventions

- **Bun-first**, TypeScript, zod at every boundary (webhooks, agent events,
  env). Never `as X` on I/O.
- **Hono** on the Worker, one Durable Object class, R2 and AI bindings
  (`wrangler.jsonc`). Secrets via `wrangler secret put`, never in vars.
- **Web**: the prebuilt RealtimeKit component is the one earned dependency.
  Everything around it (the book pane, the join gate) is plain and small.
- **Tests** run `TZ=UTC bun test`. An instant is UTC; a day is local.
- Every push to `main` deploys (Workers Builds). Live-test with
  `bun run tail` open and a second browser or phone in the room.

## Open until the spike settles them

1. Whether the Create-meeting API accepts `language: "multi"` (the API
   reference lists ten codes without `es` or `multi`; the transcription docs
   say both work). Bilingual live transcription depends on it; post-meeting
   Whisper auto-detects regardless.
2. Whether the agent feed's `transcript.received` carries a timestamp (the
   client SDK payload does, in epoch ms).
3. Whether the web `RtkMeeting` needs any setup for screen share (only iOS
   is documented as special).
4. The cap on `keywords`.
