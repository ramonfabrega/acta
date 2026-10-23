# The spike — evening one

Goal: three participants in the room with screen share for an hour, a book
that filled in while they talked, and a folder in the R2 bucket with three
audio tracks and the utterance JSONL. About $2.

## Settled in the first ten minutes (2026-10-23)

1. `language: "multi"` → **400 "Invalid language 'multi' for post-meeting
   transcription"** when `transcribe_on_end: true`; **201** with it false.
   Live nova-3 then transcribed Spanish and English in one breath
   ("Hola, hola, hola, prueba." … "lore, attrition, rise of nations.") with
   the keyword `lore` landing. Meetings are created without post-meeting
   Whisper; our batch pass over the tracks replaces it.
2. Prebuilt `<rtk-meeting>` from the CDN, no bundler: screen share worked
   first click (Chrome picker, nothing to configure). Served over Tailscale
   Serve HTTPS because `getUserMedia` needs a secure context.
3. Agent feed `transcript.received`: `started_at`/`ended_at` ISO to the
   second, `started_at` = server receipt (it advances with every partial),
   `ended_at` frequently later than wall-clock receipt. Not speech timing, no
   segment id; the client payload's `date` is also second-granular. Scribe
   keeps its own millisecond receipt clock for `t0`/`t1`.

Spike meeting: app `acta` (`276bc18e-…`), presets `human` and `agent`
created by API; 26 agent frames for 5 finals in 18 s of speech.

## Setup, in order

- [x] `bunx wrangler whoami` shows the right account (`2deff…08e2`).
- [x] RealtimeKit app `acta` on that account, `RTK_APP_ID` in vars. The
      Realtime-admin token lives in passage at
      `tokens/cloudflare/personal/acta/rtk-admin`; `wrangler secret put
      RTK_API_TOKEN` from there.
- [x] Presets: `human` with `permissions.transcription_enabled: true`;
      `agent` with `permissions.hidden_participant: true` and no media.
- [ ] Webhook pointing at `https://<hostname>/hooks/rtk`, secret as
      `WEBHOOK_SECRET`. Subscribe to meeting, participant, recording and
      transcript events.
- [ ] R2 bucket named as in `wrangler.jsonc`.
- [ ] Cloudflare Access application on the hostname, your identity provider,
      a policy allowlisting the participants' emails. Put the team domain
      and AUD in vars; the Worker verifies the JWT and uses the email as
      identity.
- [ ] Workers Builds connected to the GitHub repo; push to `main` deploys.
- [ ] `bun run tail` in a terminal for the whole evening.

## A meeting, end to end

1. `acta new "dev sync"`, run by the Claude Code session that will be the
   brain, which then shares nothing but a URL. The Worker creates the
   meeting (`ai_config.transcription` with `multi` and the keywords,
   `transcribe_on_end: false`, no `record_on_start`,
   `session_keep_alive_time_in_secs: 60`), adds the agent participant,
   stores its token in Scribe, and answers with the room link.
2. Scribe opens the agent socket at once, `subscriptions=transcript,participant`.
3. A human opens the link, passes Access, the Worker mints a `human` token
   for that email and renders the room with the book pane beside it. On the
   first `participant.join`, Scribe starts track recording.
4. Finals arrive. Scribe stores them, applies the paragraph rule, updates
   the book's transcript section, and emits one frame per closed paragraph
   on `/m/<id>/events`.
5. The brain, a Claude Code session in this repo started before the
   meeting, has armed Monitor on the events socket with the `EVENTS_TOKEN`.
   Each frame is a notification; it writes notes, decisions and action items
   into the book through `acta book put`; the room sees them land.
6. Last human leaves. Scribe closes the agent, writes `utterances.jsonl` to
   R2, emits `ended`. The book stays at `/m/<id>/book`; `acta export` is
   the way out.
7. Webhooks: `recording.statusUpdate` and `meeting.transcript` arrive within
   the hour with 7-day URLs. Scribe streams each file into R2 under
   `meetings/<id>/`.
8. Later, `acta sync` on a local machine pulls the meeting to
   `~/.acta/meetings/<id>/`. Batch passes and lore start there.

## What can bite

- The agent joining late loses the opener. Join at creation, not first
  human.
- A redeploy mid-meeting drops words (5 s resume grace). Deploy between
  meetings.
- `record_on_start` is the composite recording, and it starts on the
  **agent's** join: the spike's first meeting uploaded a recording of one
  hidden participant and silence. Per-track is the explicit
  Start-track-recording call on the first human join.
- `participant.join` can arrive twice for one `peer_id` (seen live, 107 s
  apart, no leave between). Key everything on `peer_id`, idempotently.
- The agent feed's timestamps are second-granular server clocks. The
  paragraph rule's 1.5 s and 2 s thresholds run on Scribe's own receipt
  clock; precise timing comes from the batch pass over stored tracks.
- Browsers: first join in Firefox hung on "joining" (error 0014) until mic
  and camera permissions were granted; the kit's right sidebar (participants,
  chat, transcript) did not open there. Chrome is the tested path.
- A hidden agent still bills and keeps the session alive. Close it on the
  last leave or the meeting never ends.
- Recordings cannot be delivered to R2 directly. The webhook copy is the
  path; a missed webhook means a lost recording after seven days, so
  `acta doctor` lists meetings whose copy has not landed.
- The events feed must stay sparse. Interims never leave Scribe.

## Fallback

If the room is not stable by meeting time, the meeting happens where it
would have anyway and nothing is lost but an evening. Do not ship a
half-working room to colleagues; the second invitation is harder than the
first.
