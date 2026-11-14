import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// The posting form's money and draft rules, run from the bundled component without a JSX test runtime.
const built = await build({
  entryPoints: [new URL("../ui/PostJob.tsx", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
});
const module = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
);
const postingCost = module.postingCost as (
  amount: bigint,
  attempts: number,
  runDeposit: bigint,
) => Record<"amount" | "budget" | "fees" | "storage" | "total", bigint>;
const terms = module.terms as (draft: Record<string, unknown>) => unknown;
const importIntoBrief = module.importIntoBrief as (
  current: string,
  name: string,
  text: string,
) => { text: string } | { error: string };

const NEAR = 10n ** 24n;
const RUN = NEAR / 100n;

test("a posting attaches the reward, the run budget, fees and storage", () => {
  for (const attempts of [1, 3]) {
    const amount = NEAR / 2n;
    const budget = RUN * BigInt(2 + 2 * attempts);
    const fees = ((NEAR * 17n) / 1000n) * BigInt(attempts);
    const storage = (NEAR * 7n) / 100n + NEAR / 100n;
    assert.deepEqual(postingCost(amount, attempts, RUN), {
      amount,
      budget,
      fees,
      storage,
      total: amount + budget + fees + storage,
    });
  }
  assert.equal(postingCost(NEAR, 1, RUN).total, (1137n * NEAR) / 1000n);
});

const draft = {
  description: "Sum the column.",
  check: "",
  reference: "",
  amount: "0.5",
  deliverHours: "4",
  attempts: "2",
  workers: "",
  days: "3",
  revealAgreed: true,
};

test("a valid draft becomes the bid's terms", () => {
  assert.deepEqual(terms({ ...draft, workers: "a.near, b.near a.near" }), {
    amount: NEAR / 2n,
    deliver_secs: 14_400,
    max_attempts: 2,
    allowed_workers: ["a.near", "b.near"],
  });
  assert.equal(
    (terms(draft) as { allowed_workers: unknown }).allowed_workers,
    null,
  );
});

test("an invalid draft is refused before anything is signed", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ description: "  " }, /1 to 2,048 bytes/],
    [{ description: "x".repeat(2049) }, /1 to 2,048 bytes/],
    [{ days: "0" }, /1 to 7 days/],
    [{ days: "8" }, /1 to 7 days/],
    [{ deliverHours: "2" }, /how long a worker has/],
    [{ attempts: "0" }, /1 to 3 attempts/],
    [{ attempts: "4" }, /1 to 3 attempts/],
    [{ workers: "Not_Valid!" }, /up to 20 valid/],
    [
      { workers: Array.from({ length: 21 }, (_, i) => `w${i}.near`).join(" ") },
      /up to 20 valid/,
    ],
  ];
  for (const [change, message] of cases)
    assert.throws(() => terms({ ...draft, ...change }), message);
});

test("an imported file fills an empty brief, or goes under the existing text", () => {
  assert.deepEqual(importIntoBrief("", "rows.csv", "id,total\r\n1,5\r\n\n"), {
    text: "id,total\n1,5",
  });
  assert.deepEqual(
    importIntoBrief("Convert this to JSON:  \n", "rows.csv", "id,total\n1,5"),
    { text: "Convert this to JSON:\n\nid,total\n1,5" },
  );
});

test("a file that would not fit, is empty, or is not text is refused and nothing is cut", () => {
  const big = importIntoBrief("", "big.csv", "x".repeat(2049));
  assert.ok("error" in big && /2,049 bytes/.test(big.error));
  // The limit counts bytes, so multi-byte text is refused on its byte size.
  const wide = importIntoBrief("", "naira.txt", "₦".repeat(700));
  assert.ok("error" in wide && /2,100 bytes/.test(wide.error));
  const joined = importIntoBrief("a".repeat(2000), "rows.csv", "b".repeat(100));
  assert.ok("error" in joined);
  const exact = importIntoBrief("", "fit.txt", "y".repeat(2048));
  assert.ok("text" in exact && exact.text.length === 2048);
  assert.ok("error" in importIntoBrief("", "blank.txt", "  \n "));
  const binary = importIntoBrief("", "scan.pdf", "%PDF\u0000\u0001");
  assert.ok("error" in binary && /not a text file/.test(binary.error));
});
