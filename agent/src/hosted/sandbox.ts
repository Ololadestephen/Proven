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

export type SandboxCall = (request: SandboxRequest) => Promise<SandboxRun>;

export function sandboxClient(url: string, token: string): SandboxCall {
  return async (request) => {
    const response = await fetch(`${url}/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
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
): Promise<string> {
  let request: SandboxRequest;
  try {
    const value = JSON.parse(input) as SandboxRequest;
    if (value.language !== "python" && value.language !== "node")
      return "Error: language must be python or node.";
    if (typeof value.command !== "string")
      return "Error: give a command as text.";
    request = {
      language: value.language,
      command: value.command,
      files: value.files ?? {},
      repo: value.repo,
    };
  } catch {
    return `Error: ${skill} takes JSON: {"language","command","files","repo":{"owner","name","commit"}}.`;
  }
  try {
    const run = await sandbox(request);
    return JSON.stringify({
      exit_code: run.exit_code,
      timed_out: run.timed_out,
      truncated: run.truncated,
      output: run.output.slice(0, 8_192),
    });
  } catch (error) {
    return `Error: ${(error as Error).message.slice(0, 200)}`;
  }
}
