# The batch pass (queue item 4): plan, the numbers it answered, what it found

Written 2026-10-23 after the first live meeting and PR #7, before any code;
the sections "Measured" and "The numbers" were filled the same evening from
the run on meeting 1 (`acta transcribe` × 2, `acta compare`).
The goal is two more transcripts of the same meeting from two more engines,
in the row shape Scribe already writes, so that (a) a replay page can seek
audio by word, (b) engines can be compared on real speech, and (c) every
part of a meeting has a measured cost and the live transcription can be
kept or dropped on numbers.

## What exists

`acta sync` leaves, per meeting, under `~/.acta/meetings/<id>/`:

- `recordings/<speaker>-<peer8>.webm`: one opus track (48 kHz, stereo)
  per peer. A speaker who reconnected has two tracks; meeting 1 has six for
  three people, split at minute 20.
- `utterances.jsonl`: the live rows, `engine: "nova-3"`, `t0`/`t1` in epoch
  ms from Scribe's receipt clock (not speech time: boundaries overlap the
  previous paragraph by about half a second, and a lost final can leave a
  stale `t0`; PR #7 bounds that, it does not make it speech time).
- `meta.json`: `participants[]` with `peerId` and `joinedAt`. A track's
  first sample is that peer's join, so **a word at `start` seconds into
  `<speaker>-<peer8>.webm` is at `joinedAt + start * 1000` epoch ms**.
  Verify once against the first live utterance of each track; the expected
  error is the vendor's recording start latency, under a second.
- `paragraphs.json`, `book.md`, `log.jsonl`.

## The two engines, where they run

| engine | runs | why there | cost |
| --- | --- | --- | --- |
| Whisper large-v3-turbo | Workers AI, called from the Worker (`env.AI`, the binding exists) on the track already in R2 | no new token, no download; the same call can later run from Scribe's copy webhook, so the batch pass becomes automatic | $0.0005 per audio minute (10-22); meeting 1's 174 track-minutes ≈ $0.09, before the free tier's 10 min/day |
| Parakeet tdt-0.6b-v3 (multilingual) | locally, through the MLX port, on the synced track | the operator agreement allows a local shell-out for batch transcription; about 100x realtime on this machine, a one-hour meeting in about a minute | free; about 1.2 GB of weights (bf16 safetensors) plus a few hundred MB of toolchain through uv; about 3 GB of memory while it runs |

Avoid the NeMo route for Parakeet (PyTorch, several GB). `uv` and
`ffmpeg`/`ffprobe` are installed; nothing else is. Both engines want 16 kHz
mono: decode the opus track with ffmpeg first.

Whisper on Workers AI takes the audio as base64 in the JSON body and
answers `text`, `segments[]` (each with `words[]` carrying `start`/`end`
in seconds) and a `transcription_info`; it takes `language`, an
`initial_prompt` (the place for the meeting's keywords, which meeting 1
showed nova-3 `multi` may ignore) and `vad_filter`. The Parakeet CLI
answers word timestamps too (`--output-format` json or srt; check
`--help`, the flag names are the port's). Measure, do not assume: request
size limits on a 17 MB track, whether a 40-minute track needs chunking,
and the real wall time of each.

## The verb

`acta transcribe <id> --engine whisper|parakeet` reads the tracks, writes
rows with the live shape and `engine` set, `t0`/`t1` from the formula
above, `conf` when the engine gives one, `lang` when it detects one, and
word timings kept beside the row (`words: [{w, t0, t1}]`, a field the live
rows do not have). Rows go to `transcripts/<engine>.jsonl` next to
`utterances.jsonl`, locally and in R2 (`utterances.jsonl` stays the live
record; one line per utterance holds per file; a merged view is the CLI's
job). Then `acta compare <id>`: per speaker and engine, utterances, words,
wall time, cost, and agreement between engines on rows that overlap in
time (token overlap, and WER once a reference exists). Low-confidence and
high-disagreement rows listed first: that list is the review page's
sampling order.

Bun-first, zod at the boundary of each engine's output, no `as X`. Nothing
from the meeting enters the repo: the spike runs on `~/.acta` and writes
there.

## Measured (2026-10-23, meeting 1, six tracks, 174.1 track-minutes)

What the verb does, as built: `acta transcribe <id> --engine whisper`
POSTs one track at a time to `/api/meetings/:id/transcribe`; the Worker
reads the webm from R2, base64-encodes it into the `env.AI.run` call
(`@cf/openai/whisper-large-v3-turbo`, `vad_filter: true`, the meeting's
keywords as `initial_prompt`, language detected unless `--language`), and
answers the model's segments with words. `--engine parakeet` decodes each
track to 16 kHz mono with ffmpeg and runs `parakeet-mlx` once over all of
them (`uv tool install parakeet-mlx`; `uvx` is the fallback). Both go
through `src/core/batch.ts`: words → rows cut on the word timings (a 1 s
gap, 0.4 s after sentence punctuation, a 20 s cap), `t0`/`t1` =
`joinedAt + seconds × 1000`, `words[]` beside each row, `conf` the mean of
the words' confidences (Whisper: e^avg_logprob of the segment; Parakeet:
its token confidence). Rows land in `transcripts/<engine>.jsonl`, the run
record in `<engine>.run.json`, locally and in R2 (`PUT
/api/meetings/:id/files/transcripts/:name`, the one writable path).

**Whisper on Workers AI.**

- Takes the raw opus webm as is: the 17.2 MB, 40.7-minute track went
  through in one call (base64 in the JSON body, no chunking). Six tracks at
  concurrency 3: 160 s wall; per track 25 s (20 min of jorge) to 102 s
  (41 min of ramon). Four concurrent calls on the same track were fine.
- **Without VAD it hallucinates on silence**, and a per-speaker track is
  mostly silence (speech is 9% of jorge's second track, 66% of ramon's
  first): "Thank you." every 30 s with language auto, "No, no." with `es`,
  and with the keyword prompt the prompt itself, looped ("JG, JG, JG…", 75
  times). `vad_filter: true` removed all of it and cut the call time by
  half. VAD'd word timings are restored to track time (checked against the
  live finals).
- Segments span VAD gaps (one covered 49 s to 819 s), so rows are cut on
  the word gaps, never on segments.
- **Bills the full track duration, not the speech VAD kept:** 9 spike calls
  over 201 track-minutes billed 9,326 neurons = 46.63 per minute. Meeting
  1's pass: 174.1 min, **$0.089**.
- Language is detected once per track (all six: `es`, p = 1). The English
  stretches of a code-switched meeting come back **translated into
  Spanish** (ramon said "my edit landed only seconds before he spoke"; the
  row reads "Mira, mi editor lanzó solo segundos antes de que", conf 0.17).
  `acta compare` lists exactly these rows first, which is the point of the
  review order. nova-3 `multi` is the only one of the three engines that
  keeps both languages.
- Words: live 9,684, Whisper 10,025 (same tokenizer). Token recall of a
  live row in the Whisper rows that overlap it in time: mean 0.68 over 924
  matched rows (152 live rows unmatched, 92 Whisper rows unmatched). The
  keyword prompt gives casing and names (Slack, Felipe, "red teaming").
  `conf` p50 0.77, 3 rows under 0.4 of 480.

**Parakeet tdt-0.6b-v3 locally (MLX).**

- First run 4.6 min including the weights (about 1.2 GB through uv); after
  that 41 min of audio in 39.5 s and the six tracks (174 min) in 108 s of
  model time (≈ 97× realtime), 137 s with the ffmpeg decodes. Peak memory
  footprint 6.0 GB for one 41-minute track, 10.8 GB for the six in one
  process (`/usr/bin/time -l`). $0.
- **It translates.** Half of its function words are English against 3% in
  the live rows and 2% in Whisper's: "Okay. The other is the Heroku
  Migration that we're going to mention." for "ok, lo otro es lo de Heroku
  Migration, que lo acabamos de mencionar". The port has no language flag.
  6,511 words of 9,684; token recall against the live rows 0.29. Out, for
  a Spanish-English meeting, until a build can pin the language.

**The time formula.** `joinedAt + start` holds to 0.5–3 s (the live
final's receipt lag) on the three tracks whose length matches the
participant's presence. The three first-half tracks are 18–27 s **shorter**
than the time their speaker was in the room, and the offset of their words
against the live finals grows along the track (ramon: 9 s in the first
third, 26 s in the last), so the recorder dropped time mid-track, not at
the start; neither start- nor end-anchoring fixes it. Seeking audio by word
needs a piecewise alignment of each track to its live finals (anchors every
few seconds, both from the same clock family), which is the review page's
first job, and the live rows are what make it possible.

## The numbers

Meeting 1 as the yardstick (3 humans, 61 min in the room, 174 track-minutes),
prices from `docs/DESIGN.md`, measured where the account's own analytics
or the run said so:

| part | basis | USD | measured? |
| --- | --- | --- | --- |
| live nova-3 | 174.1 min × 836.36 neurons × $0.011/1k | $1.60 | price and rate yes (GraphQL `aiInferenceAdaptiveGroups`, `@cf/deepgram/nova-3-ws`); the day billed $3.51 for 382 min including the spike and test meetings |
| room participants | 3 humans × 61 min × $0.002 (A/V preset) + agent 64 min × $0.0005 | $0.40 | price list; no usage API found, read the bill |
| track recording | 174 min × $0.003 (audio export) | $0.52 | which rate applies still unverified |
| Durable Object, R2, Worker | | cents | |
| **live total** | | **≈ $2.50** | the Workers AI part is measured, the RealtimeKit part is list price |
| Whisper batch | 174.1 min × $0.000513 | $0.09 | yes, run record + analytics; 160 s wall |
| Parakeet batch | local | $0 | yes: 108 s, 6.0–10.8 GB peak footprint |
| the brain | subscription | $0 | |

The decision the numbers serve, as it stands after the run: live nova-3
is two thirds of the bill and, besides being what the live book is written
from, it is the only engine here that keeps a code-switched meeting in its
two languages; Whisper at $0.09 is the word-timing layer and a second
opinion, not a replacement, until language per segment is solved;
Parakeet is out for this kind of meeting. Nothing is dropped yet; the
numbers say what each part buys.

## Then

The review page (the ended room page grown: transcript with a play control
per paragraph seeking the right track at the right word, corrections as
`engine: "human"` rows, never edits), with the room UI rework folded in.
Its first job is the per-track alignment above; its sampling order is
`acta compare`'s `review` list. A typed "needs review" classifier only once
human rows exist to validate it against. Open on the engines: Whisper with
a language per VAD chunk (or nova-3 batch, $0.0052/min, `multi`) for the
code-switched stretches; the Scribe copy webhook calling the same
`transcribe` route so the Whisper pass runs itself after every meeting.
