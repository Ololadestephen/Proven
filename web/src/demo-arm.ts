import { fileURLToPath } from "node:url";
import { armDemo } from "./demo.ts";
try {
  await armDemo(fileURLToPath(new URL("../../runs/private/", import.meta.url)));
  console.log(
    "Prepared one fixed browser demo allowance. Start the private broker and web server separately. No transaction was sent.",
  );
} catch {
  console.error(
    "Allowance could not be prepared. Check private state and reconcile any consumed run. Nothing was reset or sent.",
  );
  process.exitCode = 1;
}
