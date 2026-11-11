//! Test double of the OutLayer contract for the PR probe and PR bounty sandbox tests. It takes the
//! same `request_execution` call, records it (with the receipt's refund receiver), returns the
//! deposit less a fixed charge to `payer_account_id`, and returns the reply the test set: given
//! bytes, `null` (a failed run), or a panic (a refused admission).
//!
//! The change (the deposit less the charge) is sent immediately by default, as before. A test may
//! instead delay it behind self-calls, hold it until `release_change`, or drop it, to show that a
//! caller's obligations never depend on when, or whether, OutLayer's change arrives.
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};
const CHARGE: NearToken = NearToken::from_millinear(1);
const HOP_GAS: Gas = Gas::from_tgas(3);
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayerReply {
    mode: String,
    reply: String,
    last_request: Option<String>,
    /// `immediate` (default), `delayed`, `held` or `none`.
    change_mode: String,
    change_hops: u32,
    held: Vec<(AccountId, NearToken)>,
    /// How many blocks the reply is held back (self-calls); 0 answers at once.
    reply_hops: u32,
}
#[near]
impl MockOutlayerReply {
    #[init]
    pub fn new() -> Self {
        Self {
            mode: "null".to_string(),
            reply: String::new(),
            last_request: None,
            change_mode: "immediate".to_string(),
            change_hops: 0,
            held: Vec::new(),
            reply_hops: 0,
        }
    }
    /// `mode` is `reply` (return `reply` as the run's output), `reply_echo` (the same, with the
    /// request's `bounty` and `seq` copied into the reply, so a test need not know the contract's
    /// sequence number), `null` or `panic`.
    pub fn set_reply(&mut self, mode: String, reply: Option<String>) {
        self.mode = mode;
        self.reply = reply.unwrap_or_default();
    }
    /// How the change of later requests is returned; `hops` is the delay for `delayed`.
    pub fn set_change(&mut self, mode: String, hops: Option<u32>) {
        self.change_mode = mode;
        self.change_hops = hops.unwrap_or(0);
    }
    /// Holds the reply back for `hops` blocks, so the contract's check stays live meanwhile.
    pub fn set_reply_delay(&mut self, hops: u32) {
        self.reply_hops = hops;
    }
    /// One step of a delayed reply; the last step returns the body.
    #[private]
    pub fn hop_reply(&mut self, left: u32, body: String) {
        if left == 0 {
            env::value_return(body.as_bytes());
        } else {
            Self::hop_promise(left - 1, &body).as_return();
        }
    }
    /// Sends every held change now.
    pub fn release_change(&mut self) -> u32 {
        let held = std::mem::take(&mut self.held);
        let n = held.len() as u32;
        for (to, amount) in held {
            Promise::new(to).transfer(amount).detach();
        }
        n
    }
    pub fn get_last_request(&self) -> Option<String> {
        self.last_request.clone()
    }
    /// One step of a delayed change.
    #[private]
    pub fn pay_later(&mut self, to: AccountId, amount: NearToken, left: u32) {
        if left == 0 {
            Promise::new(to).transfer(amount).detach();
        } else {
            Promise::new(env::current_account_id())
                .function_call(
                    "pay_later".to_string(),
                    json!({"to": to, "amount": amount, "left": left - 1})
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    HOP_GAS.saturating_mul(u64::from(left) + 1),
                )
                .detach();
        }
    }
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        if self.mode == "panic" {
            env::panic_str("mock: refused at admission");
        }
        self.last_request = Some(
            json!({
                "source": source, "resource_limits": resource_limits, "input_data": input_data,
                "secrets_ref": secrets_ref, "response_format": response_format,
                "payer_account_id": payer_account_id, "params": params,
                "predecessor": env::predecessor_account_id(), "deposit": env::attached_deposit(),
                "refund_to": env::refund_to_account_id(),
            })
            .to_string(),
        );
        let payer = payer_account_id.unwrap_or_else(env::predecessor_account_id);
        let change = env::attached_deposit().saturating_sub(CHARGE);
        match self.change_mode.as_str() {
            "held" => self.held.push((payer, change)),
            "none" => {}
            "delayed" => self.pay_later(payer, change, self.change_hops),
            _ => Promise::new(payer).transfer(change).detach(),
        }
        let body = match self.mode.as_str() {
            "reply" => self.reply.clone(),
            "reply_echo" => self.echo(input_data.as_deref()),
            _ => "null".to_string(),
        };
        if self.reply_hops > 0 {
            Self::hop_promise(self.reply_hops, &body).as_return();
        } else {
            env::value_return(body.as_bytes());
        }
    }
}
impl MockOutlayerReply {
    fn hop_promise(left: u32, body: &str) -> Promise {
        Promise::new(env::current_account_id()).function_call(
            "hop_reply".to_string(),
            json!({"left": left, "body": body}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            HOP_GAS.saturating_mul(u64::from(left) + 1),
        )
    }
    /// The set reply with `bounty` and `seq` taken from the request's input.
    fn echo(&self, input: Option<&str>) -> String {
        let mut reply: Value = near_sdk::serde_json::from_str(&self.reply).expect("a JSON reply");
        let input: Value = input
            .and_then(|i| near_sdk::serde_json::from_str(i).ok())
            .unwrap_or(Value::Null);
        reply["bounty"] = input["bounty"].clone();
        reply["seq"] = input["seq"].clone();
        reply.to_string()
    }
}
