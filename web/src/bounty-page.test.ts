// Page text of the PR bounty vault panel and sponsor note, rendered from the React components.
// These bundle ui/VaultPanel.tsx and ui/PrBounties.tsx.
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const CONTRACT = "pr-bounty.proven-funding.testnet";
const VAULT = `0s${"ab".repeat(20)}`;
/** Bundles a component with its own React, and renders it with that same React. */
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
    // React's server renderer is CommonJS and requires Node built-ins.
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
      module.renderToStaticMarkup(
        module.createElement(component, props),
      ) as string,
  };
};

test("the vault panel shows unavailable numbers before a read, and the sponsor note is shown", async () => {
  const panel = await bundle("../ui/VaultPanel.tsx");
  const html = panel.render(panel.VaultPanel, {
    vault: VAULT,
    network: "testnet",
    wallet: null,
    run: async () => {},
    busy: false,
    approved: false,
    near: (y: string) => `${y}`,
    entries: [
      { label: "payout", settlement: null },
      { label: "refund", settlement: null },
    ],
    shared: 2,
    now: 1_800_000_000,
    partyDelaySecs: 900,
  });
  // A browser-wallet withdrawal completed on testnet on November 11, so the page no longer
  // calls it pending.
  assert.doesNotMatch(html, /Browser wallet withdrawal: pending/);
  assert.equal(
    (html.match(/unavailable/g) ?? []).length,
    3,
    "no read yet: unavailable, never zero",
  );
  assert.match(html, /Shown for the whole vault\./);
  const page = await bundle("../ui/PrBounties.tsx");
  const note = page
    .render(page.SponsorNote, {
      config: { sponsor: "sponsor.testnet" },
    })
    .replaceAll("&#x27;", "'");
  assert.match(note, /paid from the owner's float/);
  assert.match(note, /unused compute\s+returns to/);
  assert.match(note, /sponsor\.testnet/);
  // The contract keeps no per-bounty check budget, so the note promises none.
  assert.doesNotMatch(note, /budget|reserve|returns in full/i);
});
