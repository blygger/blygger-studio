// Task 3 acceptance: request shape + error surfacing tested against a mocked
// ProviderFetchLike — no real network. See src/ai/provider.ts's DI pattern
// (mirrors importer/http.ts's FetchLike).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import { generate, ProviderError, SCOPE_MARK_START, type ProviderFetchLike } from "../src/ai/provider.ts";
import { putSettings } from "../src/model.ts";

beforeEach(() => putSettings(env.DB, { ai_model: "claude-opus-5" }));

function okResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function fixture(handler: (url: string, body: unknown) => ReturnType<typeof okResponse>): {
  fetchImpl: ProviderFetchLike;
  calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[];
} {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetchImpl: ProviderFetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, JSON.parse(init.body));
  };
  return { fetchImpl, calls };
}

describe("generate() — request shape (§4)", () => {
  it("throws when AI_PROVIDER_KEY is unset", async () => {
    const { fetchImpl } = fixture(() => okResponse({}));
    await expect(
      generate({ ...env, AI_PROVIDER_KEY: undefined }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl),
    ).rejects.toThrow(ProviderError);
  });

  it("refuses to guess a model when none is configured", async () => {
    await putSettings(env.DB, { ai_model: "" });
    const { fetchImpl, calls } = fixture(() => okResponse({}));
    await expect(
      generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl),
    ).rejects.toThrow(/no AI model is configured/);
    expect(calls).toHaveLength(0);
  });

  it("sends the API key, version header, and the configured model", async () => {
    const { fetchImpl, calls } = fixture(() =>
      okResponse({ model: "claude-opus-5", content: [{ type: "text", text: "generated span" }] }),
    );
    const result = await generate(
      { ...env, AI_PROVIDER_KEY: "sk-test-key" },
      { instruction: "write a haiku", currentText: null, sources: [], documentContext: "doc", stylePrompt: null },
      fetchImpl,
    );
    expect(result).toEqual({ text: "generated span", model: "claude-opus-5" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].init.headers["x-api-key"]).toBe("sk-test-key");
    expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe("claude-opus-5");
    expect(body.messages[0].content).toContain("write a haiku");
  });

  it("includes instruction, sources, current text, and document context in the user message", async () => {
    const { fetchImpl, calls } = fixture(() => okResponse({ model: "claude-opus-5", content: [{ type: "text", text: "out" }] }));
    await generate(
      { ...env, AI_PROVIDER_KEY: "k" },
      {
        instruction: "simplify",
        currentText: "old draft",
        sources: [{ id: "src1", content_md: "source content" }],
        documentContext: `before ${SCOPE_MARK_START}scope`,
        stylePrompt: "Write like Hemingway.",
      },
      fetchImpl,
    );
    const content = JSON.parse(calls[0].init.body).messages[0].content as string;
    expect(content).toContain("simplify");
    expect(content).toContain("source content");
    expect(content).toContain("old draft");
    expect(content).toContain(SCOPE_MARK_START);
    const system = JSON.parse(calls[0].init.body).system as string;
    expect(system).toContain("Write like Hemingway.");
  });

  it("uses settings.ai_model when set, overriding the default", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ai_model', 'claude-sonnet-5') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const { fetchImpl, calls } = fixture(() => okResponse({ model: "claude-sonnet-5", content: [{ type: "text", text: "out" }] }));
    await generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl);
    expect(JSON.parse(calls[0].init.body).model).toBe("claude-sonnet-5");
    await env.DB.prepare("DELETE FROM settings WHERE key = 'ai_model'").run();
  });
});

describe("generate() — error surfacing (§5 task 4 contract: verbatim, no retry)", () => {
  it("throws ProviderError with status + body on a non-2xx response", async () => {
    const { fetchImpl } = fixture(() => okResponse({ error: { message: "overloaded" } }, 529));
    await expect(
      generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl),
    ).rejects.toThrow(/529/);
  });

  it("throws on a refusal stop_reason, including the category when present", async () => {
    const { fetchImpl } = fixture(() => okResponse({ model: "claude-opus-5", stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }));
    await expect(
      generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl),
    ).rejects.toThrow(/refused|declined/);
  });

  it("throws when the response has no text content", async () => {
    const { fetchImpl } = fixture(() => okResponse({ model: "claude-opus-5", content: [] }));
    await expect(
      generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl),
    ).rejects.toThrow(ProviderError);
  });

  it("throws on malformed JSON in the response body", async () => {
    const fetchImpl: ProviderFetchLike = async () => ({ ok: true, status: 200, text: async () => "not json" });
    await expect(
      generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl),
    ).rejects.toThrow(ProviderError);
  });

  it("makes no real network call — fetchImpl is fully substituted", async () => {
    const { fetchImpl, calls } = fixture(() => okResponse({ model: "claude-opus-5", content: [{ type: "text", text: "ok" }] }));
    await generate({ ...env, AI_PROVIDER_KEY: "k" }, { instruction: "x", currentText: null, sources: [], documentContext: "", stylePrompt: null }, fetchImpl);
    expect(calls).toHaveLength(1);
  });
});

// 0.26.0: one model per AI function, three providers, and a manifest that
// decides which provider (and which secret) a model id needs.
import { afterEach } from "vitest";
import { complete } from "../src/ai/provider.ts";
import { providerFor } from "../src/ai/models.ts";

const PER_FUNCTION = ["ai_model_tk", "ai_model_changelog", "ai_model_feed"];
describe("complete() across providers and functions (0.26.0)", () => {
  afterEach(() => env.DB.prepare(`DELETE FROM settings WHERE key IN (${PER_FUNCTION.map(() => "?").join(",")})`).bind(...PER_FUNCTION).run());

  it("uses the model set for each function, falling back to the pre-0.26 single model", async () => {
    await putSettings(env.DB, { ai_model: "claude-sonnet-5-5", ai_model_changelog: "claude-haiku-4-5" });
    const { fetchImpl, calls } = fixture((_, body) => okResponse({ model: (body as { model: string }).model, content: [{ type: "text", text: "ok" }] }));
    const keyed = { ...env, AI_PROVIDER_KEY: "k" };
    await complete(keyed, "s", "u", fetchImpl, "tk");
    await complete(keyed, "s", "u", fetchImpl, "changelog");
    expect(calls.map((c) => JSON.parse(c.init.body).model)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5"]);
    await expect(complete(keyed, "s", "u", fetchImpl, "feed")).rejects.toThrow(/no AI model is configured for feed scoring/);
  });

  it("calls the OpenAI Responses API with a bearer key, and reads output_text", async () => {
    await putSettings(env.DB, { ai_model_tk: "gpt-6-astra" });
    const { fetchImpl, calls } = fixture(() =>
      okResponse({ model: "gpt-6-astra", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "from openai" }] }] }),
    );
    const result = await complete({ ...env, OPENAI_API_KEY: "sk-openai" }, "sys", "user text", fetchImpl, "tk");
    expect(result).toEqual({ text: "from openai", model: "gpt-6-astra" });
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk-openai");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: "gpt-6-astra", instructions: "sys", input: "user text" });
  });

  it("surfaces an OpenAI refusal as a ProviderError", async () => {
    await putSettings(env.DB, { ai_model_tk: "gpt-6-luna" });
    const { fetchImpl } = fixture(() => okResponse({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }));
    await expect(complete({ ...env, OPENAI_API_KEY: "k" }, "s", "u", fetchImpl, "tk")).rejects.toThrow(/declined the request: no/);
  });

  it("calls Gemini generateContent with the key in a header, never the URL", async () => {
    await putSettings(env.DB, { ai_model_tk: "gemini-3.8-flash" });
    const { fetchImpl, calls } = fixture(() => okResponse({ modelVersion: "gemini-3.8-flash", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "from " }, { text: "gemini" }] } }] }));
    const result = await complete({ ...env, GOOGLE_AI_KEY: "g-key" }, "sys", "user text", fetchImpl, "tk");
    expect(result).toEqual({ text: "from gemini", model: "gemini-3.8-flash" });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(calls[0].url).not.toContain("g-key");
    expect(calls[0].init.headers["x-goog-api-key"]).toBe("g-key");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ systemInstruction: { parts: [{ text: "sys" }] }, contents: [{ role: "user", parts: [{ text: "user text" }] }] });
  });

  it("surfaces a blocked Gemini prompt as a ProviderError", async () => {
    await putSettings(env.DB, { ai_model_tk: "gemini-3.8-flash" });
    const { fetchImpl } = fixture(() => okResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(complete({ ...env, GOOGLE_AI_KEY: "k" }, "s", "u", fetchImpl, "tk")).rejects.toThrow(/declined the request \(SAFETY\)/);
  });

  it("names the missing secret for the chosen provider, and calls nothing", async () => {
    await putSettings(env.DB, { ai_model_tk: "gemini-3.8-flash" });
    const { fetchImpl, calls } = fixture(() => okResponse({}));
    await expect(complete({ ...env, GOOGLE_AI_KEY: undefined }, "s", "u", fetchImpl, "tk")).rejects.toThrow(/GOOGLE_AI_KEY is not configured/);
    expect(calls).toHaveLength(0);
  });

  it("finds an unlisted model's provider by prefix, and refuses an unknown one", async () => {
    expect(providerFor("claude-some-future-model")?.key).toBe("anthropic");
    expect(providerFor("gpt-7-nova")?.key).toBe("openai");
    expect(providerFor("gemini-9-ultra")?.key).toBe("google");
    expect(providerFor("llama-5")).toBeNull();
    await putSettings(env.DB, { ai_model_tk: "llama-5" });
    await expect(complete({ ...env, AI_PROVIDER_KEY: "k" }, "s", "u", fixture(() => okResponse({})).fetchImpl, "tk")).rejects.toThrow(/add it to models.json/);
  });
});

describe("settings: the pre-0.26 ai_model alias", () => {
  afterEach(() => env.DB.prepare(`DELETE FROM settings WHERE key IN (${PER_FUNCTION.map(() => "?").join(",")})`).bind(...PER_FUNCTION).run());
  it("writing ai_model sets the TK and changelog models; the manifest route lists models and key status", async () => {
    const { apiJson, login } = await import("./helpers.ts");
    const cookie = await login();
    const res = await apiJson(cookie, "PATCH", "/api/settings", { ai_model: "claude-opus-5-5", feed_prompt: "Prioritize tech news." });
    expect(res.json).toMatchObject({ ai_model: "claude-opus-5-5", ai_model_tk: "claude-opus-5-5", ai_model_changelog: "claude-opus-5-5", ai_model_feed: "", feed_prompt: "Prioritize tech news." });
    const models = (await apiJson(cookie, "GET", "/api/ai/models")).json;
    expect(models.models.map((m: { id: string }) => m.id)).toContain("claude-sonnet-5-5");
    expect(models.providers.map((p: { id: string }) => p.id)).toEqual(["anthropic", "openai", "google", "workers-ai"]);
    expect(JSON.stringify(models)).not.toMatch(/sk-|test-key/);
  });
});
