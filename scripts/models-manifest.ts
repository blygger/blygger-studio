// The merge and validation behind scripts/build-models.ts, kept free of
// node:fs so the Worker test suite can exercise it (test/workers-ai.test.ts).
// The output is build/models.json, the manifest src/ai/models.ts embeds.

export interface Provider {
  label: string;
  api: string;
  key_secret?: string;
  binding?: string;
  base_url?: string;
  params?: Record<string, unknown>;
  prefixes?: string[];
}
export interface Model { id: string; provider: string; label: string; note?: string; params?: Record<string, unknown> }
export interface Manifest { providers: Record<string, Provider>; models: Model[] }
export interface Local { providers?: Record<string, Partial<Provider>>; models?: Model[]; remove?: string[] }

/** Every request shape src/ai/provider.ts can speak. */
export const APIS = ["anthropic-messages", "openai-responses", "gemini-generate", "workers-ai", "openai-chat"] as const;
/** The apis that take an operator-supplied endpoint or binding, and so `params`. */
const CHAT_APIS = new Set(["workers-ai", "openai-chat"]);
/** Worker secrets that are never an AI key: naming one would send it to a provider. */
const RESERVED_SECRETS = new Set(["OWNER_PASSWORD", "COOKIE_SECRET"]);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with one provider entry, as sentences; empty when it is usable. */
export function providerProblems(key: string, p: Provider): string[] {
  const out: string[] = [];
  const at = `provider "${key}"`;
  if (!p.label) out.push(`${at} needs a label`);
  if (!(APIS as readonly string[]).includes(p.api)) out.push(`${at} needs an api of ${APIS.join(", ")} (got "${p.api}")`);
  if (p.key_secret !== undefined && (typeof p.key_secret !== "string" || !ENV_NAME.test(p.key_secret))) out.push(`${at}: key_secret must be a Worker secret name like MY_PROVIDER_KEY`);
  else if (p.key_secret && RESERVED_SECRETS.has(p.key_secret)) out.push(`${at}: key_secret cannot be ${p.key_secret}, which is not an AI key`);
  if (p.api === "workers-ai") {
    if (p.key_secret) out.push(`${at}: a workers-ai provider authenticates through its binding, not a key_secret`);
    if (p.binding !== undefined && (typeof p.binding !== "string" || !ENV_NAME.test(p.binding))) out.push(`${at}: binding must be a binding name like AI`);
  } else if (p.binding !== undefined) out.push(`${at}: binding is only for a workers-ai provider`);
  if (p.api === "openai-chat") {
    const problem = baseUrlProblem(p.base_url);
    if (problem) out.push(`${at}: ${problem}`);
  } else {
    if (p.base_url !== undefined) out.push(`${at}: base_url is only for an openai-chat provider`);
    if (p.api !== "workers-ai" && !p.key_secret) out.push(`${at} needs a key_secret`);
  }
  if (p.params !== undefined && (!isObject(p.params) || !CHAT_APIS.has(p.api))) out.push(`${at}: params must be an object, and only workers-ai and openai-chat providers take them`);
  if (p.prefixes !== undefined && (!Array.isArray(p.prefixes) || p.prefixes.some((x) => typeof x !== "string" || !x))) out.push(`${at}: prefixes must be a list of non-empty strings`);
  return out;
}

/**
 * An openai-chat base URL is fixed operator config: absolute, https (plain
 * http only to this machine, for a local Ollama under `wrangler dev`), with
 * no credentials, query or fragment, since the key goes in a header and the
 * adapter appends `/chat/completions`.
 */
export function baseUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return "an openai-chat provider needs a base_url, e.g. https://api.groq.com/openai/v1";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `base_url "${raw}" is not an absolute URL`;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return `base_url must be https (plain http only to localhost), got "${raw}"`;
  if (url.username || url.password) return "base_url must not carry credentials; put the key in a Worker secret named by key_secret";
  if (url.search || url.hash) return "base_url must not have a query or fragment";
  return null;
}

/** models.json merged with models.local.json, validated; throws one Error listing every problem. */
export function mergeManifest(base: Manifest, local: Local | null): Manifest {
  const providers: Record<string, Provider> = { ...base.providers };
  for (const [key, over] of Object.entries(local?.providers ?? {})) providers[key] = { ...providers[key], ...over } as Provider;
  const byId = new Map(base.models.map((m) => [m.id, m]));
  for (const m of local?.models ?? []) byId.set(m.id, { ...byId.get(m.id), ...m });
  for (const id of local?.remove ?? []) byId.delete(id);
  const models = [...byId.values()];

  const problems = Object.entries(providers).flatMap(([key, p]) => providerProblems(key, p));
  for (const m of models) {
    if (!m.id || !m.label || !providers[m.provider]) problems.push(`model "${m.id}" needs a label and a known provider (got "${m.provider}")`);
    else if (m.params !== undefined && (!isObject(m.params) || !CHAT_APIS.has(providers[m.provider].api))) problems.push(`model "${m.id}": params must be an object, and only models of workers-ai and openai-chat providers take them`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return { providers, models };
}
