/*
 * Copies elsewhere: the owner's `syndication` list for one published item
 * (spec 0.4 §16.14, decision #98; src/syndication.ts). Each entry is the URL
 * of a copy the owner made on another network and the version it was made
 * from. Saving rewrites the live item document in place: no version, no
 * changelog entry, no feed entry. The list goes through the editor's write
 * queue, so the item's revision stays in step with autosave.
 */
import { useEffect, useState } from 'react';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { Button, Failure } from './components.tsx';
import { client } from './data.ts';
import { customSheet, Sheet, toast } from './sheets.tsx';

export type SyndicationEntry = { url: string; version: number };

/** An absolute https: URL (rule 1); anything else is refused before it is sent. */
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function SyndicationEditor({ itemId, version, save, done }: {
  itemId: string;
  version: number;
  save: (entries: SyndicationEntry[]) => Promise<unknown>;
  done: () => void;
}) {
  const [entries, setEntries] = useState<SyndicationEntry[]>();
  const [url, setUrl] = useState('');
  const [copyOf, setCopyOf] = useState(version);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    unwrap(BlyggerApi.getSyndication({ client, path: { id: itemId } }))
      .then((list) => setEntries(list.entries))
      .catch((e) => {
        setEntries([]);
        setError(e);
      });
  }, [itemId]);
  const write = async (next: SyndicationEntry[], message: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await save(next);
      setEntries(next);
      toast(message, { tone: 'ok' });
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const valid = isHttpsUrl(url);
  const duplicate = !!entries?.some((entry) => entry.url === url.trim());
  const add = async () => {
    if (!entries || !valid || duplicate) return;
    if (await write([...entries, { url: url.trim(), version: copyOf }], 'Copy added')) setUrl('');
  };
  return (
    <form
      className="syndication-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      {entries === undefined ? (
        <p className="muted">loading…</p>
      ) : entries.length ? (
        <ul className="list syndication-list">
          {entries.map((entry) => (
            <li key={entry.url} className="syndication-row" data-syndication-url={entry.url}>
              <a href={entry.url} target="_blank" rel="noreferrer">{host(entry.url)}</a>
              <span className="muted"> · copy of v{entry.version}</span>
              <Button className="btn btn-ghost btn-mini" type="button" aria-label={`remove ${host(entry.url)}`} title="remove" disabled={busy}
                onClick={() => void write(entries.filter((other) => other.url !== entry.url), 'Copy removed')}>✕</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No copies listed yet.</p>
      )}
      <label className="field">
        <span>URL of the copy</span>
        <input
          type="url"
          name="syndication-url"
          inputMode="url"
          placeholder="https://bsky.app/profile/…/post/…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      {version > 1 ? (
        <label className="field">
          <span>made from</span>
          <select name="syndication-version" value={copyOf} onChange={(event) => setCopyOf(Number(event.target.value))}>
            {Array.from({ length: version }, (_, i) => version - i).map((v) => (
              <option key={v} value={v}>v{v}{v === version ? ' (latest)' : ''}</option>
            ))}
          </select>
        </label>
      ) : null}
      {url && !valid ? <p className="muted">Use the copy's full https:// address.</p> : null}
      {duplicate ? <p className="muted">That copy is already listed.</p> : null}
      {error ? <Failure error={error} /> : null}
      <div className="sheet-actions">
        <Button className="btn btn-primary" type="submit" disabled={busy || !entries || !valid || duplicate}>
          add copy
        </Button>
        <Button className="btn btn-ghost" type="button" onClick={done}>
          done
        </Button>
      </div>
    </form>
  );
}

/** The editor's ⋯ → "copies elsewhere…". */
export function editSyndication(itemId: string, version: number, save: (entries: SyndicationEntry[]) => Promise<unknown>) {
  return customSheet((done) => (
    <Sheet
      open
      onClose={done}
      title="Copies elsewhere"
      description="Where you posted this on other networks. The list goes on the item's public page and in its item document, so readers can find the copies. It never makes a new version and adds nothing to your feed."
      className="sheet-prompt"
    >
      <SyndicationEditor itemId={itemId} version={version} save={save} done={done} />
    </Sheet>
  ));
}
