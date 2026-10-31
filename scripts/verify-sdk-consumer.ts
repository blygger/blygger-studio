import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

export async function verifySdkConsumer(temp: string, archive: string, baseUrl: string, token: string, studioUrl: string) {
  const consumer = join(temp, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "release-consumer", private: true, type: "module" }));
  // Keep the consumer install offline while supplying the schema export's
  // declared Zod dependency from the same version used to build the SDK.
  const npmIsolation = ["--cache", join(temp, "npm-cache"), "--userconfig", join(temp, "empty-npmrc")];
  const packedZod = JSON.parse(execFileSync("npm", ["pack", resolve("node_modules/zod"), "--json", "--ignore-scripts", "--pack-destination", temp, ...npmIsolation], { encoding: "utf8" }));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...npmIsolation, resolve(archive), join(temp, packedZod[0].filename)], { cwd: consumer, stdio: "pipe" });
  const smoke = `import assert from 'node:assert/strict';
import { BlyggerApi, createBlyggerClient, unwrap } from '@blygger/sdk';
import { zItem } from '@blygger/sdk/schemas';
const client = createBlyggerClient({baseUrl: process.env.TEST_URL, auth: scheme => scheme.in === 'cookie' ? process.env.TEST_TOKEN : undefined});
const created = await unwrap(BlyggerApi.createItem({client, body: {contentMd: 'Installed Node consumer'}}));
assert.equal(zItem.parse(await unwrap(BlyggerApi.getItem({client, path: {id: created.id}}))).contentMd, 'Installed Node consumer');
assert.equal(zItem.safeParse({...created, kind: 'invalid'}).success, false);
const media = await unwrap(BlyggerApi.uploadMedia({client, body: {file: new File(['consumer'], 'consumer.png', {type: 'image/png'})}}));
assert.equal(media.mime, 'image/png');
const unauthorized = await BlyggerApi.getSettings({client: createBlyggerClient({baseUrl: process.env.TEST_URL})});
assert.equal(unauthorized.response.status, 401);
console.log('Installed Node package exports/read/write/upload/auth passed');`;
  writeFileSync(join(consumer, "smoke.mjs"), smoke);
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, env: { ...process.env, TEST_URL: baseUrl, TEST_TOKEN: token }, stdio: "inherit" });
  writeFileSync(join(consumer, "types.ts"), `import { BlyggerApi, createBlyggerClient, unwrap, type BlyggerClientOptions } from '@blygger/sdk';
const options: BlyggerClientOptions = {baseUrl: 'https://example.org/api'};
const client = createBlyggerClient(options);
import { zItem } from '@blygger/sdk/schemas';
const item = await unwrap(BlyggerApi.createItem({client, body: {contentMd: 'typed'}}));
const id: string = item.id;
const parsed = zItem.parse(item);
const parsedId: string = parsed.id;
// @ts-expect-error Generated schema types must retain the API enum.
const invalidKind: typeof parsed.kind = 'invalid';
await BlyggerApi.getItem({client, path: {id}});
// @ts-expect-error Content must be text. An absent declaration makes this unused.
await BlyggerApi.createItem({client, body: {contentMd: 42}});
`);
  for (const [module, resolution, extra] of [["NodeNext", "NodeNext", []], ["ESNext", "Bundler", ["--customConditions", "browser"]]] as const) {
    execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable", "--module", module, "--moduleResolution", resolution, ...extra, "types.ts"], { cwd: consumer, stdio: "inherit" });
  }
  writeFileSync(join(consumer, "browser.js"), "import * as sdk from '@blygger/sdk'; import { zItem } from '@blygger/sdk/schemas'; globalThis.consumerSdk = sdk; globalThis.consumerSchema = zItem;");
  const bundle = await build({ absWorkingDir: consumer, entryPoints: ["browser.js"], platform: "browser", bundle: true, format: "iife", write: false, metafile: true });
  assert.ok(Object.keys(bundle.metafile!.inputs).some(path => path.endsWith("sdk/dist/browser.js")), "Browser export condition must select browser.js");
  assert.ok(Object.keys(bundle.metafile!.inputs).some(path => path.endsWith("sdk/dist/schemas.js")), "Schema export must resolve from the installed archive");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: "blyg_session", value: token, url: baseUrl }]);
    const page = await context.newPage();
    const navigation = await page.goto(studioUrl);
    assert.equal(navigation?.status(), 200, "Installed SDK browser fixture must load Studio");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async baseUrl => {
      const sdk = (globalThis as unknown as { consumerSdk: typeof import("../sdk/dist/browser.js") }).consumerSdk;
      const client = sdk.createBlyggerClient({ baseUrl });
      const created = await sdk.unwrap(sdk.BlyggerApi.createItem({ client, body: { contentMd: "Installed browser consumer" } }));
      const schema = (globalThis as unknown as { consumerSchema: typeof import("../sdk/dist/schemas.js").zItem }).consumerSchema;
      const item = schema.parse(await sdk.unwrap(sdk.BlyggerApi.getItem({ client, path: { id: created.id } })));
      const media = await sdk.unwrap(sdk.BlyggerApi.uploadMedia({ client, body: { file: new File(["browser"], "browser.png", { type: "image/png" }) } }));
      return { content: item.contentMd, mime: media.mime };
    }, baseUrl);
    assert.deepEqual(result, { content: "Installed browser consumer", mime: "image/png" });
  } finally { await browser.close(); }
  console.log("Installed SDK Node/browser exports, both TypeScript resolution modes, and Chromium read/write/upload verified");
}
