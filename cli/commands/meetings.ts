// `acta meetings`: what exists and in which state (check before deploying).
import { bool, type Command } from "../args.ts";
import { api } from "../client.ts";
import { instant, table } from "./fmt.ts";

export const command: Command = {
  name: "meetings",
  summary: "List meetings with their Scribe state (idle, live, ending, ended).",
  usage: "acta meetings [--json]",
  args: [],
  flags: [{ name: "json", type: "boolean", summary: "One JSON object per line instead of a table." }],
  notes: "Deploy only when nothing is `live`.",
  async run(p) {
    const list = await api.meetings();
    if (bool(p, "json")) {
      for (const m of list) process.stdout.write(`${JSON.stringify(m)}\n`);
      return 0;
    }
    if (list.length === 0) { process.stderr.write("no meetings\n"); return 0; }
    process.stdout.write(table(["id", "state", "created", "title"],
      list.map((m) => [m.id, m.state ?? "-", instant(m.createdAt), m.title ?? ""])));
    return 0;
  },
};
