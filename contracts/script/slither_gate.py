#!/usr/bin/env python3
"""T-025 gate (07 PRD 13): every Slither finding must be listed, with a reason, in slither-allowlist.json.

Usage (from contracts/): python3 script/slither_gate.py slither-out.json slither-allowlist.json
Exit 0 when every finding is listed; exit 1 and print the unlisted ones otherwise. Stale allowlist
entries (no longer reported) are printed as a warning so the list can be pruned.
"""
import json
import sys


def identity(result):
    """check + Contract.function (or variable) of the first function or variable element."""
    for element in result["elements"]:
        if element["type"] in ("function", "variable"):
            parent = element.get("type_specific_fields", {}).get("parent", {}).get("name", "")
            return f'{result["check"]}:{parent}.{element["name"]}'
    return f'{result["check"]}:?'


def main(out_path, allow_path):
    with open(out_path) as f:
        findings = json.load(f)["results"].get("detectors", [])
    with open(allow_path) as f:
        allowed = {f'{e["check"]}:{e["element"]}': e for e in json.load(f)["findings"]}
    seen = set()
    unlisted = []
    for result in findings:
        key = identity(result)
        seen.add(key)
        if key not in allowed or not allowed[key].get("reason"):
            unlisted.append(f'{result["impact"]:13} {key}')
    for key in sorted(set(allowed) - seen):
        print(f"stale allowlist entry (not reported any more): {key}")
    if unlisted:
        print("Slither findings without a triage reason:")
        print("\n".join(sorted(set(unlisted))))
        return 1
    print(f"slither gate: {len(findings)} findings, all triaged")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
