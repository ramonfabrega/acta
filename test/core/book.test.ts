import { describe, expect, test } from "bun:test";
import { appendParagraphToTranscript, clock, emptyBook, renderBook, renderTranscript } from "../../src/core/book.ts";
import { BookSchema, type Paragraph } from "../../src/core/schemas.ts";

const start = 1_761_250_000_000;
function para(speaker: string, offsetMs: number, text: string): Paragraph {
  return { id: `p${offsetMs}`, t0: start + offsetMs, t1: start + offsetMs + 1000, speaker, userId: `u_${speaker}`, text, utterances: [0], asides: [] };
}

describe("book", () => {
  test("clock", () => {
    expect(clock(0)).toBe("00:00:00");
    expect(clock(65_999)).toBe("00:01:05");
    expect(clock(3_723_000)).toBe("01:02:03");
    expect(clock(-5000)).toBe("00:00:00");
  });

  test("renderTranscript: speaker and offset line, then the text", () => {
    const md = renderTranscript([para("ana", 0, "hola [ben: mhm] seguimos"), para("ben", 65_000, "ok")], start);
    expect(md).toBe("**ana** · 00:00:00\nhola [ben: mhm] seguimos\n\n**ben** · 00:01:05\nok");
    expect(renderTranscript([], start)).toBe("");
  });

  test("speech text cannot become HTML or a block", () => {
    expect(renderTranscript([para("ana", 0, "# one <b>two</b>")], start)).toBe("**ana** · 00:00:00\n\\# one &lt;b>two&lt;/b>");
  });

  test("appending matches re-rendering", () => {
    const ps = [para("ana", 0, "uno"), para("ben", 4000, "dos"), para("ana", 9000, "tres")];
    let md = "";
    for (const p of ps) md = appendParagraphToTranscript(md, p, start);
    expect(md).toBe(renderTranscript(ps, start));
    expect(appendParagraphToTranscript("x\n\n\n", ps[0]!, start)).toBe("x\n\n**ana** · 00:00:00\nuno");
  });

  test("emptyBook parses as a Book", () => {
    expect(BookSchema.parse(emptyBook("dev sync"))).toEqual(emptyBook("dev sync"));
  });

  test("renderBook: order, titles, empty sections omitted but the transcript", () => {
    const b = emptyBook("dev sync");
    expect(renderBook(b)).toBe("# dev sync\n\n## Transcript\n");
    b.sections.notes = "- a note\n";
    b.sections.summary = "We met.";
    b.sections.actions = "  ";
    b.sections.transcript = "**ana** · 00:00:00\nhola";
    expect(renderBook(b)).toBe(
      "# dev sync\n\n## Summary\n\nWe met.\n\n## Notes\n\n- a note\n\n## Transcript\n\n**ana** · 00:00:00\nhola\n",
    );
    b.sections.decisions = "Ship friday.";
    b.sections.actions = "- [ ] ana: ship";
    expect(renderBook(b).match(/^## .+$/gm)).toEqual(["## Summary", "## Decisions", "## Action items", "## Notes", "## Transcript"]);
  });
});
