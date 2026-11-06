// The client for the code sandbox, which runs on its own isolated machine. Output from it is untrusted,
// and goes back to the model as data. It never decides anything: a test result here pays nobody. Only the
// verifier's verdict, through the escrow's callback, does.

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
    const body = (await response.json()) as SandboxRun & { error?: string };
    if (!response.ok)
      throw new Error(body.error ?? "The sandbox refused this.");
    return body;
  };
}

/** Runs a skill's text input, which the model writes. `run_code` is the only way code runs at all. */
export async function runCodeSkill(
  sandbox: SandboxCall,
  skill: "run_code" | "run_tests" | "read_repo" | "make_patch",
  input: string,
  agent: string,
): Promise<{ output: string; ran: boolean }> {
  let request: SandboxRequest;
  try {
    const value = JSON.parse(input) as SandboxRequest;
    if (value.language !== "python" && value.language !== "node")
      return { output: "Error: language must be python or node.", ran: false };
    if (typeof value.command !== "string")
      return { output: "Error: give a command as text.", ran: false };
    request = {
      language: value.language,
      command: value.command,
      files: value.files ?? {},
      repo: value.repo,
    };
  } catch {
    return {
      output: `Error: ${skill} takes JSON: {"language","command","files","repo":{"owner","name","commit"}}.`,
      ran: false,
    };
  }
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
