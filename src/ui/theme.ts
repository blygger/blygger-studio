/*
 * The studio wears the reading theme (settings.theme): one setting paints the
 * public pages and the studio. Colours come only from THEMES (src/themes.ts)
 * or, for `auto`, from studio.css's own light/dark pair — which is why `auto`
 * writes nothing inline and lets the stylesheet's media query decide.
 *
 * The server shell cannot know the setting without a D1 read, so the theme is
 * applied when settings first load. To keep that from flashing, the last theme
 * applied is remembered in localStorage and re-applied synchronously before
 * the first render (applyCachedTheme). A new device's first launch still
 * paints `auto` until settings arrive.
 */
import {
  resolveTheme,
  luminance,
  validateCustomTheme,
  type CustomTheme,
} from '../themes.ts';
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

const STORAGE_KEY = 'blyg-studio-theme';
const CUSTOM_KEY = 'blyg-studio-theme-custom';
const CUSTOM_DARK_KEY = 'blyg-studio-theme-custom-dark';
function prefersDark() {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Paint `name` onto <html>: CSS variables, data-theme, color-scheme, theme-color. */
export function applyTheme(
  name: string | undefined,
  custom?: CustomTheme | null,
  customDark?: CustomTheme | null,
) {
  const root = document.documentElement;
  for (const v of THEME_VARS) root.style.removeProperty(`--${v}`);
  const vars = themeVars(name, custom, customDark, prefersDark());
  root.dataset.theme = vars ? 'fixed' : 'auto';
  if (vars)
    for (const [key, value] of Object.entries(vars))
      root.style.setProperty(`--${key}`, value);
  const dark = themeIsDark(name, prefersDark(), custom, customDark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.setAttribute(
      'content',
      themeAccent(name, prefersDark(), custom, customDark),
    );
  try {
    localStorage.setItem(STORAGE_KEY, vars ? name! : 'auto');
    if (vars && custom) localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    else localStorage.removeItem(CUSTOM_KEY);
    if (vars && customDark)
      localStorage.setItem(CUSTOM_DARK_KEY, JSON.stringify(customDark));
    else localStorage.removeItem(CUSTOM_DARK_KEY);
  } catch {
    /* storage blocked: the next launch paints auto until settings load */
  }
}

/** Re-apply the last theme before the first render, so a launch does not flash. */
export function applyCachedTheme() {
  let cached: string | null = null;
  const read = (key: string): CustomTheme | null => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const checked = validateCustomTheme(JSON.parse(raw));
    return 'theme' in checked ? checked.theme : null;
  };
  let custom: CustomTheme | null = null;
  let customDark: CustomTheme | null = null;
  try {
    cached = localStorage.getItem(STORAGE_KEY);
    custom = read(CUSTOM_KEY);
    customDark = read(CUSTOM_DARK_KEY);
  } catch {
    /* ignore */
  }
  applyTheme(cached ?? 'auto', custom, customDark);
}
