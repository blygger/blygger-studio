/*
 * The studio's colour tokens for a theme: pure functions of the theme setting,
 * shared by the SPA (src/ui/theme.ts paints them onto <html>) and the server
 * (the login page, painted before there is a session).
 */
import {
  resolveTheme,
  luminance,
  type CustomTheme,
} from './themes.ts';
export { luminance };

export const THEME_VARS = [
  'page',
  'card',
  'sunk',
  'ink',
  'ink-soft',
  'page-ink',
  'page-ink-soft',
  'rule',
  'rule-strong',
  'pencil',
  'on-pencil',
  'alert',
  'ok',
  'warn',
  'shadow',
] as const;
export type ThemeVars = Record<(typeof THEME_VARS)[number], string>;

const STATE_LIGHT = { alert: '#b3261e', ok: '#1c7a52', warn: '#a35a00' };
const STATE_DARK = { alert: '#f0a19a', ok: '#74c79c', warn: '#e0a75c' };
const SHADOW_LIGHT =
  '0 1px 2px rgba(20,30,35,.06), 0 6px 20px rgba(20,30,35,.06)';
const SHADOW_DARK = '0 1px 2px rgba(0,0,0,.3), 0 6px 20px rgba(0,0,0,.25)';
/** studio.css's own pair — what `auto` resolves to. */
export const AUTO_LIGHT_PENCIL = '#23608c';
export const AUTO_DARK_PENCIL = '#8cc0e4';

/**
 * The studio tokens for a named theme, or null for `auto` (and anything
 * unknown), which leaves studio.css's light/dark defaults in charge.
 */
export function themeVars(
  name: string | undefined,
  custom?: CustomTheme | null,
  customDark?: CustomTheme | null,
  dark = false,
): ThemeVars | null {
  const t = resolveTheme(name, custom, customDark, dark);
  if (!t) return null;
  // Slate is a light sheet on a dark page: text set directly on the page
  // (headings, hints) must read against the page, not the sheet.
  const pageDark = luminance(t.page) < 0.2;
  return {
    page: t.page,
    card: t.paper,
    ink: t.ink,
    'ink-soft': t.inkSoft,
    rule: t.rule,
    pencil: t.pencil,
    sunk: `color-mix(in srgb, ${t.ink} 6%, ${t.paper})`,
    'rule-strong': `color-mix(in srgb, ${t.ink} 24%, ${t.paper})`,
    'on-pencil': t.dark ? t.page : t.paper,
    'page-ink': pageDark && !t.dark ? t.paper : t.ink,
    'page-ink-soft':
      pageDark && !t.dark
        ? `color-mix(in srgb, ${t.paper} 70%, ${t.page})`
        : t.inkSoft,
    ...(t.dark ? STATE_DARK : STATE_LIGHT),
    shadow: t.dark ? SHADOW_DARK : SHADOW_LIGHT,
  };
}

/** True when the theme paints dark (auto follows the device). */
export function themeIsDark(
  name: string | undefined,
  prefersDark: boolean,
  custom?: CustomTheme | null,
  customDark?: CustomTheme | null,
) {
  const t = resolveTheme(name, custom, customDark, prefersDark);
  return t ? t.dark : prefersDark;
}

/** The accent the top bar wears — also the browser's theme-color. */
export function themeAccent(
  name: string | undefined,
  prefersDark: boolean,
  custom?: CustomTheme | null,
  customDark?: CustomTheme | null,
) {
  const t = resolveTheme(name, custom, customDark, prefersDark);
  if (t) return t.pencil;
  return prefersDark ? AUTO_DARK_PENCIL : AUTO_LIGHT_PENCIL;
}
