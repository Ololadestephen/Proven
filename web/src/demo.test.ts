import test from "node:test";
import assert from "node:assert/strict";
import {
  realpath,
  mkdtemp,
  rm,
  writeFile,
  chmod,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserDemo, armDemo, type DemoEvents } from "./demo.ts";

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "proven-browser-")));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("missing, malformed or public allowance fails closed; arming never launches", async (t) => {
  const path = await directory(t);
  let launches = 0;
  const launch = () => {
    launches++;
  };
  assert.equal(
    (await BrowserDemo.create(path, launch)).status().state,
    "disabled",
  );
  await armDemo(path);
  assert.equal(launches, 0);
  assert.equal(
    (await BrowserDemo.create(path, launch)).status().state,
    "ready",
  );
  await chmod(join(path, "browser-demo-allowance.json"), 0o644);
  assert.equal(
    (await BrowserDemo.create(path, launch)).status().state,
    "disabled",
  );
  await chmod(join(path, "browser-demo-allowance.json"), 0o600);
  await writeFile(
    join(path, "browser-demo-allowance.json"),
    '{"network":"mainnet"}',
  );
  assert.equal(
    (await BrowserDemo.create(path, launch)).status().state,
    "disabled",
  );
  assert.equal(launches, 0);
});
test("concurrent clicks and independent servers consume exactly one allowance before launch", async (t) => {
  const path = await directory(t);
  await armDemo(path);
  let launches = 0,
    events: DemoEvents | undefined,
    clock = 1000;
  const launch = (value: DemoEvents) => {
    launches++;
    events = value;
  };
  const a = await BrowserDemo.create(path, launch, () => clock);
  const b = await BrowserDemo.create(path, launch, () => clock);
  await Promise.all([a.start(), a.start(), b.start(), b.start()]);
  assert.equal(launches, 1);
  assert.ok(events);
  const winner = a.status().state === "running" ? a : b;
  events.job({ worker: "honest", id: 101, phase: "challenge" });
  events.job({ worker: "honest", id: 999, phase: "payout" });
  clock = 1500;
  assert.equal(winner.status().elapsed_ms, 500);
  assert.deepEqual(winner.status().jobs, [
    { worker: "honest", id: 101, phase: "challenge" },
  ]);
  const copied = winner.status();
  copied.jobs[0]!.phase = "tampered";
  assert.equal(winner.status().jobs[0]!.phase, "challenge");
  events.done(true);
  events.done(false);
  clock = 9999;
  assert.equal(winner.status().state, "completed");
  assert.equal(winner.status().elapsed_ms, 500);
  await winner.start();
  assert.equal(launches, 1);
  assert.equal(
    (await BrowserDemo.create(path, launch)).status().state,
    "consumed",
  );
  await assert.rejects(armDemo(path));
});
test("launch failure or unknown prior marker never replays; removal of allowance before POST prevents signing", async (t) => {
  const path = await directory(t);
  await armDemo(path);
  let launches = 0;
  const demo = await BrowserDemo.create(path, () => {
    launches++;
    throw Error("PRIVATE key");
  });
  const result = await demo.start();
  assert.equal(result.state, "stopped");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  await demo.start();
  assert.equal(launches, 1);
  assert.equal(
    (await BrowserDemo.create(path, () => launches++)).status().state,
    "consumed",
  );
  const second = await directory(t);
  await armDemo(second);
  const other = await BrowserDemo.create(second, () => launches++);
  await rm(join(second, "browser-demo-allowance.json"));
  assert.equal((await other.start()).state, "stopped");
  assert.equal(launches, 1);
});
test("symlink state directory cannot arm or launch", async (t) => {
  const root = await directory(t),
    target = await directory(t),
    link = join(root, "linked");
  await symlink(target, link);
  await assert.rejects(armDemo(link));
  assert.equal(
    (await BrowserDemo.create(link, () => assert.fail())).status().state,
    "disabled",
  );
});
