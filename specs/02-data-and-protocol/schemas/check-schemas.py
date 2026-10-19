import json, sys, glob, os
PC = {"local-only","redacted-to-server","server-only","hash-on-chain","public"}
bad = []
def walk(node, path, require_pc):
    if not isinstance(node, dict): return
    if "properties" in node:
        for k, v in node["properties"].items():
            p = f"{path}.{k}"
            if "description" not in v: bad.append(f"{p}: missing description")
            if v.get("x-privacyClass") not in PC: bad.append(f"{p}: missing/invalid x-privacyClass")
            walk(v, p, True)
    for key in ("items",):
        if key in node: walk(node[key], path + "[]", True)
    for key in ("oneOf", "anyOf", "allOf"):
        for i, b in enumerate(node.get(key, [])): walk(b, f"{path}/{key}[{i}]", True)
    for k, v in node.get("$defs", {}).items(): walk(v, f"{path}/$defs/{k}", False)
n = 0
for f in sorted(glob.glob("*.schema.json")):
    s = json.load(open(f)); n += 1
    if s.get("$schema") != "https://json-schema.org/draft/2020-12/schema": bad.append(f"{f}: wrong $schema")
    if not s.get("$id","").startswith("https://czar.dev/schemas/"): bad.append(f"{f}: bad $id")
    if f != "common.schema.json":
        if s.get("x-privacyClass") not in PC: bad.append(f"{f}: missing object-level x-privacyClass")
        if s.get("additionalProperties", True) is not False and f != "payment-ref.schema.json": bad.append(f"{f}: additionalProperties not false")
    walk(s, f, True)
print(f"checked {n} files; problems: {len(bad)}")
for b in bad: print(" -", b)
sys.exit(1 if bad else 0)
