import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { AiModels, Settings } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { settings, client } from './data.ts';
import {
  Button,
  Failure,
  mount,
  useChrome,
  useSettings,
} from './components.tsx';
import { Link } from '@tanstack/react-router';
import './reading.css';
import { THEMES } from '../themes.ts';
import { CLIENT } from '../client.ts';
import { compiledExtensions } from '../../build/extensions.ui.ts';

const fields = [
  'site_title',
  'theme',
  'author_name',
  'author_url',
  'author_bio',
  'author_links',
  'site_url',
  'timezone',
  'picker_typing',
  'avatar_media_id',
  'ai_model_tk',
  'ai_model_changelog',
  'ai_model_feed',
  'feed_prompt',
  'ai_style_prompt',
  'accept_mentions',
  'update_check',
  'show_responses_default',
  'highlight_generated_default',
  'auto_change_notes',
  'update_feed_url',
  'extensions',
] as const;
function editable(row: Settings): Settings {
  return Object.fromEntries(fields.map((key) => [key, row[key]])) as Settings;
}
function parseLinks(text: string): Settings['author_links'] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const split = line.indexOf('|');
      if (split < 1 || !line.slice(split + 1).trim())
        throw new Error('Use label | url for each link.');
      return {
        label: line.slice(0, split).trim(),
        url: line.slice(split + 1).trim(),
      };
    });
}
export function SettingsPage() {
  useChrome({ framed: false });
  const row = useSettings();
  return (
    <>
      <Link className="back-link" to="/more">
        ← more
      </Link>
      <h2 className="view-h">settings</h2>
      <div style={{ height: 10 }} />
      {row ? (
        <SettingsForm initial={row} />
      ) : (
        <p className="view-sub">Loading settings…</p>
      )}
    </>
  );
}
function SettingsForm({ initial }: { initial: Settings }) {
  const [form, setForm] = useState(() => {
    const copy = editable(initial);
    if (!copy.timezone)
      copy.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return copy;
  });
  const [links, setLinks] = useState(
    initial.author_links
      .map((link) => `${link.label} | ${link.url}`)
      .join('\n'),
  );
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setForm((previous) => ({ ...previous, [key]: value }));
  };
  const zones = [
    ...new Set(['', form.timezone, ...Intl.supportedValuesOf('timeZone')]),
  ];
  const field = (
    key:
      | 'site_title'
      | 'author_name'
      | 'author_url'
      | 'author_bio'
      | 'site_url'
      | 'ai_style_prompt'
      | 'feed_prompt'
      | 'update_feed_url',
    label: string,
    multiline = false,
    placeholder?: string,
  ) => (
    <div className="field">
      <label htmlFor={key}>
        <span>{label}</span>
      </label>
      {multiline ? (
        <textarea
          id={key}
          rows={key === 'feed_prompt' ? 4 : 3}
          value={form[key]}
          placeholder={placeholder}
          onChange={(event) => change(key, event.target.value)}
        />
      ) : (
        <input
          id={key}
          type={key === 'site_url' || key === 'update_feed_url' ? 'url' : 'text'}
          value={form[key]}
          placeholder={placeholder}
          onChange={(event) => change(key, event.target.value)}
        />
      )}
    </div>
  );
  const toggle = (
    key:
      | 'update_check'
      | 'show_responses_default'
      | 'highlight_generated_default'
      | 'accept_mentions'
      | 'auto_change_notes',
    label: string,
    hint?: ReactNode,
  ) => (
    <>
      <label className="check">
        <input
          id={key}
          type="checkbox"
          checked={form[key]}
          aria-describedby={hint ? `${key}-hint` : undefined}
          onChange={(event) => change(key, event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p className="hint check-hint" id={`${key}-hint`}>
          {hint}
        </p>
      ) : null}
    </>
  );
  return (
    <form
      className="settings-form"
      id="settings-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(undefined);
        setSaved(false);
        try {
          const author_links = parseLinks(links);
          await settings.update('settings', (row) => {
            Object.assign(row, form, { author_links });
          }).isPersisted.promise;
          setSaved(true);
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Failure error={error} />
      <section className="card">
        <h3 className="card-h">profile</h3>
        {field('site_title', 'Site title')}
        {field('author_name', 'Author name')}
        {field('author_url', 'Author URL', false, 'blank = this blyg\'s own address')}
        {field('author_bio', 'Bio', true)}
        <div className="field">
          <label htmlFor="author_links">
            <span>Links (one per line, "label | url")</span>
          </label>
          <textarea
            id="author_links"
            rows={3}
            value={links}
            onChange={(event) => {
              setLinks(event.target.value);
              setSaved(false);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="avatar_media_id">
            <span>Avatar media ID</span>
          </label>
          <input
            id="avatar_media_id"
            type="text"
            value={form.avatar_media_id}
            onChange={(event) => change('avatar_media_id', event.target.value)}
          />
        </div>
        <div className="row avatar-row">
          {avatar ? (
            <img src={`${mount}/${avatar}`} alt="Uploaded avatar" />
          ) : null}
          <span className="spacer" />
          <Button
            type="button"
            className="btn btn-ghost btn-mini"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            upload avatar
          </Button>
          <Button
            type="button"
            className="btn btn-ghost btn-mini"
            onClick={() => {
              change('avatar_media_id', '');
              setAvatar('');
            }}
          >
            clear avatar
          </Button>
        </div>
        <input
          ref={file}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            setBusy(true);
            setError(undefined);
            try {
              const media = await unwrap(
                BlyggerApi.uploadMedia({ client, body: { file: selected } }),
              );
              change('avatar_media_id', media.id);
              setAvatar(media.url);
            } catch (failure) {
              setError(failure);
            } finally {
              setBusy(false);
            }
          }}
        />
      </section>
      <section className="card">
        <h3 className="card-h">theme</h3>
        <div className="field">
          <span>
            Reading theme — your public pages and this studio
          </span>
          <div className="theme-grid" role="radiogroup" aria-label="Reading theme">
            {['auto', ...Object.keys(THEMES)].map((id) => {
              const theme = THEMES[id];
              const automatic = id === 'auto';
              const background = automatic
                ? 'linear-gradient(90deg,#fafbfb 50%,#14191a 50%)'
                : theme.page;
              const ink = automatic
                ? 'linear-gradient(90deg,#1b2426 50%,#e3e7e7 50%)'
                : theme.ink;
              return (
                <label className="theme-opt" key={id}>
                  <input
                    type="radio"
                    name="theme"
                    value={id}
                    checked={form.theme === id}
                    onChange={() => change('theme', id)}
                  />
                  <span className="theme-swatch" style={{ background }}>
                    <span
                      className="sheet-mini"
                      style={{
                        background: automatic ? 'transparent' : theme.paper,
                      }}
                    >
                      <span className="line" style={{ background: ink }} />
                      <span
                        className="line short"
                        style={{ background: ink, opacity: 0.55 }}
                      />
                    </span>
                  </span>
                  <span className="theme-name">
                    {automatic ? 'Auto' : theme.label}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        {toggle(
          'highlight_generated_default',
          'Highlight generated portions by default',
          <>
            Text written by <code>[TK]</code> generation shows on your public
            pages in a lightly tinted, outlined box, in every theme. A post can
            override this in its editor's TK card.
          </>,
        )}
      </section>
      <section className="card">
        <h3 className="card-h">writing</h3>
        <div className="field" role="radiogroup" aria-labelledby="picker_typing-label">
          <span id="picker_typing-label">
            When you type <code>[[</code> or <code>![[</code>, search by typing in
          </span>
          {(
            [
              ['auto', 'Automatic', 'the editor with a mouse, the picker on a touch screen, where it fills the screen'],
              ['editor', 'The editor', 'keep typing after the brackets; arrow keys and Enter pick'],
              ['panel', 'The picker', 'the picker opens with its own search box'],
            ] as const
          ).map(([value, label, hint]) => (
            <label className="check" key={value}>
              <input
                type="radio"
                name="picker_typing"
                value={value}
                checked={form.picker_typing === value}
                onChange={() => change('picker_typing', value)}
              />
              <span>
                {label} <span className="hint">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>
      <section className="card">
        <h3 className="card-h">site</h3>
        {field('site_url', 'Canonical site URL (blank = derive from request)')}
        <div className="field">
          <label htmlFor="timezone">
            <span>Timezone for displayed dates</span>
          </label>
          <select
            id="timezone"
            value={form.timezone}
            onChange={(event) => change('timezone', event.target.value)}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone || 'UTC'}
              </option>
            ))}
          </select>
          {!initial.timezone ? (
            <p className="hint">detected from this device — save to keep it</p>
          ) : null}
          <p className="hint">
            Your blyg runs on a server whose clock is UTC, so without this an
            evening post can show tomorrow’s date. This changes display only, on
            your pages and in the studio. Feed dates stay RFC-822 and item
            documents stay ISO-8601 UTC.
          </p>
        </div>
      </section>
      <section className="card">
        <h3 className="card-h">AI models</h3>
        <ModelSettings form={form} change={change} />
        {field(
          'ai_style_prompt',
          'TK site-level style prompt (optional, appended to every generation request)',
          true,
        )}
        {toggle(
          'auto_change_notes',
          'Automatically generate changelog notes when publishing a new version',
          <>
            When a new version is published with no note, the changelog model
            drafts one from the change. You see it and can edit it before
            anything is published. A note published exactly as drafted is
            marked as generated in the changelog.
          </>,
        )}
      </section>
      <section className="card">
        <h3 className="card-h">smart feed</h3>
        {field(
          'feed_prompt',
          'Smart Feed prompt: how your AI agent should score new items',
          true,
          'e.g. Prioritize tech news and significant updates to items I have interacted with or liked. Deprioritize sports content, trivial updates, and items like ones I have disliked.',
        )}
        <p className="hint">
          The prompt is a rubric. Your agent will score each new item in your
          reading against it, then sort the Smart Feed by score or hide items
          below a threshold. It will read your <Link to="/signals">signals</Link>{' '}
          (thumbs, hoppers, stubs, forks and quotes) to know what you have
          liked and engaged with. The agent is not built yet: this prompt is
          saved now so the Smart Feed can use it when it is.
        </p>
      </section>
      <section className="card">
        <h3 className="card-h">updates</h3>
        {toggle(
          'update_check',
          'Tell me when a newer release of this client exists',
          <>
            On by default. Once a day your blyg fetches the client’s public
            release feed and compares the newest version to the one you are
            running — currently <code>{CLIENT.version}</code>. Nothing about
            your blyg is sent: no URL, no identifier, no query. Before 1.0 the
            wire format can change between releases, so an old client can stop
            making sense to other blygs.
          </>,
        )}
        {field(
          'update_feed_url',
          'Release feed (blank = this client’s own)',
          false,
          'https://github.com/blygger/blygger-studio/releases.atom',
        )}
        <p className="hint">
          Only change this if you have modified the client and track your own
          versions. Point it at your releases, or turn the check off.
        </p>
      </section>
      <section className="card">
        <h3 className="card-h">responses from other blygs</h3>
        {toggle(
          'show_responses_default',
          'Show verified responses on my items’ public pages, by default',
          <>
            Applies to items that have not decided for themselves. An item’s
            override keeps winning if you change this later. Set overrides and
            hide individual responses in the mentions tab. A response list is a
            citation trail with no count.
          </>,
        )}
        {toggle(
          'accept_mentions',
          'Accept Webmentions — let other blygs tell yours when they quote, respond to or fork an item',
          <>
            Unchecking this removes the public Webmention endpoint and its
            discovery links. Requests return 404. You still send mentions when
            you quote other people, and collected responses stay in your Studio.
          </>,
        )}
      </section>
      {compiledExtensions.length ? (
        <section className="card" id="extensions">
          <h3 className="card-h">extensions</h3>
          <p className="hint">
            Experiments compiled into this build, by the release or by its
            operator. They are not part of the reference Studio and change
            only what you see here, never your public pages or what other
            blygs read. Each starts off.
          </p>
          {compiledExtensions.map((extension) => (
            <div key={extension.name}>
              <label className="check">
                <input
                  id={`extension-${extension.name}`}
                  type="checkbox"
                  data-extension={extension.name}
                  checked={form.extensions.includes(extension.name)}
                  aria-describedby={`extension-${extension.name}-hint`}
                  onChange={(event) =>
                    change(
                      'extensions',
                      event.target.checked
                        ? [...form.extensions, extension.name].sort()
                        : form.extensions.filter((name) => name !== extension.name),
                    )
                  }
                />
                <span>{extension.label}</span>
              </label>
              <p className="hint check-hint" id={`extension-${extension.name}-hint`}>
                {extension.description}
              </p>
            </div>
          ))}
        </section>
      ) : null}
      <div className="save-bar">
        <span className="state">
          {saved ? <span role="status">saved</span> : null}
        </span>
        <Button className="btn btn-primary" type="submit" disabled={busy}>
          save settings
        </Button>
      </div>
    </form>
  );
}

const FUNCTIONS = [
  { key: 'ai_model_tk', label: 'TK generation' },
  { key: 'ai_model_changelog', label: 'changelog notes' },
  { key: 'ai_model_feed', label: 'feed scoring', hint: 'for the Smart Feed; not used yet' },
] as const;
const OTHER = '__other__';

/** A provider's readiness in words: a key, a Workers AI binding (studio#8), or neither needed. */
function providerStatus(p: AiModels['providers'][number]): string {
  if (p.binding) return p.configured ? 'binding set' : 'no binding';
  if (!p.key_secret) return 'no key needed';
  return p.configured ? 'key set' : 'no key';
}

/**
 * One model per AI function (0.26.0), chosen from the model manifest
 * (models.json, plus the operator's models.local.json) or typed in. The
 * fourth row, authoring, is reserved and disabled: it signals where the
 * studio is going without pretending to do it.
 */
function ModelSettings({
  form,
  change,
}: {
  form: Settings;
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const [manifest, setManifest] = useState<AiModels>();
  const [other, setOther] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    unwrap(BlyggerApi.getAiModels({ client }))
      .then((m) => live && setManifest(m))
      .catch(() => live && setManifest({ providers: [], models: [], local: false }));
    return () => {
      live = false;
    };
  }, []);
  const listed = (id: string) => !!manifest?.models.some((m) => m.id === id);
  return (
    <>
      <p className="hint model-hint">
        Each AI function uses its own model. The list comes from{' '}
        <code>models.json</code> in your studio install, and you can edit it:
        add or remove models there, or put your changes in{' '}
        <code>models.local.json</code> (same shape) so upgrades never conflict,
        then redeploy.{manifest?.local ? ' This install has a models.local.json.' : ''}{' '}
        Choose <em>other…</em> to type any model id.
      </p>
      {manifest ? (
        <ul className="provider-keys" aria-label="provider keys">
          {manifest.providers.map((p) => (
            <li key={p.id} data-configured={p.configured}>
              {p.configured ? '✓' : '–'} {p.label}{' '}
              <span className="hint">
                {providerStatus(p)}
                {p.key_secret || p.binding ? (
                  <>
                    {' '}
                    (<code>{p.key_secret ?? p.binding}</code>)
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {FUNCTIONS.map((f) => {
        const value = form[f.key];
        const isOther = other[f.key] || (!!value && !!manifest && !listed(value));
        return (
          <div className="field model-field" key={f.key}>
            <label htmlFor={f.key}>
              <span>
                {f.label}
                {'hint' in f ? <span className="hint"> · {f.hint}</span> : null}
              </span>
            </label>
            <select
              id={f.key}
              value={isOther ? OTHER : value}
              onChange={(event) => {
                const next = event.target.value;
                setOther((o) => ({ ...o, [f.key]: next === OTHER }));
                if (next !== OTHER) change(f.key, next);
              }}
            >
              <option value="">— none —</option>
              {manifest?.providers.map((p) => (
                <optgroup key={p.id} label={p.configured ? p.label : `${p.label} (${providerStatus(p)})`}>
                  {manifest.models
                    .filter((m) => m.provider === p.id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.note ? ` — ${m.note}` : ''}
                      </option>
                    ))}
                </optgroup>
              ))}
              <option value={OTHER}>other…</option>
            </select>
            {isOther ? (
              <input
                type="text"
                aria-label={`${f.label} model id`}
                placeholder="model id, e.g. claude-sonnet-5-5"
                value={value}
                onChange={(event) => change(f.key, event.target.value)}
              />
            ) : null}
          </div>
        );
      })}
      <div className="field model-field">
        <label htmlFor="ai_model_authoring">
          <span>
            authoring<span className="hint"> · coming later</span>
          </span>
        </label>
        <select id="ai_model_authoring" disabled value="">
          <option value="">reserved for agentic authoring</option>
        </select>
      </div>
    </>
  );
}
