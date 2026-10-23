import { describe, expect, test } from "bun:test";
import { createParagraphs, wordCount } from "../../src/core/paragraphs.ts";
import { ParagraphSchema, type StoredUtterance } from "../../src/core/schemas.ts";

let seq = 0;
function u(who: string, text: string, t0: number, t1: number): StoredUtterance {
  return { seq: seq++, t0, t1, speaker: who, userId: `u_${who}`, peerId: `p_${who}`, text, lang: null, final: true, engine: "nova-3", conf: null };
}

describe("paragraphs", () => {
  test("same speaker within the gap extends", () => {
    seq = 0;
    const m = createParagraphs();
    expect(m.push(u("ana", "hola a todos", 0, 3000))).toEqual([]);
    expect(m.push(u("ana", " empezamos ", 3500, 6000))).toEqual([]);
    expect(m.flush(9999)).toEqual([]);
    const [p, ...rest] = m.flush(10_000);
    expect(rest).toEqual([]);
    expect(ParagraphSchema.parse(p)).toMatchObject({
      t0: 0, t1: 6000, speaker: "ana", userId: "u_ana", text: "hola a todos empezamos", utterances: [0, 1], asides: [],
    });
    expect(m.nextDeadline()).toBeNull();
  });

  test("a gap past gapMs closes and opens a new one", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "first thought here", 0, 3000));
    const closed = m.push(u("ana", "second thought later", 7500, 9000));
    expect(closed.map((p) => p.text)).toEqual(["first thought here"]);
    expect(m.flush(13_000).map((p) => p.text)).toEqual(["second thought later"]);
  });

  test("a monologue closes at the cap", () => {
    seq = 0;
    const m = createParagraphs();
    const closed = [];
    for (let k = 0; k <= 20; k++) closed.push(...m.push(u("ana", `part ${k} of the talk`, k * 6000, k * 6000 + 5000)));
    expect(closed).toHaveLength(1);
    expect(closed[0]!.utterances).toEqual([...Array(20).keys()]);
    expect(closed[0]!.t1).toBe(119_000);
    expect(m.state().open?.t0).toBe(120_000);
  });

  test("another speaker's long final closes the paragraph", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "we should ship on friday", 0, 3000));
    const closed = m.push(u("ben", "I disagree with that completely", 3500, 6000));
    expect(closed.map((p) => p.speaker)).toEqual(["ana"]);
    expect(m.state().open?.speaker).toBe("ben");
  });

  test("a backchannel becomes an aside when the floor-holder continues", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "so the plan is", 0, 5000));
    expect(m.push(u("ben", "mhm", 5200, 5800))).toEqual([]);
    expect(m.push(u("ana", "we ship friday", 7300, 9000))).toEqual([]);
    const [p] = m.flush(13_000);
    expect(p).toMatchObject({
      text: "so the plan is [ben: mhm] we ship friday",
      utterances: [0, 2],
      asides: [{ speaker: "ben", text: "mhm", t0: 5200 }],
      t1: 9000,
    });
  });

  test("an overlapping backchannel stays an aside when partials show the floor-holder talking", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "so the plan is", 0, 5000));
    m.partial("u_ana", 5300);
    m.push(u("ben", "mhm", 5200, 5800));
    for (let t = 5600; t < 10_000; t += 400) m.partial("u_ana", t);
    expect(m.flush(7300)).toEqual([]);
    expect(m.flush(9900)).toEqual([]);
    expect(m.push(u("ana", "that we ship friday and then rest", 5300, 10_000))).toEqual([]);
    expect(m.flush(14_000)[0]?.text).toBe("so the plan is [ben: mhm] that we ship friday and then rest");
  });

  test("an unanswered backchannel becomes its own paragraph via flush", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "that is all from me", 0, 5000));
    m.push(u("ben", "mhm", 5200, 5800));
    expect(m.nextDeadline()).toBe(7300);
    expect(m.flush(7299)).toEqual([]);
    const closed = m.flush(7300);
    expect(closed.map((p) => p.text)).toEqual(["that is all from me"]);
    expect(m.state().open).toMatchObject({ speaker: "ben", pieces: ["mhm"], utterances: [1] });
    expect(m.nextDeadline()).toBe(9800);
    expect(m.flush(9800)).toMatchObject([{ speaker: "ben", text: "mhm", asides: [] }]);
  });

  test("the floor-holder resuming too late does not take the aside", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "that is all from me", 0, 5000));
    m.push(u("ben", "mhm", 5200, 5800));
    const closed = m.push(u("ana", "oh and one more thing", 7400, 9000));
    expect(closed.map((p) => [p.speaker, p.text])).toEqual([["ana", "that is all from me"], ["ben", "mhm"]]);
    expect(m.state().open?.speaker).toBe("ana");
  });

  test("two consecutive candidates both become asides", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "so the plan is", 0, 5000));
    m.push(u("ben", "mhm", 5200, 5800));
    m.push(u("cara", "yeah", 6000, 6400));
    expect(m.nextDeadline()).toBe(7900);
    expect(m.push(u("ana", "we ship friday", 7800, 9000))).toEqual([]);
    expect(m.flush(13_000)[0]).toMatchObject({
      text: "so the plan is [ben: mhm] [cara: yeah] we ship friday",
      utterances: [0, 3],
      asides: [{ speaker: "ben" }, { speaker: "cara" }],
    });
  });

  test("two unanswered candidates replay as speech", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "anything else", 0, 5000));
    m.push(u("ben", "mhm", 5200, 5800));
    m.push(u("cara", "yeah", 6000, 6400));
    expect(m.flush(7900).map((p) => p.speaker)).toEqual(["ana", "ben"]);
    expect(m.flush(10_400).map((p) => [p.speaker, p.text])).toEqual([["cara", "yeah"]]);
  });

  test("a long final from a third speaker closes the floor and the candidate", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "anything else", 0, 5000));
    m.push(u("ben", "mhm", 5200, 5800));
    const closed = m.push(u("cara", "I have a question about the budget", 5900, 7000));
    expect(closed.map((p) => p.speaker)).toEqual(["ana", "ben"]);
    expect(m.state().open?.speaker).toBe("cara");
  });

  test("the candidate's own speaker going on closes the floor and opens theirs", () => {
    seq = 0;
    const m = createParagraphs();
    m.push(u("ana", "anything else", 0, 5000));
    m.push(u("ben", "yes", 5200, 5800));
    const closed = m.push(u("ben", "I want to talk about hiring", 6000, 8000));
    expect(closed.map((p) => p.speaker)).toEqual(["ana"]);
    expect(m.state().open).toMatchObject({ speaker: "ben", pieces: ["yes", "I want to talk about hiring"], utterances: [1, 2] });
  });

  test("state round-trips through JSON mid-paragraph with a held candidate", () => {
    seq = 0;
    const a = createParagraphs();
    a.push(u("ana", "so the plan is", 0, 5000));
    a.push(u("ben", "mhm", 5200, 5800));
    a.partial("u_ana", 6000);
    const b = createParagraphs();
    b.restore(JSON.parse(JSON.stringify(a.state())));
    expect(b.state()).toEqual(a.state());
    expect(b.nextDeadline()).toBe(a.nextDeadline());
    const next = u("ana", "we ship friday", 6000, 9000);
    expect(b.push(next)).toEqual(a.push(next));
    expect(b.flush(20_000)).toEqual(a.flush(20_000));
  });

  test("restore rejects a malformed state", () => {
    expect(() => createParagraphs().restore({ v: 1, open: null })).toThrow();
  });

  test("deadlines follow the gap, partials, candidates and the cap", () => {
    seq = 0;
    const m = createParagraphs();
    expect(m.nextDeadline()).toBeNull();
    m.push(u("ana", "hello there", 0, 5000));
    expect(m.nextDeadline()).toBe(9000);
    m.partial("u_ben", 6000); // not the floor-holder: no effect
    expect(m.nextDeadline()).toBe(9000);
    m.partial("u_ana", 7000);
    expect(m.nextDeadline()).toBe(11_000);
    m.partial("u_ana", 118_000);
    expect(m.nextDeadline()).toBe(120_000);
    expect(m.flush(120_000)).toHaveLength(1);
    expect(m.nextDeadline()).toBeNull();
  });

  test("a partial after the gap does not rescue the paragraph", () => {
    seq = 0;
    const m = createParagraphs({ gapMs: 1000 });
    m.push(u("ana", "hello there", 0, 5000));
    m.partial("u_ana", 6500);
    expect(m.nextDeadline()).toBe(6000);
  });

  test("empty finals are ignored", () => {
    seq = 0;
    const m = createParagraphs();
    expect(m.push(u("ana", "  ", 0, 500))).toEqual([]);
    expect(m.nextDeadline()).toBeNull();
  });

  test("wordCount", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  sí, claro  vale ")).toBe(3);
  });
});
