// The book: five Markdown sections, rendered as one file. Only `transcript`
// is generated (from paragraphs); the brain writes the rest.
import { BOOK_SECTIONS, type Book, type BookSection, type Paragraph } from "./schemas.ts";

export const SECTION_TITLES: Record<BookSection, string> = {
  summary: "Summary",
  decisions: "Decisions",
  actions: "Action items",
  notes: "Notes",
  transcript: "Transcript",
};

export function emptyBook(title: string): Book {
  return { title, sections: { summary: "", decisions: "", actions: "", notes: "", transcript: "" } };
}

/** `ms` since meeting start → `hh:mm:ss`; negative clamps to zero. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

// Speech text is not Markdown: keep raw HTML inert and a leading block marker literal.
function escapeSpeech(text: string): string {
  return text.replace(/</g, "&lt;").replace(/^(\s*)([#>+*-]|\d+[.)])(?=\s)/, "$1\\$2");
}

function paragraphBlock(p: Paragraph, meetingStartMs: number): string {
  return `**${p.speaker}** · ${clock(p.t0 - meetingStartMs)}\n${escapeSpeech(p.text)}`;
}

export function renderTranscript(paragraphs: readonly Paragraph[], meetingStartMs: number): string {
  return paragraphs.map((p) => paragraphBlock(p, meetingStartMs)).join("\n\n");
}

/** Same result as re-rendering the transcript with `paragraph` appended. */
export function appendParagraphToTranscript(existing: string, paragraph: Paragraph, meetingStartMs: number): string {
  const head = existing.trimEnd();
  const block = paragraphBlock(paragraph, meetingStartMs);
  return head ? `${head}\n\n${block}` : block;
}

/** `# title`, then each non-empty section as `## Title`; the transcript always. */
export function renderBook(book: Book): string {
  const parts = [`# ${book.title}`];
  for (const key of BOOK_SECTIONS) {
    const body = (book.sections[key] ?? "").trim();
    if (!body && key !== "transcript") continue;
    parts.push(body ? `## ${SECTION_TITLES[key]}\n\n${body}` : `## ${SECTION_TITLES[key]}`);
  }
  return `${parts.join("\n\n")}\n`;
}
