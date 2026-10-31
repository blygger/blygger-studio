/** Sequential browser fixture setup only. Race/contract probes use captured tokens or raw fetch. */
export async function fixtureJson({ method, path, body }: { method: string; path: string; body?: unknown }) {
  const item = /^(.*\/api)\/items\/([^/]+)(?:\/(?:publish|withdraw|restore|generate|refresh|classify|note-draft|versions\/\d+\/pin))?$/.exec(new URL(path, location.href).pathname);
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && item &&
      (body === undefined || body !== null && typeof body === 'object' && !Array.isArray(body)) &&
      !(body && 'expectedRevision' in body)) {
    const observed = await fetch(`${item[1]}/items/${item[2]}`);
    if (!observed.ok) throw new Error(`Cannot observe fixture item: ${observed.status}`);
    const { revision } = await observed.json() as { revision: number };
    body = { ...body as object | undefined, expectedRevision: revision };
  }
  const response = await fetch(path, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ok: response.ok, json: await response.json().catch(() => null) };
}
