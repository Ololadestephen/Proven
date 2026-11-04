//! Function-job rules. A function deliverable is `{"wasm_base64": "..."}`: a WebAssembly module
//! with no imports that exports one function taking `arity` i64 arguments and returning an i64.
//! It runs in the wasmi interpreter with fuel per call, a total fuel budget per check, and caps on
//! memory, tables and module size.

use crate::check::{Case, FunctionCheck, FunctionRuleKind};
use crate::FailedRule;
use base64::Engine as _;
use serde_json::Value;
use wasmi::{Config, Engine, Func, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, Val, ValType};

/// Linear memory a submitted module may use.
const MAX_MEMORY_BYTES: usize = 1 << 20;
/// Largest submitted module, decoded.
const MAX_MODULE_BYTES: usize = 64 * 1024;
const MAX_TABLE_ELEMENTS: usize = 10_000;
/// Fuel one module may burn across every call while one check (or one fake search) runs. With at
/// most `MAX_MUTANTS` fakes plus the reference, one challenge burns at most about
/// 2 x 33 x 100 million fuel, which keeps it within OutLayer's limits.
pub(crate) const TOTAL_FUEL_BUDGET: u64 = 100_000_000;

pub(crate) struct Function {
    store: Store<StoreLimits>,
    func: Func,
    fuel_per_call: u64,
    budget: u64,
}

impl Function {
    /// Loads a deliverable. `None` if it is not a valid module with the expected export.
    pub(crate) fn load(deliverable: &Value, export: &str, arity: usize, fuel_per_call: u64) -> Option<Self> {
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
        // The start function, if any, runs on one call's worth of fuel.
        store.set_fuel(fuel_per_call).ok()?;
        let instance = <Linker<StoreLimits>>::new(&engine).instantiate_and_start(&mut store, &module).ok()?;
        let func = instance.get_func(&store, export)?;
        let ty = func.ty(&store);
        let shape_ok = ty.params().len() == arity
            && ty.params().iter().all(|t| *t == ValType::I64)
            && ty.results() == [ValType::I64];
        shape_ok.then_some(Self { store, func, fuel_per_call, budget: TOTAL_FUEL_BUDGET })
    }

    /// Calls the function with fresh fuel. `None` if it traps, runs out of fuel, or the total
    /// budget is spent.
    pub(crate) fn call(&mut self, args: &[i64]) -> Option<i64> {
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

/// Runs the rules in order. `Err` names the first rule that failed, or `format` if the
/// deliverable is not a loadable function of the right shape.
pub(crate) fn evaluate(check: &FunctionCheck, deliverable: &Value) -> Result<(), FailedRule> {
    let mut f = Function::load(deliverable, &check.export, check.arity, check.fuel).ok_or_else(FailedRule::format)?;
    for rule in &check.rules {
        if !holds(&rule.kind, &mut f) {
            return Err(FailedRule(rule.id.clone()));
        }
    }
    Ok(())
}

fn holds(kind: &FunctionRuleKind, f: &mut Function) -> bool {
    match kind {
        FunctionRuleKind::Vectors { cases } => cases.iter().all(|Case { args, expect }| f.call(args) == Some(*expect)),
        FunctionRuleKind::Monotonic { arg, from, to, step, fixed } => {
            let mut args = fixed.clone();
            let mut previous: Option<i64> = None;
            let mut x = *from;
            loop {
                args[*arg] = x;
                let Some(y) = f.call(&args) else { return false };
                if previous.is_some_and(|p| y < p) {
                    return false;
                }
                previous = Some(y);
                match x.checked_add(*step) {
                    Some(next) if next <= *to => x = next,
                    _ => return true,
                }
            }
        }
        FunctionRuleKind::OutputRange { grid, min, max } => {
            let mut ok = true;
            for_each_point(grid, &mut |args| {
                ok = f.call(args).is_some_and(|y| (*min..=*max).contains(&y));
                ok
            });
            ok
        }
    }
}

/// Visits every grid point until `visit` returns false.
fn for_each_point(grid: &[[i64; 3]], visit: &mut dyn FnMut(&[i64]) -> bool) {
    fn walk(grid: &[[i64; 3]], args: &mut Vec<i64>, visit: &mut dyn FnMut(&[i64]) -> bool) -> bool {
        let Some([from, to, step]) = grid.get(args.len()) else { return visit(args) };
        let mut x = *from;
        loop {
            args.push(x);
            let keep_going = walk(grid, args, visit);
            args.pop();
            if !keep_going {
                return false;
            }
            match x.checked_add(*step) {
                Some(next) if next <= *to => x = next,
                _ => return true,
            }
        }
    }
    walk(grid, &mut Vec::with_capacity(grid.len()), visit);
}
