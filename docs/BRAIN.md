# The brain

The runbook for the Claude Code session that runs a meeting's notes. Read
it before the meeting, not during. CLAUDE.md says what the brain is; this
page says what it does, in order, and what it never does.

The brain is **the session that ran `acta new`**. It is a Claude Code
session on subscription: never an API key, never a Worker calling a model.
It reads text (the paragraph frames Scribe emits), never audio, and it
writes the **book**: four Markdown sections the room renders beside the
video. The harness **Monitor** is how it listens; the CLI is how it writes.

## Before the meeting

### 1. Mint the meeting

```sh
acta new "dev sync" --keywords "lore,acta,Scribe,Ana"
```

The answer carries `id`, `url` (the room link, a capability: share it by
hand), and `events` (the socket to arm). Keywords are the names and project
words the transcriber should spell right; lore supplies them when it is
wired, until then type the ones that matter.

### 2. Arm Monitor on the events socket

With the acta plugin installed, a hook answers `acta new` with the exact
call to make. Without it, build the call yourself: the URL is `events` from
the answer with the operator token as `?token=`, and the token comes from
passage at run time, never from a file in the repo.

```sh
passage show tokens/cloudflare/personal/acta/acta-token
```

```
Monitor({
  ws: { url: "wss://acta.ramonfabrega.com/m/<id>/events?token=<ACTA_TOKEN>" },
  description: "acta <id> events",
  timeout_ms: 1800000,
})
```

The first frame is `hello` (title, state, since). Arm before anyone joins:
the agent participant is already in the room from the moment the meeting
exists, and the first human join starts the per-track recording and the
`started` frame. The token is in the Monitor URL because Monitor cannot set
headers; it is in the transcript for the same reason. Do not print it
anywhere else, and do not write it into a file.

### 3. Re-arm every thirty minutes

A Monitor expires after `timeout_ms` (30 minutes is the maximum) and the
harness sends one expiry notice. On every such notice, before anything
else, issue the same Monitor call again. A late connect still receives
`ended`, and the transcript section of the book carries every paragraph so
far, so a gap costs nothing except the frames you did not react to:

```sh
acta book show <id> --section transcript
```

Stop re-arming after the `ended` frame.

### Fallback: no Monitor

When the Monitor tool is unavailable, `acta tail <id>` prints the same
frames one per line and exits 0 on `ended`; run it under `/loop` and read
its output on each tick. It reconnects with backoff after a drop.

## During the meeting

### The frames

Scribe emits twenty to forty frames an hour, and each one is a
notification:

| frame | when | what to do |
| --- | --- | --- |
| `hello` | on connect | confirm the id and title |
| `started` | the first human joined | nothing; the recording is on |
| `participant` | a join or a leave | note who is in the room |
| `paragraph` | a turn closed (speaker change, ~4 s gap, ~120 s cap) | read it; write when it changes the book |
| `book` | a section was written | nothing (it is your own write echoed) |
| `ended` | the last human left | the final pass, below |

A paragraph is `{speaker, t0, t1, text, asides}`. A backchannel ("mhm",
"sí") appears inline in the floor-holder's text as `[ben: mhm]`; it is not a
turn. Speakers are fields, never a guess: use the `speaker` names as they
are.

### Writing the book

Four writable sections, Markdown without their own H2 (the room adds the
heading), replaced whole on every write:

| section | holds | cadence |
| --- | --- | --- |
| `summary` | three to six sentences of where the meeting is | every few minutes, and at every topic change |
| `decisions` | one bullet per decision: what, who said it, `hh:mm:ss` | the moment one is made |
| `actions` | one bullet per action: owner, item, due date if said | the moment one is given |
| `notes` | everything else: open questions, numbers, a term you did not trust with its time and speaker | as they come |

```sh
acta book show <id>                       # read before writing
acta book put <id> decisions decisions.md # from a file
acta book put <id> summary - <<'EOF'      # from stdin
Ana opened with the pilot dates: Monday, three clients in Madrid …
EOF
```

Write a section when its content changed, not on every paragraph: a
paragraph that only continues a thought is read and kept in mind. Keep
your working notes in `$CLAUDE_JOB_DIR/tmp` or under `~/.acta`, never in
the repo. Write in the language the speakers used; a bilingual meeting gets
a bilingual book. v0 is write-only for the brain and read-only for humans;
when comments arrive (v1), read them before every write.

### Things the brain does not do

- It does not deploy. Merging to `main` deploys, and a redeploy mid-meeting
  loses words (the agent socket's resume grace is five seconds). `acta
  meetings` must show `live: 0` before any merge.
- It does not end the meeting. `POST /end` exists for `acta test`; a real
  meeting ends when the last human leaves.
- It does not transcribe, translate or tag with a metered model. Those are
  later passes, and none of them is v1.
- It does not commit meeting data. No audio, transcript, book or keyword
  list enters the repo.

## After the meeting

The `ended` frame carries the reason and the counts. Then, in order:

1. The final pass on `summary`, `decisions` and `actions`: read the whole
   transcript section once more and make the three sections stand on their
   own for someone who was not there.
2. Export and sync, outside the repo:

   ```sh
   acta export <id> --out ~/.acta/exports/<id>.md
   acta sync <id>        # recordings, utterances.jsonl, book, paragraphs → ~/.acta/meetings/<id>/
   acta doctor           # exit 1 lists what has not landed
   ```

   The recording copies land a minute or two after `ended` (the vendor
   uploads, then our webhook copies). `recording … not copied yet
   (UPLOADED)` right after the meeting is the copy in flight; the same line
   the next day is a problem, and after seven days the vendor's copy is
   gone. `acta copy <id>` fetches it now instead of waiting for the
   webhook.
3. Tell the operator where the export is and what the three sections say.

## Troubleshooting

- **`NO_SOCKET` / close `1002` / `Expected 101`**: the token or the id is
  wrong. `acta meetings` lists the ids; the token is the passage entry.
- **Monitor expired with zero events**: silence is normal between turns.
  Check `acta meetings` for the state before assuming a drop, then re-arm.
- **A paragraph with the wrong speaker**: it cannot happen in Scribe (one
  track per speaker); two people on one laptop are one track. Note it in
  `notes` with the time.
- **The hook did not fire**: it matches `acta new` in a Bash command and
  needs the plugin enabled (`enabledPlugins` in settings.json, `/reload-plugins`
  after an edit). Build the Monitor call by hand from step 2.
- **Firehose suppression**: the harness suppresses a monitor that emits too
  many events. Scribe's feed is sparse by design; if it ever trips, the
  bug is in Scribe's paragraph rule, not in the monitor.
