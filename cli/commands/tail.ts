// `acta tail`: the events socket, one line per frame. Also the brain's manual
// fallback when the harness Monitor is unavailable.
import { arg, bool, type Command } from "../args.ts";
import { events } from "../client.ts";
import type { EventFrame } from "../../src/core/schemas.ts";
import { clock } from "./fmt.ts";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

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

export const command: Command = {
  name: "tail",
  summary: "Follow a meeting's events socket; one line per frame; exits 0 on `ended`.",
  usage: "acta tail <id> [--json]",
  args: [{ name: "id", summary: "Meeting id (stderr of `acta new`).", required: true }],
  flags: [{ name: "json", type: "boolean", summary: "Print each frame as its JSON object instead of a readable line." }],
  notes: "Frames are sparse (20-40 an hour): hello, started, participant, paragraph, book, ended. Reconnects with backoff after a drop; a late connect still receives `ended`.",
  async run(p) {
    const id = arg(p, "id");
    const json = bool(p, "json");
    let ended = false;
    let everOpened = false;
    let delay = 1000;
    for (;;) {
      let opened = false;
      const sock = events(id, {
        open: () => { opened = everOpened = true; delay = 1000; },
        frame: (f) => {
          process.stdout.write(`${json ? JSON.stringify(f) : frameLine(f)}\n`);
          if (f.type === "ended") { ended = true; sock.close(); }
        },
        invalid: (raw, why) => process.stderr.write(`acta tail: unparsed frame (${oneLine(why)}): ${raw.slice(0, 200)}\n`),
      });
      const { code, reason } = await sock.closed;
      if (ended) return 0;
      if (!everOpened) {
        process.stderr.write(`acta tail: could not open the events socket (close ${code}${reason ? ` ${reason}` : ""}); check the id and ACTA_TOKEN\n`);
        return 1;
      }
      process.stderr.write(`acta tail: socket closed (${code}${reason ? ` ${reason}` : ""}); reconnecting in ${delay / 1000}s\n`);
      await Bun.sleep(delay);
      if (!opened) delay = Math.min(delay * 2, 30_000);
    }
  },
};
