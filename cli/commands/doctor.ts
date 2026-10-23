// `acta doctor`: meetings that need a human. Vendor copies expire in seven
// days, so an ended meeting without its recording in R2 is the main alarm.
import { type Command } from "../args.ts";
import { api, baseUrl } from "../client.ts";
import type { MeetingStatus } from "../../src/core/schemas.ts";
import { table } from "./fmt.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Problems with one meeting, empty when it is fine. Pure; exported for tests. */
export function diagnose(s: MeetingStatus, now: number): string[] {
  const out: string[] = [];
  if (s.state === "live" || s.state === "ending") {
    const since = s.session?.startedAt ?? s.createdAt;
    if (now - since > 3 * HOUR) out.push(`${s.state} for ${((now - since) / HOUR).toFixed(1)} h`);
  }
  if (s.state === "ended") {
    const recCopies = s.copies.filter((c) => /record/i.test(c.kind) || c.key.includes("/recordings/"));
    const failed = recCopies.filter((c) => /err|fail/i.test(c.status));
    const age = now - (s.session?.endedAt ?? s.createdAt);
    if (s.recording && recCopies.length === 0) {
      out.push(age > 7 * DAY ? "recording never copied; vendor URL has expired" : `recording ${s.recording.id} not copied yet (${s.recording.status})`);
    }
    if (failed.length) out.push(`${failed.length} copy error(s): ${failed.map((c) => c.key).join(", ")}`);
    if (!s.recording && s.participants.length > 0) out.push("humans joined but no track recording was started");
  }
  return out;
}

export const command: Command = {
  name: "doctor",
  summary: "Check the Worker, then list meetings ended without their recordings in R2 or live for more than 3 h.",
  usage: "acta doctor",
  args: [],
  flags: [],
  notes: "Exits 1 when anything is listed.",
  async run() {
    const h = await api.health();
    process.stderr.write(`${baseUrl()} ok=${h.ok}${h.version ? ` version=${h.version}` : ""}\n`);
    const list = await api.meetings();
    const now = Date.now();
    const rows: string[][] = [];
    for (const m of list) {
      if (m.state !== "ended" && m.state !== "live" && m.state !== "ending") continue;
      try {
        const s = await api.status(m.id);
        for (const problem of diagnose(s, now)) rows.push([m.id, s.state, problem]);
      } catch (e) {
        rows.push([m.id, m.state ?? "-", `status failed: ${e instanceof Error ? e.message : String(e)}`]);
      }
    }
    if (rows.length === 0) { process.stderr.write(`${list.length} meetings, nothing to fix\n`); return h.ok ? 0 : 1; }
    process.stdout.write(table(["id", "state", "problem"], rows));
    return 1;
  },
};
