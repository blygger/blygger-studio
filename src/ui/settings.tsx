import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { AiModels, Settings } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { settings, client, items } from './data.ts';
import { useLiveQuery } from '@tanstack/react-db';
import { itemTitle } from './plain-text.ts';
import {
  Button,
  Failure,
  mount,
  useChrome,
  useSettings,
} from './components.tsx';
import { Link } from '@tanstack/react-router';
import './reading.css';
import {
  THEMES,
  CUSTOM_THEME_ID,
  customFromPreset,
  THEME_NAME_MAX,
  type CustomTheme,
} from '../themes.ts';
import { ThemeEditor, ThemeShare } from './theme-editor.tsx';
import { FONTS } from '../fonts.ts';
import { DEFAULT_FEED_ORDER, FEED_ALGORITHMS } from '../feeds/index.ts';
import { CLIENT } from '../client.ts';
import { compiledExtensions } from '../../build/extensions.ui.ts';

const fields = [
  'site_title',
  'theme',
  'custom_theme',
  'custom_theme_dark',
  'custom_theme_name',
  'font',
  'author_name',
  'author_url',
  'author_bio',
  'author_links',
  'site_url',
  'timezone',
  'picker_typing',
  'feed_order',
  'front_page',
  'posts_path',
  'links_position',
  'links_threads',
  'links_collections',
  'links_opml',
  'links_blygger_org',
  'links_blygger_com',
  'hopper_feeds',
  'avatar_media_id',
  'ai_model_tk',
  'ai_model_changelog',
  'ai_model_feed',
  'ai_model_classify',
  'feed_prompt',
  'ai_style_prompt',
  'accept_mentions',
  'update_check',
  'show_responses_default',
  'highlight_generated_default',
  'auto_change_notes',
  'change_category_in_note',
  'update_feed_url',
  'extensions',
] as const;
function editable(row: Settings): Settings {
  return Object.fromEntries(fields.map((key) => [key, row[key]])) as unknown as Settings;
}
export function parseLinks(text: string): Settings['author_links'] {
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
  useChrome({ framed: false, wide: true });
  const row = useSettings();
  return (
    <>
      <Link className="back-link" to="/more">
        ← more
      </Link>
      <h2 className="view-h">settings</h2>
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
  const aiModels = useAiModels();
  const [externalLinks, setExternalLinks] = useState(
    initial.links_external
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
      | 'auto_change_notes'
      | 'change_category_in_note'
      | 'links_collections'
      | 'links_opml'
      | 'links_blygger_org'
      | 'links_blygger_com'
      | 'hopper_feeds',
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
    <div className="settings-layout">
    <SettingsNav />
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
          const links_external = parseLinks(externalLinks);
          await settings.update('settings', (row) => {
            Object.assign(row, form, { author_links, links_external });
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
      <section className="settings-section" id="general" aria-labelledby="general-h">
      <h2 className="section-title" id="general-h">General</h2>
      <p className="view-sub settings-intro">
        <Link to="/setup" id="run-setup">Walk through setup again</Link>, one
        step at a time, with each setting's default beside it. Tokens and
        connected apps are on the <Link to="/access">Access</Link> page.
      </p>
      <section className="card">
        <h3 className="card-h">profile</h3>
        {field('site_title', 'Site title')}
        {field('author_name', 'Author name')}
        {field('author_url', 'Author URL', false, 'blank = this blyg\'s own address')}
        {field('author_bio', 'Bio', true)}
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
      </section>
      <section className="settings-section" id="feed" aria-labelledby="feed-h">
      <h2 className="section-title" id="feed-h">Feed</h2>
      <section className="card">
        <h3 className="card-h">home page</h3>
        <div className="field" role="radiogroup" aria-labelledby="feed_order-label">
          <span id="feed_order-label">Order of your public home page</span>
          {(initial.feed_orders ?? FEED_ALGORITHMS).map((algorithm) => (
            <label className="check" key={algorithm.id}>
              <input
                type="radio"
                name="feed_order"
                value={algorithm.id}
                checked={form.feed_order === algorithm.id}
                onChange={() => change('feed_order', algorithm.id)}
              />
              <span>
                {algorithm.title}
                {algorithm.id === DEFAULT_FEED_ORDER ? ' (recommended)' : ''}{' '}
                <span className="hint">{algorithm.description}</span>
              </span>
            </label>
          ))}
          <span className="hint">
            Feeds and the archive stay newest first whichever you choose. An
            extension that adds an order shows it here once it is enabled and
            saved.
          </span>
        </div>
        <FrontPageFields form={form} change={change} />
      </section>
      </section>
      <section className="settings-section" id="appearance" aria-labelledby="appearance-h">
      <h2 className="section-title" id="appearance-h">Appearance</h2>
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
            <label className="theme-opt" key={CUSTOM_THEME_ID}>
              <input
                type="radio"
                name="theme"
                value={CUSTOM_THEME_ID}
                checked={form.theme === CUSTOM_THEME_ID}
                onChange={() => {
                  // First time: start from whichever preset was showing.
                  if (!form.custom_theme)
                    change(
                      'custom_theme',
                      customFromPreset(Object.prototype.hasOwnProperty.call(THEMES, form.theme) ? form.theme : 'paper'),
                    );
                  change('theme', CUSTOM_THEME_ID);
                }}
              />
              <span
                className={`theme-swatch${form.custom_theme ? '' : ' theme-swatch-empty'}`}
                style={{
                  background:
                    form.custom_theme && form.custom_theme_dark
                      ? `linear-gradient(90deg,${form.custom_theme.page} 50%,${form.custom_theme_dark.page} 50%)`
                      : form.custom_theme?.page,
                }}
              >
                {form.custom_theme ? (
                  <span
                    className="sheet-mini"
                    style={{
                      background: form.custom_theme_dark
                        ? `linear-gradient(90deg,${form.custom_theme.paper} 50%,${form.custom_theme_dark.paper} 50%)`
                        : form.custom_theme.paper,
                    }}
                  >
                    <span
                      className="line"
                      style={{
                        background: form.custom_theme_dark
                          ? `linear-gradient(90deg,${form.custom_theme.ink} 50%,${form.custom_theme_dark.ink} 50%)`
                          : form.custom_theme.ink,
                      }}
                    />
                    <span
                      className="line short"
                      style={{ background: form.custom_theme.pencil }}
                    />
                  </span>
                ) : (
                  <span className="theme-plus" aria-hidden="true">
                    +
                  </span>
                )}
              </span>
              <span className="theme-name">
                {form.custom_theme_name || 'Custom'}
              </span>
            </label>
          </div>
        </div>
        {form.theme === CUSTOM_THEME_ID && form.custom_theme ? (
          <CustomThemeFields
            name={form.custom_theme_name}
            light={form.custom_theme}
            dark={form.custom_theme_dark}
            font={FONTS[form.font]?.stack}
            onName={(name) => change('custom_theme_name', name)}
            onChange={(light, dark) => {
              change('custom_theme', light);
              change('custom_theme_dark', dark);
            }}
          />
        ) : null}
        <div className="field">
          <span>
            Typeface — fonts already on the reader's device, so nothing is
            downloaded and no one else sees your readers. It will look a little
            different from one device to the next.
          </span>
          <div className="font-grid" role="radiogroup" aria-label="Typeface">
            {Object.entries(FONTS).map(([id, f]) => (
              <label className="font-opt" key={id}>
                <input
                  type="radio"
                  name="font"
                  value={id}
                  checked={form.font === id}
                  onChange={() => change('font', id)}
                />
                <span className="font-sample" style={{ fontFamily: f.stack }}>
                  <span className="font-sample-text">
                    The quick brown fox
                  </span>
                  <span className="font-name">{f.label}</span>
                </span>
              </label>
            ))}
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
      </section>
      <section className="settings-section" id="links" aria-labelledby="links-h">
      <h2 className="section-title" id="links-h">Links</h2>
      <section className="card" id="masthead-menu">
        <h3 className="card-h">masthead menu</h3>
        <p className="hint">Links under your name at the top of every public page, such as your newsletter or other sites. They are also your <code>author.links</code> in <code>blyg.json</code>.</p>
        <div className="field">
          <label htmlFor="author_links">
            <span>One per line: label | url</span>
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
      </section>
      <section className="card" id="links-section">
        <h3 className="card-h">main menu</h3>
        <p className="hint">
          A short list on every public page: threads you choose, your public
          collections, your own links, and a line of standard links.
        </p>
        <div className="field" role="radiogroup" aria-labelledby="links_position-label">
          <span id="links_position-label">Where it sits</span>
          {(
            [
              ['left', 'On the left (default)'],
              ['right', 'On the right'],
              ['bottom', 'Below the content'],
            ] as const
          ).map(([value, label]) => (
            <label className="check" key={value}>
              <input
                type="radio"
                name="links_position"
                value={value}
                checked={form.links_position === value}
                onChange={() => change('links_position', value)}
              />
              <span>{label}</span>
            </label>
          ))}
          <span className="hint">
            A side column shows on wide screens; on a phone it folds behind a
            Menu button under your name.
          </span>
        </div>
        <LinkedThreads
          ids={form.links_threads}
          onChange={(ids) => change('links_threads', ids)}
        />
        <div className="field">
          <label htmlFor="links_external">
            <span>Your links, one per line: label | url</span>
          </label>
          <textarea
            id="links_external"
            rows={3}
            value={externalLinks}
            placeholder="Résumé | https://example.com/resume.pdf"
            onChange={(event) => {
              setSaved(false);
              setExternalLinks(event.target.value);
            }}
          />
        </div>
        {toggle('links_collections', 'Your public collections')}
        {toggle('links_opml', 'Your blogroll as an OPML file, when it lists anyone')}
        {toggle('links_blygger_org', 'Made with Blygger (blygger.org)')}
        {toggle('links_blygger_com', 'Find more blygs (blygger.com)')}
      </section>
      </section>
      <section className="settings-section" id="ai" aria-labelledby="ai-h">
      <h2 className="section-title" id="ai-h">AI</h2>
      <p className="hint section-intro">AI bindings: which model each function uses, and what it is told. A function with no model never calls one.</p>
      <ModelIntro manifest={aiModels} />
      <section className="card" id="ai-tk">
        <h3 className="card-h">TK generation</h3>
        <ModelField fkey="ai_model_tk" label="Model" name="TK generation" manifest={aiModels} form={form} change={change} />
        {field(
          'ai_style_prompt',
          'House style (optional): added to every [TK] generation request',
          true,
        )}
      </section>
      <section className="card" id="ai-changelog">
        <h3 className="card-h">change notes</h3>
        <ModelField fkey="ai_model_changelog" label="Model" name="change notes" manifest={aiModels} form={form} change={change} />
        {toggle(
          'auto_change_notes',
          'Draft a note when I publish a new version without one',
          <>
            When a new version is published with no note, the changelog model
            drafts one from the change. You see it and can edit it before
            anything is published. A note published exactly as drafted is
            marked as generated in the changelog.
          </>,
        )}
      </section>
      <section className="card" id="ai-classify">
        <h3 className="card-h">change classifier</h3>
        <p className="hint">
          Off unless you choose a model. A decision model (Clef on Workers AI,
          or TypeSafe&apos;s Jev) labels each new version <em>typo</em>,{' '}
          <em>minor</em> or <em>major</em> before you publish it; a republish of
          the same words is <em>refresh</em> with no model call. You see the
          label and can change or clear it. It is kept privately with the
          version and is never sent as data: readers see it only as the words
          of your change note.
        </p>
        <ModelField
          fkey="ai_model_classify"
          label="Model"
          name="change classifier"
          decision
          manifest={aiModels}
          form={form}
          change={change}
        />
        {form.ai_model_classify
          ? toggle(
              'change_category_in_note',
              'Start the change note with the label',
              <>
                An empty note becomes the label (<code>minor</code>); a note
                becomes <code>minor: your note</code>, unless it already starts
                with a label. The publish dialog shows the note as it will
                publish.
              </>,
            )
          : null}
      </section>
      <section className="card" id="ai-feed">
        <h3 className="card-h">smart feed</h3>
        <ModelField fkey="ai_model_feed" label="Model" name="feed scoring" hint="not used yet" manifest={aiModels} form={form} change={change} />
        {field(
          'feed_prompt',
          'Scoring prompt: how the agent should score new items',
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
      <section className="card" id="ai-authoring">
        <h3 className="card-h">authoring</h3>
        <div className="field model-field">
          <label htmlFor="ai_model_authoring">
            <span>
              Model<span className="hint"> · coming later</span>
            </span>
          </label>
          <select id="ai_model_authoring" disabled value="">
            <option value="">reserved for agentic authoring</option>
          </select>
        </div>
      </section>
      </section>
      <section className="settings-section" id="network" aria-labelledby="network-h">
      <h2 className="section-title" id="network-h">Network</h2>
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
      <section className="card" id="network-hopper-feeds">
        <h3 className="card-h">collection feeds <span className="hint">· experimental, pending a protocol ruling</span></h3>
        {toggle(
          'hopper_feeds',
          'Give each public collection its own RSS feed',
          <>
            Each public collection gets a feed at <code>h/&lt;slug&gt;/feed.xml</code>,
            linked from its page, and blyg.json lists your public collections.
            Entries are curation, not reposts: an excerpt, who wrote it, and a
            link to where it lives. Off by default while the protocol decides
            the shape, which may still change.
          </>,
        )}
      </section>
      </section>
      {compiledExtensions.length ? (
        <section className="settings-section" id="extensions" aria-labelledby="extensions-h">
          <h2 className="section-title" id="extensions-h">Extensions</h2>
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
    </div>
  );
}

/** The page's sections, in order; the sidebar and its scroll tracking read this. */
const SECTIONS = [
  ['general', 'General'],
  ['feed', 'Feed'],
  ['appearance', 'Appearance'],
  ['links', 'Links'],
  ['ai', 'AI'],
  ['network', 'Network'],
  ...(compiledExtensions.length ? [['extensions', 'Extensions'] as const] : []),
] as const;

/**
 * One page, a sidebar of anchors (session 47): the section in view is marked
 * current, and a link like settings#ai lands on its section. On a phone the
 * sidebar is a row of chips under the top bar.
 */
function SettingsNav() {
  const [current, setCurrent] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    const go = location.hash.slice(1);
    if (SECTIONS.some(([id]) => id === go)) document.getElementById(go)?.scrollIntoView();
    // The topmost section crossing the upper part of the screen is the current one.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    // On a phone the chips scroll sideways; keep the current one in view.
    const chip = nav.current?.querySelector<HTMLElement>('[aria-current="true"]');
    const row = nav.current;
    if (chip && row && row.scrollWidth > row.clientWidth)
      row.scrollTo({ left: chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2, behavior: 'smooth' });
  }, [current]);
  return (
    <nav className="settings-nav" aria-label="settings sections" ref={nav}>
      <ul>
        {SECTIONS.map(([id, label]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              aria-current={current === id ? 'true' : undefined}
              onClick={(event) => {
                // Scroll here rather than let the router see a navigation.
                event.preventDefault();
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
                history.replaceState(history.state, '', `#${id}`);
                setCurrent(id);
              }}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
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

/** The model manifest, once per page: providers with their key status, and listed models. */
function useAiModels(): AiModels | undefined {
  const [manifest, setManifest] = useState<AiModels>();
  useEffect(() => {
    let live = true;
    unwrap(BlyggerApi.getAiModels({ client }))
      .then((m) => live && setManifest(m))
      .catch(() => live && setManifest({ providers: [], models: [], local: false }));
    return () => {
      live = false;
    };
  }, []);
  return manifest;
}

/** Where the model list comes from, and which provider keys this install has. */
function ModelIntro({ manifest }: { manifest?: AiModels }) {
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
    </>
  );
}

type ModelKey = (typeof FUNCTIONS)[number]['key'] | 'ai_model_classify';

/**
 * One AI function's model, chosen from the manifest or typed in (0.26.0).
 * `decision` lists decision models only (the change classifier); without it,
 * decision models are left out, since they write no text.
 */
function ModelField({
  fkey,
  label,
  name = label,
  hint,
  decision = false,
  manifest,
  form,
  change,
}: {
  fkey: ModelKey;
  label: string;
  /** The function, for the typed-id box's label when `label` is just "Model". */
  name?: string;
  hint?: string;
  decision?: boolean;
  manifest?: AiModels;
  form: Settings;
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const [other, setOther] = useState(false);
  const value = form[fkey];
  const models = (manifest?.models ?? []).filter((m) => (m.kind === 'decision') === decision);
  const providers = (manifest?.providers ?? []).filter((p) => models.some((m) => m.provider === p.id));
  const listed = models.some((m) => m.id === value);
  const isOther = other || (!!value && !!manifest && !listed);
  return (
    <div className="field model-field">
      <label htmlFor={fkey}>
        <span>
          {label}
          {hint ? <span className="hint"> · {hint}</span> : null}
        </span>
      </label>
      <select
        id={fkey}
        value={isOther ? OTHER : value}
        onChange={(event) => {
          const next = event.target.value;
          setOther(next === OTHER);
          if (next !== OTHER) change(fkey, next);
        }}
      >
        <option value="">— none —</option>
        {providers.map((p) => (
          <optgroup key={p.id} label={p.configured ? p.label : `${p.label} (${providerStatus(p)})`}>
            {models
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
          aria-label={`${name} model id`}
          placeholder={decision ? 'model id, e.g. jev-1.14.0' : 'model id, e.g. claude-sonnet-5-5'}
          value={value}
          onChange={(event) => change(fkey, event.target.value)}
        />
      ) : null}
    </div>
  );
}

/**
 * Every AI function's model in one block, for the setup walk-through. The
 * settings page instead puts each model beside its own function's settings.
 * The fourth row, authoring, is reserved and disabled: it signals where the
 * studio is going without pretending to do it.
 */
export function ModelSettings({
  form,
  change,
}: {
  form: Settings;
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const manifest = useAiModels();
  return (
    <>
      <ModelIntro manifest={manifest} />
      {FUNCTIONS.map((f) => (
        <ModelField
          key={f.key}
          fkey={f.key}
          label={f.label}
          hint={'hint' in f ? f.hint : undefined}
          manifest={manifest}
          form={form}
          change={change}
        />
      ))}
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

/**
 * The custom theme's fields: one palette, or a light palette with a dark
 * companion so the theme follows the reader's light/dark preference the way
 * Auto does. Most people's devices switch on their own now; a custom theme
 * that ignored that would be a step back from Auto.
 */
function CustomThemeFields({
  name,
  light,
  dark,
  font,
  onName,
  onChange,
}: {
  name: string;
  light: CustomTheme;
  dark: CustomTheme | null;
  font?: string;
  onName: (name: string) => void;
  onChange: (light: CustomTheme, dark: CustomTheme | null) => void;
}) {
  const [editing, setEditing] = useState<'light' | 'dark'>('light');
  const paired = dark !== null;
  const showing = paired && editing === 'dark' ? 'dark' : 'light';
  return (
    <div className="custom-theme">
      <div className="field">
        <label htmlFor="theme-name">
          <span>Name this look (optional)</span>
        </label>
        <input
          id="theme-name"
          type="text"
          maxLength={THEME_NAME_MAX}
          value={name}
          placeholder="e.g. Pink Quill"
          onChange={(event) => onName(event.target.value)}
        />
        <p className="hint">
          Shown on the tile, and carried with the look when you share it.
        </p>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={paired}
          onChange={(event) => {
            if (event.target.checked) {
              // A pair is a light palette plus a dark one. If the palette so
              // far is dark, it becomes the dark half and a light one is
              // seeded; otherwise a dark one is seeded from Nord.
              if (light.dark) onChange(customFromPreset('paper'), light);
              else onChange(light, customFromPreset('nord'));
              setEditing('dark');
            } else {
              onChange(light, null);
              setEditing('light');
            }
          }}
        />
        <span>Follow the reader's light/dark setting</span>
      </label>
      <p className="hint check-hint">
        Adds a dark version. Readers whose device is in dark mode get it;
        everyone else gets the light one.
      </p>
      {paired ? (
        <div className="segmented" aria-label="Palette">
          {(['light', 'dark'] as const).map((which) => (
            <button
              key={which}
              type="button"
              aria-pressed={showing === which}
              className={`seg${showing === which ? ' is-active' : ''}`}
              onClick={() => setEditing(which)}
            >
              {which === 'light' ? 'Light palette' : 'Dark palette'}
            </button>
          ))}
        </div>
      ) : null}
      {showing === 'dark' && dark ? (
        <ThemeEditor
          key="dark"
          value={dark}
          font={font}
          lockDark
          onChange={(next) => onChange(light, { ...next, dark: true })}
        />
      ) : (
        <ThemeEditor
          key="light"
          value={light}
          font={font}
          lockDark={paired}
          onChange={(next) =>
            onChange(paired ? { ...next, dark: false } : next, dark)
          }
        />
      )}
      <ThemeShare
        name={name}
        light={light}
        dark={dark}
        onImport={(look) => {
          onChange(look.light, look.dark);
          if (look.name) onName(look.name);
          setEditing('light');
        }}
      />
    </div>
  );
}

/**
 * The static front page (session 47): a published thread at the public root,
 * the latest items moved to {mount}/{posts_path}/. The server refuses anything
 * but a published thread and a free single-segment address.
 */
function FrontPageFields({
  form,
  change,
}: {
  form: Settings;
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const rows =
    useLiveQuery({ query: (q) => q.from({ item: items }) }).data ?? [];
  const threads = rows.filter(
    (row) => row.status === 'public' && row.kind === 'thread',
  );
  const missing =
    form.front_page && !threads.some((row) => row.id === form.front_page);
  return (
    <>
      <div className="field">
        <span id="front_page-label">Front page</span>
        <p className="front-page-choice" id="front_page" aria-labelledby="front_page-label">
          <strong>
            {!form.front_page
              ? 'Your latest items'
              : missing
                ? 'A thread that is no longer published'
                : itemTitle(threads.find((row) => row.id === form.front_page)!.content_md) || form.front_page}
          </strong>
          {form.front_page ? (
            <>
              {' '}
              <Button className="btn btn-ghost btn-mini" onClick={() => change('front_page', '')}>
                use latest items
              </Button>
            </>
          ) : null}
        </p>
        <ThreadSearch
          id="front_page_search"
          label="find a thread for the front page"
          placeholder="Find a thread to use as the front page…"
          threads={threads.filter((row) => row.id !== form.front_page)}
          onPick={(id) => change('front_page', id)}
        />
        <span className="hint">
          Choose a published thread to greet readers at {mount || ''}/ instead
          of your latest items, as a static front page. You edit it like any
          thread, and it stays in your feed and archive.
          {missing
            ? ' This one has been withdrawn, so readers see your latest items until you choose another.'
            : ''}
        </span>
      </div>
      <div className="field">
        <label htmlFor="posts_path">
          <span>Address of your latest items</span>
        </label>
        <input
          id="posts_path"
          value={form.posts_path}
          onChange={(event) =>
            change('posts_path', event.target.value.trim().toLowerCase())
          }
        />
        <span className="hint">
          Your latest items are always at {mount || ''}/{form.posts_path || 'posts'}/,
          and with a front page every public page links there. Lowercase
          letters, digits and hyphens.
        </span>
      </div>
    </>
  );
}

/** Choose published threads for the links section, in order. */
function LinkedThreads({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const rows =
    useLiveQuery({ query: (q) => q.from({ item: items }) }).data ?? [];
  const threads = rows.filter(
    (row) => row.status === 'public' && row.kind === 'thread',
  );
  const title = (id: string) => {
    const row = threads.find((t) => t.id === id);
    return row ? itemTitle(row.content_md) || id : 'a thread that is no longer published';
  };
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
  };
  const available = threads.filter((row) => !ids.includes(row.id));
  return (
    <div className="field">
      <span>Threads to list</span>
      {ids.length ? (
        <ol className="linked-threads">
          {ids.map((id, i) => (
            <li key={id}>
              <span>{title(id)}</span>{' '}
              <Button
                className="btn btn-ghost btn-mini"
                aria-label="move up"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </Button>
              <Button
                className="btn btn-ghost btn-mini"
                aria-label="move down"
                disabled={i === ids.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </Button>
              <Button
                className="btn btn-ghost btn-mini"
                aria-label="remove"
                onClick={() => onChange(ids.filter((other) => other !== id))}
              >
                ✕
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {available.length ? (
        <ThreadSearch
          id="links_threads_search"
          label="find a thread to add"
          placeholder="Find a thread to add…"
          threads={available}
          onPick={(id) => onChange([...ids, id])}
        />
      ) : (
        <span className="hint">
          {ids.length ? '' : 'Publish a thread to list it here.'}
        </span>
      )}
    </div>
  );
}

type ThreadRow = { id: string; content_md: string; updated: string };

/**
 * Find a published thread by title or id (session 47): up to eight matches,
 * newest first, since a long blyg has too many threads for a dropdown. Enter
 * picks the first match and never submits the settings form.
 */
function ThreadSearch({
  id,
  label,
  placeholder,
  threads,
  onPick,
}: {
  id: string;
  label: string;
  placeholder: string;
  threads: ThreadRow[];
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? threads
        .filter((row) => (itemTitle(row.content_md) + ' ' + row.id).toLowerCase().includes(needle))
        .sort((a, b) => (a.updated < b.updated ? 1 : -1))
        .slice(0, 8)
    : [];
  const pick = (picked: string) => {
    onPick(picked);
    setQuery('');
  };
  return (
    <div className="thread-search">
      <input
        id={id}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (matches[0]) pick(matches[0].id);
        }}
      />
      {needle ? (
        matches.length ? (
          <ul className="thread-matches" aria-label={`matching threads: ${label}`}>
            {matches.map((row) => (
              <li key={row.id}>
                <button type="button" className="link" onClick={() => pick(row.id)}>
                  {itemTitle(row.content_md) || row.id}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="hint">No published thread matches.</span>
        )
      ) : null}
    </div>
  );
}
