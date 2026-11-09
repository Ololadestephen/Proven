import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extract, normalise } from "./extract.ts";
import { decimalText, tableAggregate, toDecimal } from "./table-aggregate.ts";
import { csvToJson, MAX_CSV_RESULT, runSkill } from "./skills.ts";

const honest = JSON.parse(
  readFileSync(
    new URL(
      "../../../examples/data-job/deliverable-honest.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { rows: Array<Record<string, unknown>> };
const fake = JSON.parse(
  readFileSync(
    new URL(
      "../../../examples/data-job/deliverable-fake.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { rows: Array<Record<string, unknown>> };

const aggregate = (request: unknown) =>
  JSON.parse(tableAggregate(JSON.stringify(request))) as Record<
    string,
    unknown
  >;

test("decimals are exact, and numbers that may already be rounded are refused", () => {
  const sum = ["0.1", "0.2", "1000000000000000000000000.000001"]
    .map((v) => toDecimal(v)!)
    .reduce((a, b) => {
      const scale = Math.max(a.scale, b.scale);
      return {
        units:
          a.units * 10n ** BigInt(scale - a.scale) +
          b.units * 10n ** BigInt(scale - b.scale),
        scale,
      };
    });
  assert.equal(decimalText(sum), "1000000000000000000000000.300001");
  assert.equal(decimalText(toDecimal("-0.5")!), "-0.5");
  assert.equal(decimalText(toDecimal(-42)!), "-42");
  for (const bad of [2 ** 60, 1.5, "1e3", "", "12a", null, "1".repeat(81)])
    assert.equal(toDecimal(bad), null, String(bad).slice(0, 20));
});

test("totals give the same grand total the example check expects", () => {
  const out = aggregate({
    op: "totals",
    rows: honest.rows,
    fields: ["total_cents"],
  }) as { all: { count: number; total_cents: { sum: string } } };
  assert.equal(out.all.count, 10);
  // check-strong.json: column_total total_cents equals 61341.
  assert.equal(out.all.total_cents.sum, "61341");
});

test("totals group exactly, and say which values were skipped", () => {
  const out = aggregate({
    op: "totals",
    rows: [
      { s: "a", v: "1.25" },
      { s: "a", v: 2 },
      { s: "b", v: "x" },
      { s: "b" },
    ],
    fields: ["v"],
    group_by: "s",
  }) as {
    all: { v: { sum: string; skipped: number } };
    groups: Array<{ s: string; count: number; v: Record<string, unknown> }>;
  };
  assert.equal(out.all.v.sum, "3.25");
  assert.equal(out.all.v.skipped, 2);
  assert.deepEqual(out.groups[0], {
    s: "a",
    count: 2,
    v: { sum: "3.25", min: "1.25", max: "2", skipped: 0 },
  });
  assert.deepEqual(out.groups[1], { s: "b", count: 2, v: { skipped: 2 } });
});

test("reconcile and totals show what the example check sees in honest and fake work", () => {
  const request = {
    op: "reconcile",
    items: "lines",
    item_field: "amount_cents",
    total_field: "total_cents",
    key_field: "invoice_id",
  };
  const good = aggregate({ ...request, rows: honest.rows });
  assert.equal(good.mismatched, 0);
  // The verifier fails the fake on grand_total, after reconcile passed: every invoice adds up, and
  // only the grand total is wrong, which totals shows.
  const bad = aggregate({ ...request, rows: fake.rows });
  assert.equal(bad.mismatched, 0);
  const fakeTotal = aggregate({
    op: "totals",
    rows: fake.rows,
    fields: ["total_cents"],
  }) as { all: { total_cents: { sum: string } } };
  assert.notEqual(fakeTotal.all.total_cents.sum, "61341");
  const broken = aggregate({
    ...request,
    rows: [
      { invoice_id: "A", lines: [{ amount_cents: 1 }], total_cents: 2 },
      { invoice_id: "B", lines: "x", total_cents: 2 },
    ],
  });
  assert.deepEqual(broken.mismatches, [
    { row: "A", items_sum: "1", total: "2" },
    { row: "B", items_sum: "unreadable", total: "2" },
  ]);
});

test("duplicates lists repeated values, and large answers say how much is shown", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: `id-${Math.floor(i / 2)}-${"x".repeat(20)}`,
  }));
  const out = aggregate({ op: "duplicates", rows, field: "id" }) as {
    duplicated_values: number;
    duplicates: unknown[];
    shown: number;
    total: number;
  };
  assert.equal(out.duplicated_values, 500);
  assert.equal(out.total, 500);
  assert.ok(out.shown < 500 && out.duplicates.length === out.shown);
  assert.ok(
    tableAggregate(JSON.stringify({ op: "duplicates", rows, field: "id" }))
      .length <= 4096,
  );
});

test("table_aggregate refuses malformed requests with a reason", () => {
  for (const bad of [
    "not json",
    "[]",
    JSON.stringify({ op: "delete" }),
    JSON.stringify({ op: "totals", rows: [], fields: ["v"] }),
    JSON.stringify({ op: "totals", rows: [1], fields: ["v"] }),
    JSON.stringify({ op: "totals", rows: [{}], fields: [] }),
    JSON.stringify({ op: "reconcile", rows: [{}] }),
  ])
    assert.match(tableAggregate(bad), /^Error/, bad);
});

test("normalisers convert exactly or give null", () => {
  assert.equal(normalise(" $1,234.50 ", "cents"), "123450");
  assert.equal(normalise("1.234,5", "cents_comma_decimal"), "123450");
  assert.equal(normalise("(12.00)", "cents"), "-1200");
  assert.equal(normalise("-$3", "cents"), "-300");
  assert.equal(normalise("1.005", "cents"), null);
  assert.equal(normalise("1,5", "number"), null);
  assert.equal(normalise("1 234 567.25", "number"), "1234567.25");
  assert.equal(normalise("03/04/2026", "date_dmy"), "2026-04-03");
  assert.equal(normalise("03/04/2026", "date_mdy"), "2026-03-04");
  assert.equal(normalise("4th March 2026", "date_dmy"), "2026-03-04");
  assert.equal(normalise("March 4, 2026", "date_mdy"), "2026-03-04");
  assert.equal(normalise("2026-02-30", "date_ymd"), null);
  assert.equal(normalise("  A   b ", "trim"), "A b");
});

test("extract returns numbered and named groups, normalised", async () => {
  const text =
    "INV-1 total $1,200.00 on 03/04/2026\nINV-2 total $15.5 on 9/12/2026";
  const done = await extract(
    JSON.stringify({
      text,
      pattern: "(?<id>INV-\\d+) total (\\$[\\d,.]+) on (?<date>[\\d/]+)",
      normalise: { "2": "cents", date: "date_dmy" },
    }),
  );
  assert.equal(done.ran, true);
  assert.deepEqual(JSON.parse(done.output), {
    matches: [
      {
        "1": "INV-1",
        "2": "120000",
        "3": "03/04/2026",
        id: "INV-1",
        date: "2026-04-03",
      },
      {
        "1": "INV-2",
        "2": "1550",
        "3": "9/12/2026",
        id: "INV-2",
        date: "2026-12-09",
      },
    ],
  });
});

test("extract stops a pattern that backtracks without end, and refuses bad requests", async () => {
  const slow = await extract(
    JSON.stringify({ text: `${"a".repeat(40)}!`, pattern: "(a+)+$" }),
    300,
  );
  assert.equal(slow.ran, true);
  assert.match(slow.output, /took too long/);
  const invalid = await extract(JSON.stringify({ text: "x", pattern: "(" }));
  assert.match(invalid.output, /not valid/);
  for (const bad of [
    "not json",
    JSON.stringify({ text: "x" }),
    JSON.stringify({ text: "x", pattern: "x", flags: "g" }),
    JSON.stringify({ text: "x", pattern: "x", normalise: { "1": "eval" } }),
    JSON.stringify({ text: "x", pattern: "x".repeat(301) }),
  ]) {
    const refused = await extract(bad);
    assert.equal(refused.ran, false, bad);
  }
  const empty = await extract(JSON.stringify({ text: "abc", pattern: "x*" }));
  assert.equal(empty.ran, true);
});

test("csv_to_json returns up to 16 KB, never a partial table", async () => {
  const row = (i: number) => `${i},"name, ${i}",${i * 10}`;
  const small = Array.from({ length: 100 }, (_, i) => row(i)).join("\n");
  const fits = csvToJson(`id,name,amount\n${small}`);
  assert.ok(fits.length > 4096 && fits.length <= MAX_CSV_RESULT);
  assert.equal((JSON.parse(fits) as unknown[]).length, 100);
  const large = Array.from({ length: 1000 }, (_, i) => row(i)).join("\n");
  assert.match(
    csvToJson(`id,name,amount\n${large}`),
    /^Error: CSV result exceeds 16 KB/,
  );
  const through = await runSkill("table_aggregate", "{}", {
    knowledge: "",
    format: "{}",
  });
  assert.equal(through.ran, true);
  assert.match(through.output, /^Error/);
});

test("extract bounds repeated captures before copying matches out of the worker", async () => {
  const captures = 145;
  const result = await extract(
    JSON.stringify({
      text: "a".repeat(60_000),
      pattern: "(?=" + "(".repeat(captures) + ".*" + ")".repeat(captures + 1),
    }),
  );
  assert.equal(result.ran, true);
  assert.deepEqual(JSON.parse(result.output), {
    matches: [],
    capture_limit_reached: true,
  });
});
