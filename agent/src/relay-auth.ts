// Signatures the relay asks for: NEP-413, addressed to the relay, naming the action, the job and a hash
// of the exact texts. A worker with a scoped key signs with it; a custody wallet signs through its API.
import { KeyPair } from "near-api-js";
import { nep413Digest, relayPayload } from "../../relay/src/buyer-auth.ts";
import {
  RELAY_RECIPIENT,
  relayMessage as message,
} from "../../shared/relay-auth.ts";

export { relayPayload };

export const relayMessage = (request: Record<string, unknown>) =>
  message(
    String(request.action),
    String(request.job_id),
    relayPayload(request),
    Date.now(),
  );

export function signWithKey(key: string, text: string) {
  const pair = KeyPair.fromString(key as `ed25519:${string}`);
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const digest = nep413Digest(text, nonce, RELAY_RECIPIENT);
  return {
    public_key: pair.getPublicKey().toString(),
    signature_base64: Buffer.from(pair.sign(digest).signature).toString(
      "base64",
    ),
    nonce_base64: nonce.toString("base64"),
  };
}
