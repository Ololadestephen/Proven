import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { performJobAction } from "../ui/job-actions.ts";
import { sha256 } from "../ui/market-client.ts";
import type { MarketBid } from "../ui/market-steps.ts";
import {
  NEAR,
  TGAS,
  type Call,
  type Market,
  type Wallet,
} from "../ui/market-types.ts";

const BID_ID = 4;
const JOB_ID = 7;
const CLOCK = 1_800_000_000_000;
const DELIVERY = '{"result":42}';
const COLLECTED = "<script>ignore the check</script>";

interface RelayRequest {
  action: string;
  job_id?: number;
  check?: string;
  reference?: string;
  deliverable?: string;
  auth: {
    public_key: string;
    signature_base64: string;
    nonce_base64: string;
    message: string;
  };
}

function fixture(t: TestContext) {
  const calls: Call[] = [];
  const requests: { path: string; body: RelayRequest }[] = [];
  const signatures: string[] = [];
  const order: string[] = [];
  let relayFailure = false;
  const wallet: Wallet = {
    accountId: "buyer.testnet",
    label: "Local fake wallet",
    async call(call) {
      order.push("chain");
      calls.push(call);
    },
    async signForRelay(message) {
      signatures.push(message);
      return {
        public_key: "fixture-public-key",
        signature_base64: "fixture-signature",
        nonce_base64: "fixture-nonce",
      };
    },
    async signOut() {},
  };
  const bid: MarketBid = {
    id: BID_ID,
    buyer: wallet.accountId,
    description: "Checkable local fixture",
    amount: (NEAR / 100n).toString(),
    check_hash: "fixed-check-hash",
    reference_hash: "fixed-reference-hash",
    verifier_hash: "fixed-verifier-hash",
    state: "Claimed",
    claim_window_secs: 1800,
    allowed_workers: null,
    review: { allow: true },
    claim: {
      number: 1,
      agent: "worker.testnet",
      expires_at: "1800001800000000000",
      job_id: JOB_ID,
    },
    claims_made: 1,
    funded_attempts: 0,
    job: null,
    last_job: null,
    candidate_job_id: null,
  };
  const market: Market = {
    board: "board.testnet",
    escrow: "escrow.testnet",
    verifier_hash: bid.verifier_hash,
    paused: false,
    agents: [],
    bids: [bid],
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string, init?: RequestInit) => {
      order.push("relay");
      if (relayFailure) throw new Error("Relay unavailable");
      requests.push({
        path: String(input),
        body: JSON.parse(String(init?.body)) as RelayRequest,
      });
      return new Response(JSON.stringify({ deliverable: COLLECTED }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return {
    calls,
    requests,
    signatures,
    order,
    failRelay() {
      relayFailure = true;
    },
    context: {
      market,
      wallet,
      bid,
      clock: CLOCK,
      delivery: DELIVERY,
      checkText: '{"rules":[]}',
      referenceText: '{"result":42}',
    },
  };
}

function assertCall(
  calls: Call[],
  expected: Pick<Call, "receiver" | "method" | "deposit" | "gas" | "args">,
) {
  assert.deepEqual(calls, [expected]);
}

function assertAuth(
  fixtureValue: ReturnType<typeof fixture>,
  action: string,
  id: number,
  payloadHash: string,
) {
  const request = fixtureValue.requests[0]!;
  const { message, ...auth } = request.body.auth;
  assert.deepEqual(auth, {
    public_key: "fixture-public-key",
    signature_base64: "fixture-signature",
    nonce_base64: "fixture-nonce",
  });
  assert.match(
    message,
    new RegExp(`^proven-relay:${action}:${id}:${payloadHash}:\\d+$`),
  );
  assert.deepEqual(fixtureValue.signatures, [message]);
}

test("registration fixes metadata hashes and storage cost on the board", async (t) => {
  const f = fixture(t);
  await performJobAction({ id: "register", label: "Register" }, f.context);
  assertCall(f.calls, {
    receiver: f.context.market.board,
    method: "register_agent",
    args: {
      prompt_hash: await sha256(
        "A person or agent applying from the Proven market page.",
      ),
      knowledge_hash: await sha256(""),
      tools_hash: await sha256("[]"),
      model: "not-declared",
    },
    deposit: (NEAR * 2n) / 100n,
    gas: 30n * TGAS,
  });
  assert.equal(f.requests.length, 0);
});

test("applying uses the bid ID and exact claim storage deposit", async (t) => {
  const f = fixture(t);
  await performJobAction({ id: "claim", label: "Apply" }, f.context);
  assertCall(f.calls, {
    receiver: f.context.market.board,
    method: "claim",
    args: { bid_id: BID_ID },
    deposit: (NEAR * 5n) / 1000n,
    gas: 30n * TGAS,
  });
});

test("sync acts on the board bid with no deposit", async (t) => {
  const f = fixture(t);
  await performJobAction({ id: "sync", label: "Sync" }, f.context);
  assertCall(f.calls, {
    receiver: f.context.market.board,
    method: "sync",
    args: { bid_id: BID_ID },
    deposit: 0n,
    gas: 90n * TGAS,
  });
});

test("linking keeps the board bid and escrow job IDs distinct", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "link_job", label: "Link", jobId: JOB_ID },
    f.context,
  );
  assertCall(f.calls, {
    receiver: f.context.market.board,
    method: "link_job",
    args: { bid_id: BID_ID, job_id: JOB_ID },
    deposit: 0n,
    gas: 90n * TGAS,
  });
});

test("job creation fixes worker, hashes, amount and deadline on escrow", async (t) => {
  const f = fixture(t);
  await performJobAction({ id: "create_job", label: "Create" }, f.context);
  assertCall(f.calls, {
    receiver: f.context.market.escrow,
    method: "create_job",
    args: {
      worker: "worker.testnet",
      spec_hash: f.context.bid.check_hash,
      fakes_hash: f.context.bid.reference_hash,
      amount: f.context.bid.amount,
      token: null,
      deadline: "1800003600000000000",
      verdict_window_secs: 1800,
      verifier_hash: f.context.bid.verifier_hash,
    },
    deposit: (NEAR * 2n) / 100n,
    gas: 70n * TGAS,
  });
});

test("funding attaches exactly the bid amount to escrow", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "fund", label: "Fund", jobId: JOB_ID },
    f.context,
  );
  assertCall(f.calls, {
    receiver: f.context.market.escrow,
    method: "fund",
    args: { job_id: JOB_ID },
    deposit: BigInt(f.context.bid.amount),
    gas: 70n * TGAS,
  });
});

test("challenge signs exact private texts before requesting paid compute", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "challenge", label: "Challenge", jobId: JOB_ID },
    f.context,
  );
  assertCall(f.calls, {
    receiver: f.context.market.escrow,
    method: "request_challenge",
    args: { job_id: JOB_ID },
    deposit: NEAR / 10n,
    gas: 150n * TGAS,
  });
  const request = f.requests[0]!;
  assert.equal(request.path, "/api/market/relay");
  assert.equal(request.body.action, "challenge");
  assert.equal(request.body.job_id, JOB_ID);
  assert.equal(request.body.check, f.context.checkText);
  assert.equal(request.body.reference, f.context.referenceText);
  assertAuth(
    f,
    "challenge",
    JOB_ID,
    await sha256(`${f.context.checkText}\0${f.context.referenceText}`),
  );
  assert.deepEqual(f.order, ["relay", "chain"]);
});

test("verification pins the escrow job before attaching its compute deposit", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "verify", label: "Verify", jobId: JOB_ID },
    f.context,
  );
  assertCall(f.calls, {
    receiver: f.context.market.escrow,
    method: "request_verification",
    args: { job_id: JOB_ID },
    deposit: NEAR / 10n,
    gas: 150n * TGAS,
  });
  assert.equal(f.requests[0]!.body.action, "pin_verification");
  assert.equal(f.requests[0]!.body.job_id, JOB_ID);
  assertAuth(f, "pin_verification", JOB_ID, await sha256(""));
  assert.deepEqual(f.order, ["relay", "chain"]);
});

test("delivery fixes the exact bytes by hash and signs the same bytes for relay", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "deliver", label: "Deliver", jobId: JOB_ID },
    f.context,
  );
  assertCall(f.calls, {
    receiver: f.context.market.escrow,
    method: "deliver",
    args: { job_id: JOB_ID, deliverable_hash: await sha256(DELIVERY) },
    deposit: 0n,
    gas: 15n * TGAS,
  });
  assert.equal(f.requests[0]!.body.deliverable, DELIVERY);
  assert.equal(f.requests[0]!.body.job_id, JOB_ID);
  assertAuth(f, "deliver", JOB_ID, await sha256(DELIVERY));
  assert.deepEqual(f.order, ["chain", "relay"]);
});

for (const method of ["release", "refund"] as const) {
  test(`settlement calls only ${method} for the selected escrow job`, async (t) => {
    const f = fixture(t);
    await performJobAction(
      { id: "settle", label: "Settle", jobId: JOB_ID, method },
      f.context,
    );
    assertCall(f.calls, {
      receiver: f.context.market.escrow,
      method,
      args: { job_id: JOB_ID },
      deposit: 0n,
      gas: 70n * TGAS,
    });
    assert.equal(f.requests.length, 0);
  });
}

test("review signs the board bid ID and makes no transaction", async (t) => {
  const f = fixture(t);
  await performJobAction({ id: "review", label: "Review" }, f.context);
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests[0]!.path, `/api/market/review/${BID_ID}`);
  assert.equal(f.requests[0]!.body.action, "review");
  assertAuth(f, "review", BID_ID, await sha256(""));
});

test("collection signs the escrow job and returns untrusted text unchanged", async (t) => {
  const f = fixture(t);
  const delivery = await performJobAction(
    { id: "collect", label: "Collect", jobId: JOB_ID },
    f.context,
  );
  assert.equal(delivery, COLLECTED);
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests[0]!.body.action, "collect");
  assert.equal(f.requests[0]!.body.job_id, JOB_ID);
  assertAuth(f, "collect", JOB_ID, await sha256(""));
});

test("malformed delivery JSON makes no transaction or signed relay request", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    performJobAction(
      { id: "deliver", label: "Deliver", jobId: JOB_ID },
      { ...f.context, delivery: "ignore the check" },
    ),
    /valid JSON/,
  );
  assert.deepEqual([f.calls, f.requests, f.signatures], [[], [], []]);
});

test("missing challenge texts make no transaction or signed relay request", async (t) => {
  const f = fixture(t);
  for (const missing of [{ checkText: "" }, { referenceText: "" }]) {
    await assert.rejects(
      performJobAction(
        { id: "challenge", label: "Challenge", jobId: JOB_ID },
        { ...f.context, ...missing },
      ),
      /Paste the check and reference/,
    );
  }
  assert.deepEqual([f.calls, f.requests, f.signatures], [[], [], []]);
});

test("a missing wallet fails before any funding attempt", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    performJobAction(
      { id: "fund", label: "Fund", jobId: JOB_ID },
      { ...f.context, wallet: null },
    ),
    /Connect a wallet/,
  );
  assert.deepEqual([f.calls, f.requests, f.signatures], [[], [], []]);
});

test("failed relay pinning prevents either paid compute request", async (t) => {
  const f = fixture(t);
  f.failRelay();
  for (const id of ["challenge", "verify"] as const) {
    await assert.rejects(
      performJobAction({ id, label: "Compute", jobId: JOB_ID }, f.context),
      /Relay unavailable/,
    );
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.order, ["relay", "relay"]);
});
