# The spike — evening one

Goal: three participants in the room with screen share for an hour, a book
that filled in while they talked, and a folder in the R2 bucket with three
audio tracks and the utterance JSONL. About $2.

## Settle these in the first ten minutes

1. Create a meeting with `ai_config.transcription.language: "multi"`. If the
   API rejects it, try a single language code. Mixed-language live
   transcription depends on this; the post-meeting Whisper pass auto-detects
   either way.
2. Open the prebuilt `RtkMeeting` in Chrome and share a screen. Only iOS is
   documented as needing setup.
3. Connect the agent socket and read one `transcript.received`: does it
   carry a timestamp? The client payload does (epoch ms).

## Setup, in order

- [ ] `bunx wrangler whoami` shows the right account, and the zone for the
      hostname in `wrangler.jsonc` lives there.
- [ ] RealtimeKit app on that account. Keep `RTK_APP_ID` in vars; the
      Realtime-admin API token as the `RTK_API_TOKEN` secret.
- [ ] Presets: `human` with `permissions.transcription_enabled: true`;
      `agent` with `permissions.hidden_participant: true`.
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
   meeting (`record_on_start`, `transcribe_on_end`, `summarize_on_end`,
   `summary_type: team_meeting`, low `session_keep_alive_time_in_secs`,
   `ai_config.transcription` with `multi` and the keywords), adds the agent
   participant, stores its token in Scribe, and answers with the room link.
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
- `record_on_start` is the composite recording. Per-track is the explicit
  Start-track-recording call on the first join.
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
