/** Only messages explicitly created here or at validated boundaries may reach agent output. */
export class PublicError extends Error {}

export function publicMessage(error: unknown): string {
  return error instanceof PublicError
    ? error.message
    : "The operation failed. Check the local service configuration and evidence.";
}
