// Marks the h-cards in a reading body that name the owner, so a mention can be
// seen at a glance. A baked quote's are the quoted author's speech (tn-6 section 6).
import { useMemo } from 'react';
import { normalizeMentionTarget, ownMentionTargets } from '../mention-targets.ts';
import { mount, useSettings } from './components.tsx';

export function useOwnMentionTargets(): string {
  const settings = useSettings();
  return useMemo(
    () => ownMentionTargets(settings?.authorUrl, settings?.siteUrl || `${location.origin}${mount}/`).join(' '),
    [settings?.authorUrl, settings?.siteUrl],
  );
}

/** Adds `.mention-you` to each match; returns the first. */
export function markOwnMentions(root: HTMLElement, targets: string): HTMLElement | null {
  const own = new Set(targets.split(' '));
  let first: HTMLElement | null = null;
  for (const card of root.querySelectorAll<HTMLElement>('.h-card')) {
    if (card.closest('blockquote.blyg-transclusion')) continue;
    const urls = [card, ...card.querySelectorAll<HTMLElement>('.u-url')].map((el) => el.getAttribute('href') ?? el.getAttribute('value'));
    if (!urls.some((url) => url && own.has(normalizeMentionTarget(url)))) continue;
    card.classList.add('mention-you');
    first ??= card;
  }
  return first;
}
