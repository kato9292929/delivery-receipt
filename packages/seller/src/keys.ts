import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { base64urlEncode, receiptSigningBytes, type ReceiptPayload } from "@delivery-receipt/verify";

/** DER prefix of a PKCS8 Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SigningKey {
  privateKey: KeyObject;
  /** Raw 32-byte public key. */
  publicKeyRaw: Uint8Array;
  /** base64url of the raw public key, as published in the well-known document. */
  publicKey: string;
}

/**
 * Load an Ed25519 signing key from either a PKCS8 PEM or a base64/base64url
 * encoded 32-byte seed.
 */
export function loadSigningKey(input: string): SigningKey {
  const trimmed = input.trim();
  let privateKey: KeyObject;
  if (trimmed.includes("-----BEGIN")) {
    privateKey = createPrivateKey({ key: trimmed.replace(/\\n/g, "\n"), format: "pem" });
  } else {
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("RECEIPT_SIGNING_KEY: not base64/base64url");
    const seed = Buffer.from(b64, "base64");
    if (seed.length !== 32) {
      throw new Error(`RECEIPT_SIGNING_KEY: expected a 32-byte Ed25519 seed, got ${seed.length} bytes`);
    }
    privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("RECEIPT_SIGNING_KEY: not an Ed25519 key");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const publicKey = jwk.x as string;
  return { privateKey, publicKey, publicKeyRaw: new Uint8Array(Buffer.from(publicKey, "base64url")) };
}

/** Default key id: first 16 hex chars of sha256(raw public key). */
export function deriveKeyId(publicKeyRaw: Uint8Array): string {
  return createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, 16);
}

/** Ed25519 signature (base64url) over the canonical receipt payload. */
export function signPayload(payload: ReceiptPayload, privateKey: KeyObject): string {
  return base64urlEncode(new Uint8Array(sign(null, receiptSigningBytes(payload), privateKey)));
}
