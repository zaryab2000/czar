import json,sys,os
m=json.load(open(sys.argv[1])); out=sys.argv[2]
for s,c in zip(m['sources'], m.get('sourcesContent') or []):
    if c is None or 'node_modules' in s: continue
    p=os.path.join(out, s.replace('../','').lstrip('/'))
    os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w').write(c)
print(len(m['sources']))
