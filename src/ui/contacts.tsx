/*
 * The address book (tn-6 section 5): Settings' list of contacts, and the `@`
 * autocomplete in the composer and editor. Handles are studio-private. The
 * server consumes them at publish on every write path, so everything here is a
 * convenience over that resolver (#91).
 */
import { useEffect, useState } from 'react';
import type { Contact } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { Button, Failure } from './components.tsx';
import { setTextAt } from './caret.ts';
import { client } from './data.ts';
import { handleInsert, handleTrigger, sameContactUrl, suggestHandle } from './handle-trigger.ts';
import { customSheet, Sheet, toast } from './sheets.tsx';
import './picker.css';

const loadContacts = async () => (await unwrap(BlyggerApi.listContacts({ client }))).contacts;

/** The three fields, with their help text, in Settings and in the offer sheet. */
function ContactFields({ prefix, handle, setHandle, name, setName, url, setUrl }: {
  prefix: string;
  handle: string;
  setHandle: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-handle`}><span>Handle</span></label>
        <input id={`${prefix}-handle`} type="text" aria-describedby={`${prefix}-handle-help`} value={handle} onChange={(e) => setHandle(e.target.value)} />
        <p className="hint contact-help" id={`${prefix}-handle-help`}>private to you</p>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-name`}><span>Display name</span></label>
        <input id={`${prefix}-name`} type="text" aria-describedby={`${prefix}-name-help`} value={name} onChange={(e) => setName(e.target.value)} />
        <p className="hint contact-help" id={`${prefix}-name-help`}>Displayed on public page</p>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-url`}><span>URL</span></label>
        <input id={`${prefix}-url`} type="url" placeholder="https://" aria-describedby={`${prefix}-url-help`} value={url} onChange={(e) => setUrl(e.target.value)} />
        <p className="hint contact-help" id={`${prefix}-url-help`}>Where the person can be found, such as a blyg address or social feed profile</p>
      </div>
    </>
  );
}

async function saveContact(handle: string, name: string, url: string) {
  const made = await unwrap(BlyggerApi.createContact({ client, body: { handle: handle.replace(/^@/, ''), name, url } }));
  // Best effort: a page that cannot be read leaves a contact that still works.
  await unwrap(BlyggerApi.resolveContact({ client, path: { id: made.id } })).catch(() => {});
  return made;
}

export function AddressBook() {
  const [contacts, setContacts] = useState<Contact[]>();
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    loadContacts().then(setContacts).catch(setError);
  }, []);
  const add = async () => {
    setError(undefined);
    try {
      await saveContact(handle, name, url);
      setHandle('');
      setName('');
      setUrl('');
      setContacts(await loadContacts());
    } catch (e) {
      setError(e);
    }
  };
  const remove = async (id: string) => {
    setError(undefined);
    try {
      await unwrap(BlyggerApi.deleteContact({ client, path: { id } }));
      setContacts(await loadContacts());
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card">
      <p className="hint">
        Type <code>@handle</code> while writing. At publish it becomes a link to the person, and
        the handle stays here. A mention notifies nobody, and past versions keep the link they
        were published with.
      </p>
      {contacts?.length ? (
        <ul className="contact-list">
          {contacts.map((contact) => (
            <li key={contact.id} className="row">
              <code>@{contact.handle}</code> <span>{contact.name}</span> <span className="hint">{contact.url}</span>
              {contact.ids.length ? <span className="hint">· {contact.ids.filter((i) => i.provenance !== 'entered').length} checked identifiers</span> : null}
              <span className="spacer" />
              <Button className="btn btn-ghost btn-mini" aria-label={`remove @${contact.handle}`} onClick={() => void remove(contact.id)}>
                remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <ContactFields prefix="contact" handle={handle} setHandle={setHandle} name={name} setName={setName} url={url} setUrl={setUrl} />
        <Button className="btn btn-primary" type="submit" disabled={!handle || !name || !url}>
          add contact
        </Button>
      </form>
      {error ? <Failure error={error} /> : null}
    </section>
  );
}

function ContactSheet({ title, seed, done }: { title: string; seed: { name: string; url: string }; done: () => void }) {
  const [handle, setHandle] = useState(suggestHandle(seed.name));
  const [name, setName] = useState(seed.name);
  const [url, setUrl] = useState(seed.url);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const made = await saveContact(handle, name, url);
      toast(`added @${made.handle} to your address book`, { tone: 'ok' });
      done();
    } catch (e) {
      // Stays open: a handle already taken is fixed here, not by starting over.
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={done} title={title} className="sheet-prompt">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ContactFields prefix="offer" handle={handle} setHandle={setHandle} name={name} setName={setName} url={url} setUrl={setUrl} />
        {error ? <Failure error={error} /> : null}
        <div className="sheet-actions">
          <Button className="btn btn-primary" type="submit" disabled={busy || !handle || !name || !url}>
            add contact
          </Button>
          <Button className="btn btn-ghost" type="button" onClick={done}>
            not now
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

const openContactSheet = (title: string, seed: { name: string; url: string }) =>
  customSheet((done) => <ContactSheet title={title} seed={seed} done={done} />);

/**
 * After subscribing to one blyg: offer to add it, unless the book already has
 * it. `{identity}blyg.json` is always the manifest (#87), and it supplies the
 * author's own name and address; a manifest the browser may not read (CORS is a
 * SHOULD, §4) leaves the subscription's title and origin, which the owner edits.
 */
export async function offerBlygContact(blyg: { origin: string; title: string }) {
  let author: { name?: unknown; url?: unknown } = {};
  try {
    const manifest = await (await fetch(new URL('blyg.json', blyg.origin))).json() as { author?: typeof author };
    author = manifest.author ?? {};
  } catch {
    // The fallback above.
  }
  const url = typeof author.url === 'string' && author.url.startsWith('https:') ? author.url : blyg.origin;
  const name = typeof author.name === 'string' && author.name ? author.name : blyg.title;
  const book = await loadContacts().catch(() => null);
  if (!book || book.some((c) => sameContactUrl(c.url, url) || sameContactUrl(c.url, blyg.origin))) return;
  await openContactSheet('Add this blyg to address book?', { name, url });
}

/** The reading menu's "add author to address book". */
export async function addAuthorContact(seed: { name: string; url: string }) {
  const held = (await loadContacts().catch(() => [])).find((c) => sameContactUrl(c.url, seed.url));
  if (held) toast(`already in your address book as @${held.handle}`);
  else await openContactSheet('Add author to address book', seed);
}

export function HandlePicker({ input, text, change }: {
  input: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  change: (text: string) => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>();
  const [caret, setCaret] = useState(text.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<number>();
  useEffect(() => {
    const element = input.current;
    const update = () => setCaret(element?.selectionStart ?? text.length);
    element?.addEventListener('selectionchange', update);
    element?.addEventListener('keyup', update);
    element?.addEventListener('click', update);
    update();
    return () => {
      element?.removeEventListener('selectionchange', update);
      element?.removeEventListener('keyup', update);
      element?.removeEventListener('click', update);
    };
  }, [input, text]);
  const trigger = handleTrigger(text, caret);
  const active = !!trigger && dismissed !== trigger.start;
  // Read when first wanted, and again each time a new `@` opens, so a contact
  // added in Settings is offered without a reload.
  useEffect(() => {
    if (active) loadContacts().then(setContacts).catch(() => setContacts([]));
  }, [active, trigger?.start]);
  const query = trigger?.query.toLowerCase() ?? '';
  const matches = (contacts ?? [])
    .filter((c) => c.handle.toLowerCase().startsWith(query) || c.name.toLowerCase().includes(query))
    .slice(0, 8);
  useEffect(() => setSelected(0), [query]);
  const open = active && matches.length > 0;
  const pick = (contact: Contact) => {
    if (!trigger) return;
    const next = handleInsert(text, trigger, contact.handle);
    if (input.current) setTextAt(input.current, change, next.text, next.caret);
    else change(next.text);
  };
  useEffect(() => {
    const element = input.current;
    if (!element || !open) return;
    const navigate = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(trigger?.start);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((i) => Math.min(i + 1, matches.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if ((event.key === 'Enter' || event.key === 'Tab') && matches[selected]) {
        event.preventDefault();
        pick(matches[selected]);
      }
    };
    element.addEventListener('keydown', navigate);
    return () => element.removeEventListener('keydown', navigate);
  });
  if (!open) return null;
  return (
    <aside className="picker" role="complementary" aria-label="mention picker">
      <header className="picker-head">
        <div>
          <strong>mention</strong> <code>@</code>
          <div className="picker-sub">a link at publish; notifies nobody</div>
        </div>
      </header>
      <ul role="listbox" aria-label="contacts" className="picker-list handle-hits">
        {matches.map((contact, i) => (
          <li key={contact.id} className={i === selected ? 'sel' : undefined}>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(contact)}>
              <code>@{contact.handle}</code> {contact.name}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
