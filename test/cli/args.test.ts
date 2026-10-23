import { describe, expect, test } from "bun:test";
import { parse, resolve, group, UsageError, type Command } from "../../cli/args.ts";
import { COMMANDS } from "../../cli/commands/index.ts";
import { localPath } from "../../cli/commands/sync.ts";
import { relativeKey, capabilityOf } from "../../cli/client.ts";

const spec: Pick<Command, "args" | "flags"> = {
  args: [{ name: "id", summary: "", required: true }, { name: "file", summary: "" }],
  flags: [
    { name: "out", short: "o", type: "string", summary: "" },
    { name: "json", type: "boolean", summary: "" },
    { name: "port", type: "number", default: 0, summary: "" },
  ],
};

describe("parse", () => {
  test("positionals, flags, defaults", () => {
    const p = parse(spec, ["m1", "--out", "x.md", "--json"]);
    expect(p.args).toEqual({ id: "m1", file: undefined });
    expect(p.flags).toEqual({ out: "x.md", json: true, port: 0 });
  });

  test("--flag=value, short flags, numbers, --no-switch", () => {
    const p = parse(spec, ["-o", "a", "--port=8790", "m1", "--no-json"]);
    expect(p.flags).toEqual({ out: "a", port: 8790, json: false });
    expect(p.args.id).toBe("m1");
  });

  test("`-` is a positional (stdin), `--` ends flags", () => {
    expect(parse(spec, ["m1", "-"]).args.file).toBe("-");
    expect(parse(spec, ["--", "--weird-id"]).args.id).toBe("--weird-id");
  });

  test("errors are UsageError", () => {
    expect(() => parse(spec, [])).toThrow(UsageError);
    expect(() => parse(spec, ["m1", "--nope"])).toThrow("unknown flag --nope");
    expect(() => parse(spec, ["m1", "--out"])).toThrow("--out needs a value");
    expect(() => parse(spec, ["m1", "--port", "x"])).toThrow("expects a number");
    expect(() => parse(spec, ["m1", "f", "extra"])).toThrow('unexpected argument "extra"');
  });

  test("variadic collects the rest", () => {
    const p = parse({ args: [{ name: "words", summary: "", variadic: true }], flags: [] }, ["a", "b", "c"]);
    expect(p.rest).toEqual(["a", "b", "c"]);
    expect(p.args.words).toBe("a");
  });
});

describe("resolve", () => {
  test("two-word commands win; the name is stripped", () => {
    const hit = resolve(COMMANDS, ["book", "put", "m1", "summary", "-"]);
    expect(hit?.command.name).toBe("book put");
    expect(hit?.rest).toEqual(["m1", "summary", "-"]);
  });

  test("one-word commands", () => {
    const hit = resolve(COMMANDS, ["tail", "m1", "--json"]);
    expect(hit?.command.name).toBe("tail");
    expect(hit?.rest).toEqual(["m1", "--json"]);
  });

  test("unknown and group-only", () => {
    expect(resolve(COMMANDS, ["nope"])).toBeNull();
    expect(resolve(COMMANDS, ["book"])).toBeNull();
    expect(group(COMMANDS, "book").map((c) => c.name).sort()).toEqual(["book put", "book show"]);
  });

  test("every command parses its own usage arguments", () => {
    const tail = resolve(COMMANDS, ["tail", "abc"]);
    expect(tail && parse(tail.command, tail.rest).args.id).toBe("abc");
    const put = resolve(COMMANDS, ["book", "put", "abc", "notes"]);
    expect(put && parse(put.command, put.rest).args).toEqual({ id: "abc", section: "notes", file: undefined });
    const t = resolve(COMMANDS, ["test", "--keep", "--relay-port", "8790"]);
    expect(t && parse(t.command, t.rest).flags).toMatchObject({ keep: true, "relay-port": 8790, audio: "mic", bot: "local", timeout: 180 });
  });
});

describe("helpers", () => {
  test("relativeKey strips the meeting prefix only", () => {
    expect(relativeKey("m1", "meetings/m1/utterances.jsonl")).toBe("utterances.jsonl");
    expect(relativeKey("m1", "recordings/a.webm")).toBe("recordings/a.webm");
  });

  test("localPath refuses escapes", () => {
    expect(localPath("/r", "m1", "recordings/a.webm")).toBe("/r/m1/recordings/a.webm");
    expect(localPath("/r", "m1", "../m2/x")).toBeNull();
    expect(localPath("/r", "m1", "")).toBeNull();
  });

  test("capabilityOf reads ?k=", () => {
    expect(capabilityOf("https://acta.example/m/abc?k=s3cret")).toBe("s3cret");
    expect(() => capabilityOf("https://acta.example/m/abc")).toThrow();
  });
});
