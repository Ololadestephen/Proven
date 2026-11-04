import test from "node:test";
import assert from "node:assert/strict";
import { KeyPair, type JsonRpcProvider } from "near-api-js";
import { scopedWorker } from "./near.ts";
import type { Config } from "./config.ts";

test("worker signer refuses full-access, other targets, unrestricted methods and deposits", async () => {
  const config: Config = {
    actor: "honest",
    escrow: "escrow-v2.proven.testnet",
    rpc: "",
    socket: "",
    custodyApi: "",
    account: "honest.testnet",
    key: KeyPair.fromRandom("ed25519").toString(),
  };
  for (const permission of [
    "FullAccess",
    {
      FunctionCall: {
        receiver_id: "attacker.testnet",
        method_names: ["deliver"],
      },
    },
    { FunctionCall: { receiver_id: config.escrow, method_names: [] } },
    {
      FunctionCall: {
        receiver_id: config.escrow,
        method_names: ["deliver", "set_verifier"],
      },
    },
  ]) {
    const provider = {
      viewAccessKey: async () => ({ nonce: 0, permission }),
    } as unknown as JsonRpcProvider;
    await assert.rejects(scopedWorker(config, provider, "deliver", "0"));
  }
  const provider = {
    viewAccessKey: async () => ({
      nonce: 0,
      permission: {
        FunctionCall: { receiver_id: config.escrow, method_names: ["deliver"] },
      },
    }),
  } as unknown as JsonRpcProvider;
  await assert.rejects(scopedWorker(config, provider, "deliver", "1"));
  await assert.doesNotReject(scopedWorker(config, provider, "deliver", "0"));
});
