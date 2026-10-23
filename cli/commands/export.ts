// `acta export`: the book plus transcript as Markdown, the way out of acta.
import { api } from "../client.ts";

/** The Markdown itself, or where it was written. */
export async function exportMeeting(id: string, out: string | undefined): Promise<string | { wrote: string; bytes: number }> {
  const md = await api.exportMarkdown(id);
  if (out === undefined) return md.endsWith("\n") ? md.slice(0, -1) : md;
  const bytes = await Bun.write(out, md);
  return { wrote: out, bytes };
}
