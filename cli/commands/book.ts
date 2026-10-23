// `acta book put` (the brain writes) and `acta book show` (read before writing).
import { api } from "../client.ts";
import { BOOK_SECTIONS, type BookSection, type WritableBookSectionSchema } from "../../src/core/schemas.ts";
import type { z } from "zod";

export type WritableSection = z.infer<typeof WritableBookSectionSchema>;

/** Markdown from a file, or stdin when the file is `-` or omitted. */
export async function readMarkdown(file: string | undefined): Promise<string> {
  return file === undefined || file === "-" ? Bun.stdin.text() : Bun.file(file).text();
}

export async function putSection(id: string, section: WritableSection, file: string | undefined) {
  const markdown = await readMarkdown(file);
  const { updatedAt } = await api.putBook(id, section, markdown);
  return { section, bytes: Buffer.byteLength(markdown), updatedAt: new Date(updatedAt).toISOString() };
}

/** The whole book as one Markdown document, or one section's body. */
export function renderBook(book: { title: string; sections: Partial<Record<BookSection, string>> }, only?: BookSection): string {
  if (only !== undefined) return book.sections[only] ?? "";
  const parts = [`# ${book.title}`];
  for (const s of BOOK_SECTIONS) {
    const body = book.sections[s];
    if (body === undefined || (body.trim() === "" && s !== "transcript")) continue;
    parts.push(`## ${s[0]?.toUpperCase()}${s.slice(1)}\n\n${body.trim()}`);
  }
  return parts.join("\n\n");
}

export async function showBook(id: string, only: BookSection | undefined): Promise<string> {
  return renderBook(await api.book(id), only);
}
