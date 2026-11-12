// Local files shared by the owner-only setup scripts: the .env writer and the evidence journal.
// Never imported by the agent or MCP server.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PublicError } from "../src/errors.ts";
import { isObject, parseJson } from "../src/json.ts";

/**
 * Set each name in the .env file at envPath and in `env`, replacing any earlier line for it.
 * The new file is written beside the old one with owner-only permissions and renamed into place.
 */
export function saveEnv(
  envPath: string,
  env: Record<string, string | undefined>,
  values: Record<string, string>,
): void {
  let content = readFileSync(envPath, "utf8");
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(value))
      throw new PublicError(
        `Refusing to write ${name} to .env: invalid name or value.`,
      );
    content = `${content.replace(new RegExp(`^${name}=.*$\\n?`, "m"), "").trimEnd()}\n${name}=${value}\n`;
  }
  const temp = `${envPath}.proven-setup-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  renameSync(temp, envPath);
  Object.assign(env, values);
}

/** The evidence journal at path, or an empty one if the file does not exist yet. */
export function loadJournal(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = parseJson(readFileSync(path, "utf8"), path);
  if (!isObject(value)) throw new PublicError(`${path} is not a JSON object.`);
  return value;
}

export function writeJournal(
  path: string,
  evidence: Record<string, unknown>,
): void {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}
