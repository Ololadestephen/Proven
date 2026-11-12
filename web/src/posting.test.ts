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
