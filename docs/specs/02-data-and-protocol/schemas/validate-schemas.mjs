// Full JSON Schema Draft 2020-12 check of every schema in this directory, plus every example file.
// Run: ES modules resolve packages next to the script, so copy it into a scratch directory that has
// `npm install ajv@8.17.1 ajv-formats@3.0.1`, then: node <scratch>/validate-schemas.mjs <this dir> <this dir>/../examples
// An example file named <name>.example.json or <name>.example.<label>.json is validated against <name>.schema.json.
// Exit code 0 only when every schema compiles and every example validates.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fs from "fs";
import path from "path";

const schemaDir = process.argv[2] ?? ".";
const exampleDir = process.argv[3];
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// Czar annotation keywords (schemas/README.md); they carry no validation semantics.
ajv.addKeyword({ keyword: "x-privacyClass" });
ajv.addKeyword({ keyword: "x-phase" });

const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
let failures = 0;
for (const f of files) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemaDir, f), "utf8")));
for (const f of files) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, f), "utf8"));
  try {
    const validate = ajv.getSchema(schema.$id);
    if (!validate) throw new Error("did not compile");
    for (const [i, ex] of (schema.examples ?? []).entries()) {
      if (!validate(ex)) { failures++; console.log(`EXAMPLE FAIL ${f} inline[${i}] ${JSON.stringify(validate.errors)}`); }
    }
    console.log(`schema ok   ${f}`);
  } catch (e) {
    failures++;
    console.log(`SCHEMA FAIL ${f} ${e.message}`);
  }
}
if (exampleDir) {
  for (const f of fs.readdirSync(exampleDir).filter((f) => f.endsWith(".json")).sort()) {
    const name = f.replace(/\.example(\.[a-z0-9-]+)?\.json$/, "");
    const validate = ajv.getSchema(`https://czar.dev/schemas/${name}.schema.json`);
    if (!validate) { failures++; console.log(`NO SCHEMA   ${f}`); continue; }
    const ex = JSON.parse(fs.readFileSync(path.join(exampleDir, f), "utf8"));
    if (validate(ex)) console.log(`example ok  ${f}`);
    else { failures++; console.log(`EXAMPLE FAIL ${f} ${JSON.stringify(validate.errors)}`); }
  }
}
console.log(failures ? `FAILURES: ${failures}` : "ALL PASS");
process.exit(failures ? 1 : 0);
