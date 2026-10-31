import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
copyFileSync("LICENSE", "sdk/LICENSE");
rmSync("sdk/dist", { recursive: true, force: true });
// Run tsc through node rather than the .bin shim: on Windows the shim is a
// .cmd and execFileSync on the extensionless path fails with ENOENT.
execFileSync(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "sdk/tsconfig.json"], { stdio: "inherit" });
for (const [outfile, platform] of [["sdk/dist/index.js", "neutral"], ["sdk/dist/browser.js", "browser"]] as const) {
  await build({ entryPoints: ["sdk/index.ts"], outfile, bundle: true, format: "esm", platform, target: "es2022" });
}
await build({
  entryPoints: ["sdk/generated/zod.gen.ts"],
  outfile: "sdk/dist/schemas.js",
  bundle: true,
  external: ["zod"],
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
copyFileSync("sdk/dist/generated/zod.gen.d.ts", "sdk/dist/schemas.d.ts");
copyFileSync("sdk/dist/index.d.ts", "sdk/dist/browser.d.ts");
mkdirSync("build", { recursive: true });
