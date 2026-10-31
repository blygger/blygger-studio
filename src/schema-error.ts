import type { ZodError } from 'zod';

/** Use the shortest union branch and keep paths safe for JSON and text. */
export function schemaError(error: ZodError) {
  const flatten = (issues: typeof error.issues): typeof error.issues => issues.flatMap(issue =>
    issue.code === 'invalid_union' ? flatten([...issue.errors].sort((a, b) => a.length - b.length)[0] ?? []) : [issue]);
  const issues = flatten(error.issues).map(({ path, message }) => ({ path: path.map(key => typeof key === 'symbol' ? String(key) : key), message }));
  return { error: issues.map(({ path, message }) => `${path.join('.') || 'request'}: ${message}`).join('; '), issues };
}
