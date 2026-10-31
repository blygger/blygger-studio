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
  'primitive-page',
  'primitive-layer',
  'primitive-field',
  'primitive-text-primary',
  'primitive-text-secondary',
  'primitive-text-primary-on-background',
  'primitive-text-secondary-on-background',
  'primitive-border-subtle',
  'primitive-border-strong',
  'primitive-accent',
  'primitive-text-on-accent',
  'primitive-support-error',
  'primitive-support-success',
  'primitive-support-warning',
  'shadow',
] as const;
export type ThemeVars = Record<(typeof THEME_VARS)[number], string>;

const STATE_LIGHT = {
  'primitive-support-error': '#b3261e',
  'primitive-support-success': '#1c7a52',
  'primitive-support-warning': '#a35a00',
};
const STATE_DARK = {
  'primitive-support-error': '#f0a19a',
  'primitive-support-success': '#74c79c',
  'primitive-support-warning': '#e0a75c',
};
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
    'primitive-page': t.page,
    'primitive-layer': t.paper,
    'primitive-text-primary': t.ink,
    'primitive-text-secondary': t.inkSoft,
    'primitive-border-subtle': t.rule,
    'primitive-accent': t.pencil,
    'primitive-field': `color-mix(in srgb, ${t.ink} 6%, ${t.paper})`,
    'primitive-border-strong': `color-mix(in srgb, ${t.ink} 24%, ${t.paper})`,
    'primitive-text-on-accent': t.dark ? t.page : t.paper,
    'primitive-text-primary-on-background': pageDark && !t.dark ? t.paper : t.ink,
    'primitive-text-secondary-on-background':
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
