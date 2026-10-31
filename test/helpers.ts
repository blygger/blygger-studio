import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { routes } from "../src/contract/routes.ts";
import { makeApp } from '../src/index.ts';
import { normalizeMount } from '../src/util.ts';

export const BASE = "https://example.com";
/** Matches vitest.config.ts's default-worker MOUNT binding ("/blyg") — studio is nested under it since session 16. */
export const STUDIO = "/blyg/studio";

/** Sequential fixture setup only. Concurrency/contract tests send their captured revision explicitly. */
export async function testItemRevision(id: string): Promise<number> {
  return (await env.DB.prepare('SELECT revision FROM items WHERE id = ?').bind(id).first<{ revision: number }>())?.revision ?? 1;
}
export async function testMediaRevision(id: string): Promise<number | undefined> {
  const row = await env.DB.prepare('SELECT item_id FROM media WHERE id = ?').bind(id).first<{ item_id: string | null }>();
  return row?.item_id ? testItemRevision(row.item_id) : undefined;
}

/** Carry current revisions only in sequential legacy fixture setup, never race probes. */
export async function testRevisionBody(method: string, path: string, body?: unknown): Promise<unknown> {
  const pathname = new URL(path, BASE).pathname;
  const item = /^(?:\/blyg)?\/api\/items\/([^/]+)(?:\/(?:publish|withdraw|restore|generate|refresh|classify|note-draft|versions\/\d+\/pin))?$/.exec(pathname);
  const media = /^(?:\/blyg)?\/api\/media\/([^/]+)$/.exec(pathname);
  if (!['GET', 'HEAD'].includes(method) && (item || media) &&
      (body === undefined || body !== null && typeof body === 'object' && !Array.isArray(body)) &&
      !(body && 'expectedRevision' in (body as object))) {
    const expectedRevision = item ? await testItemRevision(decodeURIComponent(item[1])) : await testMediaRevision(decodeURIComponent(media![1]));
    body = { ...(body as object | undefined), ...(expectedRevision === undefined ? {} : { expectedRevision }) };
  }
  return body;
}

/** Each call opens an independent test browser, with its own edge address. */
let ownerBrowserSequence = 0;
export async function login(password = "test-password", edgeIP = `2001:db8:c001:${(++ownerBrowserSequence).toString(16)}::1`): Promise<string> {
  const res = await SELF.fetch(`${BASE}${STUDIO}/login`, {
    method: "POST",
    headers: { "cf-connecting-ip": edgeIP },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`login failed: ${res.status}`);
  return setCookie.split(";")[0];
}

export async function apiJson(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  body = await testRevisionBody(method, path, body);
  const pathname = new URL(path, BASE).pathname;
  const res = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  const relativePath = pathname.replace(/^\/blyg\/api/, "");
  const contract = Object.values(routes).find((route) => route.method === method.toLowerCase() && new RegExp(`^${route.path.replace(/\{\w+\}/g, "[^/]+")}$`).test(relativePath));
  if (contract) {
    const definition = contract.responses[res.status];
    const media = definition && "content" in definition ? definition.content?.["application/json"] : undefined;
    const schema = media && "schema" in media ? media.schema : undefined;
    if (!schema || !("safeParse" in schema)) throw new Error(`Missing response contract: ${method} ${path} ${res.status}`);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`Response contract failed: ${method} ${path} ${res.status}: ${parsed.error.message}`);
  }
  return { status: res.status, json };
}

/** Create a draft with content and publish it; returns the item id. */
export async function createAndPublish(cookie: string, contentMd: string, note?: string): Promise<string> {
  const created = await apiJson(cookie, "POST", "/blyg/api/items", { contentMd: contentMd });
  if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
  const id = created.json.id as string;
  const pub = await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, note ? { note } : {});
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.json)}`);
  return id;
}

export async function getPublic(path: string): Promise<Response> {
  if (new URL(path, BASE).pathname.endsWith('/feed.xml')) {
    // Existing wire-content tests compare settled XML. The dedicated cache
    // oracle separately asserts the first stale response and background work.
    const app = makeApp(normalizeMount(env.MOUNT));
    const firstCtx = createExecutionContext();
    const first = await app.fetch(new Request(new URL(path, BASE)), env, firstCtx);
    await first.arrayBuffer(); await waitOnExecutionContext(firstCtx);
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(new URL(path, BASE)), env, ctx);
    await waitOnExecutionContext(ctx); return response;
  }
  return SELF.fetch(`${BASE}${path}`);
}

/** The unchanged public protocol and R2 use this mounted media key. */
export const testMediaKey = (url: string) => new URL(url).pathname.replace(/^\/blyg\//, "");
