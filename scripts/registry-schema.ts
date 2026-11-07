// The extension registry's index format (docs/extension-registry.md).
//
// PROPOSAL, pending Venkat's ruling: third-party code compiled into the owner's
// session is a security-model question, and hosting the index on blygger.org is
// a program question. Nothing here is decided until that ruling.
//
// An index entry names a pinned, reviewed source tree. It never names a URL a
// Studio loads at run time: the operator vendors the tree into their own build
// (`npm run ext:add`), which is the only way registry code reaches a Studio.
//
// registry/index.schema.json is generated from this file (`npm run registry:schema`)
// for editors and for a hosted copy of the index; this file is the authority.
import { z } from "zod";

/** Same rule as extensions/catalog.ts: the directory, the Settings key, and the class-name prefix. */
export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A full commit id: SHA-1 (40) or SHA-256 (64) object names, lowercase. Never a branch, tag or short id. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The tree hash (scripts/registry-tree.ts), lowercase hex. */
export const SHA256 = /^[0-9a-f]{64}$/;
/** A subdirectory of the source repository: relative, forward slashes, no `.`/`..` segments. Empty means the root. */
export const SUBDIR = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)?$/;
/** Space-separated comparators, every one of which must hold: `>=0.39.0 <0.50.0`. */
export const RANGE = /^(?:(?:>=|<=|>|<|=)?\d+\.\d+\.\d+)(?: (?:>=|<=|>|<|=)?\d+\.\d+\.\d+)*$/;

const httpsUrl = z.url({ protocol: /^https$/, error: "must be an https:// URL" });

export const entrySchema = z.strictObject({
  name: z.string().regex(NAME, "lowercase letters, digits and single hyphens").max(40),
  label: z.string().min(1).max(40),
  description: z.string().min(1).max(280),
  author: z.strictObject({ name: z.string().min(1).max(80), url: httpsUrl.optional() }),
  homepage: httpsUrl,
  license: z.string().min(1).max(64).describe("An SPDX license expression, e.g. MIT"),
  source: z.strictObject({
    repo: z
      .string()
      .regex(/^https:\/\/[^\s]+$/, "must be an https:// git URL")
      .describe("A git URL the operator's machine fetches at ext:add time, never the Studio"),
    commit: z.string().regex(COMMIT, "a full, lowercase commit id (40 or 64 hex characters), never a branch or tag"),
    path: z.string().regex(SUBDIR, "a relative subdirectory without . or .. segments").default(""),
  }),
  sha256: z.string().regex(SHA256, "the tree hash printed by `npm run registry:hash`, 64 lowercase hex characters"),
  studio: z.string().regex(RANGE, "space-separated comparators, e.g. \">=0.39.0 <0.50.0\"").describe("The Studio versions this extension targets"),
  // v1 is browser-only. A server half adds routes to openapi.json, which must
  // stay a function of this repository (docs/extensions.md, "Why every
  // extension's routes are in openapi.json"). Open question in the docs.
  server: z.literal(false, { error: "registry extensions are browser-only in v1: a server half would add routes to openapi.json, which must stay a function of the repository" }),
});

export const indexSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1),
  extensions: z.array(entrySchema),
});

export type RegistryEntry = z.infer<typeof entrySchema>;
export type RegistryIndex = z.infer<typeof indexSchema>;

/** Parse an index, with every problem named by its path. Throws on any. */
export function parseIndex(raw: unknown): RegistryIndex {
  const result = indexSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "(index)"}: ${issue.message}`).join("\n"));
  }
  const seen = new Set<string>();
  for (const entry of result.data.extensions) {
    if (seen.has(entry.name)) throw new Error(`extensions: "${entry.name}" is listed twice`);
    seen.add(entry.name);
  }
  return result.data;
}

export const jsonSchema = () => ({
  ...z.toJSONSchema(indexSchema, { io: "input" }),
  $id: "https://github.com/blygger/blygger-studio/blob/main/registry/index.schema.json",
  title: "Blygger Studio extension registry index (proposal)",
});
