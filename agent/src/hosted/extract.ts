// `extract`: pulls fields out of text with a regular expression and normalises numbers, cents and dates.
// The pattern runs in a worker thread with a time limit, so a pattern that backtracks without end is
// stopped. It decides nothing: only the verifier's check run does.
import { fitList } from "./fit-list.ts";
import type { SkillOutcome } from "./function-skill.ts";
import { runInWorker } from "./worker-run.ts";

const MAX_PATTERN = 300;
const MAX_MATCHES = 200;
const MAX_CAPTURE_UNITS = 65_536;
const REGEX_TIME_LIMIT_MS = 2_000;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const REGEX_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { text, pattern, flags, max, maxCaptureUnits } = workerData;
let answer;
try {
  const regex = new RegExp(pattern, flags + "g");
  const matches = [];
  let remaining = maxCaptureUnits;
  let captureLimitReached = false;
  // matchAll moves past empty matches by itself, so a pattern that matches "" still ends.
  for (const match of text.matchAll(regex)) {
    const groups = match.slice(1).map((g) => g ?? null);
    const named = match.groups ?? null;
    // Structured cloning copies captures, including duplicate and named captures.
    const units = groups.reduce((sum, group) => sum + (group?.length ?? 0), 0)
      + Object.entries(named ?? {}).reduce((sum, [name, value]) => sum + name.length + (value?.length ?? 0), 0);
    if (units > remaining) {
      captureLimitReached = true;
      break;
    }
    remaining -= units;
    matches.push({ groups, named });
    if (matches.length > max) break;
  }
  answer = { ok: true, matches, captureLimitReached };
} catch (error) {
  answer = { ok: false, error: String(error && error.message || error).slice(0, 200) };
}
parentPort.postMessage(answer);
`;

/** A number written with "," or spaces between thousands and "." before decimals, or the other way round. */
function plainNumber(text: string, commaDecimal: boolean): string | null {
  const cleaned = text
    .trim()
    .replace(/^\+/, "")
    .replace(/[\s\u00a0']/g, "");
  const thousands = commaDecimal ? "." : ",";
  const decimal = commaDecimal ? "," : ".";
  // A minus before the first digit ("-$12", "$-12") or brackets round the whole value mean negative.
  const negative = /^[^\d]*-/.test(cleaned) || /^\(.*\)$/.test(cleaned);
  const body = cleaned.replace(/^[^\d]+|[^\d]+$/g, "");
  const groups = new RegExp(
    `^\\d{1,3}(\\${thousands}\\d{3})*(\\${decimal}\\d+)?$|^\\d+(\\${decimal}\\d+)?$`,
  );
  if (!groups.test(body)) return null;
  const normal = body.split(thousands).join("").replace(decimal, ".");
  return `${negative ? "-" : ""}${normal}`;
}

function toCents(text: string, commaDecimal: boolean): string | null {
  const number = plainNumber(text, commaDecimal);
  if (number === null) return null;
  const [whole, fraction = ""] = number.replace("-", "").split(".");
  // More than two decimal places would need rounding, which is the agent's decision, not ours.
  if (fraction.length > 2) return null;
  const cents = BigInt(`${whole}${fraction.padEnd(2, "0")}`);
  return (number.startsWith("-") ? -cents : cents).toString();
}

function month(text: string): number | null {
  if (/^\d{1,2}$/.test(text)) return Number(text);
  const index = MONTHS.indexOf(text.slice(0, 3).toLowerCase());
  return index >= 0 ? index + 1 : null;
}

type DateOrder = "ymd" | "dmy" | "mdy";

function dateParts(text: string, order: DateOrder): string[] | null {
  const parts = text
    .trim()
    .replace(/,/g, " ")
    .split(/[\s\-/.]+/)
    .filter(Boolean)
    .map((part) => part.replace(/(st|nd|rd|th)$/i, ""));
  if (parts.length !== 3) return null;
  const [a, b, c] = parts as [string, string, string];
  return order === "ymd" ? [a, b, c] : order === "dmy" ? [c, b, a] : [c, a, b];
}

function toDate(text: string, order: DateOrder): string | null {
  const parts = dateParts(text, order);
  if (!parts) return null;
  const [y, m, d] = parts as [string, string, string];
  const monthNumber = month(m);
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(d) || monthNumber === null)
    return null;
  const date = new Date(Date.UTC(Number(y), monthNumber - 1, Number(d)));
  const real =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === monthNumber - 1 &&
    date.getUTCDate() === Number(d);
  return real ? date.toISOString().slice(0, 10) : null;
}

const NORMALISE = {
  trim: (value: string) => value.replace(/\s+/g, " ").trim(),
  lower: (value: string) => value.trim().toLowerCase(),
  upper: (value: string) => value.trim().toUpperCase(),
  number: (value: string) => plainNumber(value, false),
  number_comma_decimal: (value: string) => plainNumber(value, true),
  cents: (value: string) => toCents(value, false),
  cents_comma_decimal: (value: string) => toCents(value, true),
  date_ymd: (value: string) => toDate(value, "ymd"),
  date_dmy: (value: string) => toDate(value, "dmy"),
  date_mdy: (value: string) => toDate(value, "mdy"),
} satisfies Record<string, (value: string) => string | null>;

type Normaliser = keyof typeof NORMALISE;
export const NORMALISERS = Object.keys(NORMALISE) as Normaliser[];

function isNormaliser(value: unknown): value is Normaliser {
  return typeof value === "string" && Object.hasOwn(NORMALISE, value);
}

export function normalise(value: string, how: Normaliser): string | null {
  return NORMALISE[how](value);
}

interface ExtractRequest {
  text: string;
  pattern: string;
  flags: string;
  normalise: Record<string, Normaliser>;
}

function readExtract(input: string): ExtractRequest | string {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return "extract takes one JSON object";
  }
  if (typeof value?.text !== "string" || typeof value.pattern !== "string")
    return 'give "text" and "pattern" as strings';
  if (value.pattern.length === 0 || value.pattern.length > MAX_PATTERN)
    return `the pattern must be 1 to ${MAX_PATTERN} characters`;
  const flags = value.flags ?? "";
  if (typeof flags !== "string" || !/^[imsu]*$/.test(flags))
    return 'flags may use only "i", "m", "s" and "u"';
  const rules = value.normalise ?? {};
  if (
    typeof rules !== "object" ||
    Array.isArray(rules) ||
    !Object.values(rules).every(isNormaliser)
  )
    return `normalise maps a group number or name to one of: ${NORMALISERS.join(", ")}`;
  return {
    text: value.text,
    pattern: value.pattern,
    flags,
    normalise: rules as Record<string, Normaliser>,
  };
}

interface Match {
  groups: Array<string | null>;
  named: Record<string, string | undefined> | null;
}

type PatternRun =
  | { ok: true; matches: Match[]; captureLimitReached: boolean }
  | { ok: false; error: string };

/** The worker posts an object, so the answer arrives already structured. */
function runPattern(
  request: ExtractRequest,
  timeLimitMs: number,
): Promise<PatternRun> {
  return runInWorker<PatternRun>(
    REGEX_WORKER,
    {
      text: request.text,
      pattern: request.pattern,
      flags: request.flags,
      max: MAX_MATCHES,
      maxCaptureUnits: MAX_CAPTURE_UNITS,
    },
    timeLimitMs,
    "pattern",
    true,
  );
}

/** One match's groups by number and name, normalised where asked. */
function matchValues(
  match: Match,
  rules: Record<string, Normaliser>,
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  match.groups.forEach((group, at) => {
    values[String(at + 1)] = group;
  });
  for (const [name, group] of Object.entries(match.named ?? {}))
    values[name] = group ?? null;
  for (const [key, how] of Object.entries(rules)) {
    const value = values[key];
    if (typeof value === "string") values[key] = normalise(value, how);
  }
  return values;
}

/** `extract`: {"text","pattern","flags"?,"normalise"?:{"1":"cents","date":"date_dmy"}}. */
export async function extract(
  input: string,
  timeLimitMs = REGEX_TIME_LIMIT_MS,
): Promise<SkillOutcome> {
  const request = readExtract(input);
  if (typeof request === "string")
    return { output: `Error: ${request}.`, ran: false };
  let reply: PatternRun;
  try {
    reply = await runPattern(request, timeLimitMs);
  } catch (error) {
    return {
      output: `Error: ${(error as Error).message.slice(0, 200)} Use a simpler pattern.`,
      ran: true,
    };
  }
  if (!reply.ok)
    return {
      output: `Error: the pattern is not valid: ${reply.error}`,
      ran: true,
    };
  const stopped = reply.matches.length > MAX_MATCHES;
  const matches = reply.matches
    .slice(0, MAX_MATCHES)
    .map((match) => matchValues(match, request.normalise));
  return {
    output: fitList(matches, (shown) => ({
      matches: shown,
      ...(stopped ? { stopped_at: MAX_MATCHES } : {}),
      ...(reply.captureLimitReached ? { capture_limit_reached: true } : {}),
    })),
    ran: true,
  };
}
