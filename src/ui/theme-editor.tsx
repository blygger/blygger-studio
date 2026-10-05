/*
 * Custom theme editor (Settings → theme → Custom). The author's own palette:
 * the same nine values a preset has, edited here with a live preview, contrast
 * warnings, and a JSON form for sharing a palette with another blyg.
 *
 * Colours only. Every value is a #rrggbb checked by validateCustomTheme, here
 * and again on the server, so nothing but a colour reaches the stylesheet.
 */
import { useState } from 'react';
import {
  THEMES,
  THEME_COLORS,
  HEX_COLOR,
  contrastWarnings,
  customFromPreset,
  pairError,
  validateCustomTheme,
  type CustomTheme,
  type ThemeColor,
} from '../themes.ts';

const LABELS: Record<ThemeColor, [string, string]> = {
  page: ['Page', 'the margins behind everything'],
  paper: ['Paper', 'the block the writing sits in'],
  ink: ['Text', 'body text and headings'],
  inkSoft: ['Secondary text', 'dates, bylines, hints'],
  rule: ['Lines', 'rules and borders'],
  pencil: ['Accent', 'links and buttons'],
  genBg: ['Generated tint', 'behind highlighted generated text'],
  genRule: ['Generated outline', 'around highlighted generated text'],
};

export function ThemeEditor({
  value,
  font,
  lockDark = false,
  onChange,
}: {
  value: CustomTheme;
  /** The chosen typeface's stack, so the preview reads as the page will. */
  font?: string;
  /** In a light/dark pair each palette's scheme is fixed by its role. */
  lockDark?: boolean;
  onChange: (next: CustomTheme) => void;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<ThemeColor, string>>>({});
  const set = (key: ThemeColor, colour: string) =>
    onChange({ ...value, [key]: colour.toLowerCase() });
  const warnings = contrastWarnings(value);
  return (
    <div className="theme-editor">
      <div className="field">
        <label htmlFor="theme-start">
          <span>Start from a preset</span>
        </label>
        <select
          id="theme-start"
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            const start = customFromPreset(event.target.value);
            // In a pair, keep this palette's role whichever preset it starts from.
            onChange(lockDark ? { ...start, dark: value.dark } : start);
          }}
        >
          <option value="">Choose…</option>
          {Object.entries(THEMES).map(([id, t]) => (
            <option key={id} value={id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {lockDark ? null : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={value.dark}
              onChange={(event) =>
                onChange({ ...value, dark: event.target.checked })
              }
            />
            <span>This palette is dark</span>
          </label>
          <p className="hint check-hint">
            Tells browsers to draw scrollbars and form controls dark to match.
          </p>
        </>
      )}
      <div className="theme-colours">
        {THEME_COLORS.map((key) => {
          const [label, hint] = LABELS[key];
          const draft = drafts[key];
          return (
            <div className="theme-colour" key={key}>
              <input
                type="color"
                aria-label={`${label} colour`}
                value={value[key]}
                onChange={(event) => set(key, event.target.value)}
              />
              <div className="theme-colour-text">
                <label htmlFor={`theme-${key}`}>
                  {label} <span className="hint">— {hint}</span>
                </label>
                <input
                  id={`theme-${key}`}
                  type="text"
                  spellCheck={false}
                  value={draft ?? value[key]}
                  aria-invalid={draft !== undefined && !HEX_COLOR.test(draft.trim().toLowerCase())}
                  onChange={(event) => {
                    const text = event.target.value;
                    const colour = text.trim().toLowerCase();
                    if (HEX_COLOR.test(colour)) {
                      setDrafts(({ [key]: _gone, ...rest }) => rest);
                      set(key, colour);
                    } else setDrafts((d) => ({ ...d, [key]: text }));
                  }}
                  onBlur={() => setDrafts(({ [key]: _gone, ...rest }) => rest)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <ThemePreview value={value} font={font} />
      {warnings.length ? (
        <div className="theme-warnings" role="status">
          {warnings.map((w) => (
            <p key={w.label} className="hint">
              ⚠ {w.label}: contrast {w.ratio.toFixed(1)}:1, below {w.min}:1 (WCAG AA).
            </p>
          ))}
        </div>
      ) : (
        <p className="hint" role="status">
          ✓ Text, secondary text and links meet WCAG AA contrast on paper.
        </p>
      )}
    </div>
  );
}

/**
 * Share a look as JSON: one palette, or a light/dark pair as
 * `{"light": {…}, "dark": {…}}`. Import accepts either, and checks every
 * value (and the pair's roles) before anything changes.
 */
export function parseShared(
  text: string,
): { light: CustomTheme; dark: CustomTheme | null } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'That is not valid JSON.' };
  }
  const v = parsed as Record<string, unknown> | null;
  if (v && typeof v === 'object' && !Array.isArray(v) && 'light' in v) {
    const extra = Object.keys(v).filter((k) => k !== 'light' && k !== 'dark');
    if (extra.length) return { error: `unknown key: ${extra.join(', ')}` };
    const light = validateCustomTheme(v.light);
    if ('error' in light) return { error: `light: ${light.error}` };
    const dark = v.dark == null ? null : validateCustomTheme(v.dark);
    if (dark && 'error' in dark) return { error: `dark: ${dark.error}` };
    const pair = { light: light.theme, dark: dark ? dark.theme : null };
    const incoherent = pairError(pair.light, pair.dark);
    return incoherent ? { error: incoherent } : pair;
  }
  const single = validateCustomTheme(parsed);
  return 'error' in single ? single : { light: single.theme, dark: null };
}

export function ThemeShare({
  light,
  dark,
  onImport,
}: {
  light: CustomTheme;
  dark: CustomTheme | null;
  onImport: (light: CustomTheme, dark: CustomTheme | null) => void;
}) {
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [copied, setCopied] = useState(false);
  const exported = JSON.stringify(dark ? { light, dark } : light, null, 2);
  return (
    <details className="theme-share">
      <summary>Share or import a look</summary>
      <div className="field">
        <label htmlFor="theme-export">
          <span>
            {dark ? 'This light/dark pair as JSON' : 'This palette as JSON'}
          </span>
        </label>
        <textarea id="theme-export" rows={6} readOnly value={exported} />
        <button
          type="button"
          className="btn btn-ghost btn-mini"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(exported);
              setCopied(true);
            } catch {
              /* clipboard blocked: the text is selectable above */
            }
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="field">
        <label htmlFor="theme-import">
          <span>Paste a palette or a light/dark pair to use it</span>
        </label>
        <textarea
          id="theme-import"
          rows={4}
          value={json}
          placeholder='{"dark": false, "page": "#…", …}  or  {"light": {…}, "dark": {…}}'
          onChange={(event) => {
            setJson(event.target.value);
            setJsonError('');
          }}
        />
        <button
          type="button"
          className="btn btn-ghost btn-mini"
          onClick={() => {
            const result = parseShared(json);
            if ('error' in result) setJsonError(result.error);
            else {
              onImport(result.light, result.dark);
              setJson('');
              setCopied(false);
            }
          }}
        >
          import
        </button>
        {jsonError ? <p className="hint theme-error">{jsonError}</p> : null}
      </div>
    </details>
  );
}

/** A small public page in the palette: what a reader will see. */
export function ThemePreview({
  value: t,
  font,
}: {
  value: CustomTheme;
  font?: string;
}) {
  return (
    <div
      className="theme-preview"
      aria-label="Preview"
      style={{ background: t.page, colorScheme: t.dark ? 'dark' : 'light' }}
    >
      <div
        className="theme-preview-sheet"
        style={{
          background: t.paper,
          color: t.ink,
          borderColor: t.rule,
          fontFamily: font,
        }}
      >
        <p className="theme-preview-title">A fragment, in your colours</p>
        <p style={{ color: t.inkSoft }} className="theme-preview-meta">
          Oct 5, 2026 · v1
        </p>
        <p>
          Body text reads like this, with{' '}
          <a style={{ color: t.pencil }} href="#preview" onClick={(e) => e.preventDefault()}>
            a link
          </a>{' '}
          and{' '}
          <span
            className="theme-preview-gen"
            style={{ background: t.genBg, outlineColor: t.genRule }}
          >
            a generated passage
          </span>
          .
        </p>
        <hr style={{ borderColor: t.rule }} />
        <p style={{ color: t.inkSoft }} className="theme-preview-meta">
          Permalink
        </p>
      </div>
    </div>
  );
}
