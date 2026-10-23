// A synthetic speaker: headless Chromium whose microphone is a WAV file,
// loading the bot page that joins the room. The flags are the ones that
// worked in the spike; `AudioServiceSandbox,AudioServiceOutOfProcess` off is
// what lets the fake-capture file be read at all on macOS.
import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PLAYWRIGHT = join(homedir(), "Library", "Caches", "ms-playwright");
const BINARIES = [
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  "chrome-linux64/chrome",
  "chrome-linux/chrome",
];

/** `ACTA_CHROME`, else the newest Playwright `chromium-<rev>` build. */
export async function findChrome(): Promise<string> {
  const env = process.env.ACTA_CHROME;
  if (env) {
    if (await Bun.file(env).exists()) return env;
    throw new Error(`ACTA_CHROME=${env} does not exist`);
  }
  let dirs: string[] = [];
  try { dirs = await readdir(PLAYWRIGHT); } catch { /* none */ }
  const revs = dirs
    .map((d) => /^chromium-(\d+)$/.exec(d))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of revs) {
    for (const bin of BINARIES) {
      const path = join(PLAYWRIGHT, m[0], bin);
      if (await Bun.file(path).exists()) return path;
    }
  }
  throw new Error(`no Chromium under ${PLAYWRIGHT} (bunx playwright install chromium) and ACTA_CHROME unset`);
}

export function chromeArgs(o: { url: string; wav: string; profileDir: string; loop?: boolean }): string[] {
  return [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    // Audio service in-process and unsandboxed: the fake-capture WAV is read.
    // LocalNetworkAccessChecks off: a page served by the Worker may POST to the local relay.
    "--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
    `--user-data-dir=${o.profileDir}`,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // `%noloop`: play the file once, then silence (Chromium loops it otherwise).
    `--use-file-for-fake-audio-capture=${o.wav}${o.loop ? "" : "%noloop"}`,
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=800,600",
    o.url,
  ];
}

export type Speaker = { pid: number; tag: string; log: string; exited: Promise<number>; stop(): Promise<void> };

/**
 * Launch one speaker. `url` is the bot page with its fragment
 * (`#authToken=…&tag=…&relay=…`). The profile dir is wiped before and after.
 */
export async function launchSpeaker(o: { url: string; wav: string; tag: string; profileDir?: string; loop?: boolean; chrome?: string }): Promise<Speaker> {
  const chrome = o.chrome ?? (await findChrome());
  const profileDir = o.profileDir ?? join(process.env.TMPDIR ?? tmpdir(), "acta-synth", "profiles", `${o.tag}-${process.pid}-${Date.now()}`);
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  const log = `${profileDir}.log`;
  const args = chromeArgs({ url: o.url, wav: o.wav, profileDir, ...(o.loop !== undefined ? { loop: o.loop } : {}) });
  const proc = Bun.spawn([chrome, ...args], { stdout: "ignore", stderr: Bun.file(log), stdin: "ignore" });
  let stopped = false;
  return {
    pid: proc.pid,
    tag: o.tag,
    log,
    exited: proc.exited,
    async stop() {
      if (stopped) return;
      stopped = true;
      proc.kill("SIGTERM");
      const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(4000).then(() => false)]);
      if (!done) proc.kill("SIGKILL");
      // Renderer/GPU children carry the same profile flag; make sure none linger.
      Bun.spawnSync(["pkill", "-f", `user-data-dir=${profileDir}`]);
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}
