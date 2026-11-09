// The fixed safe skills. Each has bounded input and output. A stranger's prompt can choose when to call
// one, and with what text. No code of theirs runs here, except WebAssembly text a function skill compiles,
// which runs only in an interpreter with fuel, inside a module with no imports (see function-skill.ts).
import type { Skill } from "./limits.ts";
import {
  runFunction,
  watCompile,
  type SkillOutcome,
} from "./function-skill.ts";
import { extract } from "./extract.ts";
import { tableAggregate } from "./table-aggregate.ts";
import type { ChainReader } from "./chain-read.ts";

const MAX_INPUT = 64 * 1024;
const MAX_RESULT = 4 * 1024;
/** Rows of a data job are often more than 4 KB, and a partial table is never returned. */
export const MAX_CSV_RESULT = 16 * 1024;

export function knowledgeSearch(knowledge: string, query: string): string {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1)
      .slice(0, 32),
  );
  if (words.size === 0) return "No search terms.";
  const scored = knowledge
    .split(/\n\s*\n/)
    .slice(0, 2_000)
    .map((part, index) => {
      const lower = part.toLowerCase();
      let score = 0;
      for (const word of words) if (lower.includes(word)) score += 1;
      return { part: part.trim(), score, index };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3);
  if (scored.length === 0) return "Nothing in the knowledge base matches.";
  return scored
    .map((row) => row.part)
    .join("\n\n")
    .slice(0, MAX_RESULT);
}

/** Arithmetic only: numbers, + - * / %, brackets. A hand-written parser, never eval. */
export function calculator(expression: string): string {
  if (expression.length > 200) return "Error: expression too long.";
  let at = 0;
  let depth = 0;
  const space = () => {
    while (expression[at] === " ") at += 1;
  };
  const fail = (): never => {
    throw new Error("bad");
  };
  const atom = (): number => {
    space();
    if (expression[at] === "-") {
      at += 1;
      return -atom();
    }
    if (expression[at] === "(") {
      depth += 1;
      if (depth > 20) fail();
      at += 1;
      const value = sum();
      space();
      if (expression[at] !== ")") fail();
      at += 1;
      depth -= 1;
      return value;
    }
    const match = /^\d+(\.\d+)?/.exec(expression.slice(at));
    if (!match) return fail();
    at += match[0].length;
    return Number(match[0]);
  };
  const product = (): number => {
    let value = atom();
    for (;;) {
      space();
      const op = expression[at];
      if (op !== "*" && op !== "/" && op !== "%") return value;
      at += 1;
      const next = atom();
      value =
        op === "*" ? value * next : op === "/" ? value / next : value % next;
    }
  };
  function sum(): number {
    let value = product();
    for (;;) {
      space();
      const op = expression[at];
      if (op !== "+" && op !== "-") return value;
      at += 1;
      const next = product();
      value = op === "+" ? value + next : value - next;
    }
  }
  try {
    const value = sum();
    space();
    if (at !== expression.length || !Number.isFinite(value)) fail();
    return String(value);
  } catch {
    return "Error: not a valid calculation.";
  }
}

type Fields = Record<string, string>;
function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}
function fieldProblems(
  value: unknown,
  fields: Fields,
  where: string,
): string[] {
  if (typeOf(value) !== "object") return [`${where} is not an object`];
  const object = value as Record<string, unknown>;
  const problems = Object.keys(fields)
    .filter((name) => typeOf(object[name]) !== fields[name])
    .map((name) => `${where}.${name} must be ${fields[name]}`);
  for (const name of Object.keys(object))
    if (!(name in fields))
      problems.push(`${where}.${name} is not in the format`);
  return problems;
}

/** Checks a candidate against the bid's public format, by the same rules as the verifier's format step.
 * Only the verifier's verdict decides anything: this only helps an agent avoid a format failure. */
export function publicFormatCheck(
  candidate: string,
  formatText: string,
): { fits: boolean; message: string } {
  const fail = (message: string) => ({ fits: false, message });
  let value: unknown, format: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return fail("Not valid JSON.");
  }
  try {
    format = JSON.parse(formatText);
  } catch {
    return fail("The bid's format could not be read.");
  }
  if (!format || typeof format !== "object" || Array.isArray(format))
    return fail("The public format is invalid.");
  const f = format as {
    kind?: unknown;
    rows?: Fields;
    items?: Record<string, Fields>;
  };
  if (f.kind === "function") {
    const valid =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as { wasm_base64?: unknown }).wasm_base64 === "string";
    return valid
      ? {
          fits: true,
          message:
            "Fits the function envelope. This does not validate or execute the WASM.",
        }
      : fail("The function result must contain only wasm_base64.");
  }
  const validFields = (fields: unknown): fields is Fields =>
    fields !== null &&
    typeof fields === "object" &&
    !Array.isArray(fields) &&
    Object.values(fields).every((type) =>
      [
        "string",
        "integer",
        "number",
        "boolean",
        "array",
        "object",
        "null",
      ].includes(String(type)),
    );
  if (
    f.kind !== "data" ||
    !validFields(f.rows) ||
    (f.items !== undefined &&
      (!f.items ||
        typeof f.items !== "object" ||
        Array.isArray(f.items) ||
        !Object.values(f.items).every(validFields)))
  )
    return fail("The public data format is invalid.");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray((value as { rows?: unknown }).rows)
  )
    return fail('The result must be exactly {"rows":[...]}.');
  const rows = (value as { rows: unknown[] }).rows;
  if (!rows.length) return fail("An empty result does not fit any format.");
  if (rows.length > 500)
    return fail("The result exceeds 500 rows; the whole result was refused.");
  for (const [index, row] of rows.entries()) {
    const problems = fieldProblems(row, f.rows, `rows[${index}]`);
    for (const [array, fields] of Object.entries(f.items ?? {})) {
      const list = (row as Record<string, unknown> | null)?.[array];
      if (!Array.isArray(list)) {
        problems.push(`rows[${index}].${array} must be an array`);
        continue;
      }
      if (list.length > 500)
        return fail(
          "An item array exceeds 500 entries; the whole result was refused.",
        );
      for (const [at, item] of list.entries())
        problems.push(
          ...fieldProblems(item, fields, `rows[${index}].${array}[${at}]`),
        );
    }
    if (problems.length)
      return fail(problems.slice(0, 20).join("\n").slice(0, MAX_RESULT));
  }
  return {
    fits: true,
    message:
      "Fits the public format. This says nothing about whether the check will pass.",
  };
}

export function jsonValidator(candidate: string, formatText: string): string {
  return publicFormatCheck(candidate, formatText).message;
}

export type ServiceSkill = Exclude<
  Skill,
  "run_code" | "run_tests" | "read_repo" | "make_patch"
>;

export interface SkillContext {
  knowledge: string;
  format: string;
  functionSkill?: string;
  /** The service's chain reader and this attempt's run name, for chain_read's per-attempt limit. */
  chain?: ChainReader;
  run?: string;
}

type SkillRunner = (
  input: string,
  context: SkillContext,
) => SkillOutcome | Promise<SkillOutcome>;

const ran = (output: string): SkillOutcome => ({ output, ran: true });

/** Every service skill, by name. A new name in SAFE_SKILLS fails to type-check until it is listed here. */
const SKILL_RUNNERS: Record<ServiceSkill, SkillRunner> = {
  knowledge_search: (input, c) => ran(knowledgeSearch(c.knowledge, input)),
  calculator: (input) => ran(calculator(input)),
  csv_to_json: (input) => ran(csvToJson(input)),
  json_validator: (input, c) => ran(jsonValidator(input, c.format)),
  wat_compile: (input, c) => watCompile(input, c.format, c.functionSkill),
  run_function: (input, c) => runFunction(input, c.format, c.functionSkill),
  table_aggregate: (input) => ran(tableAggregate(input)),
  extract: (input) => extract(input),
  chain_read: (input, c) =>
    c.chain
      ? c.chain.read(input, c.run ?? "")
      : {
          output: "Error: chain reads are not available on this service.",
          ran: false,
        },
};

/** Runs one of this service's own skills. `ran` is false when nothing ran, so nothing is charged. */
export function runSkill(
  skill: ServiceSkill,
  input: string,
  context: SkillContext,
): Promise<SkillOutcome> {
  if (input.length > MAX_INPUT)
    return Promise.resolve({
      output: "Error: skill input exceeds the size limit.",
      ran: false,
    });
  return Promise.resolve(SKILL_RUNNERS[skill](input, context));
}

/** CSV text to rows, with quoted fields. Pure parsing, bounded in size. */
export function csvToJson(text: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  if (text.length > MAX_INPUT)
    return "Error: CSV input exceeds the size limit.";
  const input = text;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...rest] = rows;
  if (!header) return "[]";
  const out = rest.map((cells) =>
    Object.fromEntries(header.map((name, at) => [name, cells[at] ?? ""])),
  );
  const result = JSON.stringify(out);
  return result.length <= MAX_CSV_RESULT
    ? result
    : "Error: CSV result exceeds 16 KB; no partial JSON was returned. Convert fewer rows at a time.";
}
