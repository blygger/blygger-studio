/**
 * Anonymous registration must not permanently occupy all client storage. OWASP
 * DoS guidance calls for bounds and expiry of attacker-controlled storage:
 * https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
 * Model: unapproved registrations expire after the operator's configured grace;
 * approved grants and pending live authorization work are retained. Owner-created
 * manual clients do not occupy the anonymous pool. A failed registration releases
 * its reservation (separate work-admission oracle).
 * Driver: actual native registration/consent/token and D1 timestamps. Ageing keeps the
 * library's stored timestamp format; writing a different type would test a row
 * production never holds. Time is a
 * fixed logical input; no sleep or production retention helper computes results.
 * Limits: recovery after abandoned registration, not sustained bot resistance or
 * garbage collection of owner-approved accounts.
 */
import { env } from 'cloudflare:test';
import { expect, it, beforeEach } from 'vitest';
import { flow } from './oauth-flow-driver.ts';
beforeEach(async()=>{await env.DB.prepare('DELETE FROM oauthClient').run();await env.DB.prepare('DELETE FROM security_registrations').run();});
// Two days older, in the stored ISO form. The row count proves the age landed.
async function age(clientId:string){
  const result=await env.DB.prepare("UPDATE oauthClient SET createdAt=strftime('%Y-%m-%dT%H:%M:%fZ',createdAt,'-2 days') WHERE clientId=? AND typeof(createdAt)='text'").bind(clientId).run();
  expect(result.meta.changes,'client timestamps must keep the library storage format').toBe(1);
}
it('an abandoned old registration cannot permanently fill the anonymous pool', async()=>{
  const f=await flow();await f.decide('browser-a',false);
  await age(f.client.client_id);
  const response=await f.request(f.issuer+'/oauth2/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'fresh neighbor',redirect_uris:[f.redirect],token_endpoint_auth_method:'none'})},{...env,OAUTH_CLIENT_LIMIT:'1'});
  expect(response.status,'abandoned anonymous storage must become reclaimable').toBe(201);
  expect(await env.DB.prepare('SELECT clientId FROM oauthClient WHERE clientId=?').bind(f.client.client_id).first()).toBeNull();
});
it('old approved clients remain usable and still occupy the pool',async()=>{
  const f=await flow();const approval=await f.decide('browser-a',true);
  const response=await f.token(new URL(approval.headers.get('location')!).searchParams.get('code')!);expect(response.status).toBe(200);
  const token=(await response.json() as {access_token:string}).access_token;
  await age(f.client.client_id);
  const registration=await f.request(f.issuer+'/oauth2/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[f.redirect],token_endpoint_auth_method:'none'})},{...env,OAUTH_CLIENT_LIMIT:'1'});
  expect(registration.status).toBe(429);
  expect((await f.request('/blyg/api/settings',{headers:{Authorization:'Bearer '+token}})).status,'reclamation must preserve approved authority').toBe(200);
});
it('a pending live consent protects an old client from reclamation',async()=>{
  const f=await flow();
  await age(f.client.client_id);
  const registration=await f.request(f.issuer+'/oauth2/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[f.redirect],token_endpoint_auth_method:'none'})},{...env,OAUTH_CLIENT_LIMIT:'1'});
  expect(registration.status).toBe(429);
  const approval=await f.decide('browser-a',true);
  expect((await f.token(new URL(approval.headers.get('location')!).searchParams.get('code')!)).status,'live pending authorization survives reclamation pressure').toBe(200);
});
it('owner-created manual clients do not occupy the anonymous registration pool',async()=>{
  const f=await flow();await f.decide('browser-a',false);
  await env.DB.prepare('DELETE FROM oauthClient WHERE clientId=?').bind(f.client.client_id).run();
  const minted=await f.request('/blyg/api/authorizations',{method:'POST',headers:{cookie:f.owner,'Content-Type':'application/json'},body:JSON.stringify({name:'Owner manual client',scope:['owner:read'],resource:'api'})});
  expect(minted.status).toBe(200);
  const registration=await f.request(f.issuer+'/oauth2/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[f.redirect],token_endpoint_auth_method:'none'})},{...env,OAUTH_CLIENT_LIMIT:'1'});
  expect(registration.status,'manual client must not consume an anonymous slot').toBe(201);
});
