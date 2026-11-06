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
import { handleInsert, handleTrigger } from './handle-trigger.ts';
import './picker.css';

const loadContacts = async () => (await unwrap(BlyggerApi.listContacts({ client }))).contacts;

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
      const made = await unwrap(BlyggerApi.createContact({ client, body: { handle: handle.replace(/^@/, ''), name, url } }));
      // Best effort: a page that cannot be read leaves a contact that still works.
      await unwrap(BlyggerApi.resolveContact({ client, path: { id: made.id } })).catch(() => {});
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
      <div className="field">
        <label htmlFor="contact-handle"><span>Handle</span></label>
        <input id="contact-handle" type="text" value={handle} onChange={(e) => setHandle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="contact-name"><span>Name</span></label>
        <input id="contact-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="contact-url"><span>URL</span></label>
        <input id="contact-url" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <Button className="btn" disabled={!handle || !name || !url} onClick={() => void add()}>
        add contact
      </Button>
      {error ? <Failure error={error} /> : null}
    </section>
  );
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
