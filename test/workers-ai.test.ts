// studio#8: Cloudflare Workers AI through the Worker's AI binding, and any
// OpenAI-compatible Chat Completions endpoint, as manifest providers. A fake
// env.AI records calls and the HTTP layer is a fixture: no real inference and
// no network (vitest.config.ts also sets remoteBindings: false).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { complete, generate, ProviderError, SCOPE_MARK_START, stripReasoning, type GenerateRequest, type ProviderFetchLike } from "../src/ai/provider.ts";
import { MODELS, configuredProviders, providerFor, type Manifest } from "../src/ai/models.ts";
import { putSettings } from "../src/model.ts";
import type { Env } from "../src/types.ts";
import { baseUrlProblem, mergeManifest, type Manifest as RawManifest } from "../scripts/models-manifest.ts";
import shipped from "../models.json";

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const PURPOSES = ["ai_model_tk", "ai_model_changelog", "ai_model_feed"];

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM settings WHERE key IN ('ai_model', ${PURPOSES.map(() => "?").join(",")})`).bind(...PURPOSES).run();
  await env.DB.prepare("DELETE FROM security_budgets").run();
});

const req: GenerateRequest = {
  instruction: "write a haiku",
  currentText: null,
  sources: [{ id: "src1", content_md: "source body" }],
  documentContext: `before ${SCOPE_MARK_START}x<<<END-TK-SCOPE>>> after`,
  stylePrompt: "Be terse.",
};

function fakeAi(result: unknown | ((model: string, input: unknown) => unknown)) {
  const calls: { model: string; input: any }[] = [];
  const ai = {
    run: async (model: string, input: unknown) => {
      calls.push({ model, input });
      return typeof result === "function" ? (result as (m: string, i: unknown) => unknown)(model, input) : result;
    },
  } as unknown as Ai;
  return { ai, calls };
}

const chat = (content: unknown, extra: Record<string, unknown> = {}, finish = "stop") => ({
  id: "x",
  object: "chat.completion",
  model: "served-model-name",
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...extra } }],
});

function http(handler: (url: string, body: any) => { status?: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl: ProviderFetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const r = handler(url, body);
    const status = r.status ?? 200;
    return { ok: status < 300, status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { fetchImpl, calls };
}
const noHttp = () => http(() => ({ body: {} }));

describe("Workers AI provider (the AI binding)", () => {
  const withAi = (ai: Ai | undefined, extra: Partial<Env> = {}) => ({ ...env, AI: ai, ...extra }) as Env;

  it("runs a listed @cf model on the binding with the TK prompt, its params and no HTTP", async () => {
    await putSettings(env.DB, { ai_model_tk: GEMMA });
    const { ai, calls } = fakeAi(chat("old pond, a frog leaps"));
    const { fetchImpl, calls: httpCalls } = noHttp();
    const result = await generate(withAi(ai), req, fetchImpl);
    expect(result).toEqual({ text: "old pond, a frog leaps", model: GEMMA });
    expect(httpCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(GEMMA);
    const { messages, max_tokens, chat_template_kwargs } = calls[0].input;
    expect(chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(max_tokens).toBe(4096);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toMatch(/^You are the generation engine behind a TK/);
    expect(messages[0].content.endsWith("\n\nBe terse.")).toBe(true);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Instruction: write a haiku");
    expect(messages[1].content).toContain("--- source src1 ---\nsource body");
  });

  it("sends the same system and user text the Anthropic adapter sends", async () => {
    await putSettings(env.DB, { ai_model_tk: GEMMA, ai_model_changelog: "claude-opus-5-5" });
    const { ai, calls } = fakeAi(chat("ok"));
    const { fetchImpl, calls: httpCalls } = http(() => ({ body: { model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } }));
    const e = withAi(ai, { AI_PROVIDER_KEY: "k" });
    await complete(e, "SYS", "USER", fetchImpl, "tk");
    await complete(e, "SYS", "USER", fetchImpl, "changelog");
    expect(calls[0].input.messages).toEqual([{ role: "system", content: httpCalls[0].body.system }, { role: "user", content: httpCalls[0].body.messages[0].content }]);
  });

  it("routes a typed-in @cf id by prefix, without another model's params", async () => {
    await putSettings(env.DB, { ai_model_feed: "@cf/qwen/qwen3-30b-a3b-fp8" });
    expect(providerFor("@cf/qwen/qwen3-30b-a3b-fp8")?.key).toBe("workers-ai");
    const { ai, calls } = fakeAi(chat("scored"));
    expect(await complete(withAi(ai), "S", "U", undefined, "feed")).toEqual({ text: "scored", model: "@cf/qwen/qwen3-30b-a3b-fp8" });
    expect(calls[0].input.chat_template_kwargs).toBeUndefined();
  });

  it("never runs unasked: a bound AI with no model chosen is the usual no-model error", async () => {
    const { ai, calls } = fakeAi(chat("should not be used"));
    await expect(generate(withAi(ai), req)).rejects.toThrow(/no AI model is configured/);
    await expect(complete(withAi(ai), "S", "U", undefined, "changelog")).rejects.toThrow(/no AI model is configured for changelog notes/);
    expect(calls).toHaveLength(0);
  });

  it("never falls back to it either: a keyed model without its key stays that key's error", async () => {
    await putSettings(env.DB, { ai_model_tk: "claude-sonnet-5-5" });
    const { ai, calls } = fakeAi(chat("should not be used"));
    await expect(generate(withAi(ai, { AI_PROVIDER_KEY: undefined }), req)).rejects.toThrow("AI_PROVIDER_KEY is not configured");
    expect(calls).toHaveLength(0);
  });

  it("names the missing binding, and calls nothing, when an @cf model is chosen without one", async () => {
    await putSettings(env.DB, { ai_model_tk: GEMMA });
    const { fetchImpl, calls } = noHttp();
    await expect(generate(withAi(undefined, { AI_PROVIDER_KEY: "k" }), req, fetchImpl)).rejects.toThrow(/the AI binding is not configured/);
    expect(calls).toHaveLength(0);
  });

  it("spends the daily AI budget like every provider, refusing before the binding", async () => {
    await putSettings(env.DB, { ai_model_tk: GEMMA });
    const { ai, calls } = fakeAi(chat("ok"));
    const limited = withAi(ai, { AI_DAILY_CALL_LIMIT: "2" });
    await complete(limited, "S", "U");
    await complete(limited, "S", "U");
    await expect(complete(limited, "S", "U")).rejects.toThrow("daily AI call budget exceeded");
    expect(calls).toHaveLength(2);
  });

  it("ignores reasoning fields and strips inline reasoning", async () => {
    await putSettings(env.DB, { ai_model_tk: GEMMA });
    const answer = async (r: unknown) => (await complete(withAi(fakeAi(r).ai), "S", "U")).text;
    expect(await answer(chat("the answer", { reasoning_content: "I thought hard", reasoning: "more" }))).toBe("the answer");
    expect(await answer(chat("<think>plan the haiku</think>\nold pond, a frog leaps"))).toBe("old pond, a frog leaps");
    expect(await answer(chat("<|channel>thought\nhmm<channel|>final"))).toBe("final");
    expect(await answer({ response: "legacy text" })).toBe("legacy text");
    expect(stripReasoning("<thought>a</thought>b<thinking>c</thinking>")).toBe("b");
    expect(stripReasoning("<think>truncated reasoning with no end")).toBe("");
    expect(stripReasoning("plain prose stays")).toBe("plain prose stays");
  });

  it("surfaces empty output, refusals, filtering, truncation and binding errors as ProviderError", async () => {
    await putSettings(env.DB, { ai_model_tk: GEMMA });
    const run = (r: unknown) => complete(withAi(fakeAi(r).ai), "S", "U");
    await expect(run(chat(null))).rejects.toThrow("provider returned no text content");
    await expect(run(chat("<think>only thoughts</think>"))).rejects.toThrow(ProviderError);
    await expect(run(chat(null, { refusal: "nope" }))).rejects.toThrow(/declined the request: nope/);
    await expect(run(chat("x", {}, "content_filter"))).rejects.toThrow(/content_filter/);
    await expect(run(chat("<think>cut off", {}, "length"))).rejects.toThrow(/stopped early \(length\)/);
    await expect(run(() => { throw new Error("3040: capacity"); })).rejects.toThrow(/provider request failed: 3040: capacity/);
  });
});

// A manifest with OpenAI-compatible providers, as an operator's models.local.json would add them.
const chatManifest: Manifest = {
  ...MODELS,
  providers: {
    ...MODELS.providers,
    groq: { label: "Groq", api: "openai-chat", base_url: "https://api.groq.com/openai/v1/", key_secret: "GROQ_API_KEY", params: { temperature: 0.7 } },
    ollama: { label: "Ollama", api: "openai-chat", base_url: "http://localhost:11434/v1" },
  },
  models: [
    ...MODELS.models,
    { id: "qwen/qwen3-32b", provider: "groq", label: "Qwen3 32B", params: { reasoning_format: "hidden", temperature: 0.2, model: "spoofed", messages: [] } },
    { id: "llama3.3", provider: "ollama", label: "Llama 3.3 (local)" },
  ],
};
const GROQ_ENV = { ...env, GROQ_API_KEY: "gsk-test" } as Env;

describe("OpenAI-compatible Chat Completions provider", () => {
  it("posts to {base_url}/chat/completions with a bearer key and merged params", async () => {
    await putSettings(env.DB, { ai_model_tk: "qwen/qwen3-32b" });
    const { fetchImpl, calls } = http(() => ({ body: chat("from groq", { reasoning: "hidden thoughts" }) }));
    const result = await complete(GROQ_ENV, "SYS", "USER", fetchImpl, "tk", chatManifest);
    expect(result).toEqual({ text: "from groq", model: "served-model-name" });
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0].url).not.toContain("gsk-test");
    expect(calls[0].headers.authorization).toBe("Bearer gsk-test");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    // Model params override the provider's; neither can override the model or the messages.
    expect(calls[0].body).toEqual({
      max_tokens: 4096,
      temperature: 0.2,
      reasoning_format: "hidden",
      model: "qwen/qwen3-32b",
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }],
    });
  });

  it("sends no Authorization header to a keyless endpoint, which counts as configured", async () => {
    await putSettings(env.DB, { ai_model_tk: "llama3.3" });
    const { fetchImpl, calls } = http(() => ({ body: chat([{ type: "text", text: "array " }, { type: "text", text: "content" }]) }));
    expect((await complete(env as Env, "S", "U", fetchImpl, "tk", chatManifest)).text).toBe("array content");
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(configuredProviders(env, chatManifest).ollama).toBe(true);
  });

  it("names the missing key secret and calls nothing", async () => {
    await putSettings(env.DB, { ai_model_tk: "qwen/qwen3-32b" });
    const { fetchImpl, calls } = noHttp();
    await expect(complete(env as Env, "S", "U", fetchImpl, "tk", chatManifest)).rejects.toThrow("GROQ_API_KEY is not configured (the Groq API key)");
    expect(calls).toHaveLength(0);
    expect(configuredProviders(env, chatManifest).groq).toBe(false);
    expect(configuredProviders(GROQ_ENV, chatManifest).groq).toBe(true);
  });

  it("surfaces HTTP errors, bad JSON, refusals and inline reasoning like the other adapters", async () => {
    await putSettings(env.DB, { ai_model_tk: "qwen/qwen3-32b" });
    const run = (r: { status?: number; body: unknown }) => complete(GROQ_ENV, "S", "U", http(() => r).fetchImpl, "tk", chatManifest);
    await expect(run({ status: 429, body: { error: { message: "rate limited" } } })).rejects.toThrow(/provider request failed: 429.*rate limited/);
    await expect(run({ body: "not json" })).rejects.toThrow("provider returned invalid JSON");
    await expect(run({ body: chat(null, { refusal: "no" }) })).rejects.toThrow(/declined the request: no/);
    await expect(run({ body: { choices: [] } })).rejects.toThrow("provider returned no text content");
    expect((await run({ body: chat("<think>x</think>answer") })).text).toBe("answer");
  });

  it("spends the daily AI budget before calling", async () => {
    await putSettings(env.DB, { ai_model_tk: "qwen/qwen3-32b" });
    const { fetchImpl, calls } = http(() => ({ body: chat("ok") }));
    const limited = { ...GROQ_ENV, AI_DAILY_CALL_LIMIT: "1" } as Env;
    await complete(limited, "S", "U", fetchImpl, "tk", chatManifest);
    await expect(complete(limited, "S", "U", fetchImpl, "tk", chatManifest)).rejects.toThrow("daily AI call budget exceeded");
    expect(calls).toHaveLength(1);
  });
});

describe("build-models: manifest validation", () => {
  const base = shipped as unknown as RawManifest;
  const withProvider = (p: Record<string, unknown>) => () => mergeManifest(base, { providers: { x: p as never } });

  it("accepts the shipped models.json, with Workers AI and Gemma 4 listed", () => {
    const m = mergeManifest(base, null);
    expect(m.providers["workers-ai"]).toMatchObject({ api: "workers-ai", binding: "AI", prefixes: ["@cf/"] });
    expect(m.providers["workers-ai"].key_secret).toBeUndefined();
    expect(m.models.find((x) => x.id === GEMMA)).toMatchObject({ provider: "workers-ai", params: { chat_template_kwargs: { enable_thinking: false } } });
  });

  it("merges an openai-chat provider and its models from models.local.json", () => {
    const m = mergeManifest(base, {
      providers: { openrouter: { label: "OpenRouter", api: "openai-chat", base_url: "https://openrouter.ai/api/v1", key_secret: "OPENROUTER_API_KEY" } },
      models: [{ id: "deepseek/deepseek-v4", provider: "openrouter", label: "DeepSeek V4" }],
      remove: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
    });
    expect(m.providers.openrouter.api).toBe("openai-chat");
    expect(m.models.some((x) => x.id === "deepseek/deepseek-v4")).toBe(true);
    expect(m.models.some((x) => x.id === "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(false);
  });

  it("refuses providers that could not be called, or would leak a secret", () => {
    expect(withProvider({ label: "X", api: "openai-chat-v9", key_secret: "K" })).toThrow(/api of/);
    expect(withProvider({ label: "X", api: "openai-chat", key_secret: "K" })).toThrow(/needs a base_url/);
    expect(withProvider({ label: "X", api: "openai-chat", base_url: "http://api.example.com/v1" })).toThrow(/must be https/);
    expect(withProvider({ label: "X", api: "openai-chat", base_url: "https://user:pw@api.example.com/v1" })).toThrow(/credentials/);
    expect(withProvider({ label: "X", api: "openai-chat", base_url: "https://api.example.com/v1?key=k" })).toThrow(/query/);
    expect(withProvider({ label: "X", api: "openai-chat", base_url: "https://api.example.com/v1", key_secret: "OWNER_PASSWORD" })).toThrow(/not an AI key/);
    expect(withProvider({ label: "X", api: "openai-chat", base_url: "https://api.example.com/v1", key_secret: "lower case" })).toThrow(/secret name/);
    expect(withProvider({ label: "X", api: "workers-ai", key_secret: "K" })).toThrow(/through its binding/);
    expect(withProvider({ label: "X", api: "anthropic-messages" })).toThrow(/needs a key_secret/);
    expect(withProvider({ label: "X", api: "anthropic-messages", key_secret: "K", base_url: "https://x.example" })).toThrow(/only for an openai-chat/);
    expect(withProvider({ label: "X", api: "anthropic-messages", key_secret: "K", params: { a: 1 } })).toThrow(/params/);
    expect(() => mergeManifest(base, { models: [{ id: "claude-x", provider: "anthropic", label: "X", params: { a: 1 } }] })).toThrow(/params/);
    expect(() => mergeManifest(base, { models: [{ id: "m", provider: "nobody", label: "M" }] })).toThrow(/known provider/);
  });

  it("allows plain http only to this machine", () => {
    expect(baseUrlProblem("http://localhost:11434/v1")).toBeNull();
    expect(baseUrlProblem("http://127.0.0.1:11434/v1")).toBeNull();
    expect(baseUrlProblem("https://gateway.ai.cloudflare.com/v1/acct/gw/compat")).toBeNull();
    expect(baseUrlProblem("http://10.0.0.5/v1")).toMatch(/https/);
    expect(baseUrlProblem("not a url")).toMatch(/absolute/);
  });
});

describe("GET /api/ai/models with Workers AI", () => {
  it("lists the Workers AI provider by binding, with no key secret, and never params or base URLs", async () => {
    const { apiJson, login } = await import("./helpers.ts");
    const models = (await apiJson(await login(), "GET", "/api/ai/models")).json;
    const wai = models.providers.find((p: { id: string }) => p.id === "workers-ai");
    // The suite binds no AI (remoteBindings: false, and the template's binding is commented out).
    expect(wai).toEqual({ id: "workers-ai", label: "Cloudflare Workers AI", binding: "AI", configured: false });
    expect(models.models.find((m: { id: string }) => m.id === GEMMA)).toEqual({ id: GEMMA, provider: "workers-ai", label: "Gemma 4 26B", note: "billed to your Cloudflare account" });
    expect(JSON.stringify(models)).not.toMatch(/params|chat_template_kwargs|base_url/);
  });

  it("reports Workers AI configured exactly when the binding is bound", () => {
    expect(configuredProviders({ ...env, AI: undefined })["workers-ai"]).toBe(false);
    expect(configuredProviders({ ...env, AI: fakeAi({}).ai })["workers-ai"]).toBe(true);
    expect(configuredProviders({ ...env, AI: "not a binding" })["workers-ai"]).toBe(false);
  });
});
