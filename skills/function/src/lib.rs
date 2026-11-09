//! Worker tools for function jobs. `compile` turns WebAssembly text into a function deliverable
//! exactly as `proven wat` does. `run` tries that function on a worker's own inputs by the verifier's
//! loading and calling rules. Neither decides anything: only the verifier's check run does.
//!
//! The hosted service runs the wasm32-unknown-unknown build of this crate, which has no imports, in a
//! fresh instance for every request. The request and the answer are JSON.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use wasmi::{Config, Engine, Func, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, Val, ValType};

// These match verifier/src/function.rs and verifier/src/check.rs. Keep them in step: a function that
// loads and runs here should load and run the same way in the verifier.
const MAX_MEMORY_BYTES: usize = 16 << 20;
const START_FUEL: u64 = 1_000_000;
const MAX_MODULE_BYTES: usize = 64 * 1024;
const MAX_TABLE_ELEMENTS: usize = 10_000;
const TOTAL_FUEL_BUDGET: u64 = 100_000_000;
const MAX_ARITY: usize = 4;
const MAX_FUEL: u64 = 10_000_000;
const MAX_NAME_LEN: usize = 32;

/// Longest WebAssembly text accepted.
pub const MAX_WAT_BYTES: usize = 64 * 1024;
/// Most inputs tried in one run.
pub const MAX_CASES: usize = 64;
/// Longest error message passed back.
const MAX_ERROR_CHARS: usize = 300;

/// The bid's public function format: what the verifier will load and call.
#[derive(Deserialize)]
pub struct Target {
    pub export: String,
    pub arity: usize,
    pub fuel: u64,
}

impl Target {
    fn valid(&self) -> bool {
        (1..=MAX_ARITY).contains(&self.arity)
            && (1..=MAX_FUEL).contains(&self.fuel)
            && !self.export.is_empty()
            && self.export.len() <= MAX_NAME_LEN
            && self.export.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Compile { wat: String, target: Option<Target> },
    Run { wat: String, target: Target, cases: Vec<Vec<i64>> },
}

/// Handles one JSON request and returns the JSON answer.
pub fn handle(input: &[u8]) -> String {
    let answer = match serde_json::from_slice::<Request>(input) {
        Ok(Request::Compile { wat, target }) => compile(&wat, target.as_ref()),
        Ok(Request::Run { wat, target, cases }) => run(&wat, &target, &cases),
        Err(_) => failure("the request could not be read"),
    };
    answer.to_string()
}

fn failure(message: &str) -> Value {
    json!({ "ok": false, "error": message.chars().take(MAX_ERROR_CHARS).collect::<String>() })
}

fn deliverable(wat: &str) -> Result<Value, String> {
    if wat.len() > MAX_WAT_BYTES {
        return Err("the WebAssembly text is over 64 KB".to_string());
    }
    proven_verifier::fakes::deliverable_from_wat(wat)
}

fn module_bytes(deliverable: &Value) -> usize {
    deliverable["wasm_base64"]
        .as_str()
        .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
        .map_or(0, |bytes| bytes.len())
}

/// Compiles the text. With a target, also says whether the result would load as that function.
fn compile(wat: &str, target: Option<&Target>) -> Value {
    if target.is_some_and(|t| !t.valid()) {
        return failure("the function format is not valid");
    }
    let deliverable = match deliverable(wat) {
        Ok(value) => value,
        Err(error) => return failure(&error),
    };
    let loads = target.map(|t| WorkerFunction::load(&deliverable, t).is_some());
    json!({
        "ok": true,
        "module_bytes": module_bytes(&deliverable),
        "loads": loads,
        "deliverable": deliverable.to_string(),
    })
}

/// Compiles the text and calls the function on each input, with fresh fuel per call.
fn run(wat: &str, target: &Target, cases: &[Vec<i64>]) -> Value {
    if !target.valid() {
        return failure("the function format is not valid");
    }
    if cases.is_empty() || cases.len() > MAX_CASES {
        return failure(&format!("give 1 to {MAX_CASES} inputs"));
    }
    if cases.iter().any(|args| args.len() != target.arity) {
        return failure(&format!("every input needs exactly {} arguments", target.arity));
    }
    let deliverable = match deliverable(wat) {
        Ok(value) => value,
        Err(error) => return failure(&error),
    };
    let Some(mut function) = WorkerFunction::load(&deliverable, target) else {
        return failure(&format!(
            "the module would fail the format step: it needs no imports, at most 64 KB, and an export `{}` taking {} i64 arguments and returning one i64",
            target.export, target.arity
        ));
    };
    let results: Vec<Value> = cases
        .iter()
        .map(|args| match function.call(args) {
            Some(value) => json!({ "args": args, "result": value }),
            None => json!({ "args": args, "result": "trap, out of fuel or budget spent" }),
        })
        .collect();
    json!({ "ok": true, "results": results })
}

/// A copy of the verifier's `Function`: the same checks on load, the same limits and the same fuel.
struct WorkerFunction {
    store: Store<StoreLimits>,
    func: Func,
    fuel_per_call: u64,
    budget: u64,
}

impl WorkerFunction {
    fn load(deliverable: &Value, target: &Target) -> Option<Self> {
        let object = deliverable.as_object().filter(|o| o.len() == 1)?;
        let encoded = object.get("wasm_base64")?.as_str()?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
        if bytes.len() > MAX_MODULE_BYTES {
            return None;
        }
        let mut config = Config::default();
        config.consume_fuel(true);
        let engine = Engine::new(&config);
        let module = Module::new(&engine, &bytes).ok()?;
        if module.imports().len() > 0 {
            return None;
        }
        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_MEMORY_BYTES)
            .memories(1)
            .tables(1)
            .table_elements(MAX_TABLE_ELEMENTS)
            .instances(1)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(&engine, limits);
        store.limiter(|limits| limits);
        store.set_fuel(START_FUEL).ok()?;
        let instance = <Linker<StoreLimits>>::new(&engine).instantiate_and_start(&mut store, &module).ok()?;
        let func = instance.get_func(&store, &target.export)?;
        let ty = func.ty(&store);
        let shape_ok = ty.params().len() == target.arity
            && ty.params().iter().all(|t| *t == ValType::I64)
            && ty.results() == [ValType::I64];
        shape_ok.then_some(Self { store, func, fuel_per_call: target.fuel, budget: TOTAL_FUEL_BUDGET })
    }

    fn call(&mut self, args: &[i64]) -> Option<i64> {
        let allowed = self.fuel_per_call.min(self.budget);
        if allowed == 0 {
            return None;
        }
        self.store.set_fuel(allowed).ok()?;
        let inputs: Vec<Val> = args.iter().map(|a| Val::I64(*a)).collect();
        let mut output = [Val::I64(0)];
        let result = self.func.call(&mut self.store, &inputs, &mut output);
        let left = self.store.get_fuel().unwrap_or(0);
        self.budget = self.budget.saturating_sub(allowed.saturating_sub(left));
        result.ok()?;
        match output[0] {
            Val::I64(v) => Some(v),
            _ => None,
        }
    }
}

/// The interface the hosted service calls: it writes the request into memory from `alloc`, calls
/// `skill`, and reads the answer at the returned pointer (high 32 bits) and length (low 32 bits).
/// Each request uses a fresh instance, so nothing is freed.
#[cfg(target_arch = "wasm32")]
mod exports {
    #[no_mangle]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut buffer = Vec::<u8>::with_capacity(len);
        let pointer = buffer.as_mut_ptr();
        std::mem::forget(buffer);
        pointer
    }

    /// # Safety
    /// `pointer` and `len` must come from one `alloc` call, with the request written there.
    #[no_mangle]
    pub unsafe extern "C" fn skill(pointer: *mut u8, len: usize) -> u64 {
        let input = Vec::from_raw_parts(pointer, len, len);
        let answer = super::handle(&input).into_bytes().into_boxed_slice();
        let answer_len = answer.len() as u64;
        let answer_pointer = Box::into_raw(answer) as *mut u8 as usize as u64;
        (answer_pointer << 32) | answer_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example(path: &str) -> String {
        std::fs::read_to_string(format!("../../examples/{path}")).unwrap()
    }

    fn answer(request: Value) -> Value {
        serde_json::from_str(&handle(request.to_string().as_bytes())).unwrap()
    }

    fn vat() -> Value {
        json!({ "export": "vat", "arity": 2, "fuel": 1_000_000 })
    }

    #[test]
    fn compiling_gives_the_same_deliverable_as_proven_wat() {
        let out = answer(json!({ "op": "compile", "wat": example("function-job/honest.wat"), "target": vat() }));
        assert_eq!(out["ok"], true);
        assert_eq!(out["loads"], true);
        let expected: Value = serde_json::from_str(&example("function-job/honest.json")).unwrap();
        let made: Value = serde_json::from_str(out["deliverable"].as_str().unwrap()).unwrap();
        assert_eq!(made, expected);
    }

    #[test]
    fn running_gives_the_check_vectors_for_honest_work_and_differs_for_the_fake() {
        let cases = json!([[10000, 2000], [99, 2000], [100, 2000], [125, 200], [5000, 1]]);
        let honest = answer(json!({ "op": "run", "wat": example("function-job/honest.wat"), "target": vat(), "cases": cases }));
        let results: Vec<i64> = honest["results"].as_array().unwrap().iter().map(|r| r["result"].as_i64().unwrap()).collect();
        assert_eq!(results, vec![2000, 0, 20, 3, 1]);
        let fake = answer(json!({ "op": "run", "wat": example("function-job/fake.wat"), "target": vat(), "cases": cases }));
        assert_ne!(fake["results"], honest["results"]);
    }

    #[test]
    fn a_loop_runs_out_of_fuel_instead_of_hanging() {
        let wat = r#"(module (func (export "vat") (param i64 i64) (result i64) (loop $l (br $l)) (i64.const 0)))"#;
        let out = answer(json!({ "op": "run", "wat": wat, "target": vat(), "cases": [[1, 2]] }));
        assert_eq!(out["results"][0]["result"], "trap, out of fuel or budget spent");
    }

    #[test]
    fn modules_the_verifier_would_refuse_do_not_load() {
        let import = r#"(module (import "env" "f" (func)) (func (export "vat") (param i64 i64) (result i64) (i64.const 0)))"#;
        let wrong_shape = r#"(module (func (export "vat") (param i64) (result i64) (i64.const 0)))"#;
        for wat in [import, wrong_shape] {
            assert_eq!(answer(json!({ "op": "compile", "wat": wat, "target": vat() }))["loads"], false);
            let run = answer(json!({ "op": "run", "wat": wat, "target": vat(), "cases": [[1, 2]] }));
            assert_eq!(run["ok"], false);
            assert!(run["error"].as_str().unwrap().contains("format step"));
        }
    }

    #[test]
    fn bad_requests_are_refused_with_a_short_reason() {
        let bad_text = answer(json!({ "op": "compile", "wat": "(module (func" }));
        assert_eq!(bad_text["ok"], false);
        assert!(bad_text["error"].as_str().unwrap().len() <= MAX_ERROR_CHARS);
        let too_many = vec![vec![1, 2]; MAX_CASES + 1];
        let wat = example("function-job/honest.wat");
        assert_eq!(answer(json!({ "op": "run", "wat": wat, "target": vat(), "cases": too_many }))["ok"], false);
        assert_eq!(answer(json!({ "op": "run", "wat": wat, "target": vat(), "cases": [[1]] }))["ok"], false);
        let bad_target = json!({ "export": "vat", "arity": 9, "fuel": 1 });
        assert_eq!(answer(json!({ "op": "run", "wat": wat, "target": bad_target, "cases": [[1, 2]] }))["ok"], false);
        assert_eq!(answer(json!({ "op": "compile", "wat": "x".repeat(MAX_WAT_BYTES + 1) }))["ok"], false);
        assert_eq!(answer(json!({ "op": "delete" }))["ok"], false);
    }
}
