import { buildCanonicalManifest } from "./src/lib/docs-manifest";
import fs from "fs";

const fixture = JSON.parse(fs.readFileSync("./test/fixtures/canonical-manifest.json", "utf-8"));
const generated = buildCanonicalManifest([]);

const fixtureStr = JSON.stringify(fixture, null, 2);
const generatedStr = JSON.stringify(generated, null, 2);

if (fixtureStr === generatedStr) {
  console.log("MATCH");
} else {
  console.log("MISMATCH");
  fs.writeFileSync("generated.json", generatedStr);
}
