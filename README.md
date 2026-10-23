# acta

Own the meeting. A video room for the people you can get into it, with every
speaker on their own track, a book that fills in while you talk, and the
recordings kept where you can re-read them when a better model comes along.

**Status: v0, deployed 2026-10-23.** A meeting can be minted, joined, spoken
in two languages, transcribed per speaker into paragraphs, and ends with
the utterances, the book and one audio track per participant in our own
R2. The plan, the decisions and the rejected alternatives are in
`docs/DESIGN.md`; the evening-one checklist and what it found is
`docs/SPIKE.md`; the shapes everything is built to are `docs/V0.md`. *Acta*
is Spanish for the minutes of a meeting.

## Why build this when meeting note-takers exist

The hosted note-takers sit on one mixed audio signal and guess who spoke. The
pieces are commodity: a 45-minute call between three people transcribes for
about a dollar. What none of them give you is the shape of the data: one
track per speaker so attribution is never a guess, two languages in the same
sentence, a correction loop that compounds into next week's vocabulary, a
brain that runs on your own Claude subscription instead of a metered key,
and transcripts you own and can index with [lore](https://github.com/ramonfabrega/lore).

## How it works

A meeting is minted from the CLI by the Claude Code session that will be
its brain, and the link is shared by hand; no chat integration is needed.
The room is Cloudflare RealtimeKit: WebRTC on Cloudflare's SFU, a prebuilt
meeting component with screen share, and per-participant live transcription
(Deepgram nova-3 on Workers AI, multilingual) plus per-track recording. A
hidden agent socket joins the room before anyone speaks and streams every
final utterance, with its speaker, into a Durable Object called **Scribe**.
Scribe keeps the utterances, closes them into paragraphs on real speaker
changes (an "mhm" is not a turn), writes the meeting's **book**, and emits
one sparse event per paragraph on a WebSocket.

The **brain** is a Claude Code session on subscription. It arms the harness
Monitor on Scribe's event socket and writes the book as paragraphs close:
notes, decisions, action items, the question it wants to ask about a word it
doesn't trust, with a link to that slice of the speaker's own track. The
book renders beside the video for everyone in the room. When the last
person leaves, Scribe copies the recordings and transcripts RealtimeKit would
delete after seven days into your own R2, and the local CLI syncs them down
for batch passes with other models and for lore to index. The book is the
home of the notes; chat tools, docs tools and plain Markdown are exports.

## What a meeting costs

| Line, one hour, three people | |
|---|---|
| nova-3 live, 180 track-minutes | about $1.66 |
| participants, recording export, R2 | cents |
| total | about $2 |

## Running it

```
bun install
bun run setup                 # presets, webhook, secrets check (idempotent)
bun run deploy                # or merge to main once Workers Builds is connected
acta new "dev sync"           # prints the room link; the session that ran it is the brain
acta tail <id>                # one line per paragraph; Monitor arms the same socket
acta book put <id> notes -    # the brain writes
acta test                     # two synthetic speakers, end to end, no humans needed
acta sync && acta doctor      # pull to ~/.acta/meetings, list what has not landed
```

`acta --llms` prints the whole command table. `ACTA_URL` and `ACTA_TOKEN`
configure the CLI; the token is the one operator bearer, kept in passage.

## Public repo

Meeting data never lives here: no audio, no transcripts, no books. The
keyword list (people's names and internal project names) is config, not
source, and is gitignored. Secrets go through `wrangler secret put`. Access
to the room is Cloudflare Access on the hostname, allowlisted by email.

## License

MIT.
