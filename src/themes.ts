export interface Theme {
  label: string;
  /** true when the palette is dark, so `color-scheme` can be pinned to match. */
  dark: boolean;
  page: string;
  paper: string;
  ink: string;
  inkSoft: string;
  rule: string;
  pencil: string;
  /** Highlighted generated spans: a tint just off the paper, and a hairline around it. */
  genBg: string;
  genRule: string;
}

export const THEMES: Record<string, Theme> = {
  paper: {
    label: "Paper",
    dark: false,
    page: "#fafbfb", paper: "#fafbfb",
    ink: "#1b2426", inkSoft: "#5c686b", rule: "#dde3e5", pencil: "#23608c",
    genBg: "#eef3f7", genRule: "#c9d8e4",
  },
  cream: {
    label: "Cream",
    dark: false,
    page: "#e9e2d2", paper: "#f7f2e7",
    ink: "#33312c", inkSoft: "#6d675c", rule: "#ddd5c4", pencil: "#8a5a2b",
    genBg: "#f0e7d4", genRule: "#d8c39e",
  },
  slate: {
    label: "Slate",
    dark: false,
    page: "#2f3538", paper: "#f5f7f7",
    ink: "#1b2426", inkSoft: "#5c686b", rule: "#dde3e5", pencil: "#23608c",
    genBg: "#ebf1f5", genRule: "#c6d6e2",
  },
  "solarized-light": {
    label: "Solarized Light",
    dark: false,
    page: "#eee8d5", paper: "#fdf6e3",
    ink: "#073642", inkSoft: "#657b83", rule: "#e3dcc4", pencil: "#268bd2",
    genBg: "#f3ecd6", genRule: "#d8cca5",
  },
  "solarized-dark": {
    label: "Solarized Dark",
    dark: true,
    page: "#00212b", paper: "#002b36",
    ink: "#eee8d5", inkSoft: "#93a1a1", rule: "#0c4553", pencil: "#6cb6e0",
    genBg: "#073642", genRule: "#1d5566",
  },
  nord: {
    label: "Nord",
    dark: true,
    page: "#242933", paper: "#2e3440",
    ink: "#e5e9f0", inkSoft: "#a5aec0", rule: "#3e4757", pencil: "#88c0d0",
    genBg: "#3b4252", genRule: "#4c566a",
  },
};

/**
 * CSS appended to the stylesheet when the author picked a theme. It redefines
 * the tokens for BOTH schemes — the base block and the dark-preference block —
 * because an explicit choice by the author should not flip when the reader's
 * OS does. `auto` returns nothing, leaving the light/dark defaults in charge.
 */

/**
 * Custom theme (author-defined palette). The same nine values as a preset, so
 * nothing downstream needs a second code path: `resolveTheme` turns the
 * `"custom"` id plus the stored palette into an ordinary Theme.
 *
 * Colours only, `#rrggbb` only. No free-form CSS reaches the stylesheet, which
 * keeps the one hand-written stylesheet authoritative and leaves nothing to
 * inject: every value is checked against HEX before it is stored or emitted.
 */
export const CUSTOM_THEME_ID = "custom";
export const THEME_COLORS = ["page", "paper", "ink", "inkSoft", "rule", "pencil", "genBg", "genRule"] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];
export type CustomTheme = { dark: boolean } & Record<ThemeColor, string>;
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Validate an untrusted value (API body, imported JSON). Normalises hex to lowercase. */
export function validateCustomTheme(value: unknown): { theme: CustomTheme } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "a custom theme is an object" };
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => k !== "dark" && !(THEME_COLORS as readonly string[]).includes(k));
  if (extra.length) return { error: `unknown key${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}` };
  if (typeof v.dark !== "boolean") return { error: "dark must be true or false" };
  const theme = { dark: v.dark } as CustomTheme;
  for (const key of THEME_COLORS) {
    const c = typeof v[key] === "string" ? (v[key] as string).trim().toLowerCase() : "";
    if (!HEX_COLOR.test(c)) return { error: `${key} must be a #rrggbb colour` };
    theme[key] = c;
  }
  return { theme };
}

/**
 * A look's name ("Pink Quill"): what it's called when it's shared. Plain text,
 * one line, at most 40 characters. It is shown in the studio (as text, never
 * markup) and travels in exported JSON; it never reaches the stylesheet, whose
 * comment always says "Custom".
 */
export const THEME_NAME_MAX = 40;
export function themeNameError(name: string): string | null {
  if (name.length > THEME_NAME_MAX) return `custom_theme_name: at most ${THEME_NAME_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return "custom_theme_name: one line of plain text";
  return null;
}

/** The stored palette (settings JSON), or null when absent or invalid. */
export function parseCustomTheme(stored: string | undefined | null): CustomTheme | null {
  if (!stored) return null;
  try {
    const result = validateCustomTheme(JSON.parse(stored));
    return "theme" in result ? result.theme : null;
  } catch {
    return null;
  }
}

/**
 * A theme id (and the custom palettes, if any) to a Theme; undefined for
 * `auto` or unknown. A custom theme may carry a dark companion: then it
 * follows the reader's light/dark preference, as Auto does, and
 * `prefersDark` picks which palette applies.
 */
export function resolveTheme(
  name: string | undefined,
  custom?: CustomTheme | null,
  customDark?: CustomTheme | null,
  prefersDark = false,
): Theme | undefined {
  if (!name) return undefined;
  if (name === CUSTOM_THEME_ID) {
    if (!custom) return undefined;
    if (customDark && prefersDark) return { label: "Custom (dark)", ...customDark };
    return { label: "Custom", ...custom };
  }
  return Object.prototype.hasOwnProperty.call(THEMES, name) ? THEMES[name] : undefined;
}

/**
 * A light palette and its dark companion must say so: the companion is what
 * readers in dark mode get, so it has to be a dark palette, and the one it
 * pairs with a light one. Returns an error message, or null when the pair is
 * coherent (or there is no companion).
 */
export function pairError(light: CustomTheme | null, dark: CustomTheme | null): string | null {
  if (!dark) return null;
  if (!light) return "custom_theme_dark needs a custom_theme to pair with";
  if (light.dark) return "with a dark companion, custom_theme must be a light palette (dark: false)";
  if (!dark.dark) return "custom_theme_dark must be a dark palette (dark: true)";
  return null;
}

/** A preset's palette as a starting point for a custom theme. */
export function customFromPreset(name: string): CustomTheme {
  const t = THEMES[name] ?? THEMES.paper;
  const { label: _label, ...palette } = t;
  return { ...palette };
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pairs a reader depends on, with the WCAG AA minimum for body text. Advisory:
 * the studio warns, it does not refuse — an author may want a low-contrast
 * rule line, and the rule is not text.
 */
export const CONTRAST_CHECKS: { fg: ThemeColor; bg: ThemeColor; label: string; min: number }[] = [
  { fg: "ink", bg: "paper", label: "Text on paper", min: 4.5 },
  { fg: "inkSoft", bg: "paper", label: "Secondary text on paper", min: 4.5 },
  { fg: "pencil", bg: "paper", label: "Links on paper", min: 4.5 },
  { fg: "ink", bg: "genBg", label: "Text in generated highlights", min: 4.5 },
];

export function contrastWarnings(t: CustomTheme): { label: string; ratio: number; min: number }[] {
  return CONTRAST_CHECKS.map((c) => ({ label: c.label, ratio: contrastRatio(t[c.fg], t[c.bg]), min: c.min })).filter((w) => w.ratio < w.min);
}
