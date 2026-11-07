// How an identifier is compared (tn-6 section 6): `https` URLs as an origin
// normalizes, `acct:` case-insensitively, anything else exactly. Shared by the
// import index and the reader's highlight, so the two cannot disagree.
export function normalizeMentionTarget(raw: string): string {
  const value = raw.trim();
  if (/^acct:/i.test(value)) return value.toLowerCase();
  if (!/^https?:/i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return value;
  }
}

/** The owner's own identifiers, until there is a member record to read them from (#91 B4). */
export function ownMentionTargets(authorUrl: string | null | undefined, origin: string): string[] {
  return [...new Set([authorUrl, origin].filter((u): u is string => !!u).map(normalizeMentionTarget))];
}
