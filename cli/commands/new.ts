// `acta new`: mint a meeting; the URL is what you share by hand.
import { str, type Command } from "../args.ts";
import { api } from "../client.ts";

export const command: Command = {
  name: "new",
  summary: "Create a meeting. Prints the room URL on stdout and the meeting id on stderr.",
  usage: "acta new <title> [--keywords a,b,c]",
  args: [{ name: "title", summary: "Meeting title (quote it).", required: true }],
  flags: [
    { name: "keywords", type: "string", placeholder: "a,b,c", summary: "Comma-separated transcription keywords (names, projects)." },
  ],
  notes: "The session that runs `acta new` is the meeting's brain: it arms Monitor on the events socket with the id from stderr.",
  async run(p) {
    const title = p.args.title ?? "";
    const keywords = (str(p, "keywords") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    const m = await api.createMeeting(title, keywords);
    process.stdout.write(`${m.url}\n`);
    process.stderr.write(`${m.id}\n`);
    return 0;
  },
};
