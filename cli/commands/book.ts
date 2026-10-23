// `acta book put` (the brain writes) and `acta book show` (read before writing).
import { arg, str, UsageError, type Command } from "../args.ts";
import { api } from "../client.ts";
import { BOOK_SECTIONS, BookSectionSchema, WritableBookSectionSchema } from "../../src/core/schemas.ts";

const WRITABLE = WritableBookSectionSchema.options;

export const command: Command = {
  name: "book put",
  summary: "Replace one book section with Markdown from a file or stdin.",
  usage: "acta book put <id> <section> [file|-]",
  args: [
    { name: "id", summary: "Meeting id.", required: true },
    { name: "section", summary: `One of ${WRITABLE.join(", ")} (transcript is generated).`, required: true },
    { name: "file", summary: "Markdown file; `-` or omitted reads stdin." },
  ],
  flags: [],
  notes: "Sections are Markdown without their own H2. The room sees the change at once; the events socket emits a `book` frame.",
  async run(p) {
    const id = arg(p, "id");
    const section = WritableBookSectionSchema.safeParse(p.args.section);
    if (!section.success) throw new UsageError(`section must be one of ${WRITABLE.join(", ")}`);
    const file = p.args.file;
    const markdown = file === undefined || file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
    const { updatedAt } = await api.putBook(id, section.data, markdown);
    process.stderr.write(`${section.data} updated at ${new Date(updatedAt).toISOString()}\n`);
    return 0;
  },
};

export const showCommand: Command = {
  name: "book show",
  summary: "Print the book's sections as Markdown (all, or one with --section).",
  usage: "acta book show <id> [--section name]",
  args: [{ name: "id", summary: "Meeting id.", required: true }],
  flags: [{ name: "section", type: "string", placeholder: "name", summary: `One of ${BOOK_SECTIONS.join(", ")}.` }],
  async run(p) {
    const id = arg(p, "id");
    const book = await api.book(id);
    const only = str(p, "section");
    if (only !== undefined) {
      const s = BookSectionSchema.safeParse(only);
      if (!s.success) throw new UsageError(`section must be one of ${BOOK_SECTIONS.join(", ")}`);
      process.stdout.write(`${book.sections[s.data] ?? ""}\n`);
      return 0;
    }
    const parts = [`# ${book.title}`];
    for (const s of BOOK_SECTIONS) {
      const body = book.sections[s];
      if (body === undefined || (body.trim() === "" && s !== "transcript")) continue;
      parts.push(`## ${s[0]?.toUpperCase()}${s.slice(1)}\n\n${body.trim()}`);
    }
    process.stdout.write(`${parts.join("\n\n")}\n`);
    return 0;
  },
};
