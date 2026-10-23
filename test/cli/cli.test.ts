import { describe, expect, test } from "bun:test";
import { cli, DESCRIPTION } from "../../cli/cli.ts";
import { capabilityOf, eventsUrl, relativeKey } from "../../cli/client.ts";
import { renderBook } from "../../cli/commands/book.ts";
import { diagnose } from "../../cli/commands/doctor.ts";
import { parseKeywords } from "../../cli/commands/new.ts";
import { localPath } from "../../cli/commands/sync.ts";
import { frameLine } from "../../cli/commands/tail.ts";
import { assess, coverage, report, tokens } from "../../cli/commands/test.ts";
import type { MeetingStatus, Paragraph } from "../../src/core/schemas.ts";

/** Run the CLI in-process; the answer and the exit code it asked for. */
async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ out: string; code: number | null }> {
  let out = "";
  let code: number | null = null;
  await cli.serve(argv, { stdout: (s) => { out += s; }, exit: (c) => { code = c; }, env: { ...process.env, ...env } });
  return { out, code };
}

const COMMANDS = ["new", "meetings", "tail", "book put", "book show", "export", "sync", "doctor", "test"];

describe("command table", () => {
  test("--llms lists every V0.md command with its arguments", async () => {
    const { out, code } = await run(["--llms"]);
    expect(code).toBeNull();
    expect(out.startsWith("# acta\n")).toBe(true);
    for (const c of COMMANDS) expect(out).toContain(`\`acta ${c}`);
    expect(out).toContain("`acta book put <id> <section> [file]`");
    expect(out).toContain("`acta sync [id]`");
  });

  test("--llms-full is deterministic and carries options, examples and hints", async () => {
    const a = await run(["--llms-full"]);
    const b = await run(["--llms-full"]);
    expect(a.out).toBe(b.out);
    for (const c of COMMANDS) expect(a.out).toContain(`### acta ${c}\n`);
    for (const flag of ["--keywords", "--frames", "--section", "--out", "--fixture", "--keep", "--relayPort", "--audio", "--bot", "--timeout"]) {
      expect(a.out).toContain(`\`${flag}\``);
    }
    expect(a.out).toContain("acta new \"dev sync\"");
    expect(a.out).toContain("docs/BRAIN.md");
  });

  test("the description documents env, passage and exit codes, never a token value", async () => {
    for (const s of ["ACTA_URL", "ACTA_TOKEN", "passage show tokens/cloudflare/personal/acta/acta-token", "Exit 0"]) expect(DESCRIPTION).toContain(s);
    const { out } = await run(["--llms-full"], { ACTA_TOKEN: "s3cret-token-value" });
    expect(out).not.toContain("s3cret-token-value");
  });

  test("--help lists every top-level command once", async () => {
    const { out } = await run(["--help"]);
    for (const c of ["book", "doctor", "export", "meetings", "new", "sync", "tail", "test"]) expect(out).toContain(`\n  ${c} `);
    expect(out).toContain("skills");
  });

  test("validation fails before any request: a generated section, a bad enum, a missing id", async () => {
    const put = await run(["book", "put", "m1", "transcript"]);
    expect(put.code).toBe(1);
    expect(put.out).toContain("VALIDATION_ERROR");
    expect(put.out).toContain("summary");

    const t = await run(["test", "--audio", "nope"]);
    expect(t.code).toBe(1);
    expect(t.out).toContain("VALIDATION_ERROR");

    const tail = await run(["tail"]);
    expect(tail.code).toBe(1);
    expect(tail.out).toContain("id");
  });

  test("kebab and camel spellings of an option both parse", async () => {
    // --schema answers without running the command; a wrong value would be a validation error.
    const a = await run(["test", "--schema", "--format", "json"]);
    expect(a.code).toBeNull();
    expect(a.out).toContain("relayPort");
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

  test("eventsUrl is wss on the Worker, without a token", () => {
    const prev = process.env.ACTA_URL;
    process.env.ACTA_URL = "https://acta.example/";
    try {
      expect(eventsUrl("m 1")).toBe("wss://acta.example/m/m%201/events");
    } finally {
      if (prev === undefined) delete process.env.ACTA_URL; else process.env.ACTA_URL = prev;
    }
  });

  test("parseKeywords trims and drops empties", () => {
    expect(parseKeywords(" lore, acta ,,Scribe ")).toEqual(["lore", "acta", "Scribe"]);
    expect(parseKeywords(undefined)).toEqual([]);
  });

  test("renderBook skips empty sections except the transcript, or answers one section", () => {
    const book = { title: "T", sections: { summary: "S", decisions: "  ", transcript: "" } };
    expect(renderBook(book)).toBe("# T\n\n## Summary\n\nS\n\n## Transcript\n\n");
    expect(renderBook(book, "summary")).toBe("S");
    expect(renderBook(book, "notes")).toBe("");
  });

  test("frameLine is one line per frame", () => {
    const p: Paragraph = { id: "p1", t0: 7000, t1: 12000, speaker: "ana", userId: "u", text: "hola [ben: mhm] mundo", utterances: [0, 1], asides: [{ speaker: "ben", text: "mhm", t0: 8000 }] };
    expect(frameLine({ type: "paragraph", paragraph: p })).toBe("00:00:07-00:00:12 ana: hola [ben: mhm] mundo");
    expect(frameLine({ type: "ended", at: 60_000, reason: "last_leave", utterances: 3, paragraphs: 1 })).toBe("00:01:00 ended reason=last_leave utterances=3 paragraphs=1");
  });
});

describe("doctor", () => {
  const base: MeetingStatus = {
    id: "m", title: "t", state: "ended", createdAt: 0,
    session: { id: "s", startedAt: 0, endedAt: 1000 },
    participants: [{ peerId: "p", participantId: "pid", userId: "u", speaker: "ana", joinedAt: 0, leftAt: 1000, presentAt: 0 }],
    counts: { utterances: 1, paragraphs: 1 },
    recording: { id: "r", startedAt: 0, status: "UPLOADED" },
    copies: [],
  };
  const HOUR = 3600_000, DAY = 24 * HOUR;

  test("an ended meeting without its recording copy is the alarm, and it worsens past seven days", () => {
    expect(diagnose(base, HOUR)).toEqual(["recording r not copied yet (UPLOADED)"]);
    expect(diagnose(base, 8 * DAY)).toEqual(["recording never copied; vendor URL has expired"]);
    expect(diagnose({ ...base, copies: [{ kind: "recording", key: "meetings/m/recordings/a.webm", status: "done", size: 1, at: 1 }] }, HOUR)).toEqual([]);
  });

  test("live too long, copy errors, humans without a recording", () => {
    expect(diagnose({ ...base, state: "live", session: { id: "s", startedAt: 0, endedAt: null } }, 4 * HOUR)).toEqual(["live for 4.0 h"]);
    expect(diagnose({ ...base, copies: [{ kind: "recording", key: "k", status: "error", size: null, at: 1 }] }, HOUR)).toEqual(["1 copy error(s): k"]);
    expect(diagnose({ ...base, recording: null }, HOUR)).toEqual(["humans joined but no track recording was started"]);
  });
});

describe("acta test assertions", () => {
  const fixture = {
    title: "two", leadIn: 1, tail: 2,
    speakers: [{ tag: "ana", voice: "v" }, { tag: "ben", voice: "v" }],
    lines: [
      { at: 0, who: "ana", text: "gracias por venir hoy revisamos el plan" },
      { at: 3, who: "ben", text: "mhm", expect: "aside" as const },
      { at: 6, who: "ben", text: "sounds good I will send the checklist", expect: "change" as const },
    ],
  };
  const u = (seq: number, speaker: string, text: string, t0: number, t1: number) => ({ seq, t0, t1, speaker, userId: `u_${speaker}`, peerId: "p", text, lang: null, final: true as const, engine: "nova-3", conf: 0.9 });
  const paragraphs: Paragraph[] = [
    { id: "p1", t0: 1000, t1: 4000, speaker: "ana", userId: "u_ana", text: "gracias por venir hoy [ben: mhm] revisamos el plan", utterances: [1], asides: [{ speaker: "ben", text: "mhm", t0: 3000 }] },
    { id: "p2", t0: 6000, t1: 9000, speaker: "ben", userId: "u_ben", text: "sounds good I will send the checklist", utterances: [2], asides: [] },
  ];
  // Scribe stores utterances in t1 order: the backchannel's final lands before the floor-holder's.
  const utterances = [u(0, "ben", "mhm", 3000, 3300), u(1, "ana", "gracias por venir hoy revisamos el plan", 1000, 4000), u(2, "ben", "sounds good I will send the checklist", 6000, 9000)];
  const ended = { type: "ended" as const, at: 20_000, reason: "last_leave", utterances: 3, paragraphs: 2 };

  test("tokens and coverage", () => {
    expect(tokens("¡Hola, Ciudad de México!")).toEqual(["hola", "ciudad", "de", "mexico"]);
    expect(coverage("hola mundo", new Set(["hola"]))).toBe(0.5);
    expect(coverage("", new Set(["hola"]))).toBe(0);
  });

  test("a clean run passes every required check", () => {
    const files = [{ key: "meetings/m/utterances.jsonl", size: 10, uploaded: null }];
    const checks = assess(fixture, { utterances, paragraphs, files, jsonlLines: 3, ended, forcedEnd: false, meetingId: "m" });
    expect(checks.filter((c) => c.level === "required").every((c) => c.ok)).toBe(true);
    const r = report("m", checks, paragraphs, [{ tag: "ana", ev: "joined", at: 0, ms: 0, data: null }], ["ana", "ben"]);
    expect(r.result).toBe("PASS");
    expect(r.paragraphs[0]).toEqual({ at: "00:00:01", speaker: "ana", text: "gracias por venir hoy [ben: mhm] revisamos el plan", asides: 1 });
    expect(r.bots.map((b) => b.joined)).toEqual([true, false]);
  });

  test("misattribution, a backchannel paragraph and a forced end fail", () => {
    const swapped = utterances.map((x) => (x.seq === 2 ? { ...x, speaker: "ana" } : x));
    const ownParagraph: Paragraph[] = [...paragraphs, { id: "p3", t0: 3000, t1: 3300, speaker: "ben", userId: "u_ben", text: "mhm", utterances: [0], asides: [] }];
    const checks = assess(fixture, { utterances: swapped, paragraphs: ownParagraph, files: [], jsonlLines: null, ended, forcedEnd: true, meetingId: "m" });
    const failed = checks.filter((c) => c.level === "required" && !c.ok).map((c) => c.name);
    expect(failed).toEqual(["attribution", "backchannel @3s is an aside", "utterances.jsonl in R2", "ended"]);
    expect(report("m", checks, [], [], ["ana", "ben"]).result).toBe("FAIL");
  });
});
