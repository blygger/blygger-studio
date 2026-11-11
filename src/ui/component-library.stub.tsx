/*
 * Production builds alias component-library.tsx to this inert module. Keeping
 * the gallery's actual page and CSS out of that bundle protects Studio-node
 * operators from shipping maintainer documentation as an app route.
 */
export function ComponentLibraryPage() {
  return null;
}
