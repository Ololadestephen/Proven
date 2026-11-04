//! Test double of the OutLayer contract, used only by Proven's escrow sandbox tests. It takes the
//! same `request_execution` call, records what it was asked, and answers according to `behaviour`.
//! Like the real contract it returns the output as the call's result, `null` for a failed run, and
//! refunds unused NEAR to `payer_account_id`.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, Promise};

const CHARGE: NearToken = NearToken::from_millinear(1);
const REQUEST_ID: u64 = 4242;
const DATA_ID_REGISTER: u64 = 37;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    behaviour: String,
    last_request: Option<String>,
    held: Option<CryptoHash>,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self { behaviour: "pass".to_string(), last_request: None, held: None }
    }

    /// One of: `pass`, `fail`, `strong_check`, `weak_check`, `null`, `malformed`, `too_large`,
    /// `panic`, `wrong_job`, `wrong_spec`, `wrong_deliverable`, `wrong_escrow`, `wrong_mode`,
    /// `error_field`, `no_request_id`, `hold`.
    pub fn set_behaviour(&mut self, behaviour: String) {
        self.behaviour = behaviour;
    }

    pub fn get_last_request(&self) -> Option<String> {
        self.last_request.clone()
    }

    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<AccountId>,
    ) {
        if self.behaviour == "panic" {
            env::panic_str("mock: refused at admission");
        }
        self.last_request = Some(
            json!({
                "source": source, "resource_limits": resource_limits, "input_data": input_data,
                "secrets_ref": secrets_ref, "response_format": response_format, "payer_account_id": payer_account_id,
                "signer": env::signer_account_id(), "predecessor": env::predecessor_account_id(),
                "deposit": env::attached_deposit(),
            })
            .to_string(),
        );
        let payer = payer_account_id.unwrap_or_else(env::predecessor_account_id);
        let refund = env::attached_deposit().saturating_sub(CHARGE);
        Promise::new(payer).transfer(refund).detach();

        if self.behaviour == "hold" {
            // Stays pending until `resume` is called or the yield times out, like a real run.
            let promise = env::promise_yield_create("on_held", &[], Gas::from_tgas(10), GasWeight(0), DATA_ID_REGISTER);
            let data_id: CryptoHash = env::read_register(DATA_ID_REGISTER).expect("data id").try_into().expect("32 bytes");
            self.held = Some(data_id);
            env::promise_return(promise);
            return;
        }
        let input: Value = serde_json::from_str(input_data.as_deref().unwrap_or("{}")).expect("the escrow sends JSON");
        env::value_return(&self.answer(&input));
    }

    /// Finishes a held run with `behaviour`'s answer for the recorded input.
    pub fn resume(&mut self, behaviour: String) {
        self.behaviour = behaviour;
        let request: Value = serde_json::from_str(self.last_request.as_deref().expect("a request")).expect("recorded");
        let input: Value = serde_json::from_str(request["input_data"].as_str().expect("input")).expect("JSON");
        let answer = self.answer(&input);
        env::promise_yield_resume(&self.held.take().expect("a held run"), answer);
    }

    /// What a held run returns: the resumed answer, or `null` when the yield timed out.
    #[private]
    pub fn on_held(&mut self) {
        let answer = env::promise_result_checked(0, 4096).unwrap_or_else(|_| b"null".to_vec());
        env::value_return(&answer);
    }
}

impl MockOutlayer {
    fn answer(&self, input: &Value) -> Vec<u8> {
        let mode = input["mode"].as_str().unwrap_or_default();
        let mut output = if mode == "challenge" {
            let (total, caught) = if self.behaviour == "weak_check" { (13, 4) } else { (13, 13) };
            json!({
                "v": 1, "mode": "challenge", "error": null, "escrow": input["escrow"], "job": input["job"],
                "request_id": REQUEST_ID, "spec_hash": input["check_hash"], "fakes_hash": input["reference_hash"],
                "accepted": caught == total, "reference_passed": true, "fakes_total": total, "fakes_caught": caught,
                "fakes_unconfirmed": 0, "missed": [], "missed_more": 0,
            })
        } else {
            let pass = self.behaviour != "fail";
            json!({
                "v": 1, "mode": "verify", "error": null, "escrow": input["escrow"], "job": input["job"],
                "request_id": REQUEST_ID, "spec_hash": input["check_hash"], "deliverable_hash": input["deliverable_hash"],
                "pass": pass, "failed_rule": if pass { None } else { Some("grand_total") },
            })
        };
        const OTHER: &str = "9999999999999999999999999999999999999999999999999999999999999999";
        match self.behaviour.as_str() {
            "null" => return b"null".to_vec(),
            "malformed" => return b"{\"pass\":tr".to_vec(),
            "too_large" => output["padding"] = json!("x".repeat(2048)),
            "wrong_job" => output["job"] = json!(987_654),
            "wrong_spec" => output["spec_hash"] = json!(OTHER),
            "wrong_deliverable" => output["deliverable_hash"] = json!(OTHER),
            "wrong_escrow" => output["escrow"] = json!("other.testnet"),
            "wrong_mode" => output["mode"] = json!("other"),
            "error_field" => output["error"] = json!("secret_missing"),
            "no_request_id" => output["request_id"] = Value::Null,
            _ => {}
        }
        output.to_string().into_bytes()
    }
}
