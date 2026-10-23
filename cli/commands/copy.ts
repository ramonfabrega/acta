// `acta copy`: vendor → R2, now. The webhook copies on its own; this is the
// recovery when `acta doctor` lists a recording as not copied (vendor copies
// expire in seven days). `acta sync` is the other direction, R2 → laptop.
import { api } from "../client.ts";
import type { CopyAnswer } from "../../src/core/schemas.ts";

export type CopyReport = CopyAnswer & { copied: number; pending: number; failed: string[] };

/** Totals over the copy rows; pure, exported for tests. */
export function summarize(a: CopyAnswer): CopyReport {
  const copied = a.copies.filter((c) => c.status === "copied").length;
  const pending = a.copies.filter((c) => c.status === "pending").length;
  const failed = a.copies.filter((c) => c.status !== "copied" && c.status !== "pending").map((c) => c.key);
  return { ...a, copied, pending, failed };
}

export async function copyRecording(id: string): Promise<CopyReport> {
  return summarize(await api.copy(id));
}
