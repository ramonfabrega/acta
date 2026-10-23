import { beforeAll, describe, expect, test } from "bun:test";
import { pemToSpki, verifyRtkSignature } from "../../src/core/webhook.ts";

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");

let pem = "";
let otherPem = "";
let privateKey: CryptoKey;
const body = new TextEncoder().encode(JSON.stringify({ event: "meeting.ended", meeting: { id: "m_1" } }));
let sig = "";

async function keypair() {
  const kp = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in kp)) throw new Error("expected a key pair");
  const der = await crypto.subtle.exportKey("spki", kp.publicKey);
  if (!(der instanceof ArrayBuffer)) throw new Error("expected DER");
  const spki = b64(der);
  const lines = spki.match(/.{1,64}/g) ?? [];
  return { kp, pem: `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n` };
}

beforeAll(async () => {
  const a = await keypair();
  const b = await keypair();
  pem = a.pem;
  otherPem = b.pem;
  privateKey = a.kp.privateKey;
  sig = b64(await crypto.subtle.sign(ALG, privateKey, body));
});

describe("verifyRtkSignature", () => {
  test("a good signature verifies (Uint8Array and ArrayBuffer bodies)", async () => {
    expect(await verifyRtkSignature(body, sig, pem)).toBe(true);
    expect(await verifyRtkSignature(body.slice().buffer, sig, pem)).toBe(true);
  });

  test("a view into a larger buffer verifies on its own bytes", async () => {
    const big = new Uint8Array(body.length + 10);
    big.set(body, 5);
    expect(await verifyRtkSignature(big.subarray(5, 5 + body.length), sig, pem)).toBe(true);
  });

  test("a tampered body fails", async () => {
    const t = body.slice();
    t[3] = (t[3] ?? 0) ^ 1;
    expect(await verifyRtkSignature(t, sig, pem)).toBe(false);
  });

  test("the wrong key fails", async () => {
    expect(await verifyRtkSignature(body, sig, otherPem)).toBe(false);
  });

  test("malformed inputs are false, not a throw", async () => {
    expect(await verifyRtkSignature(body, "", pem)).toBe(false);
    expect(await verifyRtkSignature(body, "!!!not base64", pem)).toBe(false);
    expect(await verifyRtkSignature(body, sig, "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toBe(false);
    expect(await verifyRtkSignature(body, sig, "")).toBe(false);
  });

  test("pemToSpki strips armour and whitespace", () => {
    const der = pemToSpki(pem);
    expect(der[0]).toBe(0x30); // DER SEQUENCE
    expect(() => pemToSpki("-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----")).toThrow();
  });
});
