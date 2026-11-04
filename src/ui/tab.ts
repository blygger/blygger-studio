/*
 * The browser tab says which studio it is (Venkat, session 59: three studios
 * open, no telling them apart without clicking in). The title names the blyg,
 * and the ❝ icon wears the theme's accent, the colour of the top bar.
 *
 * The site title is remembered in localStorage and re-applied at startup, as
 * the theme is (theme.ts), so a reload does not flash the generic title.
 */
import { studioIconSvg } from '../studio-icon.ts';

const TITLE_KEY = 'blyg-studio-title';

export function studioTitle(siteTitle: string | undefined) {
  return siteTitle ? `blyg studio — ${siteTitle}` : 'blyg studio';
}

export function applyTitle(siteTitle: string | undefined) {
  document.title = studioTitle(siteTitle);
  try {
    if (siteTitle) localStorage.setItem(TITLE_KEY, siteTitle);
    else localStorage.removeItem(TITLE_KEY);
  } catch {
    /* storage blocked: the next launch shows the generic title until settings load */
  }
}

export function applyCachedTitle() {
  try {
    const cached = localStorage.getItem(TITLE_KEY);
    if (cached) document.title = studioTitle(cached);
  } catch {
    /* ignore */
  }
}

/** The tab icon in the given accent; `glyph` is the colour on the accent. */
export function applyTabIcon(accent: string, glyph: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(studioIconSvg(accent, glyph))}`;
}
