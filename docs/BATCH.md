# The batch pass (queue item 4): plan and the numbers it answers

Written 2026-10-23 after the first live meeting and PR #7, before any code.
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

## The numbers to come out with

Meeting 1 as the yardstick (3 humans, 65 min, 174 track-minutes), at the
prices checked in `docs/DESIGN.md`:

| part | basis | ballpark | measured? |
| --- | --- | --- | --- |
| live nova-3 | 3 tracks × 61 min × $0.0092 | $1.70 | price yes, minutes yes |
| room participants (audio rate) | 4 × 65 min × $0.0005 | $0.13 | video rate unverified |
| track recording | 174 min × $0.003 (export rate) | $0.52 | which rate applies unverified |
| Durable Object, R2, Worker | | cents | |
| **live total** | | **≈ $2.40** | read the Cloudflare bill for 10-23 and replace this row |
| Whisper batch | 174 min × $0.0005 | $0.09 | spike |
| Parakeet batch | local | $0 | spike: wall time, memory |
| the brain | subscription | $0 | |

The decision the numbers serve: live transcription is three quarters of
the bill and exists for the live book. If the batch transcript is better
and the live book matters less than assumed, live transcription can go and
the brain writes the book after the meeting from the batch rows. If the
live book is the product, $1.70 an hour is the price of it. Either is
acceptable; the point is to know.

## Then

The review page (the ended room page grown: transcript with a play control
per paragraph seeking the right track at the right word, corrections as
`engine: "human"` rows, never edits), with the room UI rework folded in.
A typed "needs review" classifier only once human rows exist to validate
it against.
