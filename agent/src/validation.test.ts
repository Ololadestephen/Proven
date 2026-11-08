import assert from "node:assert/strict";
import test from "node:test";
import { checkPostingCaps, yocto } from "./validation.ts";
const near = 10n ** 24n;
const caps = {
  caps: [
    {
      token: null,
      max_job: `${5n * near}`,
      max_held: `${10n * near}`,
      max_held_per_buyer: `${5n * near}`,
    },
  ],
};
test("NEAR conversion is exact and accepts positive u128 values without a demo cap", () => {
  assert.equal(yocto("5"), `${5n * near}`);
  assert.equal(yocto("0.000000000000000000000001"), "1");
  assert.equal(
    yocto("340282366920938.463463374607431768211455"),
    `${(1n << 128n) - 1n}`,
  );
  for (const invalid of [
    "0",
    "-1",
    "01",
    "1e3",
    "0.0000000000000000000000001",
    "340282366920938.463463374607431768211456",
  ])
    assert.throws(() => yocto(invalid));
});
test("posting reads the three native caps, accepts their boundary and refuses each exceeded limit", () => {
  assert.doesNotThrow(() => checkPostingCaps(caps, `${5n * near}`));
  assert.throws(
    () => checkPostingCaps(caps, `${5n * near + 1n}`),
    /exceeds.*limits/,
  );
  for (const name of ["max_job", "max_held", "max_held_per_buyer"])
    assert.throws(
      () =>
        checkPostingCaps(
          { caps: [{ ...caps.caps[0], [name]: `${near}` }] },
          `${2n * near}`,
        ),
      /exceeds.*limits/,
    );
});
test("unknown or malformed native caps refuse posting rather than assume a limit", () => {
  for (const config of [
    null,
    {},
    { caps: [] },
    { caps: [{ token: "token.near" }] },
    { caps: [{ ...caps.caps[0], max_job: "-1" }] },
    { caps: [{ ...caps.caps[0], max_held: "1.5" }] },
    { caps: [{ ...caps.caps[0], max_held_per_buyer: 5 }] },
    { caps: [{ ...caps.caps[0], max_job: `${1n << 128n}` }] },
  ])
    assert.throws(
      () => checkPostingCaps(config, "1"),
      /unavailable.*No posting was signed/,
    );
});
