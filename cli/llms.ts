// `acta --llms` and `acta --help`, rendered from the command table so the
// docs cannot drift from the code.
import { argLabel, flagLabel, GLOBAL_FLAGS, type Command, type FlagSpec } from "./args.ts";
import { DEFAULT_URL, PASSAGE_ENTRY } from "./client.ts";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function flagDefault(f: FlagSpec): string {
  if (f.default === undefined || f.default === false) return "";
  return `\`${String(f.default)}\``;
}

/** The whole table as Markdown, for agents. */
export function renderLlms(table: readonly Command[]): string {
  const out: string[] = [];
  out.push("# acta");
  out.push("");
  out.push("Own the meeting: a RealtimeKit room with per-speaker transcripts, a Durable Object (Scribe) that turns them into a live book, and recordings copied into R2. This CLI talks to the acta Worker.");
  out.push("");
  out.push(`- \`ACTA_URL\`: the Worker (default \`${DEFAULT_URL}\`).`);
  out.push(`- \`ACTA_TOKEN\`: operator bearer; when unset, read from \`passage show ${PASSAGE_ENTRY}\`. Never printed.`);
  out.push("- Exit codes: `0` ok, `1` failure (API error with the server's message, failed check), `2` usage error.");
  out.push("- Global flags: " + GLOBAL_FLAGS.map((f) => `\`${flagLabel(f)}\` ${f.summary}`).join(" "));
  out.push("");
  out.push("## Commands");
  out.push("");
  out.push("| command | summary |");
  out.push("| --- | --- |");
  for (const c of table) out.push(`| \`acta ${c.name}\` | ${cell(c.summary)} |`);
  for (const c of table) {
    out.push("");
    out.push(`### acta ${c.name}`);
    out.push("");
    out.push(c.summary);
    out.push("");
    out.push("```");
    out.push(c.usage);
    out.push("```");
    if (c.args.length) {
      out.push("");
      out.push("| argument | required | description |");
      out.push("| --- | --- | --- |");
      for (const a of c.args) out.push(`| \`${cell(argLabel(a))}\` | ${a.required ? "yes" : "no"} | ${cell(a.summary)} |`);
    }
    if (c.flags.length) {
      out.push("");
      out.push("| flag | default | description |");
      out.push("| --- | --- | --- |");
      for (const f of c.flags) out.push(`| \`${cell(flagLabel(f))}\` | ${flagDefault(f)} | ${cell(f.summary)} |`);
    }
    if (c.notes) {
      out.push("");
      out.push(c.notes);
    }
  }
  return out.join("\n") + "\n";
}

/** `acta --help`: one line per command. */
export function renderHelp(table: readonly Command[]): string {
  const width = Math.max(...table.map((c) => c.name.length));
  return [
    "acta: own the meeting (rooms, transcripts, the book, recordings).",
    "",
    "usage: acta <command> [args] [flags]",
    "",
    "commands:",
    ...table.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "global flags:",
    ...GLOBAL_FLAGS.map((f) => `  ${flagLabel(f).padEnd(14)}  ${f.summary}`),
    "",
    `env: ACTA_URL (default ${DEFAULT_URL}), ACTA_TOKEN (else passage ${PASSAGE_ENTRY})`,
    "`acta <command> --help` for one command; `acta --llms` for everything as Markdown.",
    "",
  ].join("\n");
}

/** `acta <command> --help`. */
export function renderCommandHelp(c: Command): string {
  const lines = [`usage: ${c.usage}`, "", c.summary];
  if (c.args.length) {
    lines.push("", "arguments:");
    const w = Math.max(...c.args.map((a) => argLabel(a).length));
    for (const a of c.args) lines.push(`  ${argLabel(a).padEnd(w)}  ${a.summary}`);
  }
  if (c.flags.length) {
    lines.push("", "flags:");
    const w = Math.max(...c.flags.map((f) => flagLabel(f).length));
    for (const f of c.flags) {
      const d = f.default === undefined || f.default === false ? "" : ` (default ${String(f.default)})`;
      lines.push(`  ${flagLabel(f).padEnd(w)}  ${f.summary}${d}`);
    }
  }
  if (c.notes) lines.push("", c.notes);
  return lines.join("\n") + "\n";
}
