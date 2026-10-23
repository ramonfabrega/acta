// `acta sync`: R2 → ~/.acta/meetings/<id>/, where batch passes and lore start.
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { api, relativeKey } from "../client.ts";
import { bytes } from "../fmt.ts";

/** `ACTA_HOME` (default `~/.acta`) + `/meetings`. */
export function meetingsRoot(): string {
  return join(process.env.ACTA_HOME ?? join(homedir(), ".acta"), "meetings");
}

/** Local path for a key, refusing anything that escapes the meeting dir. */
export function localPath(root: string, id: string, rel: string): string | null {
  const dir = resolve(root, id);
  const target = resolve(dir, rel);
  if (rel === "" || !target.startsWith(dir + sep)) return null;
  return target;
}

async function sizeOf(path: string): Promise<number | null> {
  try { return (await stat(path)).size; } catch { return null; }
}

async function syncOne(root: string, id: string): Promise<{ fetched: number; unchanged: number; bytes: number }> {
  const files = await api.files(id);
  let fetched = 0, unchanged = 0, total = 0;
  for (const f of files) {
    const rel = relativeKey(id, f.key);
    const path = localPath(root, id, rel);
    if (!path) { process.stderr.write(`skip unsafe key ${f.key}\n`); continue; }
    if ((await sizeOf(path)) === f.size) { unchanged++; continue; }
    await mkdir(dirname(path), { recursive: true });
    const res = await api.file(id, rel);
    const tmp = `${path}.part`;
    const n = await Bun.write(tmp, res);
    await rename(tmp, path);
    if (n !== f.size) process.stderr.write(`warn ${rel}: listed ${f.size} B, got ${n} B\n`);
    fetched++; total += n;
    process.stderr.write(`${id}/${rel} ${bytes(n)}\n`);
  }
  return { fetched, unchanged, bytes: total };
}

export type SyncRow =
  | { id: string; dir: string; fetched: number; unchanged: number; bytes: number }
  | { id: string; dir: string; error: string };

/** One row per meeting as it lands; returns how many failed. One failing meeting never stops a full sync. */
export async function* syncMeetings(id: string | undefined): AsyncGenerator<SyncRow, { root: string; failed: string[] }> {
  const root = meetingsRoot();
  const ids = id ? [id] : (await api.meetings()).map((m) => m.id);
  const failed: string[] = [];
  for (const mid of ids) {
    const dir = join(root, mid);
    try {
      yield { id: mid, dir, ...(await syncOne(root, mid)) };
    } catch (e) {
      if (ids.length === 1) throw e;
      failed.push(mid);
      yield { id: mid, dir, error: e instanceof Error ? e.toString() : String(e) };
    }
  }
  return { root, failed };
}
