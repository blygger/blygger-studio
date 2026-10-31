import { API_CONTRACT_VERSION } from '../src/operation-policy.ts';
import { writeFileSync } from "node:fs";
import { contractApp } from "../src/contract/app.ts";
import { routes } from "../src/contract/routes.ts";

import { authRoutes } from '../src/contract/auth-routes.ts';
import { SCOPE_DESCRIPTIONS, operationScopes } from '../src/permissions.ts';
const app = contractApp();
app.openAPIRegistry.registerComponent("securitySchemes", "ownerSession", { type: "apiKey", in: "cookie", name: "blyg_session" });
app.openAPIRegistry.registerComponent('securitySchemes', 'ownerOAuth', { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: '/studio/auth/oauth2/authorize', tokenUrl: '/studio/auth/oauth2/token', scopes: SCOPE_DESCRIPTIONS } } });
for (const r of Object.values(authRoutes)) app.openAPIRegistry.registerPath({ ...r, path: r.path });
for (const { policy, ...r } of Object.values(routes)) {
  const notes = [r.description, policy.conditionalScopes?.description, policy.scopeNotes].filter(Boolean).join(' ');
  app.openAPIRegistry.registerPath({ ...r, ...(notes ? { description: notes } : {}), security: [{ ownerSession: [] }, { ownerOAuth: operationScopes(r.operationId!) }], path: r.path });
}
const spec = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "Blygger Studio API", version: API_CONTRACT_VERSION, description: "Private authoring and reading API. Protocol files remain a separate public interface." }, servers: [{ url: "http://localhost:8787/api" }] });
writeFileSync(`${import.meta.dirname}/../openapi.json`, JSON.stringify(spec, null, 2) + "\n");
