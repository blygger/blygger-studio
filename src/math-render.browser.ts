// The browser bundle's stand-in for math-render.ts (scripts/build-spa.ts): the
// Studio's own previews of text come from the server, so the page never draws a
// formula, and the renderer stays out of the bundle. A formula reads as written.
// Escaped here, not imported: this module is in both the Worker and the UI
// typecheck, and util.ts is Worker-only.
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderTex(tex: string, display: boolean): { html: string; error?: string } {
  return { html: escapeHtml(display ? `$$${tex}$$` : `$${tex}$`) };
}

/** The browser never publishes: nothing to record. */
export const noteMathFailure = (_failure: { formula: string; reason: string }) => {};
/** Kept equal to math-render.ts's, which the finder in math.ts imports. */
export const TEX_MAX = 4000;
