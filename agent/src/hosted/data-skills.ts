// Data-job skills. `table_aggregate` gives exact totals, reconciliations and duplicates, the same sums
// the verifier's column_total, sum_equals and unique rules look at, so an agent can see a wrong total
// before it delivers. `extract` pulls fields out of text with a regular expression, run in a worker with
// a time limit, and normalises numbers, cents and dates. Neither decides anything: only the verifier's
// check run does.
import type { SkillOutcome } from "./function-skill.ts";
import { runInWorker } from "./worker-run.ts";

const MAX_RESULT = 4 * 1024;
const MAX_ROWS = 2_000;
const MAX_FIELDS = 8;
const MAX_DIGITS = 80;
const DECIMAL = /^-?\d+(\.\d+)?$/;

// ---- Exact decimals ----

interface Decimal {
  units: bigint;
  scale: number;
}

/** An integer, or a decimal written as a string. Null for anything that could be rounded or is not a number. */
export function toDecimal(value: unknown): Decimal | null {
  let text: string;
  if (typeof value === "number") {
    // A JSON number above 2^53 has already lost digits, so it is refused, not used.
    if (!Number.isSafeInteger(value)) return null;
    text = String(value);
  } else if (typeof value === "string") text = value.trim();
  else return null;
  if (!DECIMAL.test(text) || text.replace(/[-.]/g, "").length > MAX_DIGITS)
    return null;
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const units = BigInt(`${whole}${fraction}`);
  return {
    units: text.startsWith("-") ? -units : units,
    scale: fraction.length,
  };
}

function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function decimalText(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units)
    .toString()
    .padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = value.scale ? `.${digits.slice(-value.scale)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

// ---- table_aggregate ----

type Row = Record<string, unknown>;

interface Stats {
  count: number;
  fields: Record<string, { sum: Decimal; min: Decimal; max: Decimal } | null>;
  /** Values that were missing or not exact numbers, per field. */
  skipped: Record<string, number>;
}

function readRows(rows: unknown): Row[] | string {
  if (!Array.isArray(rows)) return 'give "rows" as a list of objects';
  if (rows.length === 0 || rows.length > MAX_ROWS)
    return `give 1 to ${MAX_ROWS} rows`;
  if (
    !rows.every((row) => row && typeof row === "object" && !Array.isArray(row))
  )
    return "every row must be an object";
  return rows as Row[];
}

function names(value: unknown, what: string): string[] | string {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FIELDS ||
    !value.every((name) => typeof name === "string" && name.length <= 64)
  )
    return `give "${what}" as a list of 1 to ${MAX_FIELDS} field names`;
  return value as string[];
}

function field(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : null;
}

function emptyStats(fields: string[]): Stats {
  return {
    count: 0,
    fields: Object.fromEntries(fields.map((name) => [name, null])),
    skipped: Object.fromEntries(fields.map((name) => [name, 0])),
  };
}

function addRow(stats: Stats, row: Row, fields: string[]) {
  stats.count += 1;
  for (const name of fields) {
    const value = toDecimal(row[name]);
    if (!value) {
      stats.skipped[name] += 1;
      continue;
    }
    const now = stats.fields[name];
    stats.fields[name] = now
      ? {
          sum: add(now.sum, value),
          min: compare(value, now.min) < 0 ? value : now.min,
          max: compare(value, now.max) > 0 ? value : now.max,
        }
      : { sum: value, min: value, max: value };
  }
}

function statsView(stats: Stats) {
  return {
    count: stats.count,
    ...Object.fromEntries(
      Object.entries(stats.fields).map(([name, value]) => [
        name,
        value
          ? {
              sum: decimalText(value.sum),
              min: decimalText(value.min),
              max: decimalText(value.max),
              skipped: stats.skipped[name],
            }
          : { skipped: stats.skipped[name] },
      ]),
    ),
  };
}

/** Keeps adding entries while the answer fits, and says how many there were in all. */
function fitList<T>(
  entries: T[],
  wrap: (shown: T[]) => Record<string, unknown>,
): string {
  let shown = entries.length;
  for (;;) {
    const text = JSON.stringify({
      ...wrap(entries.slice(0, shown)),
      ...(shown < entries.length ? { shown, total: entries.length } : {}),
    });
    if (text.length <= MAX_RESULT || shown === 0)
      return text.slice(0, MAX_RESULT);
    shown = Math.floor(shown / 2);
  }
}

function totals(request: Row): string {
  const rows = readRows(request.rows);
  if (typeof rows === "string") return `Error: ${rows}.`;
  const fields = names(request.fields, "fields");
  if (typeof fields === "string") return `Error: ${fields}.`;
  const groupBy =
    request.group_by === undefined ? null : field(request.group_by);
  if (request.group_by !== undefined && !groupBy)
    return "Error: group_by must be one field name.";
  const all = emptyStats(fields);
  const groups = new Map<string, Stats>();
  for (const row of rows) {
    addRow(all, row, fields);
    if (!groupBy) continue;
    const key = JSON.stringify(row[groupBy] ?? null);
    if (!groups.has(key)) groups.set(key, emptyStats(fields));
    addRow(groups.get(key)!, row, fields);
  }
  if (!groupBy)
    return JSON.stringify({ all: statsView(all) }).slice(0, MAX_RESULT);
  const list = [...groups.entries()].map(([key, stats]) => ({
    [groupBy]: JSON.parse(key) as unknown,
    ...statsView(stats),
  }));
  return fitList(list, (shown) => ({ all: statsView(all), groups: shown }));
}

/** Mirrors the verifier's sum_equals rule: each row's items must add up to its total. */
function reconcile(request: Row): string {
  const rows = readRows(request.rows);
  if (typeof rows === "string") return `Error: ${rows}.`;
  const items = field(request.items);
  const itemField = field(request.item_field);
  const totalField = field(request.total_field);
  const keyField =
    request.key_field === undefined ? null : field(request.key_field);
  if (
    !items ||
    !itemField ||
    !totalField ||
    (request.key_field !== undefined && !keyField)
  )
    return 'Error: reconcile takes "items", "item_field" and "total_field" as field names, and an optional "key_field".';
  const mismatches: Record<string, unknown>[] = [];
  rows.forEach((row, index) => {
    const list = row[items];
    const total = toDecimal(row[totalField]);
    let sum: Decimal | null = { units: 0n, scale: 0 };
    if (!Array.isArray(list)) sum = null;
    else
      for (const item of list) {
        const value = toDecimal((item as Row | null)?.[itemField]);
        sum = value && sum ? add(sum, value) : null;
      }
    if (sum && total && compare(sum, total) === 0) return;
    mismatches.push({
      row: keyField ? row[keyField] : index,
      items_sum: sum ? decimalText(sum) : "unreadable",
      total: total ? decimalText(total) : "unreadable",
    });
  });
  return fitList(mismatches, (shown) => ({
    rows_checked: rows.length,
    mismatched: mismatches.length,
    mismatches: shown,
  }));
}

/** Mirrors the verifier's unique rule: values of `field` that appear on more than one row. */
function duplicates(request: Row): string {
  const rows = readRows(request.rows);
  if (typeof rows === "string") return `Error: ${rows}.`;
  const name = field(request.field);
  if (!name) return 'Error: duplicates takes "field" as one field name.';
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(row[name] ?? null);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({
      value: JSON.parse(key) as unknown,
      rows: count,
    }));
  return fitList(repeated, (shown) => ({
    rows_checked: rows.length,
    duplicated_values: repeated.length,
    duplicates: shown,
  }));
}

/** `table_aggregate`: {"op":"totals"|"reconcile"|"duplicates", "rows":[...], ...}. */
export function tableAggregate(input: string): string {
  let request: Row;
  try {
    request = JSON.parse(input) as Row;
  } catch {
    return "Error: table_aggregate takes one JSON object.";
  }
  if (!request || typeof request !== "object" || Array.isArray(request))
    return "Error: table_aggregate takes one JSON object.";
  if (request.op === "totals") return totals(request);
  if (request.op === "reconcile") return reconcile(request);
  if (request.op === "duplicates") return duplicates(request);
  return 'Error: op must be "totals", "reconcile" or "duplicates".';
}

// ---- extract ----

const MAX_PATTERN = 300;
const MAX_MATCHES = 200;
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
export const NORMALISERS = [
  "trim",
  "lower",
  "upper",
  "number",
  "number_comma_decimal",
  "cents",
  "cents_comma_decimal",
  "date_ymd",
  "date_dmy",
  "date_mdy",
] as const;
type Normaliser = (typeof NORMALISERS)[number];

const REGEX_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { text, pattern, flags, max } = workerData;
let answer;
try {
  const regex = new RegExp(pattern, flags + "g");
  const matches = [];
  // matchAll moves past empty matches by itself, so a pattern that matches "" still ends.
  for (const match of text.matchAll(regex)) {
    matches.push({ index: match.index, groups: match.slice(1).map((g) => g ?? null), named: match.groups ?? null });
    if (matches.length > max) break;
  }
  answer = JSON.stringify({ ok: true, matches });
} catch (error) {
  answer = JSON.stringify({ ok: false, error: String(error && error.message || error).slice(0, 200) });
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

function toDate(text: string, order: "ymd" | "dmy" | "mdy"): string | null {
  const parts = text
    .trim()
    .replace(/,/g, " ")
    .split(/[\s\-/.]+/)
    .filter(Boolean)
    .map((part) => part.replace(/(st|nd|rd|th)$/i, ""));
  if (parts.length !== 3) return null;
  const [a, b, c] = parts;
  const [y, m, d] =
    order === "ymd" ? [a, b, c] : order === "dmy" ? [c, b, a] : [c, a, b];
  const monthNumber = month(m!);
  if (!/^\d{4}$/.test(y!) || !/^\d{1,2}$/.test(d!) || monthNumber === null)
    return null;
  const date = new Date(Date.UTC(Number(y), monthNumber - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== monthNumber - 1 ||
    date.getUTCDate() !== Number(d)
  )
    return null;
  return date.toISOString().slice(0, 10);
}

export function normalise(value: string, how: Normaliser): string | null {
  switch (how) {
    case "trim":
      return value.replace(/\s+/g, " ").trim();
    case "lower":
      return value.trim().toLowerCase();
    case "upper":
      return value.trim().toUpperCase();
    case "number":
      return plainNumber(value, false);
    case "number_comma_decimal":
      return plainNumber(value, true);
    case "cents":
      return toCents(value, false);
    case "cents_comma_decimal":
      return toCents(value, true);
    case "date_ymd":
      return toDate(value, "ymd");
    case "date_dmy":
      return toDate(value, "dmy");
    case "date_mdy":
      return toDate(value, "mdy");
  }
}

interface ExtractRequest {
  text: string;
  pattern: string;
  flags: string;
  normalise: Record<string, Normaliser>;
}

function readExtract(input: string): ExtractRequest | string {
  let value: Row;
  try {
    value = JSON.parse(input) as Row;
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
    !Object.values(rules).every((how) =>
      (NORMALISERS as readonly unknown[]).includes(how),
    )
  )
    return `normalise maps a group number or name to one of: ${NORMALISERS.join(", ")}`;
  return {
    text: value.text,
    pattern: value.pattern,
    flags,
    normalise: rules as Record<string, Normaliser>,
  };
}

/** `extract`: {"text","pattern","flags"?,"normalise"?:{"1":"cents","date":"date_dmy"}}. */
export async function extract(
  input: string,
  timeLimitMs = REGEX_TIME_LIMIT_MS,
): Promise<SkillOutcome> {
  const request = readExtract(input);
  if (typeof request === "string")
    return { output: `Error: ${request}.`, ran: false };
  let reply: {
    ok: boolean;
    error?: string;
    matches?: Array<{
      index: number;
      groups: Array<string | null>;
      named: Record<string, string | undefined> | null;
    }>;
  };
  try {
    reply = JSON.parse(
      await runInWorker(
        REGEX_WORKER,
        {
          text: request.text,
          pattern: request.pattern,
          flags: request.flags,
          max: MAX_MATCHES,
        },
        timeLimitMs,
        "pattern",
        true,
      ),
    ) as typeof reply;
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
  const matches = (reply.matches ?? []).slice(0, MAX_MATCHES).map((match) => {
    const values: Record<string, string | null> = {};
    match.groups.forEach((group, at) => {
      values[String(at + 1)] = group;
    });
    for (const [name, group] of Object.entries(match.named ?? {}))
      values[name] = group ?? null;
    for (const [key, how] of Object.entries(request.normalise))
      if (typeof values[key] === "string")
        values[key] = normalise(values[key]!, how);
    return values;
  });
  return {
    output: fitList(matches, (shown) => ({
      matches: shown,
      ...((reply.matches?.length ?? 0) > MAX_MATCHES
        ? { stopped_at: MAX_MATCHES }
        : {}),
    })),
    ran: true,
  };
}
