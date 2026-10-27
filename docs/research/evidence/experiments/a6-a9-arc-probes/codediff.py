"""Diff runtime code of the same address on two chains; print differing byte ranges."""
import subprocess
import sys

addr = sys.argv[1]
rpcs = sys.argv[2:]
codes = [bytes.fromhex(subprocess.check_output(["cast", "code", addr, "--rpc-url", r], text=True).strip()[2:]) for r in rpcs]
a, b = codes[0], codes[1]
print(addr, "sizes", len(a), len(b))
ranges, start = [], None
for i in range(min(len(a), len(b))):
    if a[i] != b[i]:
        start = i if start is None else start
    elif start is not None:
        ranges.append((start, i)); start = None
if start is not None:
    ranges.append((start, min(len(a), len(b))))
print("differing ranges:", [(s, e - s) for s, e in ranges])
for s, e in ranges[:6]:
    print(f"  @{s}: {a[s:e].hex()} vs {b[s:e].hex()}")
