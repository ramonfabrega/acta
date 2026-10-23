// `acta meetings`: what exists and in which state (check before deploying).
import { api } from "../client.ts";
import { instant } from "../fmt.ts";

export async function listMeetings() {
  const list = await api.meetings();
  const meetings = list.map((m) => ({ id: m.id, state: m.state ?? null, created: instant(m.createdAt), title: m.title ?? "" }));
  return { count: meetings.length, live: meetings.filter((m) => m.state === "live" || m.state === "ending").length, meetings };
}
