// `acta new`: mint a meeting; the URL is what you share by hand. The session
// that runs it is the meeting's brain, so the answer also carries the events
// socket URL it arms Monitor on (docs/BRAIN.md).
import { api, eventsUrl } from "../client.ts";

export function parseKeywords(csv: string | undefined): string[] {
  return (csv ?? "").split(",").map((k) => k.trim()).filter(Boolean);
}

export async function createMeeting(title: string, keywordsCsv: string | undefined) {
  const m = await api.createMeeting(title, parseKeywords(keywordsCsv));
  return { id: m.id, url: m.url, title: m.title, createdAt: m.createdAt, events: eventsUrl(m.id) };
}
