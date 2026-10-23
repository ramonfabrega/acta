# acta — design narrative

Three days of scouting (2026-10-22 → 23) before a line of code. This file
keeps the decisions and what they beat, so a later session does not
re-litigate them. Facts carry the date they were checked; vendor pages move.

## The problem as stated

A local-capture meeting plugin recorded the mixed audio of a call: it missed
the host's own voice and could not tell who was speaking. The hosted
note-takers have the same two weaknesses by construction and charge per
seat for about a dollar of inference. The operator speaks two languages,
often in the same sentence, says "mhm" a lot, hosts a small team's recurring
dev huddles, and wants a tool that gets used on day one.

## Decisions

**D1 — Per-speaker tracks by owning the room (10-22).** "Who said what" is a
model problem on a mixed signal and a plumbing problem with one track per
participant. Owning the room makes attribution a field. The cost is
adoption: only meetings the operator hosts. Accepted; the recurring huddles
are those meetings, and a link is easy to get colleagues into.
*Rejected:* a bot that joins a third-party meeting product (the Google Meet
Media API is developer-preview, needs every participant enrolled, sends
about three "relevant" streams); voiceprint diarization on a mixed track
(best-effort by construction).

**D2 — Record first, batch first; realtime is a UX layer (10-22).** The
audio is the immutable raw source, the transcript a derived artifact, the
notes the wiki tier. Realtime adds nothing to knowledge, and a batch
transcript is how a streaming one gets evaluated. *Rejected:* building
captions before recordings.

**D3 — Nova-3 is not a WER upgrade; it is a code-switching upgrade (10-22).**
On the Open ASR Leaderboard Parakeet-tdt-0.6b-v3 averages about 6.3% English
WER and Whisper large-v3 about 7.4%; nova-3 is not listed. Its edge is
word-level mid-sentence language switching, `keywords`, and streaming.
Locally on a current Apple-silicon desktop Parakeet runs about 100x realtime
and Whisper turbo 12 to 25x, so batch passes are free and local; nova-3 is
for live and for mixed-language speech. *Rejected:* fine-tuning Whisper on
code-switched speech (no corpus, prompting covers names).

**D4 — The brain stays in-sub (10-22).** Claude cannot ingest audio; neither
can Codex; Gemini can but is a different lane. So ASR is a tool and the
brain reads text. The notes loop is a Claude Code session, never an API key.
Workers AI and RealtimeKit are Cloudflare usage, not LLM billing.

**D5 — The room is Cloudflare, not a VPS or a home machine (10-23).** A home
box cannot host an SFU: media is UDP and Cloudflare Tunnel and Tailscale
Funnel carry only HTTP and WebSockets. A $5 VPS with LiveKit buys ops and a
Pion tree to read, nothing the meeting needs. *Rejected:* LiveKit on a VPS
(kept as the path if we ever want to read an SFU as code); a bespoke
Pion/str0m SFU.

**D6 — RealtimeKit over the SFU fork (10-23, reversed the same day's first
pick).** First pick was the official `video-room` example (Hono, one DO per
room, React, Access) plus the WebSocket media adapter, which went GA
2026-09-30 and pushes each participant's Opus track to a `wss://` endpoint as
48 kHz stereo s16le PCM in protobuf packets with sequence and timestamp. That
remains the right design when raw audio is needed live (local models). It
lost to RealtimeKit because the room is a commodity: screen share ships in
the UI kit, per-participant live nova-3 ships (`language: multi`,
`keywords`), track recording ships, and the Agent Participant delivers
`transcript.received` to our own Durable Object. Day-one use beat WebRTC
homework. *Rejected:* Orange / "Cloudflare Meet" as a fork base (Remix +
Drizzle + a Rust MLS worker, no transcription, no recording).

**D7 — A hidden agent socket, not browser forwarding (10-23).** Every browser
receives everyone's transcript events, so forwarding works in principle. It
loses to the agent because a tab sleeps or throttles and leaves a hole,
three browsers forward three copies and leader election is more code than a
bot, and the agent hears from the first second and survives reloads. The
agent is a WebSocket upgrade with a participant token: no browser, no
media, three cents an hour. It must join at creation and leave on the last
human's exit.

**D8 — Monitor, not /loop, is the trigger (10-23).** Precedent: a live
fantasy-draft assistant (2026-09) where a local `/ws` emitted three kinds of
sparse event and the session armed the harness Monitor on it; about 30
events for a draft, no polling, no missed trigger on record. Monitor has a
native `ws:` source; each frame is a notification; 30-minute arms,
re-armed. A loop is a timer that wakes whether or not anything happened.
The design cost is that the feed must be sparse, hence the paragraph rule.
*Rejected:* `/loop` as primary (kept as fallback); SSE polling; routing
events through a chat tool and back.

**D9 — The book lives in the app (10-23).** The brain's output is a Markdown
document per meeting owned by Scribe, rendered beside the video, pushed over
the WebSocket the page already holds. v0 the brain writes and humans read;
v1 adds comments and edits. The book is the home; chat tools, docs tools
and plain Markdown are exports, run by hand or by the brain when asked, so
v1 needs no chat integration at all: the brain's session mints the meeting
with `acta new` and the operator shares the link. *Rejected as the home:* a
docs product (not reachable from every session, and a foreign doc for a
first-party brain), a chat canvas, a hosted artifact (link-public), a loose
Markdown file.

**D10 — Backchannels do not close a turn (10-23).** A final of three words
or fewer, under about 2 s, from a non-floor-holder who does not take the
floor within 1.5 s, is an aside kept inline. Paragraphs close on real speaker
change, a 4 s gap, or a 120 s cap.

**D11 — Two-channel Mac capture stays as the second front end (10-22).**
ScreenCaptureKit system audio plus AVAudioEngine mic, two mono tracks on one
clock, in Swift. It is the path for meetings hosted on someone else's
product and shares the pipeline from the JSONL on. Not in the spike.

**D12 — lore is a source adapter, in lore (10-22).** Layer 1 of lore is
model-free and lore routes rather than operates. acta emits
`~/.acta/meetings/<id>/` (JSONL, tracks, book); lore's index reads it as a
session-shaped unit with speaker as an authorship field. lore supplies the
entity names for `keywords`. Precedent: lore's Codex rollouts adapter.

**D13 — Public from the first commit (10-23).** No meeting data, no keyword
list, no secrets in the tree. Access on the hostname is the gate, not
obscurity.

**D14 — Name (10-23).** `acta`, Spanish for the minutes of a meeting.
Considered: `opus` (the codec; clashes with Claude Opus), `silk` (Opus's
parent codec), `hansard`, `vorbis`.

## Facts checked (dates are check dates)

- Workers AI nova-3: $0.0052 per audio minute batch, $0.0092 over WebSocket
  (10-22). Whisper large-v3-turbo $0.0005. Free tier 10 min/day.
- RealtimeKit: audio participant $0.0005/min, audio-only export
  $0.003/min, raw RTP to R2 $0.0005/min; track recording GA 2026-05-28 as one
  WebM per participant; `user_ids` selection early beta; download URLs
  expire in 7 days; `storage_config` targets aws/gcs/azure/digitalocean/sftp
  with no S3 endpoint field, so R2 is reached by copying from the webhook,
  not by direct delivery (10-23).
- RealtimeKit transcription: `ai_config.transcription.language` with
  `multi` and `keywords`; interim results flagged `isPartialTranscript`;
  client payload has `timestamp` in epoch ms; post-meeting Whisper outputs
  CSV/JSON/SRT/VTT via `meeting.transcript` webhook; real-time bills 836.36
  neurons per audio minute. The Create-meeting API reference lists only
  `en-US, en-IN, de, hi, sv, ru, pl, el, fr, nl` (10-23) — the discrepancy
  with the transcription page is open item 1.
- Agent Participant: `wss://api.realtime.cloudflare.com/agent-ws/v1`,
  `Authorization: Bearer <participant token>`,
  `Sec-WebSocket-Protocol: realtimekit.v1`, subscriptions
  `transcript,participant,broadcast`, ping every 20 s, 5 s resume grace,
  10,000 unsent events buffer, receive-only today, token valid 100 days
  (10-23).
- Realtime SFU: egress $0.05/GB after 1,000 GB/month free, shared with TURN
  (10-23). WebSocket media adapter GA 2026-09-30; 1 to 4 tracks per create;
  15 s reconnect window; PCM is 48 kHz stereo s16le.
- Cloudflare Tunnel public hostnames carry HTTP/WebSocket only; WebRTC
  media (UDP) needs a public inbound port or a TURN relay.
- Monitor: `ws:` source, each text frame one event, arms up to 30 min,
  firehose suppressed (10-23).
- Hosted note-takers run about $14 per seat per month; a chat product's
  built-in huddle notes about $15 per seat; no chat API exposes huddle
  audio (10-22).
