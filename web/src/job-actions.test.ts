import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { performJobAction, resendDelivery } from "../ui/job-actions.ts";
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
  auth?: {
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
    async transfer() {
      return "fixture-hash";
    },
  };
  const bid: MarketBid = {
    id: BID_ID,
    buyer: wallet.accountId,
    description: "Checkable local fixture",
    amount: (NEAR / 100n).toString(),
    check_hash: "fixed-check-hash",
    reference_hash: "fixed-reference-hash",
    verifier_hash: "fixed-verifier-hash",
    format: "{}",
    format_hash: "fixed-format-hash",
    expires_at: "9000000000000000000",
    state: "Claimed",
    job_id: JOB_ID,
    deliver_secs: 3_600,
    max_attempts: 3,
    allowed_workers: null,
    review: { allow: true },
    claim: { number: 1, agent: "worker.testnet" },
    claims_made: 1,
    funded_attempts: 0,
    fees: ["Held", "Held", "Held"],
    job: null,
    last_job: null,
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
  const { message, ...auth } = request.body.auth!;
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
      owner: null,
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
    gas: 100n * TGAS,
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
    gas: 200n * TGAS,
  });
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
      gas: 100n * TGAS,
    });
    assert.equal(f.requests.length, 0);
  });
}

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

test("sending the check posts the exact texts to the relay with no signature or transaction", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "send_check", label: "Send", jobId: JOB_ID },
    f.context,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.signatures.length, 0);
  assert.deepEqual(f.requests[0]!.body, {
    action: "challenge",
    job_id: JOB_ID,
    check: f.context.checkText,
    reference: f.context.referenceText,
  });
});

test("missing check texts send nothing", async (t) => {
  const f = fixture(t);
  for (const missing of [{ checkText: "" }, { referenceText: "" }]) {
    await assert.rejects(
      performJobAction(
        { id: "send_check", label: "Send", jobId: JOB_ID },
        { ...f.context, ...missing },
      ),
      /Paste the check and reference/,
    );
  }
  assert.deepEqual([f.calls, f.requests, f.signatures], [[], [], []]);
});

test("the review needs no wallet and makes no transaction", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "review", label: "Review" },
    { ...f.context, wallet: null },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests[0]!.path, `/api/market/review/${BID_ID}`);
  assert.equal(f.requests[0]!.body.auth, undefined);
});

test("verification attaches no deposit: the job's budget pays for the run", async (t) => {
  const f = fixture(t);
  await performJobAction(
    { id: "verify", label: "Verify", jobId: JOB_ID },
    f.context,
  );
  assertCall(f.calls, {
    receiver: f.context.market.escrow,
    method: "request_verification",
    args: { job_id: JOB_ID },
    deposit: 0n,
    gas: 200n * TGAS,
  });
  assert.equal(f.requests.length, 0);
});

test("closing a bid goes through the board with no deposit", async (t) => {
  const f = fixture(t);
  await performJobAction({ id: "close", label: "Close" }, f.context);
  assertCall(f.calls, {
    receiver: f.context.market.board,
    method: "close_bid",
    args: { bid_id: BID_ID },
    deposit: 0n,
    gas: 150n * TGAS,
  });
});

test("a missing wallet fails before any transaction", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    performJobAction(
      { id: "close", label: "Close" },
      { ...f.context, wallet: null },
    ),
    /Connect a wallet/,
  );
  assert.deepEqual([f.calls, f.requests, f.signatures], [[], [], []]);
});

test("an unknown delivery transaction outcome never hands private work to the relay", async (t) => {
  const f = fixture(t);
  t.mock.method(f.context.wallet, "call", async () => {
    throw new Error("Submission outcome unknown; reconcile before retrying");
  });
  await assert.rejects(
    performJobAction(
      { id: "deliver", label: "Deliver", jobId: JOB_ID },
      f.context,
    ),
    /outcome unknown/,
  );
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.signatures, []);
});

test("a failed private handoff preserves exact work and does not repeat the recorded transaction", async (t) => {
  const f = fixture(t);
  const stored = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { setItem: (key: string, value: string) => stored.set(key, value) },
  });
  t.after(() => {
    if (previousStorage)
      Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  f.failRelay();
  await assert.rejects(
    performJobAction(
      { id: "deliver", label: "Deliver", jobId: JOB_ID },
      f.context,
    ),
    /recorded on the chain.*did not reach the relay/,
  );
  assert.equal(
    stored.get(`proven-private-${await sha256(DELIVERY)}`),
    DELIVERY,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.method, "deliver");
  assert.equal(f.signatures.length, 1);
  assert.deepEqual(f.order, ["chain", "relay"]);
});

test("resending work checks the original fingerprint before signing and never repeats delivery", async (t) => {
  const f = fixture(t);
  const exact = ' {"result":42}\r\n';
  const hash = await sha256(exact);
  await assert.rejects(resendDelivery(null, JOB_ID, exact, hash), /Connect/);
  await assert.rejects(
    resendDelivery(f.context.wallet, JOB_ID, DELIVERY, hash),
    /not the work recorded/,
  );
  assert.deepEqual([f.calls, f.requests, f.signatures], [[], [], []]);
  await resendDelivery(f.context.wallet, JOB_ID, exact, hash);
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests[0]!.body.deliverable, exact);
  assertAuth(f, "deliver", JOB_ID, hash);
});

test("a collection signature refusal returns no work and makes no relay request", async (t) => {
  const f = fixture(t);
  t.mock.method(f.context.wallet, "signForRelay", async () => {
    throw new Error("Wallet signature refused");
  });
  await assert.rejects(
    performJobAction(
      { id: "collect", label: "Collect", jobId: JOB_ID },
      f.context,
    ),
    /signature refused/,
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.requests, []);
});

test("an unavailable collection relay cannot return a cached or invented delivery", async (t) => {
  const f = fixture(t);
  f.failRelay();
  await assert.rejects(
    performJobAction(
      { id: "collect", label: "Collect", jobId: JOB_ID },
      f.context,
    ),
    /Relay unavailable/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.signatures.length, 1);
});
