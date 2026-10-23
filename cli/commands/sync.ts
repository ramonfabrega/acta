// `acta sync`: R2 → ~/.acta/meetings/<id>/, where batch passes and lore start.
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type Command } from "../args.ts";
import { api, relativeKey } from "../client.ts";
import { bytes } from "./fmt.ts";

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

async function syncOne(root: string, id: string): Promise<{ got: number; skipped: number; bytes: number }> {
  const files = await api.files(id);
  let got = 0, skipped = 0, total = 0;
  for (const f of files) {
    const rel = relativeKey(id, f.key);
    const path = localPath(root, id, rel);
    if (!path) { process.stderr.write(`skip unsafe key ${f.key}\n`); continue; }
    if ((await sizeOf(path)) === f.size) { skipped++; continue; }
    await mkdir(dirname(path), { recursive: true });
    const res = await api.file(id, rel);
    const tmp = `${path}.part`;
    const n = await Bun.write(tmp, res);
    await rename(tmp, path);
    if (n !== f.size) process.stderr.write(`warn ${rel}: listed ${f.size} B, got ${n} B\n`);
    got++; total += n;
    process.stderr.write(`${id}/${rel} ${bytes(n)}\n`);
  }
  return { got, skipped, bytes: total };
}

export const command: Command = {
  name: "sync",
  summary: "Copy a meeting's R2 files (or every meeting's) to ~/.acta/meetings/<id>/, skipping same-size files.",
  usage: "acta sync [id]",
  args: [{ name: "id", summary: "Meeting id; omitted syncs every listed meeting." }],
  flags: [],
  notes: "ACTA_HOME overrides ~/.acta. Prints the local directory of each meeting on stdout.",
  async run(p) {
    const root = meetingsRoot();
    const ids = p.args.id ? [p.args.id] : (await api.meetings()).map((m) => m.id);
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await syncOne(root, id);
        process.stdout.write(`${join(root, id)}\n`);
        process.stderr.write(`${id}: ${r.got} fetched (${bytes(r.bytes)}), ${r.skipped} unchanged\n`);
      } catch (e) {
        // One meeting failing must not stop the rest of a full sync.
        if (ids.length === 1) throw e;
        failed++;
        process.stderr.write(`${id}: ${e instanceof Error ? e.toString() : String(e)}\n`);
      }
    }
    return failed ? 1 : 0;
  },
};
