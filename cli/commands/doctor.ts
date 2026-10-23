// `acta doctor`: meetings that need a human. Vendor copies expire in seven
// days, so an ended meeting without its recording in R2 is the main alarm.
import { api, baseUrl } from "../client.ts";
import type { MeetingStatus } from "../../src/core/schemas.ts";

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

export type Problem = { id: string; state: string; problem: string };

export async function doctorReport(now = Date.now()) {
  const h = await api.health();
  const list = await api.meetings();
  const problems: Problem[] = [];
  for (const m of list) {
    if (m.state !== "ended" && m.state !== "live" && m.state !== "ending") continue;
    try {
      const s = await api.status(m.id);
      for (const problem of diagnose(s, now)) problems.push({ id: m.id, state: s.state, problem });
    } catch (e) {
      problems.push({ id: m.id, state: m.state ?? "-", problem: `status failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { worker: { url: baseUrl(), ok: h.ok, version: h.version ?? null }, meetings: list.length, problems };
}
