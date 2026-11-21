/*
 * Settings → writing → dictionary: the words this blyg's spellchecking accepts
 * (src/dictionary.ts). The author's own words can be added and removed here; a set
 * an extension or client installed shows its size and can be looked at or removed.
 * Saved at once, apart from the settings form, through GET/PUT /dictionary.
 */
import { useEffect, useState } from 'react';
import type { Dictionary } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { client } from './data.ts';
import { confirm, toast } from './sheets.tsx';
import './dictionary.css';

const OWNER = 'owner';
const wordsOf = (dictionary: Dictionary, source: string) => dictionary.sources.find((s) => s.source === source)?.words ?? [];

export function DictionaryCard() {
  const [dictionary, setDictionary] = useState<Dictionary | null>(null);
  const [failed, setFailed] = useState<string>();
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const reload = async () => {
    const next = (await unwrap(BlyggerApi.getDictionary({ client }))) as Dictionary;
    setDictionary(next);
    return next;
  };
  useEffect(() => {
    reload().catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);

  /** Replace a source with what `next` makes of its current words; on a revision conflict, once more on fresh data. */
  const save = async (source: string, next: (words: string[]) => string[]) => {
    setBusy(true);
    try {
      let current = dictionary ?? (await reload());
      for (let attempt = 0; ; attempt++) {
        try {
          setDictionary((await unwrap(BlyggerApi.putDictionarySource({ client, path: { source }, body: { words: next(wordsOf(current, source)), expectedRevision: current.revision } }))) as Dictionary);
          return true;
        } catch (e) {
          if (attempt === 0 && (e as { statusCode?: number }).statusCode === 409) {
            current = await reload();
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const words = word.trim().split(/[\s,]+/).filter(Boolean);
    if (!words.length) return;
    if (await save(OWNER, (now) => [...now, ...words])) setWord('');
  };

  if (failed) return <p className="hint">The dictionary didn't load: {failed}</p>;
  if (!dictionary) return <p className="hint">Loading…</p>;
  const own = wordsOf(dictionary, OWNER);
  const sets = dictionary.sources.filter((s) => s.source !== OWNER);
  return (
    <div className="dictionary" id="dictionary">
      <p className="hint">
        Words spellchecking accepts on every device: yours, and any set an extension installed. Your browser's own spellcheck doesn't read it.
      </p>
      <div className="dictionary-add">
        <input
          aria-label="add words to the dictionary"
          placeholder="add a word (or several)"
          value={word}
          disabled={busy}
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button type="button" className="act" disabled={busy || !word.trim()} onClick={() => void add()}>
          add
        </button>
      </div>
      {own.length ? (
        <ul className="dictionary-words" aria-label="your words">
          {own.map((w) => (
            <li key={w} data-word={w}>
              {w}
              <button type="button" className="link-btn" aria-label={`remove ${w}`} disabled={busy} onClick={() => void save(OWNER, (now) => now.filter((x) => x !== w))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">You haven't added any words yet.</p>
      )}
      {sets.length ? (
        <ul className="dictionary-sets" aria-label="installed sets">
          {sets.map((s) => (
            <li key={s.source} data-source={s.source}>
              <span>
                <strong>{s.source}</strong> <span className="hint">{s.words.length.toLocaleString()} words</span>
              </span>
              <button type="button" className="link-btn" onClick={() => setOpen(open === s.source ? null : s.source)}>
                {open === s.source ? 'hide' : 'show'}
              </button>
              <button
                type="button"
                className="link-btn"
                disabled={busy}
                onClick={async () => {
                  if (await confirm({ title: `Remove the ${s.source} words?`, body: `${s.words.length.toLocaleString()} words leave the dictionary. Whatever installed them may add them again.`, ok: 'remove' }))
                    await save(s.source, () => []);
                }}
              >
                remove
              </button>
              {open === s.source ? <p className="dictionary-list">{s.words.join(', ')}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
