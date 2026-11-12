// The relay's signed-request protocol, shared by the relay, the agent tools and the web page. A request
// is a NEP-413 signature addressed to the relay over a message naming the action, the job and a hash of
// the exact texts. Hashing stays with each caller (node:crypto on servers, WebCrypto in the browser).

/** The recipient the buyer's wallet policy allows it to sign for, and nothing else. */
export const RELAY_RECIPIENT = "proven-relay";
/** NEP-413's prefix tag, 2^31 + 413. */
export const NEP413_TAG = 2147484061;

/** The text a signature binds to, before hashing, so a signed request cannot carry different texts. */
export function relayPayloadText(request: Record<string, unknown>): string {
  switch (request.action) {
    case "challenge":
      return `${String(request.check)}\0${String(request.reference)}`;
    case "deliver":
      return String(request.deliverable);
    case "cleanup":
      return String(request.kind);
    default:
      return "";
  }
}

/** The message a relay request signs: the action, the job id, the payload hash and the time. */
export const relayMessage = (
  action: string,
  id: number | string,
  payloadHex: string,
  atMs: number,
) => `${RELAY_RECIPIENT}:${action}:${id}:${payloadHex}:${atMs}`;
