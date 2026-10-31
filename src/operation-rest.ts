import { z } from 'zod';
import { schemaError } from './schema-error.ts';
import type { Context } from 'hono';
import type { Env } from './types.ts';
import type { OperationDefinition } from './operations.ts';
import { runOperation } from './operation-runner.ts';
import { failure, FAILURE_STATUS, type MediaInput, type OperationInput } from './operation-types.ts';
import { bearerChallenge } from './oauth.ts';

export async function multipartInput(form: FormData): Promise<MediaInput> {
  const file = form.get('file');
  return {
    ...(file instanceof File ? { file: { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, name: file.name } } : {}),
    ...(typeof form.get('item_id') === 'string' ? { itemId: form.get('item_id') as string } : {}),
    ...(typeof form.get('alt') === 'string' ? { alt: form.get('alt') as string } : {}),
    ...(typeof form.get('expectedRevision') === 'string' ? { expectedRevision: Number(form.get('expectedRevision')) } : {}),
    inline: form.get('inline') === 'true',
  };
}
export async function executeRest(definition: OperationDefinition, c: Context<{ Bindings: Env }>) {
  const input: OperationInput = { path: c.req.param(), query: c.req.query() };
  const type = c.req.header('content-type');
  if (definition.route.request?.body) {
    // Preserve the declared JSON/form media gate used by Hono OpenAPI.
    const json = /^application\/([a-z-\.]+\+)?json(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/i;
    const form = /^(?:multipart\/form-data(;\s?boundary=[a-zA-Z0-9'"()+_,\-./:=?]+)?|application\/x-www-form-urlencoded(;\s*[a-zA-Z0-9\-]+\=([^;]+))*)$/i;
    const supported = type ? (definition.route.operationId === 'uploadMedia' ? form : json).test(type) : await c.req.raw.clone().text() === '';
    if (!supported) {
      input.inputFailure = failure('unsupported-media', { error: 'Unsupported Media Type' });
      // Conditional permission rules still inspect valid JSON before encoding denial.
      try { input.body = JSON.parse(await c.req.text()); } catch { /* not JSON */ }
    }
  }
  if (!input.inputFailure && definition.route.operationId === 'uploadMedia') {
    const form = await c.req.formData().catch(() => new FormData());
    const media = definition.route.request?.body?.content['multipart/form-data'];
    const schema = media && 'schema' in media ? media.schema : undefined;
    if (schema instanceof z.ZodType) {
      const parsed = schema.safeParse(Object.fromEntries(form));
      if (!parsed.success) input.inputFailure = failure('invalid-input', schemaError(parsed.error));
    }
    if (!input.inputFailure) input.media = await multipartInput(form);
  } else if (!input.inputFailure && definition.route.request?.body) {
    if (/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
      const text = await c.req.text();
      if (text || definition.route.request.body.required) {
        try { input.body = JSON.parse(text); } catch { input.inputFailure = failure('invalid-input', { error: 'Malformed JSON in request body' }); }
      }
    }
  }
  const result = await runOperation(definition, input, { env: c.env, url: c.req.url, access: c.get('apiAccess'), extensions: c.get('apiExtensions'), defer: task => c.executionCtx.waitUntil(task) });
  if (result.ok) {
    if (result.location) c.header('Location', result.location);
    return c.json(result.value as Record<string, unknown>, result.created ? 201 : 200);
  }
  if (result.requiredScopes) c.header('WWW-Authenticate', bearerChallenge(c.req.url, c.env, 'api', result.requiredScopes.join(' '), true));
  if (result.kind === 'rate-limit') c.header('Retry-After', '60');
  return c.json(result.value, FAILURE_STATUS[result.kind]);
}
