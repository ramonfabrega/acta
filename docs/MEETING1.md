# The first live meeting (2026-10-23)

Three humans, about 65 minutes, a Claude Code session as brain in another
repo, the room link shared by hand. Minted with 34 keywords. The hook fired
on the real mint and handed a correct Monitor call; `ended` arrived about
20 s after the last leave; the book accepted writes after `ended`; export,
sync (six tracks, two per speaker) and doctor all clean. Nothing from the
meeting is in this file: counts and mechanisms only, no names, no quotes.

| | |
| --- | --- |
| utterances | 1076 |
| paragraphs | 309 (about 285 an hour) |
| speakers | 3 |
| recordings | 6 webm tracks, two per speaker |

## What was wrong, most useful first

1. **Event volume.** The paragraph rule promised twenty to forty events an
   hour and produced about 285. With three people, short real turns
   ("yes", "okay") each closed a paragraph, and the backchannel rule folded
   some of them and not others. The harness did not suppress the feed, so
   every paragraph was a notification. The brain coped; the design did not
   hold. Options, not yet chosen: emit `paragraph` events in batches (one
   frame per N seconds or per M paragraphs, carrying all of them), loosen
   the backchannel bound for short turns that do not take the floor, or
   make the event cadence a per-meeting setting the brain picks.
2. **`t0` is wrong on short turns after a gap.** Seen: a one-word paragraph
   spanning 71 s from the speaker's join, a four-word one spanning ~115 s,
   and one with `t0 == t1` holding two utterances. Mechanism, confirmed in
   `src/scribe.ts`: `firstPartial` per peer is set on the first partial and
   cleared only by a final. A final lost in the agent-socket gap (item 3)
   leaves a stale first-partial stamp that the next final inherits. Fix:
   expire a first-partial stamp older than a bound (a few seconds past
   what the word count allows), clear the map on every agent reconnect,
   and never let `t0 == t1` for non-empty text.
3. **Participant frames after a reconnect.** Within one second: join,
   leave, join, leave, leave, then no join frames at all while all three
   kept talking and paragraphs kept arriving. The recordings confirm the
   room reconnected: every speaker has two tracks split at that instant
   and someone said aloud that the bot left and came back. Mechanism,
   confirmed: a rejoin with a known `peer_id` is logged as `rejoin` and
   emits no frame, by design for the duplicate-join-on-failed-first-attempt
   case from the spike. That dedupe is right when `left_at` is null and
   wrong after a real leave. Fix: emit `join` again when the row had
   `left_at` set. The agent's own reconnect should also be a frame, so the
   brain can explain a gap.
4. **Events socket closed 1006** about 21 minutes after the reconnect, not
   at the 30-minute expiry, no deploy in between. Re-arming got `hello`
   and the transcript showed no gap, so the design's "a gap costs nothing"
   held. Cause unknown; one data point.
5. **Room chat is invisible to the brain.** Links pasted in chat never
   reached it. v1 said no chat integration; this is the first argument for
   a `chat` subscription on the agent socket, if the vendor offers one.
6. **Captions UX.** Live captions cover faces in a small window; turning
   them off is per viewer; the side transcript strip stays. Layout and
   resize were praised against the usual huddle.
7. **Keyword misses.** A two-word keyword that was in the list came back as
   three unrelated words; several product and model names were wrong; one
   name never resolved. Spanish and English mixing was otherwise very good.
   To check: whether keyterm prompting applies at all under
   `language: "multi"` on nova-3, and whether multi-word keywords need
   quoting. The batch pass (V0 queue item 4) is where a better model gets
   its say on the stored tracks.

## What held

Mint, hook, Monitor, re-arm, paragraphs with speaker as a field, the book
over the room socket, `ended` on last leave, the copy of six tracks into
R2 within a minute, export and sync outside the repo, doctor clean. The
first live run of a design that had only been run with two synthetic
speakers for two minutes at a time.
