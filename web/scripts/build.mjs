import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["ui/market.tsx"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  legalComments: "eof",
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "globalThis",
  },
  alias: { buffer: "buffer", util: "util" },
});

await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["ui/ui.tsx"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  legalComments: "eof",
  banner: {
    js: "/*! Adapted React Bits UI components. Full third-party notices: /third-party-notices.txt */",
  },
  define: { "process.env.NODE_ENV": '"production"' },
});

const licenses = [
  "react-bits-LICENSE.md",
  "react-LICENSE.txt",
  "react-dom-LICENSE.txt",
  "motion-LICENSE.md",
  "framer-motion-LICENSE.md",
  "motion-dom-LICENSE.md",
  "motion-utils-LICENSE.md",
];
const notices = await Promise.all(
  licenses.map(
    async (name) =>
      `${name}\n\n${await readFile(new URL(`../licenses/${name}`, import.meta.url), "utf8")}`,
  ),
);
await writeFile(
  new URL("../dist/third-party-notices.txt", import.meta.url),
  notices.join("\n\n---\n\n"),
);
