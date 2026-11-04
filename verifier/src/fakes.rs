//! Planted-fake generation, run inside the verifier during a challenge.
//!
//! The buyer supplies only a reference result; the fakes are produced here, mechanically and
//! with no model, so the same reference and the same verifier build always give the same fakes,
//! and nobody can make a weak check look strong by choosing easy fakes. Data fakes apply mutation
//! operators to a reference `{"rows": [...]}`. Function fakes apply single-operator mutations to
//! the reference function's WebAssembly text, and a mutant is planted only if a search finds a
//! witness input where it disagrees with the reference (run with fixed fuel, independent of the
//! buyer's check). Mutants with no witness are counted as unconfirmed and never as caught.

use crate::function::Function;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// Fuel per call while searching for witnesses; independent of any buyer's check.
const GENERATOR_FUEL: u64 = 1_000_000;
/// Most function mutants planted per challenge, so one challenge's work stays bounded.
const MAX_MUTANTS: usize = 32;
/// Most reference constants used to place probe points, and most grid probe points in all.
const MAX_CONSTANTS: usize = 16;
const MAX_GRID_PROBES: usize = 4_096;
const RANDOM_PROBES: usize = 200_000;

/// A planted fake: a wrong deliverable and the name of the mutation that made it.
pub(crate) struct Planted {
    pub(crate) name: String,
    pub(crate) deliverable: Value,
}

/// The reference for a function job: the correct function as WebAssembly text, and an inclusive
/// `[low, high]` range per argument for the witness search.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FunctionReference {
    pub(crate) wat: String,
    pub(crate) domain: Vec<[i64; 2]>,
}

/// Function fakes and how many mutants could not be confirmed wrong.
pub(crate) struct FunctionFakes {
    pub(crate) reference: Value,
    pub(crate) planted: Vec<Planted>,
    pub(crate) unconfirmed: Vec<String>,
}

// ---------------------------------------------------------------- data fakes

/// Wrong-but-plausible variants of a data reference. Fakes that state the same facts as the
/// reference (for example on a row with no numbers) are skipped.
pub(crate) fn data_fakes(reference: &Value) -> Result<Vec<Planted>, String> {
    let rows = reference
        .get("rows")
        .and_then(Value::as_array)
        .filter(|r| r.len() >= 3 && r.iter().all(Value::is_object))
        .ok_or("the reference must be {\"rows\": [...]} with at least 3 rows, each an object")?;
    let picks = [("first", 0), ("middle", rows.len() / 2), ("last", rows.len() - 1)];
    let mut fakes: Vec<(String, Vec<Value>)> = Vec::new();

    for (label, r) in picks {
        // One item value nudged by one unit: the totals no longer reconcile.
        fakes.push((format!("item_plus_one_{label}"), with_row(rows, r, |row| add_to_first_item_int(row, 1))));
        // An item and every row total shifted together: reconciles, but the facts are wrong.
        fakes.push((
            format!("consistent_shift_{label}"),
            with_row(rows, r, |row| {
                add_to_first_item_int(row, 100);
                add_to_row_ints(row, 100);
            }),
        ));
    }
    let mut dropped = rows.clone();
    dropped.pop();
    fakes.push(("drop_last_row".into(), dropped));

    let mut duplicated = rows.clone();
    duplicated.push(rows[rows.len() - 1].clone());
    fakes.push(("duplicate_last_row".into(), duplicated));

    let mut fabricated = rows.clone();
    let mut invented = rows[rows.len() - 1].clone();
    suffix_row_strings(&mut invented, "-X");
    add_to_first_item_int(&mut invented, 7);
    add_to_row_ints(&mut invented, 7);
    fabricated.push(invented);
    fakes.push(("fabricated_row".into(), fabricated));

    let mut swapped = rows.clone();
    swap_row_ints(&mut swapped, 0, 1);
    fakes.push(("swapped_totals".into(), swapped));

    fakes.push(("units_x100".into(), rows.iter().cloned().map(|mut row| { scale_all_ints(&mut row, 100); row }).collect()));

    fakes.push((
        "negative_item_middle".into(),
        with_row(rows, rows.len() / 2, |row| {
            if let Some(v) = first_item_int(row) {
                add_to_first_item_int(row, -2 * v);
                add_to_row_ints(row, -2 * v);
            }
        }),
    ));

    let mut stolen = rows.clone();
    if let Some((field, value)) = first_string_field(&rows[0]) {
        stolen[1][field.as_str()] = value;
    }
    fakes.push(("copied_key".into(), stolen));

    let reference_rows = json!({ "rows": rows });
    Ok(fakes
        .into_iter()
        .map(|(name, rows)| Planted { name, deliverable: json!({ "rows": rows }) })
        .filter(|f| crate::data::differs(&reference_rows, &f.deliverable))
        .collect())
}

fn with_row(rows: &[Value], r: usize, change: impl FnOnce(&mut Value)) -> Vec<Value> {
    let mut rows = rows.to_vec();
    change(&mut rows[r]);
    rows
}

fn row_object(row: &mut Value) -> Option<&mut Map<String, Value>> {
    row.as_object_mut()
}

fn first_item(row: &mut Value) -> Option<&mut Map<String, Value>> {
    row_object(row)?
        .values_mut()
        .find_map(|v| v.as_array_mut().and_then(|items| items.first_mut()).and_then(Value::as_object_mut))
}

fn first_item_int(row: &Value) -> Option<i64> {
    row.as_object()?
        .values()
        .find_map(|v| v.as_array().and_then(|items| items.first()))?
        .as_object()?
        .values()
        .find_map(Value::as_i64)
}

fn add_to_first_item_int(row: &mut Value, delta: i64) {
    if let Some(v) = first_item(row).and_then(|item| item.values_mut().find(|v| v.as_i64().is_some())) {
        *v = json!(v.as_i64().unwrap_or(0).saturating_add(delta));
    }
}

fn add_to_row_ints(row: &mut Value, delta: i64) {
    for v in row_object(row).into_iter().flat_map(|o| o.values_mut()) {
        if let Some(n) = v.as_i64() {
            *v = json!(n.saturating_add(delta));
        }
    }
}

fn scale_all_ints(value: &mut Value, factor: i64) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(|v| scale_all_ints(v, factor)),
        Value::Object(map) => map.values_mut().for_each(|v| scale_all_ints(v, factor)),
        v => {
            if let Some(n) = v.as_i64() {
                *v = json!(n.saturating_mul(factor));
            }
        }
    }
}

fn swap_row_ints(rows: &mut [Value], a: usize, b: usize) {
    let ints = |row: &Value| -> Vec<(String, Value)> {
        row.as_object().into_iter().flatten().filter(|(_, v)| v.as_i64().is_some()).map(|(k, v)| (k.clone(), v.clone())).collect()
    };
    let (from_a, from_b) = (ints(&rows[a]), ints(&rows[b]));
    for (k, v) in from_b {
        rows[a][k.as_str()] = v;
    }
    for (k, v) in from_a {
        rows[b][k.as_str()] = v;
    }
}

fn suffix_row_strings(row: &mut Value, suffix: &str) {
    for v in row_object(row).into_iter().flat_map(|o| o.values_mut()) {
        if let Value::String(s) = v {
            s.push_str(suffix);
        }
    }
}

fn first_string_field(row: &Value) -> Option<(String, Value)> {
    row.as_object()?.iter().find(|(_, v)| v.is_string()).map(|(k, v)| (k.clone(), v.clone()))
}

// ---------------------------------------------------------------- function fakes

/// Single-operator substitutions applied to WebAssembly text, one occurrence at a time.
const SWAPS: &[(&str, &str)] = &[
    ("i64.lt_s", "i64.le_s"),
    ("i64.le_s", "i64.lt_s"),
    ("i64.gt_s", "i64.ge_s"),
    ("i64.ge_s", "i64.gt_s"),
    ("i64.eq", "i64.ne"),
    ("i64.ne", "i64.eq"),
    ("i64.add", "i64.sub"),
    ("i64.sub", "i64.add"),
    ("i64.mul", "i64.add"),
    ("i64.div_s", "i64.div_u"),
    ("i64.rem_s", "i64.rem_u"),
];

/// Mutants of a reference function that are confirmed wrong by a witness input.
pub(crate) fn function_fakes(reference: &FunctionReference, export: &str, arity: usize) -> Result<FunctionFakes, String> {
    if reference.domain.len() != arity || reference.domain.iter().any(|[low, high]| low > high) {
        return Err(format!("the domain needs one [low, high] per argument ({arity})"));
    }
    let domain: Vec<(i64, i64)> = reference.domain.iter().map(|[low, high]| (*low, *high)).collect();
    let reference_deliverable = deliverable_from_wat(&reference.wat)?;
    let mut reference_fn = Function::load(&reference_deliverable, export, arity, GENERATOR_FUEL).ok_or("the reference does not load")?;
    let constants = constants(&reference.wat);
    let grid = grid_points(&domain, &constants);

    let mut planted = Vec::new();
    let mut unconfirmed = Vec::new();
    // Fakes are named by position only, so a rejected check's missed list says nothing about the
    // reference's operators, lines or constants.
    for (index, mutant_wat) in mutants(&reference.wat).into_iter().take(MAX_MUTANTS).enumerate() {
        let name = format!("fn_mutant_{index:02}");
        let Ok(deliverable) = deliverable_from_wat(&mutant_wat) else { continue };
        let confirmed = match Function::load(&deliverable, export, arity, GENERATOR_FUEL) {
            None => true,
            Some(mut mutant) => probes(&domain, &grid).any(|args| {
                let expected = reference_fn.call(&args);
                expected.is_some() && mutant.call(&args) != expected
            }),
        };
        if confirmed {
            planted.push(Planted { name, deliverable });
        } else {
            unconfirmed.push(name);
        }
    }
    Ok(FunctionFakes { reference: reference_deliverable, planted, unconfirmed })
}

pub fn deliverable_from_wat(wat_text: &str) -> Result<Value, String> {
    let bytes = wat::parse_str(wat_text).map_err(|e| format!("invalid WebAssembly text: {e}"))?;
    Ok(json!({ "wasm_base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

fn mutants(wat_text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (from, to) in SWAPS {
        for (at, _) in wat_text.match_indices(from) {
            // Skip partial matches such as `i64.le_s` inside `i64.le_u`.
            let next = wat_text[at + from.len()..].chars().next();
            if next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            out.push(format!("{}{}{}", &wat_text[..at], to, &wat_text[at + from.len()..]));
        }
    }
    // Every integer constant nudged up and down by one.
    let mut search = 0;
    while let Some(found) = wat_text[search..].find("i64.const ") {
        let start = search + found + "i64.const ".len();
        let end = start + wat_text[start..].find(|c: char| !(c.is_ascii_digit() || c == '-')).unwrap_or(wat_text.len() - start);
        if let Ok(n) = wat_text[start..end].parse::<i64>() {
            for value in [n.wrapping_add(1), n.wrapping_sub(1)] {
                out.push(format!("{}{}{}", &wat_text[..start], value, &wat_text[end..]));
            }
        }
        search = end.max(start);
    }
    out
}

/// Every `i64.const` value in the text, where off-by-one mistakes usually live.
fn constants(wat_text: &str) -> Vec<i64> {
    wat_text
        .split("i64.const ")
        .skip(1)
        .filter_map(|rest| rest.split(|c: char| !(c.is_ascii_digit() || c == '-')).next()?.parse().ok())
        .fold(Vec::new(), |mut seen: Vec<i64>, c| {
            if !seen.contains(&c) && seen.len() < MAX_CONSTANTS {
                seen.push(c);
            }
            seen
        })
}

/// Grid probe points: for each argument its domain's edges, a coarse grid, and the reference's
/// constants one either side, combined across arguments and thinned to at most `MAX_GRID_PROBES`.
fn grid_points(domain: &[(i64, i64)], constants: &[i64]) -> Vec<Vec<i64>> {
    let mut axes: Vec<Vec<i64>> = domain
        .iter()
        .map(|&(low, high)| {
            let mut values = vec![low, high, low.saturating_add(1), high.saturating_sub(1)];
            if low <= 0 && 0 <= high {
                values.push(0);
            }
            for k in 1..10 {
                values.push(low + ((high as i128 - low as i128) * k / 10) as i64);
            }
            for c in constants {
                values.extend([c.saturating_sub(1), *c, c.saturating_add(1)]);
            }
            values.retain(|v| (low..=high).contains(v));
            values.sort();
            values.dedup();
            values
        })
        .collect();
    // Thin the longest axis (keeping every other value) until the product fits.
    while axes.iter().map(Vec::len).product::<usize>() > MAX_GRID_PROBES {
        let longest = axes.iter_mut().max_by_key(|a| a.len()).expect("at least one axis");
        *longest = longest.iter().step_by(2).copied().collect();
    }
    axes.iter().fold(vec![Vec::new()], |points, axis| {
        points.into_iter().flat_map(|p| axis.iter().map(move |v| { let mut q = p.clone(); q.push(*v); q })).collect()
    })
}

/// The grid points, then `RANDOM_PROBES` pseudo-random points from a fixed seed (so the search,
/// and the fakes, are reproducible), produced one at a time.
fn probes<'a>(domain: &'a [(i64, i64)], grid: &'a [Vec<i64>]) -> impl Iterator<Item = Vec<i64>> + 'a {
    let mut state: u64 = 0x5052_4f56_454e_0001;
    let random = (0..RANDOM_PROBES).map(move |_| {
        domain
            .iter()
            .map(|&(low, high)| {
                let span = (high as i128 - low as i128 + 1) as u128;
                low + (u128::from(splitmix64(&mut state)) % span) as i64
            })
            .collect()
    });
    grid.iter().cloned().chain(random)
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example(path: &str) -> String {
        std::fs::read_to_string(format!("../examples/{path}")).unwrap()
    }

    #[test]
    fn data_fakes_are_reproducible_and_all_differ_from_the_reference() {
        let reference: Value = serde_json::from_str(&example("data-job/reference.json")).unwrap();
        let names = |fakes: &[Planted]| fakes.iter().map(|f| f.name.clone()).collect::<Vec<_>>();
        let first = data_fakes(&reference).unwrap();
        assert_eq!(names(&first), names(&data_fakes(&reference).unwrap()));
        assert_eq!(first.len(), 13);
        assert!(first.iter().all(|f| crate::data::differs(&reference, &f.deliverable)));
    }

    #[test]
    fn data_fakes_need_at_least_three_object_rows() {
        assert!(data_fakes(&json!({ "rows": [{ "id": "a" }, { "id": "b" }] })).is_err());
        assert!(data_fakes(&json!({ "rows": [{ "id": "a", "t": 1 }, 5, { "id": "c", "t": 2 }] })).is_err());
    }

    #[test]
    fn many_constants_stay_within_the_probe_and_mutant_caps() {
        let body: String = (0..60).map(|i| format!("(i64.add (i64.const {i}))")).collect();
        let wat = format!("(module (func (export \"f\") (param i64 i64 i64 i64) (result i64) (local.get 0) {body}))");
        let constants = constants(&wat);
        assert_eq!(constants.len(), MAX_CONSTANTS);
        let domain = [(0, 1_000_000); 4];
        assert!(grid_points(&domain, &constants).len() <= MAX_GRID_PROBES);
        assert!(mutants(&wat).len() > MAX_MUTANTS);
    }

    #[test]
    fn function_fakes_keep_only_confirmed_mutants() {
        let reference: FunctionReference = serde_json::from_str(&example("function-job/challenge-reference.json")).unwrap();
        let fakes = function_fakes(&reference, "vat", 2).unwrap();
        assert_eq!(fakes.planted.len(), 11);
        assert_eq!(fakes.unconfirmed.len(), 1);
        assert!(fakes.planted.iter().all(|f| f.name.starts_with("fn_mutant_")));
    }

    #[test]
    fn function_reference_needs_one_range_per_argument() {
        let reference = FunctionReference { wat: example("function-job/reference.wat"), domain: vec![[0, 10]] };
        assert!(function_fakes(&reference, "vat", 2).is_err());
    }

    #[test]
    fn invalid_webassembly_text_is_reported() {
        assert!(deliverable_from_wat("(module (func").is_err());
    }
}
