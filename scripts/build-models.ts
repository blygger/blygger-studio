// Merge models.json with an optional, gitignored models.local.json into
// build/models.json, which the Worker embeds (src/ai/models.ts). The local file
// is how an operator edits the model list without a merge conflict on the next
// `npm run upgrade`. Runs as the first step of `npm run build`. The merge and
// its checks live in models-manifest.ts, where the test suite can reach them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mergeManifest, type Local, type Manifest } from "./models-manifest.ts";

const fail = (msg: string): never => {
  console.error(`build-models: ${msg.split("\n").join("\nbuild-models: ")}`);
  process.exit(1);
};
const read = <T>(path: string): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    return fail(`${path} is not valid JSON: ${(e as Error).message}`);
  }
};

const base = read<Manifest>("models.json");
// A release bundles the shipped list only, never a maintainer's own overrides.
const local = !process.env.BLYG_MODELS_SHIPPED_ONLY && existsSync("models.local.json") ? read<Local>("models.local.json") : null;
let merged: Manifest = { providers: {}, models: [] };
try {
  merged = mergeManifest(base, local);
} catch (e) {
  fail((e as Error).message);
}

mkdirSync("build", { recursive: true });
writeFileSync("build/models.json", JSON.stringify({ ...merged, local: !!local }, null, 2) + "\n");
console.log(`build-models: ${merged.models.length} models from ${local ? "models.json + models.local.json" : "models.json"}`);
