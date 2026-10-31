// The optional change classifier (session 49). What matters:
// - it is off until a decision model is chosen, and a decision model serves
//   nothing else (and a text model never serves it);
// - answers are parsed from the documented decision-model response, and an
//   unusable answer is no category rather than a guess;
// - every failure (no binding, provider error, budget) is non-fatal;
// - `refresh` is decided locally from content_hash, with no model call;
// - the note composition the publish dialog applies, and the generated flag;
// - and nothing new reaches the wire: a classified publish emits exactly the
//   document keys an unclassified one does (#19 / TN-1, #77).
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { decide, parseDecisionResponse, ProviderError, type DecisionQuestion, type ProviderFetchLike } from "../src/ai/provider.ts";
import { MODELS, isDecisionModel } from "../src/ai/models.ts";
import { CLASSIFY_QUESTION, classifyChange } from "../src/change-class.ts";
import { composeNote, leadingCategory, noteIsGenerated, recategorize, stripCategory } from "../src/change-category.ts";
import { getItem, putSettings } from "../src/model.ts";
import type { Env } from "../src/types.ts";
import { mergeManifest } from "../scripts/models-manifest.ts";
import shipped from "../models.json";
import { apiJson, createAndPublish, getPublic, login } from "./helpers.ts";

const CLEF = "@cf/cloudflare/clef-flash";
const JEV = "jev-latest";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key IN ('ai_model_classify', 'change_category_in_note')").run();
  await env.DB.prepare("DELETE FROM security_budgets").run();
});

/** A choice answer in the shape Cloudflare's output schema and TypeSafe's API reference both document. */
const choiceAnswer = (choice: string, probabilities: Record<string, number>) => ({
  model: "clef-flash",
  answers: { change: { type: "choice", choice, probabilities, confidence: 0.8 } },
  usage: { input_tokens: 300, output_tokens: 3 },
});

function fakeAi(result: unknown) {
  const calls: { model: string; input: any }[] = [];
  const ai = {
    run: async (model: string, input: unknown) => {
      calls.push({ model, input });
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Ai;
  return { ai, calls };
}
const withAi = (ai: Ai | undefined, extra: Partial<Env> = {}) => ({ ...env, AI: ai, ...extra }) as Env;

async function editedItem(cookie: string, v1: string, v2: string) {
  const id = await createAndPublish(cookie, v1);
  await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: v2 });
  return id;
}

describe("decision models in the manifest", () => {
  it("ships Clef, Clef-flash and Jev as decision models, and no text model is one", () => {
    expect(isDecisionModel("@cf/cloudflare/clef")).toBe(true);
    expect(isDecisionModel(CLEF)).toBe(true);
    expect(isDecisionModel(JEV)).toBe(true);
    // Any System One id is a decision model, listed or not.
    expect(isDecisionModel("jev-1.14.0")).toBe(true);
    expect(isDecisionModel("claude-sonnet-5-5")).toBe(false);
    expect(isDecisionModel("@cf/google/gemma-4-26b-a4b-it")).toBe(false);
    expect(MODELS.providers.typesafe).toMatchObject({ api: "systemone", key_secret: "TYPESAFE_API_KEY" });
  });

  it("refuses a decision kind on a provider that cannot serve one", () => {
    const base = shipped as Parameters<typeof mergeManifest>[0];
    expect(() => mergeManifest(base, { models: [{ id: "claude-x", provider: "anthropic", label: "X", kind: "decision" }] })).toThrow(/decision model runs on a workers-ai or systemone provider/);
  });

  it("lists decision models as such, so Settings offers them only for the classifier", async () => {
    const cookie = await login();
    const models = (await apiJson(cookie, "GET", "/blyg/api/ai/models")).json.models as { id: string; kind?: string }[];
    expect(models.find((m) => m.id === CLEF)?.kind).toBe("decision");
    expect(models.find((m) => m.id === "claude-sonnet-5-5")?.kind).toBeUndefined();
  });

  it("keeps decision models and text functions apart in settings", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { aiModelClassify: "claude-sonnet-5-5" })).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { aiModelTk: CLEF })).status).toBe(400);
    expect((await apiJson(cookie, "PATCH", "/blyg/api/settings", { aiModelChangelog: JEV })).status).toBe(400);
    const ok = await apiJson(cookie, "PATCH", "/blyg/api/settings", { aiModelClassify: CLEF });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ aiModelClassify: CLEF, changeCategoryInNote: true });
  });

  it("is off by default", async () => {
    const cookie = await login();
    expect((await apiJson(cookie, "GET", "/blyg/api/settings")).json).toMatchObject({ aiModelClassify: "", changeCategoryInNote: true });
  });
});

describe("decide(): the shared decision-model request", () => {
  const questions = { change: CLASSIFY_QUESTION };

  it("sends Clef the System One shape on the AI binding, with the body's model selector", async () => {
    const { ai, calls } = fakeAi(choiceAnswer("minor", { typo: 0.1, minor: 0.85, major: 0.05 }));
    const result = await decide(withAi(ai), CLEF, "state text", questions);
    expect(result).toEqual({ model: CLEF, answers: { change: { choice: "minor", probability: 0.85 } } });
    expect(calls[0].model).toBe(CLEF);
    expect(calls[0].input).toEqual({ model: "clef-flash", state: "state text", questions });
  });

  it("sends Jev the same shape over HTTP with the key as a bearer token", async () => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetchImpl: ProviderFetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ...choiceAnswer("major", { typo: 0, minor: 0.2, major: 0.8 }), model: "jev-1.13.0" }) };
    };
    const result = await decide({ ...env, TYPESAFE_API_KEY: "ts-key" } as Env, JEV, "s", questions, fetchImpl);
    expect(result.answers.change).toEqual({ choice: "major", probability: 0.8 });
    expect(seen[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0].headers.authorization).toBe("Bearer ts-key");
    expect(seen[0].body).toEqual({ model: JEV, state: "s", questions });
  });

  it("refuses a text model, and complete() refuses a decision model", async () => {
    await expect(decide(withAi(fakeAi({}).ai), "claude-sonnet-5-5", "s", questions)).rejects.toThrow(/not a decision model/);
    const { complete } = await import("../src/ai/provider.ts");
    await putSettings(env.DB, { ai_model_tk: CLEF });
    await expect(complete(withAi(fakeAi({}).ai), "sys", "user")).rejects.toThrow(/is a decision model/);
    await putSettings(env.DB, { ai_model_tk: "" });
  });

  it("parses defensively: envelopes, unknown options, missing probabilities", () => {
    const q: Record<string, DecisionQuestion> = { change: CLASSIFY_QUESTION };
    // A REST-style envelope is unwrapped.
    expect(parseDecisionResponse(q, { result: choiceAnswer("typo", { typo: 0.9, minor: 0.1, major: 0 }), success: true })).toEqual({ change: { choice: "typo", probability: 0.9 } });
    // A choice outside the asked options falls back to the most probable asked option.
    expect(parseDecisionResponse(q, choiceAnswer("refresh", { typo: 0.2, minor: 0.7, major: 0.1 }))).toEqual({ change: { choice: "minor", probability: 0.7 } });
    // No probability for the choice: the confidence stands in.
    expect(parseDecisionResponse(q, { answers: { change: { type: "choice", choice: "major", confidence: 0.6 } } })).toEqual({ change: { choice: "major", probability: 0.6 } });
    // Garbage is no answer.
    for (const garbage of [null, "minor", 42, {}, { answers: null }, { answers: { change: "minor" } }, { answers: { change: { choice: "nonsense", probabilities: { nonsense: 1 } } } }, { answers: { change: { choice: "minor", probabilities: { minor: 7 } } } }]) {
      expect(parseDecisionResponse(q, garbage)).toEqual({});
    }
    // Score and noul answers parse too, by the documented shapes.
    expect(parseDecisionResponse({ s: { type: "score", instructions: "x", criteria: ["a", "b", "c"] } }, { answers: { s: { type: "score", score: 1.05, legend: { 0: "a", 1: "b", 2: "c" }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.9 } } })).toEqual({ s: { choice: "1", probability: 0.95 } });
    expect(parseDecisionResponse({ n: { type: "noul", instructions: "x" } }, { answers: { n: { type: "noul", noul: 0.2 } } })).toEqual({ n: { choice: "no", probability: 0.8 } });
  });
});

describe("POST /items/{id}/classify", () => {
  it("is off (409) until a decision model is chosen", async () => {
    const cookie = await login();
    const id = await editedItem(cookie, "First take.", "First take, revised.");
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/classify`);
    expect(res.status).toBe(409);
    expect(res.json.message).toMatch(/classifier is off/);
  });

  it("classifies with the model's choice and probability, and keeps it studio-private", async () => {
    const cookie = await login();
    await putSettings(env.DB, { ai_model_classify: CLEF });
    const id = await editedItem(cookie, "The argument runs one way.", "The argument now runs the other way entirely, with a new section.");
    const { ai, calls } = fakeAi(choiceAnswer("major", { typo: 0.01, minor: 0.12, major: 0.87 }));
    const result = await classifyChange(withAi(ai), (await getItem(env.DB, id))!);
    expect(result).toEqual({ ok: true, version: 2, category: "major", model: CLEF, probability: 0.87 });
    // The state carries both versions and the change.
    expect(calls[0].input.state).toContain("Previous version (v1)");
    expect(calls[0].input.state).toContain("+ added:");
    expect(calls[0].input.questions.change.criteria).toHaveProperty("typo");
    // Settled at publish and shown in the owner's versions.
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "major: Reversed the argument.", changeCategory: "major" })).status).toBe(200);
    const detail = (await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json;
    expect(detail.versions[1].changeClass).toMatchObject({ category: "major", model: CLEF, probability: 0.87, overridden: false });
    expect(detail.versions[0].changeClass).toBeNull();
  });

  it("decides refresh locally from content_hash, with no model call", async () => {
    const cookie = await login();
    await putSettings(env.DB, { ai_model_classify: CLEF });
    const id = await createAndPublish(cookie, "Same words.");
    const { ai, calls } = fakeAi(choiceAnswer("major", { major: 1 }));
    const result = await classifyChange(withAi(ai), (await getItem(env.DB, id))!);
    expect(result).toMatchObject({ ok: true, category: "refresh", model: null });
    expect(calls).toHaveLength(0);
  });

  it("an unusable answer is no category", async () => {
    const cookie = await login();
    await putSettings(env.DB, { ai_model_classify: CLEF });
    const id = await editedItem(cookie, "Teh cat.", "The cat.");
    const { ai } = fakeAi({ answers: { change: { type: "choice", choice: "banana", probabilities: { banana: 1 } } } });
    expect(await classifyChange(withAi(ai), (await getItem(env.DB, id))!)).toMatchObject({ ok: true, category: null, reason: "the model gave no usable answer" });
  });

  it("a provider error or an exhausted budget is non-fatal, and publish proceeds", async () => {
    const cookie = await login();
    await putSettings(env.DB, { ai_model_classify: CLEF });
    const id = await editedItem(cookie, "Teh cat.", "The cat.");
    const failing = fakeAi(new Error("upstream 503"));
    expect(await classifyChange(withAi(failing.ai), (await getItem(env.DB, id))!)).toMatchObject({ ok: true, category: null, reason: expect.stringContaining("upstream 503") });
    const { ai, calls } = fakeAi(choiceAnswer("typo", { typo: 0.9, minor: 0.1, major: 0 }));
    // The failed call above spent one of the two; budget is admitted before the call.
    const limited = withAi(ai, { AI_DAILY_CALL_LIMIT: "2" });
    expect(await classifyChange(limited, (await getItem(env.DB, id))!)).toMatchObject({ category: "typo" });
    const over = await classifyChange(limited, (await getItem(env.DB, id))!);
    expect(over).toMatchObject({ ok: true, category: null, reason: "daily AI call budget exceeded" });
    expect(calls).toHaveLength(1);
    // The failed retry dropped the earlier classification, and publishing works.
    expect((await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {})).status).toBe(200);
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.versions[1].changeClass).toBeNull();
  });

  it("through the route, a missing AI binding is a null category with a reason, not an error", async () => {
    const cookie = await login();
    await putSettings(env.DB, { ai_model_classify: CLEF });
    const id = await editedItem(cookie, "Teh cat.", "The cat.");
    const res = await apiJson(cookie, "POST", `/blyg/api/items/${id}/classify`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ version: 2, category: null, model: null, probability: null, reason: expect.stringContaining("binding is not configured") });
  });

  it("records an override, and drops a classification of words that were not published", async () => {
    const cookie = await login();
    await putSettings(env.DB, { ai_model_classify: CLEF });
    const id = await editedItem(cookie, "Teh cat sat.", "The cat sat.");
    await classifyChange(withAi(fakeAi(choiceAnswer("typo", { typo: 0.95, minor: 0.05, major: 0 })).ai), (await getItem(env.DB, id))!);
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "minor", changeCategory: "minor" });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.versions[1].changeClass).toMatchObject({ category: "minor", model: CLEF, probability: 0.95, overridden: true });
    // Classified, then edited again before publishing: the record is stale.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "The cat sat on the mat." });
    await classifyChange(withAi(fakeAi(choiceAnswer("minor", { typo: 0.1, minor: 0.9, major: 0 })).ai), (await getItem(env.DB, id))!);
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Something else altogether." });
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, {});
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.versions[2].changeClass).toBeNull();
    // Cleared by the author: kept as a record that there is no category.
    await apiJson(cookie, "PATCH", `/blyg/api/items/${id}`, { contentMd: "Something else altogether, again." });
    await classifyChange(withAi(fakeAi(choiceAnswer("minor", { typo: 0.1, minor: 0.9, major: 0 })).ai), (await getItem(env.DB, id))!);
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { changeCategory: null });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${id}`)).json.versions[3].changeClass).toMatchObject({ category: null, overridden: true });
  });
});

describe("the note the dialog composes", () => {
  it("an empty note becomes the bare word; a note is prefixed; a categorised note is left alone", () => {
    expect(composeNote("", "minor")).toBe("minor");
    expect(composeNote("  Fixed the date. ", "typo")).toBe("typo: Fixed the date.");
    expect(composeNote("Typo fix in the second paragraph.", "minor")).toBe("Typo fix in the second paragraph.");
    expect(composeNote("major: Rewrote it.", "minor")).toBe("major: Rewrote it.");
    expect(composeNote("Fixed the date.", null)).toBe("Fixed the date.");
    expect(leadingCategory("Minor: x")).toBe("minor");
    expect(leadingCategory("Minority report")).toBeNull();
  });

  it("changing or clearing the chip swaps only the prefix it wrote", () => {
    expect(recategorize("typo: Fixed the date.", "minor")).toBe("minor: Fixed the date.");
    expect(recategorize("typo", "major")).toBe("major");
    expect(recategorize("minor: Fixed the date.", null)).toBe("Fixed the date.");
    expect(stripCategory("Typo fix.")).toBe("Typo fix.");
  });

  it("a note is generated only when it is exactly the machine's text", () => {
    // The classifier's bare word on an empty note is generated…
    expect(noteIsGenerated("minor", "minor")).toBe(true);
    // …and so is a drafted note led by the classifier's category, unedited.
    expect(noteIsGenerated("minor: Added an example.", composeNote("Added an example.", "minor"))).toBe(true);
    // An edited one, an overridden category, or the author's own words are not.
    expect(noteIsGenerated("major", "minor")).toBe(false);
    expect(noteIsGenerated("minor: Added an example, by hand.", composeNote("Added an example.", "minor"))).toBe(false);
    expect(noteIsGenerated("minor: my words", undefined)).toBe(false);
    expect(noteIsGenerated("", "")).toBe(false);
  });

  it("a note that is only the category word, published as generated, is marked generated on the wire", async () => {
    const cookie = await login();
    const id = await editedItem(cookie, "Teh cat.", "The cat.");
    await apiJson(cookie, "POST", `/blyg/api/items/${id}/publish`, { note: "typo", noteGenerated: true, changeCategory: "typo" });
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.changelog[1]).toEqual(expect.objectContaining({ note: "typo", generated: true }));
  });
});

describe("nothing new on the wire (#19 / TN-1, #77)", () => {
  /** Every key path in a JSON value, arrays collapsed, so two documents can be compared by shape. */
  const shape = (value: unknown, at = ""): string[] => {
    if (Array.isArray(value)) return value.flatMap((v) => shape(v, `${at}[]`));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [`${at}.${k}`, ...shape(v, `${at}.${k}`)]);
    return [];
  };
  const uniq = (xs: string[]) => [...new Set(xs)].sort();

  it("a classified publish produces the same document keys as an unclassified one", async () => {
    const cookie = await login();
    const plain = await editedItem(cookie, "Teh cat.", "The cat.");
    await apiJson(cookie, "POST", `/blyg/api/items/${plain}/publish`, { note: "typo: Fixed a word." });

    await putSettings(env.DB, { ai_model_classify: CLEF });
    const classified = await editedItem(cookie, "Teh dog.", "The dog.");
    await classifyChange(withAi(fakeAi(choiceAnswer("typo", { typo: 0.97, minor: 0.03, major: 0 })).ai), (await getItem(env.DB, classified))!);
    await apiJson(cookie, "POST", `/blyg/api/items/${classified}/publish`, { note: "typo: Fixed a word.", changeCategory: "typo" });
    expect((await apiJson(cookie, "GET", `/blyg/api/items/${classified}`)).json.versions[1].changeClass.category).toBe("typo");

    const a = await (await getPublic(`/blyg/items/${plain}.json`)).json<any>();
    const b = await (await getPublic(`/blyg/items/${classified}.json`)).json<any>();
    expect(uniq(shape(b))).toEqual(uniq(shape(a)));
    expect(Object.keys(b.changelog[1]).sort()).toEqual(Object.keys(a.changelog[1]).sort());
    // The category appears only as the author's note text.
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/"(category|change_class|change_category|classified_at|probability|overridden)"/);
    expect(text.match(/typo/g)).toHaveLength(1);
    // The feed and the manifest carry nothing of it either.
    const feed = await (await getPublic("/blyg/feed.xml")).text();
    expect(feed).not.toMatch(/category|change_class|probability/i);
    const manifest = await (await getPublic("/blyg/blyg.json")).json<any>();
    expect(JSON.stringify(manifest)).not.toMatch(/classif|change_category/);
  });
});

it("ProviderError is what decide() throws for an unconfigured provider", async () => {
  await expect(decide({ ...env } as Env, JEV, "s", { change: CLASSIFY_QUESTION })).rejects.toBeInstanceOf(ProviderError);
});
