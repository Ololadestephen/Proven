// Operator commands for the bid board on testnet. Needs the relay handoff for attempts:
// `cd relay && npm run handoff`.
//   node scripts/swarm.ts post <job-directory>
//   node scripts/swarm.ts review <bid-id> [key-variable=NEARAI_KEY_REVIEW]
//   node scripts/swarm.ts attempt <bid-id> <a|b> <job-directory> [key-variable=NEARAI_KEY_AGENT_<A|B>]
//   node scripts/swarm.ts scripted-fake <bid-id> <a|b|c> <job-directory> <wrong-delivery-file>
import { appendFileSync, readFileSync } from "node:fs";
import { ROOT } from "../src/config.ts";
import { publicMessage } from "../src/errors.ts";
import { attempt, postBid, runReview } from "../src/swarm.ts";

const [command, first, second, third, fourth] = process.argv.slice(2);

async function main() {
  if (command === "post") return postBid(first);
  if (command === "review")
    return runReview(Number(first), second ?? "NEARAI_KEY_REVIEW");
  if (command === "attempt") {
    const evidence = `${ROOT}runs/swarm-bid-${first}-${second}.jsonl`;
    const log = (step: string, detail: unknown) => {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        step,
        detail,
      });
      appendFileSync(evidence, `${line}\n`);
      console.log(line);
    };
    return attempt(
      Number(first),
      second,
      third,
      fourth ?? `NEARAI_KEY_AGENT_${second.toUpperCase()}`,
      log,
    );
  }
  if (command === "scripted-fake") {
    const evidence = `${ROOT}runs/swarm-bid-${first}-${second}-scripted.jsonl`;
    return attempt(
      Number(first),
      second,
      third,
      "NEARAI_KEY_AGENT_B",
      (step, detail) => {
        const line = JSON.stringify({
          at: new Date().toISOString(),
          step,
          detail,
        });
        appendFileSync(evidence, `${line}\n`);
        console.log(line);
      },
      readFileSync(fourth, "utf8"),
    );
  }
  throw new Error("Usage: swarm.ts post|review|attempt|scripted-fake");
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(publicMessage(error));
    process.exitCode = 1;
  });
