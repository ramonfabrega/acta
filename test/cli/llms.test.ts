import { describe, expect, test } from "bun:test";
import { argLabel, flagLabel } from "../../cli/args.ts";
import { COMMANDS } from "../../cli/commands/index.ts";
import { renderCommandHelp, renderHelp, renderLlms } from "../../cli/llms.ts";

describe("command table", () => {
  test("names are unique and cover V0.md §CLI", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["new", "meetings", "tail", "book put", "export", "sync", "doctor", "test"]) expect(names).toContain(n);
  });

  test("every usage line names its command and its args", () => {
    for (const c of COMMANDS) {
      expect(c.usage.startsWith(`acta ${c.name}`)).toBe(true);
      for (const a of c.args) expect(c.usage).toContain(a.name);
      const variadic = c.args.findIndex((a) => a.variadic);
      expect(variadic === -1 || variadic === c.args.length - 1).toBe(true);
      // required args come first
      const firstOptional = c.args.findIndex((a) => !a.required);
      if (firstOptional >= 0) expect(c.args.slice(firstOptional).every((a) => !a.required)).toBe(true);
    }
  });
});

describe("--llms", () => {
  const md = renderLlms(COMMANDS);

  test("is deterministic Markdown with one section per command", () => {
    expect(renderLlms(COMMANDS)).toBe(md);
    expect(md.startsWith("# acta\n")).toBe(true);
    for (const c of COMMANDS) {
      expect(md).toContain(`### acta ${c.name}\n`);
      expect(md).toContain(c.usage);
      const esc = (s: string) => s.replace(/\|/g, "\\|");
      for (const a of c.args) expect(md).toContain(`\`${esc(argLabel(a))}\``);
      for (const f of c.flags) expect(md).toContain(`\`${esc(flagLabel(f))}\``);
    }
  });

  test("documents env and exit codes, never a token value", () => {
    expect(md).toContain("ACTA_URL");
    expect(md).toContain("ACTA_TOKEN");
    expect(md).toContain("`2` usage error");
    if (process.env.ACTA_TOKEN) expect(md).not.toContain(process.env.ACTA_TOKEN);
  });

  test("table cells escape pipes", () => {
    const row = md.split("\n").find((l) => l.startsWith("| `--audio"));
    expect(row).toContain("mic\\|file");
  });
});

describe("--help", () => {
  test("lists every command once", () => {
    const h = renderHelp(COMMANDS);
    for (const c of COMMANDS) expect(h).toContain(`  ${c.name}`);
  });

  test("per-command help shows usage, args and defaults", () => {
    const t = COMMANDS.find((c) => c.name === "test");
    expect(t).toBeDefined();
    if (!t) return;
    const h = renderCommandHelp(t);
    expect(h).toContain(`usage: ${t.usage}`);
    expect(h).toContain("(default 180)");
  });
});
