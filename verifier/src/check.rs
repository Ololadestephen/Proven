//! The acceptance-check format a buyer writes, and the fakes bundle it is challenged with.

use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Longest rule id or fake name, so a verdict always fits OutLayer's output limit.
pub(crate) const MAX_NAME_LEN: usize = 32;
const MAX_ARITY: usize = 4;
const MAX_FUEL: u64 = 10_000_000;
const DEFAULT_FUEL: u64 = 1_000_000;
/// Rules in one check. The first failing rule is reported, so this also bounds what a buyer's own
/// check can learn from one attempt: at most about five bits.
pub(crate) const MAX_RULES: usize = 32;
/// Longest format text. The bid publishes this exact text on chain.
pub(crate) const MAX_FORMAT_BYTES: usize = 2_048;
/// Reported when a deliverable does not fit the public format. A check cannot use this id, so a
/// buyer cannot pass off a real rule as a format failure and keep the attempt fee.
pub(crate) const FORMAT_RULE: &str = "format";
const CHECK_VERSION: u32 = 2;

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
    /// The bid's public format, as its exact text. The verifier hashes this text, and reports the
    /// hash so the contracts can match it with the job and the bid.
    pub format: String,
    pub rules: Vec<DataRule>,
}

/// What a delivery must look like, published with the bid. Rows and items must have exactly these
/// fields, so a worker can see every field a check may look at before starting.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Format {
    Data {
        rows: BTreeMap<String, FieldType>,
        #[serde(default)]
        items: BTreeMap<String, BTreeMap<String, FieldType>>,
    },
    /// A function delivery: a WebAssembly module with no imports, at most 64 KB and 16 MB of memory,
    /// exporting `export`, taking `arity` i64 arguments and returning one i64, with `fuel` for each call.
    /// The check must use the same values.
    Function {
        export: String,
        arity: usize,
        fuel: u64,
    },
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
    pub format: String,
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
        let names_ok = !ids.is_empty()
            && ids.len() <= MAX_RULES
            && unique.len() == ids.len()
            && ids.iter().all(|id| valid_name(id) && *id != FORMAT_RULE);
        let base_ok = version == CHECK_VERSION && is_hash(verifier) && names_ok && self.parsed_format().is_some();
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

    /// The exact text of the public format.
    pub fn format_text(&self) -> &str {
        match self {
            Check::Data(c) => &c.format,
            Check::Function(c) => &c.format,
        }
    }

    /// The public format, if it is well formed and of this check's kind.
    pub fn parsed_format(&self) -> Option<Format> {
        let text = self.format_text();
        if text.len() > MAX_FORMAT_BYTES {
            return None;
        }
        let format: Format = serde_json::from_str(text).ok()?;
        match (&format, self) {
            (Format::Data { rows, items }, Check::Data(_)) => {
                let items_declared = items.keys().all(|array| rows.get(array) == Some(&FieldType::Array));
                let named = rows.keys().chain(items.values().flat_map(|fields| fields.keys()));
                (!rows.is_empty() && items_declared && named.into_iter().all(|name| valid_name(name))).then_some(format)
            }
            (Format::Function { export, arity, fuel }, Check::Function(c)) => {
                (*export == c.export && *arity == c.arity && *fuel == c.fuel).then_some(format)
            }
            _ => None,
        }
    }

    /// True if every field a rule looks at is published in the format, with the same type. A check
    /// that needs anything else is refused, so a worker can never fail on a field nobody told them about.
    pub fn rules_within_format(&self) -> bool {
        match (self, self.parsed_format()) {
            (Check::Data(c), Some(Format::Data { rows, items })) => c.rules.iter().all(|rule| rule.kind.within(&rows, &items)),
            (Check::Function(_), Some(Format::Function { .. })) => true,
            _ => false,
        }
    }
}

impl DataRuleKind {
    fn within(&self, rows: &BTreeMap<String, FieldType>, items: &BTreeMap<String, BTreeMap<String, FieldType>>) -> bool {
        let row = |field: &String, ty: FieldType| rows.get(field) == Some(&ty);
        let row_any = |field: &String| rows.contains_key(field);
        let item = |array: &String, field: &String, ty: FieldType| items.get(array).and_then(|f| f.get(field)) == Some(&ty);
        match self {
            DataRuleKind::RowCount { .. } => true,
            DataRuleKind::Fields { fields } => fields.iter().all(|(field, ty)| rows.get(field) == Some(ty)),
            DataRuleKind::ItemFields { array, fields } => {
                fields.iter().all(|(field, ty)| items.get(array).and_then(|f| f.get(field)) == Some(ty))
            }
            DataRuleKind::Unique { field } => row_any(field),
            DataRuleKind::Range { field, .. } | DataRuleKind::ColumnTotal { field, .. } => row(field, FieldType::Integer),
            DataRuleKind::ItemRange { array, field, .. } => item(array, field, FieldType::Integer),
            DataRuleKind::SumEquals { array, item_field, total_field } => {
                item(array, item_field, FieldType::Integer) && row(total_field, FieldType::Integer)
            }
            // Only scalars of the published type: comparing a whole object or array would look inside a
            // field the format leaves opaque.
            DataRuleKind::SpotCheck { key_field, key, field, equals } => {
                let scalar = |name: &String, value: &Value| {
                    rows.get(name).is_some_and(|ty| match ty {
                        FieldType::String => value.is_string(),
                        FieldType::Integer => value.is_i64() || value.is_u64(),
                        FieldType::Boolean => value.is_boolean(),
                        FieldType::Array | FieldType::Object => false,
                    })
                };
                scalar(key_field, key) && scalar(field, equals)
            }
        }
    }

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
