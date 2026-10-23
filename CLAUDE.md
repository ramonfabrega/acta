# acta

Own the meeting: a RealtimeKit room with per-speaker transcripts, a Durable
Object that turns them into a live **book**, a brain that is a Claude Code
session on subscription, and recordings copied into our own R2 before the
vendor deletes them. Seeded 2026-10-23 after three days of design scouting.
Decision narrative and rejected alternatives: `docs/DESIGN.md`.
First-evening checklist: `docs/SPIKE.md`.

Start a session with `bun cli/acta.ts --llms` (`acta --llms` after
`bun link`). This file is the map; `docs/V0.md` is the contract everything
is built to (routes, shapes, the paragraph machine, vendor facts measured
live); `docs/SPIKE.md` is the log of the first evening; `docs/DESIGN.md` the
decisions and what they beat. v0 is deployed; see README for the loop.

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
  `ai_config.transcription = { language: "multi", keywords }` and
  `transcribe_on_end: false` (the API rejects `multi` whenever post-meeting
  Whisper is on; our own batch pass is the post-meeting transcript). No
  `record_on_start`: it fires on the agent's lone join and records silence;
  Scribe starts per-track recording on the first human join. The page is
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
  harness **Monitor** (`ws:` source) on the events socket with `ACTA_TOKEN`
  and re-arms every 30 minutes; each paragraph event is a notification; it
  writes the book through the CLI. `/loop` is the fallback when Monitor is
  unavailable.
  Metered models (AI Gateway) only where a session is too slow: live
  caption translation, utterance tagging. Neither is v1.
- **CLI** (`cli/`): `acta new` (mints the meeting and prints the link to
  share by hand), `acta meetings`, `acta tail <id>`, `acta book put|show`,
  `acta export <id>` (Markdown; other targets later), `acta sync` (R2 →
  `~/.acta/meetings/<id>/`), `acta doctor`, `acta test` (synthetic
  speakers, end to end). Agent-first; `--llms` is generated from the
  command table. v0 ships a hand-rolled parser; the intended base is
  **incur**, which also generates per-verb skills (`acta skills add`), and
  porting to it precedes the plugin. The session that runs `acta new` is
  the meeting's brain: it already holds the id when it arms Monitor.
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
  is 5 seconds; a redeploy mid-meeting loses words. Workers Builds deploys
  every merge to `main`, so merging is deploying: `acta meetings` first.
- **Vendor copies expire in seven days.** Recordings and transcripts are
  ours only once they sit in the R2 bucket. The webhook handler is the
  copy, not a cron.

## The paragraph rule

A paragraph closes on a real speaker change, a gap of about 4 s, or a cap
near 120 s so a monologue still flows. A final from another speaker of three
words or fewer and under about 2 s, while the floor-holder continues within
1.5 s, is a **backchannel**: it stays in the JSONL as its own utterance and
appears inline in the paragraph text as a bracketed aside, and it does not
close the turn. Partials never leave Scribe but they do feed the rule: the
floor-holder's partials keep the turn open, and live partials give a speaker
a provisional floor before their first final. Events are sparse by design:
twenty to forty per hour. The harness suppresses a firehose.

## Data shape

One line per utterance, the contract between Scribe, the CLI, batch passes
and lore:

```json
{"t0":1761250000123,"t1":1761250003800,"speaker":"ana","userId":"u_…","peerId":"…","text":"…","lang":null,"final":true,"engine":"nova-3","conf":0.99}
```

`t0`/`t1` are epoch ms from Scribe's own clock (receipt of the first partial
and of the final); the vendor's timestamps are second-granular. `lang` is
`null` from nova-3 `multi`. `engine` is a row property: a Whisper or
Parakeet pass over the stored tracks adds rows for the same instants, which
is how models are compared on a real meeting.

## Conventions

- **Bun-first**, TypeScript, zod at every boundary (webhooks, agent events,
  env). Never `as X` on I/O.
- **Hono** on the Worker, one Durable Object class, R2 and AI bindings
  (`wrangler.jsonc`). Two secrets via `wrangler secret put`, never in vars:
  `RTK_API_TOKEN` (Realtime Admin) and `ACTA_TOKEN` (the one operator
  bearer for CLI, brain and events socket). Webhooks carry an RSA signature
  against RealtimeKit's published key; there is no webhook secret. The room
  link is a capability (`/m/<id>?k=…`); Access, when configured, is
  verified on top. The exact shapes are in `docs/V0.md`.
- **Web**: the prebuilt RealtimeKit component is the one earned dependency.
  Everything around it (the book pane, the join gate) is plain and small.
- **Tests** run `TZ=UTC bun test`. An instant is UTC; a day is local.
- Every push to `main` deploys (Workers Builds). Live-test with
  `bun run tail` open and a second browser or phone in the room.

## Settled by the spike (2026-10-23, live against the API)

1. `language: "multi"` is accepted and transcribes code-switched speech live,
   **only when `transcribe_on_end` is false**: the one `language` field is
   validated against Whisper's list when post-meeting transcription is on
   (`multi` and `es-419` rejected, `es` accepted, omitted accepted). The API
   reference enum is stale. We take `multi` and drop the vendor's Whisper and
   `summarize_on_end`; the brain writes the summary.
2. The agent feed's `transcript.received` has `started_at`/`ended_at` as ISO
   strings **to the second**; `started_at` is server receipt and `ended_at`
   is often in the future, so neither is speech timing, and there is no
   segment id. The client SDK payload has a stable per-utterance `id` and a
   `date` (ISO, second), not epoch ms. Scribe stamps `t0`/`t1` from its own
   clock: first partial and final per speaker, milliseconds.
3. Screen share in the web `RtkMeeting` needs no setup.
4. No documented or observed cap on `keywords` (four tested).

Also observed: the first join from a fresh page failed in the browser
("network may be blocking", Firefox error 0014) while the agent feed saw
`participant.join`; the retry connected and produced a second `join` with
the **same `peer_id`** and no `leave` between, so joins are not unique per
peer and handlers key on `peer_id` idempotently. Partials arrive two to four
times a second per speaker and must never leave Scribe; the agent feed and
the client feed see the same final within ~10 ms of each other.
