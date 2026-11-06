#!/usr/bin/env python3
"""Adds the public format to the example checks, from their own references, and sets the verifier hash.
   python3 deploy/update-example-checks.py <verifier wasm hash>"""
import json, sys

kinds = {str: "string", bool: "boolean", int: "integer", list: "array", dict: "object"}


def fields(row):
    return {name: kinds[type(value)] for name, value in sorted(row.items())}


def data_format(reference):
    rows = json.load(open(reference))["rows"]
    items = {}
    for name, value in rows[0].items():
        if isinstance(value, list) and value and isinstance(value[0], dict):
            items[name] = fields(value[0])
    out = {"kind": "data", "rows": fields(rows[0])}
    if items:
        out["items"] = items
    return out


verifier = sys.argv[1]
for path, reference in [
    ("examples/data-job/check-strong.json", "examples/data-job/reference.json"),
    ("examples/data-job/check-weak.json", "examples/data-job/reference.json"),
    ("examples/swarm-job/check.json", "examples/swarm-job/reference.json"),
    ("examples/function-job/check-strong.json", None),
    ("examples/function-job/check-weak.json", None),
]:
    check = json.load(open(path))
    format_ = data_format(reference) if reference else {"kind": "function", "export": check["export"], "arity": check["arity"], "fuel": check.get("fuel", 1000000)}
    check["proven_check"] = 2
    check["verifier"] = verifier
    check["format"] = json.dumps(format_, separators=(",", ":"), sort_keys=True)
    json.dump(check, open(path, "w"), indent=1)
    open(path, "a").write("\n")
    print(path, "format", check["format"][:70])
