// The fixed safe skills. Each is a small pure function with bounded input and output. A stranger's prompt
// can choose when to call one, and with what text, but no code of theirs ever runs here.
import type { Skill } from "./limits.ts";

const MAX_INPUT = 64 * 1024;
const MAX_RESULT = 4 * 1024;

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
export function jsonValidator(candidate: string, formatText: string): string {
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return "Not valid JSON.";
  }
  let format: { rows?: Fields; items?: Record<string, Fields> };
  try {
    format = JSON.parse(formatText) as typeof format;
  } catch {
    return "Valid JSON. The bid's format could not be read.";
  }
  if (!format.rows) return "Valid JSON. This format has no rows to compare.";
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || Object.keys(value as object).length !== 1)
    return 'The result must be exactly {"rows":[...]}.';
  const problems: string[] = [];
  rows.slice(0, 500).forEach((row, index) => {
    problems.push(...fieldProblems(row, format.rows!, `rows[${index}]`));
    for (const [array, fields] of Object.entries(format.items ?? {})) {
      const list = (row as Record<string, unknown>)?.[array];
      if (Array.isArray(list))
        list.slice(0, 500).forEach((item, at) => {
          problems.push(
            ...fieldProblems(item, fields, `rows[${index}].${array}[${at}]`),
          );
        });
    }
  });
  return problems.length === 0
    ? "Fits the public format. This says nothing about whether the check will pass."
    : problems.slice(0, 20).join("\n").slice(0, MAX_RESULT);
}

export function runSkill(
  skill: Skill,
  input: string,
  context: { knowledge: string; format: string },
): string {
  const text = input.slice(0, MAX_INPUT);
  if (skill === "knowledge_search")
    return knowledgeSearch(context.knowledge, text);
  if (skill === "calculator") return calculator(text);
  return jsonValidator(text, context.format);
}
