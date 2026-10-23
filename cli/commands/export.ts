// `acta export`: the book plus transcript as Markdown, the way out of acta.
import { arg, str, type Command } from "../args.ts";
import { api } from "../client.ts";

export const command: Command = {
  name: "export",
  summary: "Export a meeting as Markdown (book + transcript) to stdout or a file.",
  usage: "acta export <id> [--out file]",
  args: [{ name: "id", summary: "Meeting id.", required: true }],
  flags: [{ name: "out", short: "o", type: "string", placeholder: "file", summary: "Write to this file instead of stdout." }],
  notes: "Never write an export inside the repo: meeting data does not enter it.",
  async run(p) {
    const md = await api.exportMarkdown(arg(p, "id"));
    const out = str(p, "out");
    if (out === undefined) { process.stdout.write(md.endsWith("\n") ? md : `${md}\n`); return 0; }
    await Bun.write(out, md);
    process.stderr.write(`wrote ${out}\n`);
    return 0;
  },
};
