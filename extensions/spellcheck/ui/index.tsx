// Spellcheck (docs/extensions.md): a "spelling" button in an editor bar opens a sheet with two
// checks. The dictionary check runs in the browser against a US English word list the server
// sends the first time (spell.ts); the AI proofread sends the saved draft to the blyg's TK model
// (server.ts). Words the list lacks come from the blyg's dictionary (GET /dictionary), every
// source; "add to dictionary" adds to the author's own ("owner"). Fixes go into the text box
// through the editor bar's own edit path.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { BlyggerApi, Sheet, toast, unwrap } from '../../../src/ui/extension-api.ts';
import type { EditorBarContext, StudioExtension } from '../../../src/ui/extension-api.ts';
import { misspellings, speller, unpack, type Misspelling, type Speller } from './spell.ts';
import './spellcheck.css';

const NAME = 'spellcheck';
const OWNER = 'owner';
type Dictionary = { sources: { source: string; words: string[] }[]; revision: number };

/** Adds a word to the author's own words in the blyg's dictionary; once more on a revision conflict. */
async function addToDictionary(context: EditorBarContext, word: string) {
  for (let attempt = 0; ; attempt++) {
    const dictionary = (await unwrap(BlyggerApi.getDictionary({ client: context.client }))) as Dictionary;
    const own = dictionary.sources.find((s) => s.source === OWNER)?.words ?? [];
    try {
      await unwrap(BlyggerApi.putDictionarySource({ client: context.client, path: { source: OWNER }, body: { words: [...own, word], expectedRevision: dictionary.revision } }));
      return;
    } catch (e) {
      if (attempt > 0 || (e as { statusCode?: number }).statusCode !== 409) throw e;
    }
  }
}

// One word list a page, with the blyg's dictionary, fetched the first time a check runs.
let loading: Promise<Speller> | null = null;
function load(context: EditorBarContext) {
  loading ??= Promise.all([unwrap(BlyggerApi.extSpellcheckGetWords({ client: context.client })), unwrap(BlyggerApi.getDictionary({ client: context.client }))]).then(
    async ([list, dictionary]) => speller(await unpack((list as { gz: string }).gz), (dictionary as Dictionary).sources.flatMap((s) => s.words)),
  );
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
/** Words ignored until the page reloads. */
const ignored = new Set<string>();

type Issue = { find: string; replace: string; why: string };
type Proofread = { issues: Issue[]; model: string; truncated: boolean };

function SpellSheet({ live, close, focus, onChange }: { live: RefObject<EditorBarContext>; close: () => void; focus?: string; onChange: () => void }) {
  const context = live.current!;
  const [check, setCheck] = useState<Speller | null>(null);
  const [failed, setFailed] = useState<string>();
  const [, refresh] = useState(0);
  const [proof, setProof] = useState<Proofread | null>(null);
  const [proofing, setProofing] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    load(context).then(setCheck, (e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);
  const found = check ? misspellings(context.shown, check, ignored) : [];
  const groups = new Map<string, Misspelling[]>();
  // The word clicked in the text comes first.
  if (focus) for (const m of found) if (m.word === focus) groups.set(m.word, [...(groups.get(m.word) ?? []), m]);
  for (const m of found) if (m.word !== focus) groups.set(m.word, [...(groups.get(m.word) ?? []), m]);
  const changed = () => {
    refresh((n) => n + 1);
    onChange();
  };

  // Last first, so the offsets of the others still hold.
  const replaceAll = (word: string, by: string) => {
    for (const m of [...(groups.get(word) ?? [])].reverse()) live.current!.replace(m.start, m.end, by);
    changed();
  };
  const show = (m: Misspelling) => {
    close();
    requestAnimationFrame(() => live.current!.select(m.start, m.end));
  };
  const proofread = () => {
    const id = context.item?.id;
    if (!id) return;
    setProofing(true);
    void context
      .run(async () => setProof((await unwrap(BlyggerApi.extSpellcheckProofread({ client: context.client, query: { id } }))) as Proofread))
      .finally(() => setProofing(false));
  };
  const apply = (issue: Issue) => {
    const shown = live.current!.shown;
    const at = shown.indexOf(issue.find);
    if (at < 0) {
      toast('That text is no longer in the draft');
      return false;
    }
    live.current!.replace(at, at + issue.find.length, issue.replace);
    setDone((now) => new Set(now).add(issue.find));
    return true;
  };

  return (
    <Sheet open onClose={close} title="spelling" description="Checked against a US English word list, skipping markup, links, code and TK instructions.">
      <div className="spellcheck-sheet" data-extension={NAME}>
        {failed ? <p className="spellcheck-error">The word list didn't load: {failed}</p> : !check ? <p className="hint">Loading the word list…</p> : !groups.size ? (
          <p data-spellcheck-clean>No spelling mistakes found.</p>
        ) : (
          <ul className="spellcheck-list">
            {[...groups].map(([word, at]) => (
              <li key={word} data-word={word} data-focused={word === focus || undefined}>
                <button type="button" className="spellcheck-word link-btn" title="Show it in the text" onClick={() => show(at[0])}>
                  {word}
                </button>
                {at.length > 1 ? <span className="hint"> ×{at.length}</span> : null}
                <span className="spellcheck-suggestions">
                  {check.suggest(word).map((s) => (
                    <button key={s} type="button" className="act" data-suggestion={s} onClick={() => replaceAll(word, s)}>
                      {s}
                    </button>
                  ))}
                </span>
                <span className="spellcheck-actions">
                  <button type="button" className="link-btn" onClick={() => { ignored.add(word); changed(); }}>ignore</button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void context.run(async () => { await addToDictionary(context, word); check.add(word); changed(); })}
                  >
                    add to dictionary
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <h3>AI proofread</h3>
        {!context.item ? (
          <p className="hint">In the full editor: it reads the saved draft.</p>
        ) : (
          <>
            <p className="hint">Typos, wrong or doubled words and plain grammar, from the blyg's TK model. It reads the saved draft and uses the AI budget.</p>
            <button type="button" className="act" data-action="spellcheck-proofread" disabled={proofing} onClick={proofread}>
              {proofing ? 'Proofreading…' : proof ? 'Proofread again' : 'Proofread with AI'}
            </button>
            {proof ? (
              proof.issues.length ? (
                <>
                  <ul className="spellcheck-list">
                    {proof.issues.map((issue) => (
                      <li key={issue.find} data-issue={issue.find} data-applied={done.has(issue.find) || undefined}>
                        <span className="spellcheck-find">{issue.find}</span> → <span className="spellcheck-replace">{issue.replace}</span>
                        {issue.why ? <span className="hint"> · {issue.why}</span> : null}
                        {done.has(issue.find) ? <span className="hint"> · fixed</span> : (
                          <button type="button" className="act" onClick={() => apply(issue)}>fix</button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="link-btn" onClick={() => { for (const issue of proof.issues) if (!done.has(issue.find)) apply(issue); }}>fix all</button>
                </>
              ) : (
                <p data-spellcheck-proof-clean>Nothing to fix{proof.truncated ? ' in the part it read' : ''}.</p>
              )
            ) : null}
            {proof?.truncated ? <p className="hint">The draft is long: only its start was read.</p> : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

function SpellBar({ context }: { context: EditorBarContext }) {
  const live = useRef(context);
  live.current = context;
  // This bar replaces the browser's spellcheck when it won the claim: it underlines as the author types.
  const owns = context.bar.owns.includes('spellcheck');
  const [check, setCheck] = useState<Speller | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((n) => n + 1);
  const open = (focus?: string) => context.openSheet((close) => <SpellSheet live={live} close={close} focus={focus} onChange={changed} />);
  useEffect(() => {
    if (owns) load(context).then(setCheck, (e) => context.showError(e));
  }, [owns]);
  useEffect(() => {
    if (!owns || !check) return;
    // Once typing pauses; the Studio moves the marks with each edit meanwhile.
    const timer = setTimeout(() => {
      const found = misspellings(live.current.shown, check, ignored);
      setCount(found.length);
      live.current.mark(
        found.map((m) => ({ start: m.start, end: m.end, kind: 'spelling' as const, title: 'not in the dictionary' })),
        (mark) => open(live.current.shown.slice(mark.start, mark.end)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [owns, check, context.shown, version]);
  return (
    <button type="button" className="act spellcheck-open" data-action="spellcheck" onClick={() => open()}>
      spelling{count ? ` · ${count}` : ''}
    </button>
  );
}

export const extension: StudioExtension = {
  name: NAME,
  label: 'Spellcheck',
  description: 'Spellcheck in the editor, in place of the browser’s: misspellings underlined as you type, a US English check with suggestions using the blyg’s dictionary, and an AI proofread of the draft.',
  // Replaces the browser's spellcheck (docs/extensions.md, "Replaceable controls"): it underlines
  // misspellings as the author types, and the browser's own is back when the bar is off screen.
  editorBar: { label: 'Spelling', row: 'above', blocks: 1, replaces: ['spellcheck'], component: SpellBar },
};
