import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { PublicError } from "./errors.ts";

export async function handoff(
  socket: string,
  request: Record<string, unknown>,
): Promise<unknown> {
  const info = await lstat(socket).catch(() => null);
  if (
    !info?.isSocket() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new PublicError(
      "Private relay socket is unavailable or has unsafe permissions.",
    );
  const input = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(input) > 524288)
    throw new PublicError("Private input is too large.");
  return new Promise((resolve, reject) => {
    let data = "";
    const client = createConnection(socket);
    client.setTimeout(120000, () => client.destroy(new Error("timeout")));
    client.on("connect", () => client.end(input));
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 524288)
        client.destroy(new Error("large response"));
    });
    client.on("error", () =>
      reject(
        new PublicError(
          "Private relay handoff failed; no private text was logged.",
        ),
      ),
    );
    client.on("end", () => {
      try {
        const reply = JSON.parse(data) as { ok?: boolean; result?: unknown };
        if (reply.ok !== true) throw new Error("refused");
        resolve(reply.result);
      } catch {
        reject(
          new PublicError(
            "Private relay refused the handoff. Check job hashes and local relay state.",
          ),
        );
      }
    });
  });
}
