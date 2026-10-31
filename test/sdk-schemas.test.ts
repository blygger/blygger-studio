import { expect, test } from 'vitest';
import { ItemSchema, ProvenanceSchema, VersionReferenceSchema } from '../src/contract/resources.ts';
import { SettingsSchema, SignalRowSchema } from '../src/contract/schemas.ts';
import { zItem, zGenerationProvenance, zVersionReference, zSignalRow, zSettings, zListItemsResponse } from '../sdk/dist/schemas.js';

test('generated OpenAPI schemas preserve permissive provenance metadata', () => {
  const provenance = { sources: [{ id: 'source', version: 1 }], model: 'model', provider: { request: 'opaque-id' } };
  expect(zGenerationProvenance.parse(provenance)).toEqual(ProvenanceSchema.parse(provenance));
  expect(zGenerationProvenance.parse(provenance)).toHaveProperty('provider.request', 'opaque-id');
});

test('generated OpenAPI schemas reject extra fields on strict version references', () => {
  const valid = { origin: 'https://example.com', id: 'source', version: 1 };
  expect(zVersionReference.parse(valid)).toEqual(VersionReferenceSchema.parse(valid));
  const extra = { ...valid, unexpected: true };
  expect(zVersionReference.safeParse(extra).success).toBe(false);
  expect(VersionReferenceSchema.safeParse(extra).success).toBe(false);
});

test('generated item collection schema preserves both item fields and optional pins', () => {
  const item = {
    id: 'a', revision: 1, kind: 'fragment', status: 'draft', created: '2026-10-06', updated: '2026-10-06', version: 1,
    content_md: 'draft', dirty: false, responses: 'default', highlight: 'default',
    provenance: [{ sources: [], provider: 'custom' }], stub_of: null, forked_from: null, fork_cite: null,
  };
  expect(zItem.parse(item)).toEqual(ItemSchema.parse(item));
  const withPins = { ...item, pins: [{ version: 1, kind: 'fragment' }] };
  expect(zListItemsResponse.shape.items.element.parse(withPins)).toEqual(withPins);
  expect(zListItemsResponse.shape.items.element.parse(item)).toEqual(item);
});

test('generated scalar and enum constraints match their API schemas', () => {
  const signals = [
    { subscription_id: 's', remote_id: 'r', thumb: 1, at: 'now' },
    { subscription_id: 's', remote_id: 'r', thumb: 0, at: 'now' },
    { subscription_id: 's', remote_id: 'r', thumb: -1, at: null },
  ];
  for (const signal of signals)
    expect(zSignalRow.safeParse(signal).success).toBe(SignalRowSchema.safeParse(signal).success);
  const themes = ['valid-theme', 42, null];
  for (const theme of themes)
    expect(zSettings.shape.theme.safeParse(theme).success).toBe(SettingsSchema.shape.theme.safeParse(theme).success);
});
