/** Fixed domains shared by the API and Studio. Adding a response dependency
 * requires its trigger and receiving witness, not a caller invalidation hook.
 * `mentions` is the Studio's view of both mention tables; `responses` is the
 * narrower public one (verified, unhidden inbound rows), so unverified claims
 * cannot roll the public HTML cache key (migration 0032). */
export const CHANGE_DOMAINS = ['items', 'reading', 'subscriptions', 'hoppers', 'signals', 'settings', 'feed', 'mentions', 'responses', 'interactions', 'browse', 'shelf'] as const;
export type ChangeDomain = typeof CHANGE_DOMAINS[number];
export type ChangeState = { epoch: string; domains: Record<ChangeDomain, number> };
