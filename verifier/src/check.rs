//! The acceptance-check format a buyer writes, and the fakes bundle it is challenged with.

use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Longest rule id or fake name, so a verdict always fits OutLayer's output limit.
pub(crate) const MAX_NAME_LEN: usize = 32;
const MAX_ARITY: usize = 4;
const MAX_FUEL: u64 = 10_000_000;
const DEFAULT_FUEL: u64 = 1_000_000;

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Check {
    Data(DataCheck),
    Function(FunctionCheck),
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct DataCheck {
    pub proven_check: u32,
    /// SHA-256 of the verifier build this check is written for. The relay compares it with the
    /// WASM hash in the attestation.
    pub verifier: String,
    pub rules: Vec<DataRule>,
}

#[derive(Deserialize, Debug)]
pub(crate) struct DataRule {
    pub id: String,
    #[serde(flatten)]
    pub kind: DataRuleKind,
}

/// Rules over a data deliverable of the form `{"rows": [ {...}, ... ]}`.
#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum DataRuleKind {
    /// The number of rows is within `min..=max`.
    RowCount { min: u64, max: u64 },
    /// Every row has these fields with these types.
    Fields { fields: BTreeMap<String, FieldType> },
    /// Every item of every row's `array` has these fields with these types.
    ItemFields { array: String, fields: BTreeMap<String, FieldType> },
    /// No two rows share a value of `field`.
    Unique { field: String },
    /// Every row's integer `field` is within `min..=max`.
    Range { field: String, min: i64, max: i64 },
    /// Every item's integer `field` in every row's `array` is within `min..=max`.
    ItemRange { array: String, field: String, min: i64, max: i64 },
    /// In every row, the items' `item_field` values add up to the row's `total_field`.
    SumEquals { array: String, item_field: String, total_field: String },
    /// The rows' integer `field` values add up to `equals`.
    ColumnTotal { field: String, equals: i64 },
    /// Exactly one row has `key_field == key`, and its `field` equals `equals`.
    /// Spot checks are known answers the buyer keeps private until verification.
    SpotCheck { key_field: String, key: Value, field: String, equals: Value },
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FieldType {
    String,
    Integer,
    Boolean,
    Array,
    Object,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct FunctionCheck {
    pub proven_check: u32,
    pub verifier: String,
    /// Name of the exported function. It takes `arity` i64 arguments and returns one i64.
    pub export: String,
    pub arity: usize,
    /// Fuel for each call, so a looping function cannot stall the verifier.
    #[serde(default = "default_fuel")]
    pub fuel: u64,
    pub rules: Vec<FunctionRule>,
}

fn default_fuel() -> u64 {
    DEFAULT_FUEL
}

#[derive(Deserialize, Debug)]
pub(crate) struct FunctionRule {
    pub id: String,
    #[serde(flatten)]
    pub kind: FunctionRuleKind,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum FunctionRuleKind {
    /// Each case's result equals `expect`.
    Vectors { cases: Vec<Case> },
    /// Holding the other arguments at `fixed`, the result never decreases as argument `arg`
    /// steps from `from` to `to`.
    Monotonic { arg: usize, from: i64, to: i64, step: i64, fixed: Vec<i64> },
    /// For every point of the grid (one `[from, to, step]` per argument), the result is within
    /// `min..=max`.
    OutputRange { grid: Vec<[i64; 3]>, min: i64, max: i64 },
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct Case {
    pub args: Vec<i64>,
    pub expect: i64,
}

/// Grid points a rule may evaluate, so one check cannot exhaust the verifier's budget.
pub(crate) const MAX_GRID_POINTS: u64 = 20_000;

impl Check {
    /// Parses and validates a check text.
    pub fn parse(text: &str) -> Option<Self> {
        let check: Check = serde_json::from_str(text).ok()?;
        check.validate().then_some(check)
    }

    fn validate(&self) -> bool {
        let (version, verifier, ids): (u32, &str, Vec<&str>) = match self {
            Check::Data(c) => (c.proven_check, &c.verifier, c.rules.iter().map(|r| r.id.as_str()).collect()),
            Check::Function(c) => (c.proven_check, &c.verifier, c.rules.iter().map(|r| r.id.as_str()).collect()),
        };
        let unique: BTreeSet<&str> = ids.iter().copied().collect();
        let names_ok = !ids.is_empty() && unique.len() == ids.len() && ids.iter().all(|id| valid_name(id));
        let base_ok = version == 1 && is_hash(verifier) && names_ok;
        base_ok
            && match self {
                Check::Data(c) => c.rules.iter().all(|r| r.kind.is_valid()),
                Check::Function(c) => {
                    (1..=MAX_ARITY).contains(&c.arity)
                        && valid_name(&c.export)
                        && (1..=MAX_FUEL).contains(&c.fuel)
                        && c.rules.iter().all(|r| r.kind.is_valid(c.arity))
                }
            }
    }
}

impl DataRuleKind {
    fn is_valid(&self) -> bool {
        match self {
            DataRuleKind::RowCount { min, max } => min <= max,
            DataRuleKind::Range { min, max, .. } | DataRuleKind::ItemRange { min, max, .. } => min <= max,
            _ => true,
        }
    }
}

impl FunctionRuleKind {
    fn is_valid(&self, arity: usize) -> bool {
        match self {
            FunctionRuleKind::Vectors { cases } => {
                !cases.is_empty() && cases.len() as u64 <= MAX_GRID_POINTS && cases.iter().all(|c| c.args.len() == arity)
            }
            FunctionRuleKind::Monotonic { arg, from, to, step, fixed } => {
                *arg < arity && fixed.len() == arity && *step > 0 && from < to && steps(*from, *to, *step) <= MAX_GRID_POINTS
            }
            FunctionRuleKind::OutputRange { grid, min, max } => {
                grid.len() == arity && min <= max && grid_points(grid).is_some_and(|n| n <= MAX_GRID_POINTS)
            }
        }
    }
}

/// Number of points from `from` to `to` inclusive in steps of `step`.
pub(crate) fn steps(from: i64, to: i64, step: i64) -> u64 {
    if step <= 0 || to < from {
        return 0;
    }
    ((to as i128 - from as i128) / step as i128 + 1).min(u64::MAX as i128) as u64
}

pub(crate) fn grid_points(grid: &[[i64; 3]]) -> Option<u64> {
    grid.iter().try_fold(1u64, |n, [from, to, step]| {
        let s = steps(*from, *to, *step);
        if s == 0 { None } else { n.checked_mul(s) }
    })
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

pub(crate) fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
