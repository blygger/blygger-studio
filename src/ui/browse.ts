/*
 * The reader's browsing path (0.49.0). Following a link, a nested quote or a
 * stub's source from one entry to another is a descent; the trail is the way
 * down, so backing out retraces it and the history pane can show it.
 *
 * Two records, deliberately apart:
 *  - the live trail (`stack`) lives here and in sessionStorage: where you are
 *    in this walk, which is what back and the breadcrumb need;
 *  - the log is the server's private `browse_log`, appended once per entry
 *    opened by a walk, which is what the history pane lists across walks.
 *
 * A walk starts when an entry is opened from the feed or a source list, and
 * ends when the reader returns to one (`endTrail`); the log keeps it either way.
 */
import { useSyncExternalStore } from 'react';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { client } from './data.ts';

export type Via = 'start' | 'stub' | 'quote' | 'link' | 'back';

export interface Step {
  origin: string;
  id: string;
  version: number | null;
  title: string;
  /** The log row for this visit, once the server has answered. */
  stepId?: number;
}
interface State {
  trail: string | null;
  stack: Step[];
  /** How the next entry is being reached; consumed by the entry that opens. */
  pending: Via | null;
}

const KEY = 'studio.browse';
const VIA_WORDS: Record<Via, string> = { start: 'opened', stub: 'stubbed source', quote: 'quoted layer', link: 'link', back: 'back' };
export const viaWord = (via: Via) => VIA_WORDS[via];

let state: State = load();
const listeners = new Set<() => void>();
function load(): State {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as State | null;
    if (raw && Array.isArray(raw.stack)) return { trail: raw.trail ?? null, stack: raw.stack, pending: null };
  } catch {
    /* private mode or damaged: start empty */
  }
  return { trail: null, stack: [], pending: null };
}
function set(next: State) {
  state = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* memory only */
  }
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const useTrail = () => useSyncExternalStore(subscribe, () => state);
export const currentTrail = () => state;

const sameStep = (a: Step | undefined, origin: string, id: string) => !!a && a.origin === origin && a.id === id;
const newTrailId = () => crypto.randomUUID();

/** The next entry is reached by following something inside the current one. */
export function follow(via: Exclude<Via, 'start' | 'back'>) {
  set({ ...state, pending: via });
}
/** Back at a timeline or source list: the walk is over. The log keeps it. */
export function endTrail() {
  if (state.stack.length || state.trail || state.pending) set({ trail: null, stack: [], pending: null });
}
/** Drop the live path down to `index` (the step the reader jumped to). */
export function popTo(index: number) {
  set({ ...state, stack: state.stack.slice(0, index + 1), pending: null });
}

/**
 * An entry opened. Called once per display of an entry; decides whether this
 * is a new walk, a step down, a step back, or the same entry again, keeps the
 * live path, and logs the step. Never throws: the log is a convenience.
 */
export function visit(step: Omit<Step, 'stepId'>) {
  const top = state.stack[state.stack.length - 1];
  if (sameStep(top, step.origin, step.id)) {
    // Same entry again (a re-render, or its title arriving late).
    if (step.title && top.title !== step.title) {
      set({ ...state, stack: [...state.stack.slice(0, -1), { ...top, title: step.title }] });
    }
    return;
  }
  const below = state.stack[state.stack.length - 2];
  let via: Via;
  let stack: Step[];
  let trail = state.trail;
  if (sameStep(below, step.origin, step.id)) {
    via = 'back';
    stack = state.stack.slice(0, -1);
  } else if (state.stack.length && state.pending) {
    via = state.pending;
    stack = [...state.stack, step];
  } else if (state.stack.length && !state.pending) {
    // Arrived some other way (address bar, a hopper): a new walk.
    via = 'start';
    trail = newTrailId();
    stack = [step];
  } else {
    via = 'start';
    trail = trail ?? newTrailId();
    stack = [step];
  }
  const parentId = via === 'start' ? null : top?.stepId ?? null;
  set({ trail, stack, pending: null });
  void unwrap(
    BlyggerApi.logBrowse({
      client,
      body: { trail: trail!, parentId: parentId, origin: step.origin, remoteId: step.id, version: step.version, via, title: step.title || null },
    }),
  ).then(
    ({ id }) => {
      // The answer may arrive after the reader has moved on; label the step that is still there.
      const at = state.stack.findIndex((s) => sameStep(s, step.origin, step.id) && s.stepId === undefined);
      if (at >= 0 && state.trail === trail) {
        const next = state.stack.slice();
        next[at] = { ...next[at], stepId: id };
        set({ ...state, stack: next });
      }
    },
    () => {},
  );
}
