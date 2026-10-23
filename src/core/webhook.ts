// RealtimeKit signs each webhook body with RSA-SHA256 (PKCS#1 v1.5) and sends
// the signature base64 in `rtk-signature`. The public key is SPKI PEM from
// /.well-known/webhooks.json. WebCrypto only, so this runs in Workers and Bun.

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const norm = b64.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PEM (`-----BEGIN PUBLIC KEY-----…`) → DER bytes of the SubjectPublicKeyInfo. */
export function pemToSpki(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("empty PEM");
  return base64ToBytes(body);
}

// Imported keys by PEM; the key rotates rarely and import is not free.
const keys = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let k = keys.get(pem);
  if (!k) {
    k = crypto.subtle.importKey("spki", pemToSpki(pem), ALG, false, ["verify"]);
    k.catch(() => keys.delete(pem));
    keys.set(pem, k);
  }
  return k;
}

function toBytes(body: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  // Copy: a view may sit on a shared or larger buffer.
  return body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body.slice(0));
}

/** True only for a valid signature; any malformed input (key, signature) is false, never a throw. */
export async function verifyRtkSignature(
  rawBody: ArrayBuffer | Uint8Array,
  signatureB64: string,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    if (!signatureB64.trim()) return false;
    const key = await importKey(publicKeyPem);
    return await crypto.subtle.verify(ALG, key, base64ToBytes(signatureB64), toBytes(rawBody));
  } catch {
    return false;
  }
}
