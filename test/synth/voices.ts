// Scripted dialogue → one WAV per speaker. macOS `say` speaks each line,
// ffmpeg places it at its fixture offset over silence, so all speakers'
// files share one timeline and overlap exactly as scripted. Output is
// 48 kHz mono pcm_s16le (what Chromium's fake mic reads). Cached by content
// under $TMPDIR/acta-synth/.
import { mkdir, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const FixtureLineSchema = z.object({
  /** Seconds from the start of the dialogue (before the lead-in). */
  at: z.number().nonnegative(),
  who: z.string().min(1),
  text: z.string().min(1),
  /** What the paragraph rule must make of this line; `aside` is the backchannel. */
  expect: z.enum(["aside", "overlap", "change"]).optional(),
}).strict();
export type FixtureLine = z.infer<typeof FixtureLineSchema>;

export const FixtureSchema = z.object({
  title: z.string().min(1),
  /** Silence before every speaker's first line, seconds. */
  leadIn: z.number().nonnegative().default(1),
  /** Silence after the last line, seconds (lets the final transcripts land). */
  tail: z.number().nonnegative().default(2),
  keywords: z.array(z.string()).optional(),
  speakers: z.array(z.object({ tag: z.string().regex(/^[a-z0-9-]+$/), voice: z.string().min(1) }).strict()).min(1),
  lines: z.array(FixtureLineSchema).min(1),
}).strict().superRefine((f, ctx) => {
  const tags = new Set(f.speakers.map((s) => s.tag));
  f.lines.forEach((l, i) => {
    if (!tags.has(l.who)) ctx.addIssue({ code: "custom", path: ["lines", i, "who"], message: `unknown speaker ${l.who}` });
  });
});
export type Fixture = z.infer<typeof FixtureSchema>;

export async function loadFixture(path: string): Promise<Fixture> {
  return FixtureSchema.parse(JSON.parse(await Bun.file(path).text()));
}

export const CACHE_DIR = join(process.env.TMPDIR ?? tmpdir(), "acta-synth");
export const SAMPLE_RATE = 48_000;

function hash(...parts: string[]): string {
  return new Bun.CryptoHasher("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch { return false; }
}

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (${r.exitCode}): ${r.stderr.toString().trim().slice(-600)}`);
  return r.stdout.toString();
}

const FFMPEG = process.env.ACTA_FFMPEG ?? (Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg");
const FFPROBE = process.env.ACTA_FFPROBE ?? (Bun.which("ffprobe") ?? "/opt/homebrew/bin/ffprobe");

/** Duration of an audio file in seconds. */
export function probeDuration(path: string): number {
  const out = run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]).trim();
  const d = Number(out);
  if (!Number.isFinite(d)) throw new Error(`ffprobe: no duration for ${path}: ${out}`);
  return d;
}

/** Voices `say` can use right now (names before the locale column). */
export function installedVoices(): string[] {
  return run(["say", "-v", "?"]).split("\n")
    .map((l) => /^(.+?)\s{2,}[a-z]{2}_[A-Z]{2}/.exec(l)?.[1]?.trim())
    .filter((v): v is string => !!v);
}

/** One spoken line as AIFF, cached by voice + text. */
export async function speakLine(text: string, voice: string): Promise<{ path: string; seconds: number }> {
  await mkdir(join(CACHE_DIR, "lines"), { recursive: true });
  const path = join(CACHE_DIR, "lines", `${hash(voice, text)}.aiff`);
  if (!(await exists(path))) {
    const tmp = `${path}.${process.pid}.tmp.aiff`;
    run(["say", "-v", voice, "-o", tmp, text]);
    await rename(tmp, path);
  }
  return { path, seconds: probeDuration(path) };
}

export type SynthLine = { at: number; text: string };

/**
 * One speaker's lines → WAV. Each line starts at `leadIn + at` seconds; the
 * file lasts `totalSec` (pass the same value for every speaker of a fixture).
 */
export async function synthesize(lines: SynthLine[], voice: string, opts: { totalSec: number; leadInSec?: number }): Promise<string> {
  const leadIn = opts.leadInSec ?? 0;
  const spoken = await Promise.all(lines.map((l) => speakLine(l.text, voice)));
  const key = hash(voice, String(opts.totalSec), String(leadIn), JSON.stringify(lines), String(SAMPLE_RATE));
  const out = join(CACHE_DIR, `${key}.wav`);
  if (await exists(out)) return out;

  const inputs = ["-f", "lavfi", "-t", opts.totalSec.toFixed(3), "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono`];
  const chains: string[] = [];
  const labels = ["[0:a]"];
  spoken.forEach((s, i) => {
    inputs.push("-i", s.path);
    const ms = Math.round((leadIn + (lines[i]?.at ?? 0)) * 1000);
    chains.push(`[${i + 1}:a]aresample=${SAMPLE_RATE},aformat=channel_layouts=mono,adelay=${ms}:all=1[l${i}]`);
    labels.push(`[l${i}]`);
  });
  const filter = [...chains, `${labels.join("")}amix=inputs=${labels.length}:duration=first:normalize=0[out]`].join(";");
  const tmp = `${out}.${process.pid}.tmp.wav`;
  run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter,
    "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", tmp]);
  await rename(tmp, out);
  return out;
}

export type FixtureAudio = {
  /** Speaker tag → WAV path. */
  wavs: Record<string, string>;
  /** Length of every WAV, seconds. */
  totalSec: number;
  /** Per line: when it starts and ends in the WAV, seconds. */
  timeline: { who: string; text: string; start: number; end: number }[];
  /** Same-speaker lines that run into each other (a fixture bug). */
  warnings: string[];
};

/** Synthesize every speaker of a fixture onto one shared timeline. */
export async function synthesizeFixture(f: Fixture): Promise<FixtureAudio> {
  const installed = new Set(installedVoices());
  for (const s of f.speakers) {
    if (!installed.has(s.voice)) throw new Error(`voice "${s.voice}" is not installed (say -v '?'); add it in System Settings → Accessibility → Spoken Content`);
  }
  const voiceOf = new Map(f.speakers.map((s) => [s.tag, s.voice]));
  const timeline = await Promise.all(f.lines.map(async (l) => {
    const { seconds } = await speakLine(l.text, voiceOf.get(l.who) ?? "");
    return { who: l.who, text: l.text, start: f.leadIn + l.at, end: f.leadIn + l.at + seconds };
  }));
  const warnings: string[] = [];
  for (const s of f.speakers) {
    const mine = timeline.filter((t) => t.who === s.tag).sort((a, b) => a.start - b.start);
    for (let i = 1; i < mine.length; i++) {
      const prev = mine[i - 1], cur = mine[i];
      if (prev && cur && prev.end > cur.start) warnings.push(`${s.tag}: "${prev.text.slice(0, 30)}…" runs ${(prev.end - cur.start).toFixed(1)} s into the next line`);
    }
  }
  const totalSec = Math.ceil((Math.max(...timeline.map((t) => t.end)) + f.tail) * 10) / 10;
  const wavs: Record<string, string> = {};
  for (const s of f.speakers) {
    const lines = f.lines.filter((l) => l.who === s.tag).map((l) => ({ at: l.at, text: l.text }));
    wavs[s.tag] = await synthesize(lines, s.voice, { totalSec, leadInSec: f.leadIn });
  }
  return { wavs, totalSec, timeline, warnings };
}

// `bun test/synth/voices.ts [fixture]`: build the WAVs and print the timeline.
if (import.meta.main) {
  const path = process.argv[2] ?? join(import.meta.dir, "fixtures", "two-speakers.json");
  const audio = await synthesizeFixture(await loadFixture(path));
  for (const t of audio.timeline) console.log(`${t.start.toFixed(1).padStart(5)}-${t.end.toFixed(1).padStart(5)}  ${t.who.padEnd(4)} ${t.text}`);
  for (const w of audio.warnings) console.log(`warn ${w}`);
  for (const [tag, wav] of Object.entries(audio.wavs)) console.log(`${tag} ${wav} ${probeDuration(wav).toFixed(2)} s`);
  console.log(`total ${audio.totalSec} s`);
}
