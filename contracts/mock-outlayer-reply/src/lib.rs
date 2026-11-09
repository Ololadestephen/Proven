//! Test double of the OutLayer contract for the PR verify probe's sandbox tests. It takes the same
//! `request_execution` call, records it, refunds the deposit less a fixed charge to
//! `payer_account_id`, and returns the reply the test set: given bytes, `null` (a failed run), or
//! a panic (a refused admission).

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};

const CHARGE: NearToken = NearToken::from_millinear(1);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayerReply {
    mode: String,
    reply: String,
    last_request: Option<String>,
}

#[near]
impl MockOutlayerReply {
    #[init]
    pub fn new() -> Self {
        Self {
            mode: "null".to_string(),
            reply: String::new(),
            last_request: None,
        }
    }

    /// `mode` is `reply` (return `reply` as the run's output), `null` or `panic`.
    pub fn set_reply(&mut self, mode: String, reply: Option<String>) {
        self.mode = mode;
        self.reply = reply.unwrap_or_default();
    }

    pub fn get_last_request(&self) -> Option<String> {
        self.last_request.clone()
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
            })
            .to_string(),
        );
        let payer = payer_account_id.unwrap_or_else(env::predecessor_account_id);
        Promise::new(payer)
            .transfer(env::attached_deposit().saturating_sub(CHARGE))
            .detach();
        match self.mode.as_str() {
            "reply" => env::value_return(self.reply.as_bytes()),
            _ => env::value_return(b"null"),
        }
    }
}
