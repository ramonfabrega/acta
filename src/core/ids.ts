// Small identity helpers shared by the Worker, Scribe and the CLI.

/** `"Ana María"` → `"ana-maria"`; never empty. */
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "guest";
}

/** Hex token from the platform CSPRNG; 32 bytes by default. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string equality for bearer and capability checks. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Short sortable id for paragraphs: ms timestamp + 4 random hex chars. */
export function paragraphId(t0: number): string {
  return `p${t0.toString(36)}${randomToken(2)}`;
}
