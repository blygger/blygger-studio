import { success, failure, type OperationContext, type OperationInput } from '../operation-types.ts';
// Owner-only mention visibility. This edit does not publish a version.

import { getInbound, setMentionHidden } from "./store.ts";


/**
 * Take one response off the page, or put it back. Deliberately reversible and
 * deliberately not a delete: the row stays in the studio, because "I don't
 * want this on my page" and "this never happened" are different claims.
 */
const updateMentionOperation = async (context: OperationContext, input: OperationInput) => {
  const row = await getInbound(context.env.DB, input.path.id);
  if (!row) return failure('not-found', { error: "not found" });
  const body = (input.body as { hidden: boolean });
  await setMentionHidden(context.env.DB, row.id, body.hidden);
  return success({ ok: true, hidden: body.hidden });
};

export const mentionOperations = {
  updateMention: updateMentionOperation,
};
