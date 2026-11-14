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
