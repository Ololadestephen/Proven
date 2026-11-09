// Function-job skills: compile WebAssembly text, and try the function on the agent's own inputs, by the
// verifier's loading and calling rules. The work is done by skills/function, built to a WebAssembly module
// with no imports (`npm run build:skills`). Each request gets a fresh instance in a worker thread with a
// time limit, so a slow request cannot hold up the service. Nothing here decides anything: only the
// verifier's check run does.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInWorker } from "./worker-run.ts";

const DEFAULT_PATH = fileURLToPath(
  new URL("../../assets/function-skill.wasm", import.meta.url),
);
const TIME_LIMIT_MS = 10_000;
/** run_function returns up to 64 results, each about 90 bytes at most. */
const MAX_RESULT = 8 * 1024;
const MAX_CASES = 64;
const I64 = /^-?\d{1,19}$/;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const instance = new WebAssembly.Instance(workerData.module, {});
const input = Buffer.from(workerData.input, "utf8");
const pointer = instance.exports.alloc(input.length);
new Uint8Array(instance.exports.memory.buffer, pointer, input.length).set(input);
const packed = instance.exports.skill(pointer, input.length);
const at = Number(packed >> 32n);
const length = Number(packed & 0xffffffffn);
parentPort.postMessage(Buffer.from(new Uint8Array(instance.exports.memory.buffer, at, length)).toString("utf8"));
`;

/** The module is missing or wrong. A use refused for this reason is not charged. */
export class FunctionSkillUnavailable extends Error {}

const modules = new Map<string, WebAssembly.Module>();

function skillModule(path: string): WebAssembly.Module {
  const cached = modules.get(path);
  if (cached) return cached;
  if (!existsSync(path))
    throw new FunctionSkillUnavailable(
      "The function skills are not installed on this service.",
    );
  const module = new WebAssembly.Module(readFileSync(path));
  if (WebAssembly.Module.imports(module).length !== 0)
    throw new FunctionSkillUnavailable(
      "The function skill module must have no imports.",
    );
  modules.set(path, module);
  return module;
}

export function functionSkillPath(env = process.env): string {
  return env.PROVEN_FUNCTION_SKILL_WASM ?? DEFAULT_PATH;
}

/** True if the module is installed, so the service can say so when it starts. */
export function functionSkillsInstalled(path = functionSkillPath()): boolean {
  try {
    skillModule(path);
    return true;
  } catch {
    return false;
  }
}

/** Sends one JSON request text to a fresh instance and returns its exact JSON answer text. */
export function callFunctionSkill(
  request: string,
  path = functionSkillPath(),
  timeLimitMs = TIME_LIMIT_MS,
): Promise<string> {
  const module = skillModule(path);
  return runInWorker(
    WORKER,
    { module, input: request },
    timeLimitMs,
    "function skill",
    true,
  );
}

/** The parts of an answer this side reads. Numbers are never read from it, so none is rounded. */
function status(text: string): {
  ok: boolean;
  error: string;
  loads: unknown;
  module_bytes: unknown;
  deliverable: unknown;
} {
  const reply = JSON.parse(text) as Record<string, unknown>;
  return {
    ok: reply.ok === true,
    error: String(reply.error ?? "the function skill gave no answer"),
    loads: reply.loads,
    module_bytes: reply.module_bytes,
    deliverable: reply.deliverable,
  };
}

export interface FunctionTarget {
  export: string;
  arity: number;
  fuel: number;
}

/** The function a bid's public format names, or null if the bid is not a function job. */
export function functionTarget(format: string): FunctionTarget | null {
  try {
    const value = JSON.parse(format) as Record<string, unknown>;
    if (
      value?.kind === "function" &&
      typeof value.export === "string" &&
      Number.isSafeInteger(value.arity) &&
      Number.isSafeInteger(value.fuel)
    )
      return {
        export: value.export,
        arity: value.arity as number,
        fuel: value.fuel as number,
      };
  } catch {
    /* Not a function format. */
  }
  return null;
}

export interface SkillOutcome {
  output: string;
  /** False when nothing ran, so nothing is charged. */
  ran: boolean;
}

function failed(error: unknown): SkillOutcome {
  return {
    output: `Error: ${(error as Error).message.slice(0, 200)}`,
    ran: !(error instanceof FunctionSkillUnavailable),
  };
}

function formatStep(target: FunctionTarget): string {
  return `it needs no imports, at most 64 KB, and an export "${target.export}" taking ${target.arity} i64 arguments and returning one i64`;
}

/** `wat_compile`: the input is WebAssembly text. The compiled bytes stay here; the model hears only
 * whether it compiled, its size, and whether it would load as the bid's function. */
export async function watCompile(
  input: string,
  format: string,
  path = functionSkillPath(),
): Promise<SkillOutcome> {
  const target = functionTarget(format);
  try {
    const reply = status(
      await callFunctionSkill(
        JSON.stringify({ op: "compile", wat: input, target }),
        path,
      ),
    );
    if (!reply.ok) return { output: `Error: ${reply.error}`, ran: true };
    const summary = JSON.stringify({
      compiles: true,
      module_bytes: reply.module_bytes,
      loads_as_the_bids_function: reply.loads,
    });
    const next = !target
      ? ""
      : reply.loads === true
        ? ' To deliver it, answer with only {"wat":"<the same text>"}.'
        : ` It would fail the format step: ${formatStep(target)}.`;
    return { output: `${summary}${next}`, ran: true };
  } catch (error) {
    return failed(error);
  }
}

/** Reads `cases` as lists of i64 values, keeping large values exact. Null if any is not an i64. */
export function caseList(cases: unknown, arity: number): string | null {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > MAX_CASES)
    return null;
  const rows: string[] = [];
  for (const args of cases) {
    if (!Array.isArray(args) || args.length !== arity) return null;
    const values: string[] = [];
    for (const arg of args) {
      const text =
        typeof arg === "number" && Number.isSafeInteger(arg)
          ? String(arg)
          : typeof arg === "string" && I64.test(arg)
            ? arg
            : null;
      if (text === null) return null;
      const value = BigInt(text);
      if (value < I64_MIN || value > I64_MAX) return null;
      values.push(value.toString());
    }
    rows.push(`[${values.join(",")}]`);
  }
  return `[${rows.join(",")}]`;
}

/** `run_function`: the input is {"wat","cases"}. The export, arity and fuel come from the bid's public
 * format, so the agent tries exactly what the verifier will load. Write values above 2^53 as strings. */
export async function runFunction(
  input: string,
  format: string,
  path = functionSkillPath(),
): Promise<SkillOutcome> {
  const target = functionTarget(format);
  if (!target)
    return {
      output:
        "Error: this bid is not a function job, so there is nothing to run.",
      ran: false,
    };
  let value: { wat?: unknown; cases?: unknown } | null;
  try {
    value = JSON.parse(input) as typeof value;
  } catch {
    value = null;
  }
  const cases = caseList(value?.cases, target.arity);
  if (typeof value?.wat !== "string" || cases === null)
    return {
      output: `Error: run_function takes {"wat":"<text>","cases":[...]} with 1 to ${MAX_CASES} cases, each a list of ${target.arity} whole numbers in the i64 range.`,
      ran: false,
    };
  // Built by hand so values above 2^53 reach the function exactly.
  const request = `{"op":"run","wat":${JSON.stringify(value.wat)},"target":${JSON.stringify(target)},"cases":${cases}}`;
  try {
    const text = await callFunctionSkill(request, path);
    const reply = status(text);
    if (!reply.ok) return { output: `Error: ${reply.error}`, ran: true };
    return { output: text.slice(0, MAX_RESULT), ran: true };
  } catch (error) {
    return failed(error);
  }
}

/** Compiles a final {"wat"} answer on a function bid into exactly the deliverable `proven wat` makes. */
export async function compileDelivery(
  wat: string,
  format: string,
  path = functionSkillPath(),
): Promise<{ deliverable: string } | { error: string; ran: boolean }> {
  const target = functionTarget(format);
  if (!target) return { error: "This bid is not a function job.", ran: false };
  try {
    const reply = status(
      await callFunctionSkill(
        JSON.stringify({ op: "compile", wat, target }),
        path,
      ),
    );
    if (!reply.ok)
      return {
        error: `The WebAssembly text did not compile: ${reply.error}`,
        ran: true,
      };
    if (reply.loads !== true)
      return {
        error: `The compiled module would fail the format step: ${formatStep(target)}.`,
        ran: true,
      };
    return { deliverable: String(reply.deliverable) };
  } catch (error) {
    const outcome = failed(error);
    return { error: outcome.output, ran: outcome.ran };
  }
}
