// Every Studio extension in this repository (docs/extensions.md).
//
// Listing an extension here makes it *available*: its name can appear in
// extensions.json / extensions.local.json, and its contract routes join the
// documented /api contract (openapi.json, the SDK, MCP). It does not compile
// the extension into a build — scripts/build-extensions.ts does that, from
// the operator's list — and it does not turn it on, which is a per-node
// Settings toggle that starts off.
//
// The contract is in the committed openapi.json whether or not a build carries
// the extension, so `npm run sdk:generate` is a function of the repository
// alone and CI's drift check cannot depend on an operator's local file. On a
// node where the extension is not compiled in, or not enabled, its routes 404.
import { routes as lineageGlyph } from "./lineage-glyph/contract.ts";

/** Names: lowercase, digits and hyphens; also the directory under extensions/ and the /api/ext/<name>/ prefix. */
export const EXTENSIONS = ["example", "inspect", "lineage-glyph", "reading-time"] as const;
export type ExtensionName = (typeof EXTENSIONS)[number];

/** Read routes contributed by extensions, keyed by operationId (see src/extensions/contract.ts). */
export const extensionRoutes = { ...lineageGlyph };
