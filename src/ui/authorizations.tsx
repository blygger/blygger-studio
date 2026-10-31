import { useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { authorizations, client, apiBase } from './data.ts';
import { Button, Failure, Modal, basepath } from './components.tsx';
import { OWNER_SCOPES, SCOPE_DESCRIPTIONS, type OwnerScope } from '../auth-scopes.ts';

export function AuthorizationsPage() {
  const rows = useLiveQuery(q => q.from({ authorization: authorizations })).data ?? [];
  const [name, setName] = useState('');
  const [scope, setScope] = useState<OwnerScope[]>(['owner:read']);
  const [resource, setResource] = useState<'api' | 'mcp'>('api');
  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string>();
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); await authorizations.utils.refetch(); }
    catch (error) { setError(error); }
    finally { setBusy(false); }
  };
  return <div className="prose"><h1>Client access</h1><Failure error={error} />
    <p>Connect an OAuth client or an MCP app without sharing your owner password. Each authorization has its own permissions and can be revoked here.</p>
    <p>MCP URL: <code>{location.origin + basepath}/mcp</code></p>
    <p>Owner API: <code>{apiBase}</code>. Access tokens from OAuth last one hour; clients can refresh them for up to 30 days.</p>
    <p>For a mounted node, older REST grants for the host's /api address need replacement or new consent. MCP grants keep their existing audience.</p>
    <h2>Authorizations</h2>
    {rows.length ? rows.map(row => <section key={row.id}><strong>{row.name}</strong> {row.manual ? '(manual token)' : '(OAuth)'}
      <p><code>{row.resource}</code><br />{row.scope.join(', ')}</p>
      <p>Created {new Date(row.createdAt * 1000).toLocaleString()}{row.expiresAt ? ` · expires ${new Date(row.expiresAt * 1000).toLocaleString()}` : ''}</p>
      <Button disabled={busy} onClick={() => setRemove(row.id)}>revoke access</Button></section>) : <p>No authorizations.</p>}
    <p><Button disabled={busy} onClick={() => setRemove('all')}>revoke all client access</Button></p>
    <p>Changing the owner password logs out Studio sessions but keeps client authorizations, so use revoke-all when resetting it. Rotating the cookie secret invalidates them all.</p>
    <h2>Create a manual token</h2><p>For tools that cannot run OAuth. Tokens expire in 30 days. The token appears once; store it in your tool’s credential store.</p>
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const result = await unwrap(BlyggerApi.createAuthorization({ client, body: { name, scope, resource } }));
      setToken(result.accessToken); setName('');
    }); }}>
      <p><label>Client name <input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label></p>
      <p><label>Resource <select value={resource} onChange={event => setResource(event.target.value as 'api' | 'mcp')}><option value="api">REST API</option><option value="mcp">MCP</option></select></label></p>
      {OWNER_SCOPES.map(value => <p key={value}><label><input type="checkbox" checked={scope.includes(value)} onChange={event => setScope(previous => event.target.checked ? [...previous, value] : previous.filter(scope => scope !== value))} /> {SCOPE_DESCRIPTIONS[value]}</label></p>)}
      <Button type="submit" disabled={busy || !scope.length}>create token</Button>
    </form>
    <Modal open={!!token} close={() => setToken('')} title="Copy your token"><p>This token expires in 30 days. It will not appear again after closing.</p><textarea aria-label="New access token" readOnly value={token} rows={4} onFocus={event => event.target.select()} /></Modal>
    <Modal open={remove !== undefined} close={() => setRemove(undefined)} title={remove === 'all' ? 'Revoke all client access?' : 'Revoke this client?'}>
      <p>The client must get a new authorization to connect again. Your Studio login stays active.</p>
      <Button disabled={busy} onClick={() => void run(async () => {
        if (remove === 'all') await unwrap(BlyggerApi.revokeAllAuthorizations({ client }));
        else await unwrap(BlyggerApi.revokeAuthorization({ client, path: { id: remove! } }));
        setRemove(undefined);
      })}>revoke</Button>
    </Modal>
  </div>;
}
