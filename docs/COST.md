# What a meeting costs, and the two levers

Written 2026-10-23 evening, after the batch spike (`docs/BATCH.md`) put a
measured number on each part of meeting 1 (3 humans, 61 min in the room,
174 track-minutes). Prices are from `docs/DESIGN.md`; "measured" means the
account's own analytics or a run said so.

| part | USD | share | how known |
| --- | --- | --- | --- |
| nova-3 live, 174 connected minutes | $1.60 | 64% | measured: 836.36 neurons/min on `@cf/deepgram/nova-3-ws` |
| track recording export | $0.52 | 21% | list, $0.003/min audio export; which rate applies unverified |
| participants, 3 humans A/V + agent | $0.40 | 16% | list |
| Whisper batch pass | $0.09 | | measured |
| Durable Object, R2, Worker | cents | | |
| **per meeting** | **≈ $2.50** | | |

Per person-hour that is about $0.83. A weekly hour is $10 a month; a daily
huddle about $50. Hosted note-takers run about $14 a seat a month ($42 for
three) with neither the recording nor per-speaker tracks. The price is
acceptable; the shape of it is not: nova-3 bills every connected minute of
every human, and Whisper's VAD found 56 minutes of speech in the 174. About
$1.05 of the $1.60 paid for silence.

## Lever 2: recordings straight into our R2

**Today:** RealtimeKit records each track into its own bucket, signs a
7-day URL, and Scribe copies the file into `acta-meetings` from the
`recording.statusUpdate` webhook (`acta copy` is the recovery). Billed as
export minutes.

**The docs (checked 10-23):** the Start Recording API takes
`storage_config` with `type: "cloudflare"`, an R2 access key and secret,
`bucket`, `path`, `account_id` (custom-cloud-storage guide, May 2026), and
`realtimekit_bucket_config: {enabled: false}` turns the vendor copy off.
The dashboard's Recordings → Setup Storage sets the same for every
meeting. The track-recording page documents neither field; whether
`POST /recordings/track` honours `storage_config` is the question the
live probe answers. The price list has "Export (Raw RTP) into R2
$0.0005/min" against "$0.003/min audio export"; which line a track
recording lands on is still only readable off the bill.

**Probed live (10-23):** `POST /recordings/track` rejects the field.
With `storage_config` (dummy keys, then hex-shaped keys, then with
`realtimekit_bucket_config: {enabled: false}` too) the answer is `400
Request validation failed`, `unrecognized_keys: 'storageConfig'` (the
validator reports the camelCase name it maps to), the same answer a made-up
field gets. The composite endpoint `POST /recordings` accepts the same
`storage_config` body (`200`, `storage_config: null` echoed until upload).
So direct-to-R2 exists for composite recordings and not for track
recordings, and the webhook copy stays. The plumbing that passed the
config from Scribe was reverted the same evening; nothing ships for this.
Still untested: the dashboard's Recordings → Setup Storage, which the
custom-storage guide says applies to "all meetings". If it also covers
track recordings, that is a dashboard setting on the operator's side, no
code, and one test meeting shows it; the R2 key then never touches our
Worker, which is the better shape anyway.

**What it would have bought:** the recording row from $0.52 to $0.09 if
the raw-RTP rate applies (still unverified, bill only), and the end of the
seven-day race. The race is already handled by the webhook copy plus `acta
doctor`, so the lever is worth the dashboard test and nothing more.

## Lever 1: own the audio stream, pay nova-3 for speech only

**The idea:** hold each human's audio ourselves, gate it with VAD, and
stream only speech to the same nova-3 WebSocket on Workers AI. Same model,
same `multi`, about $0.52 instead of $1.60, plus language per utterance
and the choice of engine per meeting.

**What the platform offers (checked 10-23):**

- The RealtimeKit **agent participant** receives transcripts, joins and
  broadcasts only. Audio, video and chat are "planned". Our Scribe agent
  cannot hear the room.
- The Realtime SFU **WebSocket adapter** does exactly what we want: the SFU
  connects out to a `wss://` endpoint (a Durable Object works) and sends
  PCM, 48 kHz stereo s16le in protobuf packets under 32 KB, one adapter per
  track, egress at the Realtime rate ($0.05/GB after 1,000 GB a month free;
  three PCM tracks for an hour are about 2 GB, so pennies). But it is
  created with the **SFU app secret** against a **publisher session id and
  track name**, and RealtimeKit exposes neither for its meetings. The
  adapter is for apps built directly on the SFU.
- The **custom recording app**: Start Recording accepts a `url`; RealtimeKit
  launches a Cloudflare container with Chrome, loads our page with a
  recorder token (`recorder_preset_v2`), and our page joins as a hidden
  participant with the Core SDK. From there each remote participant's
  `audioTrack` is a `MediaStreamTrack`: an AudioWorklet can turn it into
  PCM and a WebSocket can carry it to Scribe. Billed as export minutes,
  which we pay already for the recording; participant minutes are not
  charged for the recorder. This is the one path to the audio today, and
  it would also let the page write the per-track webm itself.

**Verdict for now:** the adapter path is closed on RealtimeKit, so lever 1
is not a Durable Object spike, it is a custom recording app: a browser
page we host, run by RealtimeKit's recorder, that fans PCM out to Scribe
(or straight to nova-3 from the page). It is a real build, a day or two,
with its own questions: whether the recorder container keeps up with three
AudioWorklets and WebSockets for an hour, whether the composite recorder
bills $0.003 (audio) or $0.010 (video) a minute when our page renders no
video, and how its lifetime (it starts when we call Start Recording, stops
with the session) matches the agent's. The saving is about $1.05 a meeting;
at a weekly meeting that is $4 a month, so this waits for either daily use
or the agent gaining audio, which the capability matrix marks as planned.

## Lever 0: things not worth doing

- Audio-only presets for the humans ($0.0005 instead of $0.002 a minute)
  would quarter the participant line but drop video and screen share.
- A GPU box for live transcription costs on the order of $100 a month or
  $0.40–0.80 an hour on demand and only beats $0.52 a meeting past about
  200 meetings a month. A CPU box cannot hold three live streams of a large
  model.
- The operator's Mac as the live engine: $0 but the Mac must be awake for
  every meeting, local streaming Whisper adds 2–5 s and brings the language
  problem back. An option once lever 1 exists, never the default.
- Batch only (drop live, brain writes after the meeting from Whisper rows):
  $0.09 plus participants and recording, and no live book. The floor, and
  not what the product is.
