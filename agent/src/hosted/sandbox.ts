// The client for the code sandbox, which runs on its own isolated machine. Output from it is untrusted,
// and goes back to the model as data. It never decides anything: a test result here pays nobody. Only the
// verifier's verdict, through the escrow's callback, does.
import { isObject } from "../json.ts";

export interface SandboxRun {
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  ms: number;
  output: string;
  repo_bytes: number;
}

export interface SandboxRequest {
  language: "python" | "node";
  command: string;
  files?: Record<string, string>;
  repo?: { owner: string; name: string; commit: string };
}

export type SandboxCall = (
  request: SandboxRequest,
  agent: string,
) => Promise<SandboxRun>;

/** A sandbox reply in the shape the client promises, or null. */
function sandboxRun(value: unknown): SandboxRun | null {
  if (!isObject(value)) return null;
  const { exit_code, timed_out, truncated, ms, output, repo_bytes } = value;
  if (
    (exit_code !== null && typeof exit_code !== "number") ||
    typeof timed_out !== "boolean" ||
    typeof truncated !== "boolean" ||
    typeof ms !== "number" ||
    typeof repo_bytes !== "number" ||
    typeof output !== "string"
  )
    return null;
  return { exit_code, timed_out, truncated, ms, output, repo_bytes };
}

export function sandboxClient(url: string, token: string): SandboxCall {
  return async (request, agent) => {
    const response = await fetch(`${url}/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-agent": agent,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(75_000),
      redirect: "error",
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("The sandbox sent an unreadable reply.");
    }
    if (!response.ok)
      throw new Error(
        isObject(body) && typeof body.error === "string"
          ? body.error
          : "The sandbox refused this.",
      );
    const run = sandboxRun(body);
    if (!run) throw new Error("The sandbox sent a malformed result.");
    return run;
  };
}

/** The files a request may carry: names to text, nothing else. */
const isFiles = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((v) => typeof v === "string");
const isRepo = (value: unknown): value is SandboxRequest["repo"] =>
  isObject(value) &&
  typeof value.owner === "string" &&
  typeof value.name === "string" &&
  typeof value.commit === "string";

/** Runs a skill's text input, which the model writes. `run_code` is the only way code runs at all. */
export async function runCodeSkill(
  sandbox: SandboxCall,
  skill: "run_code" | "run_tests" | "read_repo" | "make_patch",
  input: string,
  agent: string,
): Promise<{ output: string; ran: boolean }> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    value = undefined;
  }
  if (!isObject(value))
    return {
      output: `Error: ${skill} takes JSON: {"language","command","files","repo":{"owner","name","commit"}}.`,
      ran: false,
    };
  if (value.language !== "python" && value.language !== "node")
    return { output: "Error: language must be python or node.", ran: false };
  if (typeof value.command !== "string")
    return { output: "Error: give a command as text.", ran: false };
  if (value.files !== undefined && !isFiles(value.files))
    return {
      output: "Error: files must map file names to text.",
      ran: false,
    };
  if (value.repo !== undefined && !isRepo(value.repo))
    return {
      output: "Error: repo needs owner, name and commit as text.",
      ran: false,
    };
  const request: SandboxRequest = {
    language: value.language,
    command: value.command,
    files: value.files ?? {},
    repo: value.repo,
  };
  try {
    const run = await sandbox(request, agent);
    return {
      ran: true,
      output: JSON.stringify({
        exit_code: run.exit_code,
        timed_out: run.timed_out,
        truncated: run.truncated,
        output: run.output.slice(0, 8_192),
      }),
    };
  } catch (error) {
    // A refusal costs the agent nothing.
    return {
      output: `Error: ${(error as Error).message.slice(0, 200)}`,
      ran: false,
    };
  }
}
