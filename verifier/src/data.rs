//! Data-job rules. A data deliverable is `{"rows": [ {...}, ... ]}`.

use crate::check::{DataRule, DataRuleKind, FieldType};
use crate::FailedRule;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Runs the rules in order. `Err` names the first rule that failed, or `format` if the
/// deliverable is not a list of rows.
pub(crate) fn evaluate(rules: &[DataRule], deliverable: &Value) -> Result<(), FailedRule> {
    let rows = rows(deliverable).ok_or_else(FailedRule::format)?;
    for rule in rules {
        if !holds(&rule.kind, rows) {
            return Err(FailedRule(rule.id.clone()));
        }
    }
    Ok(())
}

/// True if the deliverable has exactly the published fields, with the published types.
pub(crate) fn fits_format(
    deliverable: &Value,
    row_fields: &BTreeMap<String, FieldType>,
    item_fields: &BTreeMap<String, BTreeMap<String, FieldType>>,
) -> bool {
    let exact = |value: &Value, fields: &BTreeMap<String, FieldType>| {
        value.as_object().is_some_and(|object| {
            object.len() == fields.len() && fields.iter().all(|(name, ty)| has_type(object.get(name), *ty))
        })
    };
    rows(deliverable).is_some_and(|rows| {
        rows.iter().all(|row| {
            exact(row, row_fields)
                && item_fields.iter().all(|(array, fields)| {
                    row.get(array).and_then(Value::as_array).is_some_and(|list| list.iter().all(|item| exact(item, fields)))
                })
        })
    })
}

/// True if `fake` states different facts from `reference`: the same rows in another order
/// count as the same result.
pub(crate) fn differs(reference: &Value, fake: &Value) -> bool {
    match (rows(reference), rows(fake)) {
        (Some(a), Some(b)) => normalized(a) != normalized(b),
        _ => true,
    }
}

fn rows(deliverable: &Value) -> Option<&Vec<Value>> {
    deliverable.as_object().filter(|o| o.len() == 1)?.get("rows")?.as_array()
}

fn normalized(rows: &[Value]) -> Vec<String> {
    let mut texts: Vec<String> = rows.iter().map(Value::to_string).collect();
    texts.sort();
    texts
}

fn holds(kind: &DataRuleKind, rows: &[Value]) -> bool {
    match kind {
        DataRuleKind::RowCount { min, max } => (*min..=*max).contains(&(rows.len() as u64)),
        DataRuleKind::Fields { fields } => {
            rows.iter().all(|row| fields.iter().all(|(name, ty)| has_type(row.get(name), *ty)))
        }
        DataRuleKind::ItemFields { array, fields } => all_items(rows, array, |item| {
            fields.iter().all(|(name, ty)| has_type(item.get(name), *ty))
        }),
        DataRuleKind::Unique { field } => {
            let mut seen = BTreeSet::new();
            rows.iter().all(|row| row.get(field).is_some_and(|v| seen.insert(v.to_string())))
        }
        DataRuleKind::Range { field, min, max } => rows.iter().all(|row| in_range(row.get(field), *min, *max)),
        DataRuleKind::ItemRange { array, field, min, max } => {
            all_items(rows, array, |item| in_range(item.get(field), *min, *max))
        }
        DataRuleKind::SumEquals { array, item_field, total_field } => rows.iter().all(|row| {
            let items = row.get(array).and_then(Value::as_array);
            let sum = items.and_then(|items| checked_sum(items.iter().map(|i| i.get(item_field))));
            sum.is_some() && sum == row.get(total_field).and_then(Value::as_i64)
        }),
        DataRuleKind::ColumnTotal { field, equals } => {
            checked_sum(rows.iter().map(|row| row.get(field))) == Some(*equals)
        }
        DataRuleKind::SpotCheck { key_field, key, field, equals } => {
            let mut matching = rows.iter().filter(|row| row.get(key_field) == Some(key));
            matches!((matching.next(), matching.next()), (Some(row), None) if row.get(field) == Some(equals))
        }
    }
}

fn all_items(rows: &[Value], array: &str, item_ok: impl Fn(&Value) -> bool) -> bool {
    rows.iter().all(|row| row.get(array).and_then(Value::as_array).is_some_and(|items| items.iter().all(&item_ok)))
}

fn has_type(value: Option<&Value>, ty: FieldType) -> bool {
    match (value, ty) {
        (Some(Value::String(_)), FieldType::String) => true,
        (Some(v), FieldType::Integer) => v.as_i64().is_some(),
        (Some(Value::Bool(_)), FieldType::Boolean) => true,
        (Some(Value::Array(_)), FieldType::Array) => true,
        (Some(Value::Object(_)), FieldType::Object) => true,
        _ => false,
    }
}

fn in_range(value: Option<&Value>, min: i64, max: i64) -> bool {
    value.and_then(Value::as_i64).is_some_and(|v| (min..=max).contains(&v))
}

/// Sum of integer values; `None` if any value is missing, not an integer, or the sum overflows.
fn checked_sum<'a>(mut values: impl Iterator<Item = Option<&'a Value>>) -> Option<i64> {
    values.try_fold(0i64, |acc, v| acc.checked_add(v?.as_i64()?))
}
