// Cloudflare Access JWT verification: RS256 against the team's published
// certs, `aud` and `iss` checked, keys cached per isolate. Only used when
// CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are both set.
import { z } from "zod";

const JwkSchema = z.object({ kid: z.string(), kty: z.literal("RSA"), n: z.string(), e: z.string(), alg: z.string().optional() }).loose();
const CertsSchema = z.object({ keys: z.array(JwkSchema) }).loose();
const HeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string() }).loose();
const ClaimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string(),
  exp: z.number(),
  nbf: z.number().optional(),
  email: z.string().optional(),
}).loose();

export type AccessIdentity = { email: string | null };

type KeySet = { at: number; keys: Map<string, CryptoKey> };
const cache = new Map<string, KeySet>();
const KEYS_TTL_MS = 10 * 60 * 1000;

export function teamOrigin(team: string): string {
  const host = team.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}`;
}

async function keysFor(origin: string, refresh: boolean): Promise<Map<string, CryptoKey>> {
  const hit = cache.get(origin);
  if (hit && !refresh && Date.now() - hit.at < KEYS_TTL_MS) return hit.keys;
  const res = await fetch(`${origin}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const certs = CertsSchema.parse(await res.json());
  const keys = new Map<string, CryptoKey>();
  for (const jwk of certs.keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  cache.set(origin, { at: Date.now(), keys });
  return keys;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

/** The token from the header Access injects, else its cookie. */
export function accessToken(req: Request): string | null {
  const h = req.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

/** Verified identity, or null when the token is missing, malformed, expired or for another app. */
export async function verifyAccess(token: string, team: string, aud: string, nowMs = Date.now()): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;
  let header: z.infer<typeof HeaderSchema>;
  let claims: z.infer<typeof ClaimsSchema>;
  try {
    header = HeaderSchema.parse(b64urlJson(h));
    claims = ClaimsSchema.parse(b64urlJson(p));
  } catch {
    return null;
  }
  const origin = teamOrigin(team);
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = b64urlBytes(s);
  let key = (await keysFor(origin, false)).get(header.kid);
  if (!key) key = (await keysFor(origin, true)).get(header.kid);
  if (!key) return null;
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data))) return null;
  const now = Math.floor(nowMs / 1000);
  if (claims.exp < now - 30) return null;
  if (claims.nbf !== undefined && claims.nbf > now + 30) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  if (claims.iss !== origin) return null;
  return { email: claims.email ?? null };
}
