/**
 * The acta plugin (plugin/): the skill cannot drift from the command table, the
 * marketplace and plugin manifests have the fleet shape, and the `acta new`
 * hook hands the session the Monitor call with the id it read off the output.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { renderSkill, SKILL_PATH } from "../../scripts/skill.ts";
import { contextFor, eventsUrlFrom, isActaNew, meetingIdFrom, readToken } from "../../plugin/hooks/acta-new.ts";

const root = join(import.meta.dir, "..", "..");
const read = (rel: string) => Bun.file(join(root, rel)).text();
const readJson = async (rel: string): Promise<unknown> => JSON.parse(await read(rel));

describe("manifests", () => {
  test("the repo root is the marketplace and lists ./plugin", async () => {
    const m = z.object({
      name: z.literal("acta"),
      owner: z.object({ name: z.string().min(1) }),
      plugins: z.array(z.object({ name: z.literal("acta"), source: z.literal("./plugin"), description: z.string().min(20) })).length(1),
    }).loose().parse(await readJson(".claude-plugin/marketplace.json"));
    expect(m.plugins[0]?.source).toBe("./plugin");
  });

  test("plugin.json names the plugin and a semver version", async () => {
    const p = z.object({ name: z.literal("acta"), version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string().min(20) }).loose().parse(await readJson("plugin/.claude-plugin/plugin.json"));
    expect(p.version).toBe(JSON.parse(await read("package.json")).version);
  });

  test("hooks.json wires a PostToolUse hook on Bash to the acta-new script", async () => {
    const h = z.object({
      hooks: z.object({
        PostToolUse: z.array(z.object({
          matcher: z.literal("Bash"),
          hooks: z.array(z.object({ type: z.literal("command"), command: z.string(), timeout: z.number().positive() })).min(1),
        })).length(1),
      }),
    }).loose().parse(await readJson("plugin/hooks/hooks.json"));
    const command = h.hooks.PostToolUse[0]?.hooks[0]?.command ?? "";
    expect(command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(command).toContain("hooks/acta-new.ts");
    expect(await Bun.file(join(root, "plugin/hooks/acta-new.ts")).exists()).toBe(true);
  });
});

describe("skill", () => {
  test("SKILL.md is generated from the command table (run `bun run plugin:skill`)", async () => {
    expect(await read("plugin/skills/acta/SKILL.md")).toBe(await renderSkill());
    expect(SKILL_PATH.endsWith("plugin/skills/acta/SKILL.md")).toBe(true);
  });

  test("the skill has frontmatter, the brain preamble, and every command", async () => {
    const skill = await read("plugin/skills/acta/SKILL.md");
    expect(skill.startsWith("---\nname: acta\ndescription: ")).toBe(true);
    expect(skill).toContain("## The brain");
    expect(skill).toContain("Monitor({ ws: { url:");
    expect(skill).toContain("docs/BRAIN.md");
    for (const c of ["new", "meetings", "tail", "book put", "book show", "export", "sync", "doctor", "test"]) expect(skill).toContain(`### acta ${c}\n`);
  });
});

describe("acta-new hook", () => {
  test("matches the spellings of `acta new` and nothing else", () => {
    for (const c of [
      'acta new "dev sync"',
      "acta new dev --keywords a,b",
      "bun cli/acta.ts new 'x'",
      "bun run acta new x",
      "cd ~/code/fun/acta && bun cli/acta.ts new x --json",
      "acta --json new x",
      "ACTA_URL=http://localhost:8787 acta new x",
      "acta new x | tee out.txt",
    ]) expect(isActaNew(c)).toBe(true);
    for (const c of ["acta meetings", "acta test", "acta tail new", "echo acta-new", "actanew x", "acta newer x", "git commit -m 'acta new'"]) expect(isActaNew(c)).toBe(false);
    // Found live 2026-10-23: `acta new --help` fired the hook. Help and manifest flags mint nothing.
    for (const c of ["acta new --help", "acta new -h", "acta --help new", "acta new x --llms", "bun cli/acta.ts new --schema"]) expect(isActaNew(c)).toBe(false);
  });

  test("reads the meeting id off the URL, a TOON line, or JSON", () => {
    const id = "bbb35e46-40ba-4828-a87b-fc70a719c728";
    expect(meetingIdFrom(`id: ${id}\nurl: https://acta.ramonfabrega.com/m/${id}?k=abc\n`)).toBe(id);
    expect(meetingIdFrom(`url: https://acta.ramonfabrega.com/m/${id}?k=abc`)).toBe(id);
    expect(meetingIdFrom(`{"id": "${id}", "url": "x"}`)).toBe(id);
    expect(meetingIdFrom("Error (HTTP_401): unauthorized")).toBeNull();
  });

  test("the events URL comes from the answer, else from ACTA_URL", () => {
    expect(eventsUrlFrom("events: wss://acta.example/m/x/events\n", "x")).toBe("wss://acta.example/m/x/events");
    expect(eventsUrlFrom("", "a b", { ACTA_URL: "http://localhost:8787/" })).toBe("ws://localhost:8787/m/a%20b/events");
    expect(eventsUrlFrom("", "x", {})).toBe("wss://acta.ramonfabrega.com/m/x/events");
  });

  test("the token comes from the environment before passage", () => {
    expect(readToken({ ACTA_TOKEN: " t0k " })).toBe("t0k");
    // No env and no passage binary on PATH: null, never a throw.
    expect(readToken({ PATH: "/nonexistent" })).toBeNull();
  });

  test("the context is the Monitor call with the token in the URL, the re-arm rule and the fallback", () => {
    const ctx = contextFor("m1", "wss://h/m/m1/events", "t0k");
    expect(ctx).toContain('Monitor({ ws: { url: "wss://h/m/m1/events?token=t0k" }, description: "acta m1 events", timeout_ms: 1800000 })');
    expect(ctx).toContain("Re-arm on every expiry notice (every 30 minutes)");
    expect(ctx).toContain("acta tail m1");
    expect(ctx).toContain("acta book put m1");
    const without = contextFor("m1", "wss://h/m/m1/events", null);
    expect(without).toContain("?token=<ACTA_TOKEN>");
    expect(without).toContain("passage show tokens/cloudflare/personal/acta/acta-token");
  });

  async function hook(payload: unknown, env: Record<string, string> = {}): Promise<{ out: string; code: number }> {
    const proc = Bun.spawn(["bun", join(root, "plugin/hooks/acta-new.ts")], {
      stdin: new Response(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, code };
  }

  test("end to end: a PostToolUse payload for `acta new` yields additionalContext with the armed URL", async () => {
    const id = "bbb35e46-40ba-4828-a87b-fc70a719c728";
    const { out, code } = await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: 'acta new "dev sync"' },
      tool_response: { stdout: `id: ${id}\nurl: https://acta.ramonfabrega.com/m/${id}?k=cap\ntitle: dev sync\nevents: wss://acta.ramonfabrega.com/m/${id}/events\n`, stderr: "" },
    }, { ACTA_TOKEN: "test-token" });
    expect(code).toBe(0);
    const o = z.object({ systemMessage: z.string(), hookSpecificOutput: z.object({ hookEventName: z.literal("PostToolUse"), additionalContext: z.string() }) }).parse(JSON.parse(out));
    expect(o.hookSpecificOutput.additionalContext).toContain(`wss://acta.ramonfabrega.com/m/${id}/events?token=test-token`);
    expect(o.systemMessage).toContain(id);
  });

  test("end to end: other Bash commands and other tools are ignored", async () => {
    const a = await hook({ tool_name: "Bash", tool_input: { command: "acta meetings" }, tool_response: { stdout: "count: 0" } });
    expect(a).toEqual({ out: "", code: 0 });
    const b = await hook({ tool_name: "Read", tool_input: { file_path: "x" }, tool_response: "acta new" });
    expect(b).toEqual({ out: "", code: 0 });
    const c = await hook("not an object");
    expect(c).toEqual({ out: "", code: 0 });
  });
});
