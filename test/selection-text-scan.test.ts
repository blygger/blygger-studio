// The §2 normalizer and the excerpt text find script, style and math elements
// with a linear scan, not a lazy regex (Fable's review of studio#149, R3). Two
// properties: it agrees with the regex it replaced byte for byte, since every
// client's quote check must keep agreeing with ours; and hostile HTML costs
// linear time.
import { expect, it } from "vitest";
import { plainTextFromHtml, selectionText, selectionTouchesMath } from "../src/markdown.ts";
// The old §2 normalizer, kept here only to prove the new one agrees with it.
const BLOCK = /<\/(?:p|h[1-6]|li|blockquote|pre|div|tr|section|article)>|<br\s*\/?>/gi;
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&hellip;/g, "…").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'").replace(/&amp;/g, "&");
const oldSelection = (html: string) => decode(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(BLOCK, "\u0000").replace(/<[^>]+>/g, "")).split("\u0000").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
it("agrees with the regex normalizer on a fuzzed corpus", () => {
  const parts = ["<script>", "</script>", "<style>", "</style>", "<SCRIPT x>", "</SCRIPT>", "<scripts>", "<p>", "</p>", "a", " b ", "<br>", "&amp;", "<math>", "</math>", ">", "<", "</style >", "<style", "\n"];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let n = 0; n < 20000; n++) {
    let html = "";
    for (let k = Math.floor(rnd() * 14); k > 0; k--) html += parts[Math.floor(rnd() * parts.length)];
    expect(selectionText(html), JSON.stringify(html)).toBe(oldSelection(html));
  }
});

it.each([
  ["unclosed math openers", "<math>x ".repeat(20000)],
  ["unclosed script openers", "<script>x ".repeat(20000)],
  ["unclosed style openers", "<style>x ".repeat(20000)],
])("%s cost linear time", (_, html) => {
  const started = performance.now();
  plainTextFromHtml(html);
  selectionText(html);
  selectionTouchesMath(html, "zzz");
  expect(performance.now() - started).toBeLessThan(150);
});
