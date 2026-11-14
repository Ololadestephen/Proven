import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = async (entry: string) => {
  const path = new URL(entry, import.meta.url).pathname;
  const built = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(path)};
export { createElement } from "react";
export { renderToStaticMarkup } from "react-dom/server";`,
      resolveDir: new URL("..", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(path)});`,
    },
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
  );
  return {
    ...module,
    render: (component: unknown, props: unknown) =>
      (
        module.renderToStaticMarkup(
          module.createElement(component, props),
        ) as string
      ).replaceAll("&#x27;", "'"),
  };
};
const grid = await bundle("../ui/WorkspacePages.tsx");

const bid = (id: number, state: string, job: string | null) => ({
  id,
  buyer: "buyer.near",
  description: "Extract these invoices",
  amount: "10000000000000000000000",
  check_hash: "a".repeat(64),
  reference_hash: "b".repeat(64),
  verifier_hash: "c".repeat(64),
  format: "",
  format_hash: "d".repeat(64),
  expires_at: "1800000000000000000",
  state,
  allowed_workers: null,
  review: { allow: true },
  claim: null,
  claims_made: 0,
  funded_attempts: 1,
  job: job
    ? {
        buyer: "buyer.near",
        worker: "worker.near",
        amount: "10000000000000000000000",
        state: job,
        deadline: "0",
        deliverable_hash: null,
        fakes_caught: 13,
        fakes_total: 13,
        failed_rule: null,
        challenge_request_id: null,
        verdict_request_id: null,
      }
    : null,
  last_job: null,
});

test("an empty Open tab says so and points to paid jobs and to posting", () => {
  const html = grid.render(grid.JobGrid, {
    bids: [bid(3, "Done", "Released")],
    viewer: null,
    empty: "No jobs yet.",
  });
  assert.match(html, /No open jobs right now\./);
  assert.match(html, /See paid jobs/);
  assert.match(html, /href="\/app\/post">Post a job/);
  assert.doesNotMatch(html, /No jobs yet\./);
});

test("a market with no jobs at all keeps its own empty message", () => {
  const html = grid.render(grid.JobGrid, {
    bids: [],
    viewer: null,
    empty: "No jobs yet.",
  });
  assert.match(html, /No jobs yet\./);
  assert.doesNotMatch(html, /See paid jobs/);
});
