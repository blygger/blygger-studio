// Every extension's server half, for the Worker suite (see extensions.names.ts
// beside this file); vitest.config.ts substitutes it for build/extensions.server.ts.
// test/extensions.test.ts checks this list against extensions/*/server.ts.
import type { ServerExtension } from "../../src/extensions/server.ts";
import { server as feedExample } from "../../extensions/feed-example/server.ts";
import { server as lineageGlyph } from "../../extensions/lineage-glyph/server.ts";
import { server as wordCount } from "../../extensions/word-count/server.ts";

export const compiledServerExtensions: readonly ServerExtension[] = [feedExample, lineageGlyph, wordCount];
