/** Only messages explicitly created here or at validated boundaries may reach agent output. */
export class PublicError extends Error {}

export function publicMessage(error: unknown): string {
  return error instanceof PublicError
    ? error.message
    : "The operation failed. Check the local service configuration and evidence.";
}

/** A safe label for a failure: a timeout, a system code such as ECONNREFUSED, or the error's class
 * name. It never includes the message, which may echo a URL, key or private text. */
export function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "TimeoutError" || error.name === "AbortError")
    return "timeout";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)
    ? code
    : error.name;
}

/** A network service that did not answer, named with a safe code and keeping the original as its cause. */
export function unreachable(service: string, error: unknown): PublicError {
  return new PublicError(
    `${service} could not be reached (${safeCode(error)}).`,
    { cause: error },
  );
}
