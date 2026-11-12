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
import { validateCustomTheme, type CustomTheme } from '../themes.ts';
import { applyTabIcon } from './tab.ts';
import { themeAccent, themeIsDark, themeVars, THEME_VARS } from '../studio-theme.ts';
export { luminance, THEME_VARS, themeVars, themeIsDark, themeAccent, AUTO_LIGHT_PENCIL, AUTO_DARK_PENCIL, type ThemeVars } from '../studio-theme.ts';

// Removes properties written by versions of Studio before semantic colour
// tokens, so an already-open page cannot retain a stale inline value.
const LEGACY_THEME_VARS = [
  'page', 'card', 'sunk', 'ink', 'ink-soft', 'page-ink', 'page-ink-soft',
  'rule', 'rule-strong', 'pencil', 'on-pencil', 'alert', 'ok', 'warn',
] as const;

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
  for (const v of LEGACY_THEME_VARS) root.style.removeProperty(`--${v}`);
  const vars = themeVars(name, custom, customDark, prefersDark());
  root.dataset.theme = vars ? 'fixed' : 'auto';
  if (vars)
    for (const [key, value] of Object.entries(vars))
      root.style.setProperty(`--${key}`, value);
  const dark = themeIsDark(name, prefersDark(), custom, customDark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const accent = themeAccent(name, prefersDark(), custom, customDark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', accent);
  // The tab icon wears the accent too (tab.ts); `auto` takes studio.css's own on-pencil.
  applyTabIcon(accent, vars?.['primitive-text-on-accent'] ?? (dark ? '#0f1314' : '#fafbfb'));
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
