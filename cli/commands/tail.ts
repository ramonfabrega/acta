// `acta tail`: the events socket, one frame at a time. Also the brain's manual
// fallback when the harness Monitor is unavailable (docs/BRAIN.md).
import { events } from "../client.ts";
import type { EventFrame } from "../../src/core/schemas.ts";
import { clock, oneLine } from "../fmt.ts";

/** Human form of one frame, always a single line. */
export function frameLine(f: EventFrame): string {
  switch (f.type) {
    case "hello": return `hello ${f.meetingId} "${oneLine(f.title)}" state=${f.state} since=${clock(f.since)}`;
    case "started": return `${clock(f.at)} started session=${f.sessionId}`;
    case "participant": return `${clock(f.at)} ${f.event} ${f.speaker} (${f.userId})`;
    case "paragraph": {
      const p = f.paragraph;
      const extra = p.asides.filter((a) => !p.text.includes(a.text)).map((a) => ` [${a.speaker}: ${oneLine(a.text)}]`).join("");
      return `${clock(p.t0)}-${clock(p.t1)} ${p.speaker}: ${oneLine(p.text)}${extra}`;
    }
    case "book": return `${clock(f.updatedAt)} book ${f.section} updated`;
    case "ended": return `${clock(f.at)} ended reason=${f.reason} utterances=${f.utterances} paragraphs=${f.paragraphs}`;
  }
}

export type FollowEnd = { ok: true } | { ok: false; reason: string };

/**
 * Yield every frame until `ended`; reconnect with backoff after a drop (a late
 * connect still receives `ended`). Returns `ok: false` only when the socket
 * never opened at all. Reconnect notices go to stderr.
 */
export async function* follow(id: string): AsyncGenerator<EventFrame, FollowEnd> {
  let everOpened = false;
  let delay = 1000;
  for (;;) {
    let opened = false;
    let ended = false;
    const queue: EventFrame[] = [];
    let wake: (() => void) | null = null;
    const push = (f: EventFrame) => { queue.push(f); wake?.(); };
    let closedResult: { code: number; reason: string } | null = null;
    const sock = events(id, {
      open: () => { opened = everOpened = true; delay = 1000; },
      frame: (f) => { push(f); if (f.type === "ended") { ended = true; sock.close(); } },
      invalid: (raw, why) => process.stderr.write(`acta tail: unparsed frame (${oneLine(why)}): ${raw.slice(0, 200)}\n`),
      close: (code, reason) => { closedResult = { code, reason }; wake?.(); },
    });
    while (closedResult === null || queue.length) {
      const f = queue.shift();
      if (f) { yield f; continue; }
      await new Promise<void>((r) => { wake = r; });
      wake = null;
    }
    if (ended) return { ok: true };
    const { code, reason } = closedResult as { code: number; reason: string };
    if (!everOpened) {
      return { ok: false, reason: `could not open the events socket (close ${code}${reason ? ` ${reason}` : ""}); check the id and ACTA_TOKEN` };
    }
    process.stderr.write(`acta tail: socket closed (${code}${reason ? ` ${reason}` : ""}); reconnecting in ${delay / 1000}s\n`);
    await Bun.sleep(delay);
    if (!opened) delay = Math.min(delay * 2, 30_000);
  }
}
