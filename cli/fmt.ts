// Small output helpers shared by commands. An instant is UTC.

/** `2026-10-23 07:11:25Z` from epoch ms or an ISO string; `-` when absent. */
export function instant(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "-";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** `hh:mm:ss` (UTC) from epoch ms. */
export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Collapse whitespace to one line. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
