// `table_aggregate`: exact totals, reconciliations and duplicates, the same sums the verifier's
// column_total, sum_equals and unique rules look at, so an agent can see a wrong total before it delivers.
// It decides nothing: only the verifier's check run does.
import { fitList, MAX_SKILL_RESULT } from "./fit-list.ts";

const MAX_ROWS = 2_000;
const MAX_FIELDS = 8;
const MAX_DIGITS = 80;
const MAX_NAME = 64;
const DECIMAL = /^-?\d+(\.\d+)?$/;

// ---- Exact decimals ----

interface Decimal {
  units: bigint;
  scale: number;
}

const ZERO: Decimal = { units: 0n, scale: 0 };

function decimalFromText(text: string): Decimal | null {
  if (!DECIMAL.test(text) || text.replace(/[-.]/g, "").length > MAX_DIGITS)
    return null;
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const units = BigInt(`${whole}${fraction}`);
  return {
    units: text.startsWith("-") ? -units : units,
    scale: fraction.length,
  };
}

/** An integer, or a decimal written as a string. Null for anything that could be rounded or is not a number. */
export function toDecimal(value: unknown): Decimal | null {
  // A JSON number above 2^53 has already lost digits, so it is refused, not used.
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? decimalFromText(String(value)) : null;
  return typeof value === "string" ? decimalFromText(value.trim()) : null;
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

// ---- Reading a request ----

type Row = Record<string, unknown>;

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
    !value.every((name) => typeof name === "string" && name.length <= MAX_NAME)
  )
    return `give "${what}" as a list of 1 to ${MAX_FIELDS} field names`;
  return value as string[];
}

function field(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME
    ? value
    : null;
}

/** An optional field name: undefined if absent, null if present but not a field name. */
function optionalField(value: unknown): string | null | undefined {
  return value === undefined ? undefined : field(value);
}

/** Rows grouped by one field's value, keeping each original value. */
function groupRows(
  rows: Row[],
  name: string,
): Map<string, { value: unknown; rows: Row[] }> {
  const groups = new Map<string, { value: unknown; rows: Row[] }>();
  for (const row of rows) {
    const value = row[name] ?? null;
    const key = JSON.stringify(value);
    const group = groups.get(key) ?? { value, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return groups;
}

// ---- totals ----

interface FieldStats {
  sum: Decimal;
  min: Decimal;
  max: Decimal;
}

function fieldStats(rows: Row[], name: string) {
  let stats: FieldStats | null = null;
  let skipped = 0;
  for (const row of rows) {
    const value = toDecimal(row[name]);
    if (!value) skipped += 1;
    else if (!stats) stats = { sum: value, min: value, max: value };
    else
      stats = {
        sum: add(stats.sum, value),
        min: compare(value, stats.min) < 0 ? value : stats.min,
        max: compare(value, stats.max) > 0 ? value : stats.max,
      };
  }
  return stats
    ? {
        sum: decimalText(stats.sum),
        min: decimalText(stats.min),
        max: decimalText(stats.max),
        skipped,
      }
    : { skipped };
}

function statsOf(rows: Row[], fields: string[]) {
  return {
    count: rows.length,
    ...Object.fromEntries(fields.map((name) => [name, fieldStats(rows, name)])),
  };
}

function totals(request: Row): string {
  const rows = readRows(request.rows);
  if (typeof rows === "string") return `Error: ${rows}.`;
  const fields = names(request.fields, "fields");
  if (typeof fields === "string") return `Error: ${fields}.`;
  const groupBy = optionalField(request.group_by);
  if (groupBy === null) return "Error: group_by must be one field name.";
  const all = statsOf(rows, fields);
  if (groupBy === undefined)
    return JSON.stringify({ all }).slice(0, MAX_SKILL_RESULT);
  const groups = [...groupRows(rows, groupBy).values()].map((group) => ({
    [groupBy]: group.value,
    ...statsOf(group.rows, fields),
  }));
  return fitList(groups, (shown) => ({ all, groups: shown }));
}

// ---- reconcile ----

interface ReconcileFields {
  items: string;
  itemField: string;
  totalField: string;
  keyField: string | undefined;
}

function reconcileFields(request: Row): ReconcileFields | null {
  const items = field(request.items);
  const itemField = field(request.item_field);
  const totalField = field(request.total_field);
  const keyField = optionalField(request.key_field);
  if (!items || !itemField || !totalField || keyField === null) return null;
  return { items, itemField, totalField, keyField };
}

/** The sum of the items' field, or null if the list or any value cannot be read exactly. */
function itemsSum(list: unknown, itemField: string): Decimal | null {
  if (!Array.isArray(list)) return null;
  let sum: Decimal | null = ZERO;
  for (const item of list) {
    const value = toDecimal((item as Row | null)?.[itemField]);
    sum = value && sum ? add(sum, value) : null;
  }
  return sum;
}

function mismatch(row: Row, index: number, f: ReconcileFields) {
  const sum = itemsSum(row[f.items], f.itemField);
  const total = toDecimal(row[f.totalField]);
  if (sum && total && compare(sum, total) === 0) return null;
  return {
    row: f.keyField ? row[f.keyField] : index,
    items_sum: sum ? decimalText(sum) : "unreadable",
    total: total ? decimalText(total) : "unreadable",
  };
}

/** Mirrors the verifier's sum_equals rule: each row's items must add up to its total. */
function reconcile(request: Row): string {
  const rows = readRows(request.rows);
  if (typeof rows === "string") return `Error: ${rows}.`;
  const fields = reconcileFields(request);
  if (!fields)
    return 'Error: reconcile takes "items", "item_field" and "total_field" as field names, and an optional "key_field".';
  const mismatches = rows
    .map((row, index) => mismatch(row, index, fields))
    .filter((entry) => entry !== null);
  return fitList(mismatches, (shown) => ({
    rows_checked: rows.length,
    mismatched: mismatches.length,
    mismatches: shown,
  }));
}

// ---- duplicates ----

/** Mirrors the verifier's unique rule: values of `field` that appear on more than one row. */
function duplicates(request: Row): string {
  const rows = readRows(request.rows);
  if (typeof rows === "string") return `Error: ${rows}.`;
  const name = field(request.field);
  if (!name) return 'Error: duplicates takes "field" as one field name.';
  const repeated = [...groupRows(rows, name).values()]
    .filter((group) => group.rows.length > 1)
    .map((group) => ({ value: group.value, rows: group.rows.length }));
  return fitList(repeated, (shown) => ({
    rows_checked: rows.length,
    duplicated_values: repeated.length,
    duplicates: shown,
  }));
}

const OPERATIONS: Record<string, (request: Row) => string> = {
  totals,
  reconcile,
  duplicates,
};

/** `table_aggregate`: {"op":"totals"|"reconcile"|"duplicates", "rows":[...], ...}. */
export function tableAggregate(input: string): string {
  let request: unknown;
  try {
    request = JSON.parse(input);
  } catch {
    return "Error: table_aggregate takes one JSON object.";
  }
  if (!request || typeof request !== "object" || Array.isArray(request))
    return "Error: table_aggregate takes one JSON object.";
  const op = (request as Row).op;
  const operation =
    typeof op === "string" && Object.hasOwn(OPERATIONS, op)
      ? OPERATIONS[op]
      : undefined;
  return operation
    ? operation(request as Row)
    : 'Error: op must be "totals", "reconcile" or "duplicates".';
}
