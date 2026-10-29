/**
 * Generate a NEW Ed25519 receipt signing key and print it to stdout.
 * Nothing is written to disk: paste the values into your secret store
 * (e.g. Vercel environment variables) and clear your terminal afterwards.
 *
 *   npm run keygen
 */
import { randomBytes } from "node:crypto";
import { deriveKeyId, loadSigningKey } from "../packages/seller/src/keys.ts";

const seed = randomBytes(32).toString("base64url");
const key = loadSigningKey(seed);
const keyId = deriveKeyId(key.publicKeyRaw);

process.stdout.write(
  [
    "# Secret: set as an environment variable only. Do not commit.",
    `RECEIPT_SIGNING_KEY=${seed}`,
    `RECEIPT_KEY_ID=${keyId}`,
    "",
    "# Public (appears in /.well-known/x402-receipt.json):",
    `public_key=${key.publicKey}`,
    "",
  ].join("\n"),
);
