// TK generation provider interface — tk-core-plan.md §4. One interface for
// every present and future generation hook (fragment editor, thread editor,
// later import-pipeline filters). Reference implementation targets the
// Anthropic Messages API via raw HTTP: this is a Cloudflare Worker with no
// nodejs_compat flag and a deliberately small dependency set (hono,
// markdown-it, fast-xml-parser — see package.json), so a raw `fetch` call
// against the wire API is the natural fit here, not the Node-oriented
// `@anthropic-ai/sdk`.

import { admitAi } from "../security-budgets.ts";
import { getSettings } from "../model.ts";
import type { Env, Settings } from "../types.ts";
import { MODELS, bindingName, providerConfigured, providerFor, type AiPurpose, type Manifest, type ProviderSpec } from "./models.ts";

export interface GenerateRequest {
  instruction: string;
  /** Span's current output, if regenerating; null for a first generation. */
  currentText: string | null;
  sources: { id: string; content_md: string }[];
  /** Full working copy, with the active scope marked by SCOPE_MARK_START/END. */
  documentContext: string;
  stylePrompt: string | null;
}

export interface GenerateResult {
  text: string;
  model: string;
}

/** Marks the active scope's position within `documentContext` for the model. */
export const SCOPE_MARK_START = "<<<TK-SCOPE>>>";
export const SCOPE_MARK_END = "<<<END-TK-SCOPE>>>";

/** Thrown on any provider failure — surfaced verbatim by the /generate endpoint, no retry loop (§5). */
export class ProviderError extends Error {}
export class AiBudgetError extends ProviderError {}

/** Wrap `[start, end)` of `contentMd` with the scope markers, for `documentContext`. */
export function markDocument(contentMd: string, start: number, end: number): string {
  return contentMd.slice(0, start) + SCOPE_MARK_START + contentMd.slice(start, end) + SCOPE_MARK_END + contentMd.slice(end);
}

/**
 * Injectable HTTP call, mirroring importer/http.ts's FetchLike DI pattern —
 * decouples request-shape/error-surfacing tests from a real network layer.
 */
export type ProviderFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const platformProviderFetch: ProviderFetchLike = (url, init) => fetch(url, init);

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT =
  "You are the generation engine behind a TK (\"to come\") instructed-generation " +
  "feature in a writing tool. The author has marked a span of their draft with an " +
  "instruction; you write the prose that replaces it. Output ONLY the replacement " +
  "text: no preamble, no meta-commentary, no code fences, no explanation of what " +
  "you did. The output becomes the literal body of the author's document, so match " +
  "the voice, register, and formatting conventions of the surrounding context.";

function buildUserContent(req: GenerateRequest): string {
  const parts: string[] = [`Instruction: ${req.instruction}`];
  if (req.sources.length) {
    parts.push(
      "Source material the instruction may draw on (weave into the generated prose; " +
        "do not reproduce verbatim unless the instruction asks for a quote):",
    );
    for (const s of req.sources) parts.push(`--- source ${s.id} ---\n${s.content_md}`);
  }
  if (req.currentText !== null) {
    parts.push(`Current draft of this span, to revise per the instruction above:\n${req.currentText}`);
  }
  parts.push(
    `Full document for context, with the active span marked between ${SCOPE_MARK_START} and ` +
      `${SCOPE_MARK_END} (the markers are for your orientation only — never reproduce them):\n${req.documentContext}`,
  );
  return parts.join("\n\n");
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  model: string;
  stop_reason?: string;
  stop_details?: { category?: string | null };
  content: AnthropicContentBlock[];
}

/** Runs §2.3's generation call against the Anthropic Messages API. */
export async function generate(
  env: Env,
  req: GenerateRequest,
  fetchImpl: ProviderFetchLike = platformProviderFetch,
): Promise<GenerateResult> {
  // req.stylePrompt is the site-level style prompt (settings.ai_style_prompt);
  // the caller resolves it, since GenerateRequest already owns that field.
  const system = req.stylePrompt ? `${SYSTEM_PROMPT}\n\n${req.stylePrompt}` : SYSTEM_PROMPT;
  return complete(env, system, buildUserContent(req), fetchImpl, "tk");
}

/**
 * One model call with a system prompt and one user turn — the shared transport
 * for every generation hook (TK scopes, changelog notes, later feed scoring).
 * `purpose` picks the model from settings (one per AI function, 0.26.0); the
 * model picks the provider from the manifest (src/ai/models.ts); the provider
 * names the Worker secret that holds its key, or (Workers AI, studio#8) the
 * binding it runs on. Every keyed provider is called over raw HTTP, for the
 * same small-dependency reason given at the top of this file. `models` is the
 * embedded manifest; tests substitute their own.
 */
export async function complete(
  env: Env,
  system: string,
  user: string,
  fetchImpl: ProviderFetchLike = platformProviderFetch,
  purpose: AiPurpose = "tk",
  models: Manifest = MODELS,
): Promise<GenerateResult> {
  const settings = await getSettings(env.DB);
  // No built-in default (session 32, Venkat): which model an operator pays for
  // is the operator's choice, so a fresh install names none and says so. That
  // holds for Workers AI too: a bound AI binding is never used unasked.
  const model = modelFor(settings, purpose).trim();
  if (!model) throw new ProviderError(`no AI model is configured for ${PURPOSE_LABELS[purpose]}: choose one in Settings (for example claude-sonnet-5-5)`);
  const provider = providerFor(model, models);
  if (!provider) throw new ProviderError(`no provider is known for model "${model}": add it to models.json (or models.local.json)`);
  const { spec } = provider;
  if (!providerConfigured(env, spec)) throw new ProviderError(notConfigured(spec));
  const vars = env as unknown as Record<string, unknown>;
  const apiKey = spec.key_secret ? (vars[spec.key_secret] as string) : "";
  if (!await admitAi(env)) throw new AiBudgetError('daily AI call budget exceeded');
  // Extra request members for the two chat-shaped apis: the provider's, then the model's.
  const params = { ...spec.params, ...provider.model?.params };
  switch (spec.api) {
    case "anthropic-messages":
      return anthropic(apiKey, model, system, user, fetchImpl);
    case "openai-responses":
      return openai(apiKey, model, system, user, fetchImpl);
    case "gemini-generate":
      return gemini(apiKey, model, system, user, fetchImpl);
    case "workers-ai":
      return workersAi(vars[bindingName(spec)] as WorkersAiBinding, model, system, user, params);
    case "openai-chat":
      return openaiChat(spec.base_url ?? "", apiKey, model, system, user, params, fetchImpl);
  }
}

function notConfigured(spec: ProviderSpec): string {
  if (spec.api === "workers-ai") return `the ${bindingName(spec)} binding is not configured (${spec.label}): add an "ai" binding to wrangler.jsonc and redeploy`;
  return `${spec.key_secret} is not configured (the ${spec.label} API key)`;
}

const PURPOSE_LABELS: Record<AiPurpose, string> = { tk: "TK generation", changelog: "changelog notes", feed: "feed scoring" };

export function modelFor(settings: Pick<Settings, "ai_model_tk" | "ai_model_changelog" | "ai_model_feed">, purpose: AiPurpose): string {
  return purpose === "tk" ? settings.ai_model_tk : purpose === "changelog" ? settings.ai_model_changelog : settings.ai_model_feed;
}

async function postJson(fetchImpl: ProviderFetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`provider request failed: ${res.status} ${text}`.trim());
  }
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new ProviderError("provider returned invalid JSON");
  }
}

/** Anthropic Messages API. */
async function anthropic(apiKey: string, model: string, system: string, user: string, fetchImpl: ProviderFetchLike): Promise<GenerateResult> {
  const json = (await postJson(fetchImpl, API_URL, { "x-api-key": apiKey, "anthropic-version": API_VERSION }, {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  })) as AnthropicResponse;
  if (json.stop_reason === "refusal") {
    const category = json.stop_details?.category;
    throw new ProviderError(`provider declined the request${category ? ` (${category})` : ""}`);
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (!text) throw new ProviderError("provider returned no text content");
  return { text, model: json.model ?? model };
}

interface OpenAiResponse {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
}

/** OpenAI Responses API. */
async function openai(apiKey: string, model: string, system: string, user: string, fetchImpl: ProviderFetchLike): Promise<GenerateResult> {
  const json = (await postJson(fetchImpl, "https://api.openai.com/v1/responses", { authorization: `Bearer ${apiKey}` }, {
    model,
    instructions: system,
    input: user,
    max_output_tokens: MAX_TOKENS,
  })) as OpenAiResponse;
  const parts = (json.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const refusal = parts.find((p) => p.type === "refusal");
  if (refusal) throw new ProviderError(`provider declined the request${refusal.refusal ? `: ${refusal.refusal}` : ""}`);
  const text = parts.filter((p) => p.type === "output_text").map((p) => p.text ?? "").join("");
  if (!text) throw new ProviderError(json.status === "incomplete" ? `provider stopped early (${json.incomplete_details?.reason ?? "incomplete"})` : "provider returned no text content");
  return { text, model: json.model ?? model };
}

interface GeminiResponse {
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
}

/** Google Gemini API, generateContent. */
async function gemini(apiKey: string, model: string, system: string, user: string, fetchImpl: ProviderFetchLike): Promise<GenerateResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const json = (await postJson(fetchImpl, url, { "x-goog-api-key": apiKey }, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  })) as GeminiResponse;
  if (json.promptFeedback?.blockReason) throw new ProviderError(`provider declined the request (${json.promptFeedback.blockReason})`);
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) {
    const reason = candidate?.finishReason;
    throw new ProviderError(reason && reason !== "STOP" ? `provider stopped without text (${reason})` : "provider returned no text content");
  }
  return { text, model: json.modelVersion ?? model };
}

/** The slice of the Workers AI binding this file uses; tests pass a fake. */
export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

interface ChatCompletion {
  model?: string;
  /** Older Workers AI text models answer with a bare `response`. */
  response?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null; reasoning_content?: unknown; reasoning?: unknown };
  }[];
}

function chatMessages(system: string, user: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Remove reasoning a model inlined into its answer. Separate reasoning fields
 * (`reasoning_content`, `reasoning`) are never read at all; this handles the
 * models that put it in the content instead: <think>-style blocks, Gemma's
 * thought channel, and an unterminated block left by a truncated answer.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, "")
    .replace(/^\s*<(think|thinking|thought|reasoning)>[\s\S]*$/i, "")
    .trim();
}

/** The answer text of a chat-completion response, or a ProviderError. */
function chatText(json: ChatCompletion): string {
  const choice = json?.choices?.[0];
  if (choice?.message?.refusal) throw new ProviderError(`provider declined the request: ${choice.message.refusal}`);
  if (choice?.finish_reason === "content_filter") throw new ProviderError("provider declined the request (content_filter)");
  const content = choice ? choice.message?.content : json?.response;
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.filter((p) => !p.type || p.type === "text").map((p) => p.text ?? "").join("") : "";
  const text = stripReasoning(raw);
  if (!text) throw new ProviderError(choice?.finish_reason === "length" ? "provider stopped early (length)" : "provider returned no text content");
  return text;
}

/**
 * Cloudflare Workers AI, through the Worker's own `ai` binding: no key, billed
 * to the account the Worker runs on. Chat-shaped input; the answer comes back
 * in the OpenAI chat-completion shape (or `{response}` from older models).
 */
async function workersAi(binding: WorkersAiBinding, model: string, system: string, user: string, params: Record<string, unknown>): Promise<GenerateResult> {
  let json: ChatCompletion;
  try {
    json = (await binding.run(model, { max_tokens: MAX_TOKENS, ...params, messages: chatMessages(system, user) })) as ChatCompletion;
  } catch (e) {
    throw new ProviderError(`provider request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Provenance records the model asked for: the "@cf/..." id is the honest
  // disclosure, whatever display name the response's `model` carries.
  return { text: chatText(json), model };
}

/**
 * Any OpenAI-compatible Chat Completions endpoint at the provider's
 * `base_url`: Cloudflare's OpenAI-compatible endpoint or AI Gateway,
 * OpenRouter, Groq, Together, a local Ollama. Like the other adapters this
 * calls a fixed destination: the base URL is the operator's build-time config
 * (models.json / models.local.json, checked by build-models), never request
 * input, and the key travels only in the Authorization header.
 */
async function openaiChat(baseUrl: string, apiKey: string, model: string, system: string, user: string, params: Record<string, unknown>, fetchImpl: ProviderFetchLike): Promise<GenerateResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const json = (await postJson(fetchImpl, url, headers, { max_tokens: MAX_TOKENS, ...params, model, messages: chatMessages(system, user) })) as ChatCompletion;
  return { text: chatText(json), model: json.model ?? model };
}
