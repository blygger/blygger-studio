import { createCollection, createPacedMutations, localOnlyCollectionOptions, throttleStrategy } from '@tanstack/react-db';
import { z } from 'zod';
import { CHANGE_CATEGORIES } from '../change-category.ts';
import type {
  GetItemResponses, UpdateItemResponses, GenerateItemResponses, PublishItemResponses,
  DeleteItemResponses, WithdrawItemResponses, PinItemResponses, DraftNoteResponses, ClassifyChangeResponses,
  UploadMediaResponses, DeleteMediaResponses, RefreshItemResponses,
} from '../../sdk/dist/browser.js';

const kind = z.enum(['fragment', 'thread']);
export const draftWriteSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('save'), text: z.string(), kind: kind.optional() }),
  z.object({ type: z.literal('upload'), file: z.instanceof(File), inline: z.boolean().optional() }),
  z.object({ type: z.literal('delete-media'), mediaId: z.string() }),
  z.object({ type: z.literal('refresh'), note: z.string() }),
  z.object({ type: z.literal('generate'), scope: z.number().int().nonnegative() }),
  z.object({ type: z.literal('restore'), version: z.number().int().positive() }),
  // category: the change category the author confirmed (studio-private); omitted when the classifier did not run.
  z.object({ type: z.literal('publish'), note: z.string(), generated: z.boolean(), category: z.enum(CHANGE_CATEGORIES).nullable().optional() }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('withdraw') }),
  z.object({ type: z.literal('pin'), version: z.number().int().positive() }),
  z.object({ type: z.literal('draft-note') }),
  z.object({ type: z.literal('classify') }),
  z.object({ type: z.literal('update'), changes: z.object({
    kind: kind.optional(),
    highlight: z.enum(['default', 'show', 'hide']).optional(),
    responses: z.enum(['default', 'show', 'hide']).optional(),
    stubOf: z.null().optional(),
  }) }),
]);
export type DraftWrite = z.infer<typeof draftWriteSchema>;
type Results = {
  save: UpdateItemResponses[200]; generate: GenerateItemResponses[200];
  restore: GetItemResponses[200]; publish: PublishItemResponses[200];
  delete: DeleteItemResponses[200]; withdraw: WithdrawItemResponses[200];
  pin: PinItemResponses[200]; 'draft-note': DraftNoteResponses[200]; classify: ClassifyChangeResponses[200];
  update: UpdateItemResponses[200]; upload: UploadMediaResponses[201] | UploadMediaResponses[200];
  'delete-media': DeleteMediaResponses[200]; refresh: RefreshItemResponses[200];
};
const requestSchema = z.object({ key: z.string(), revision: z.number().int(), command: draftWriteSchema });
type Request = z.infer<typeof requestSchema>;

/** All commands share one scheduler and one persistence handler. */
export function createPacedDraftAction(dispatch: (command: DraftWrite) => Promise<unknown>) {
  const requests = createCollection(localOnlyCollectionOptions({
    schema: requestSchema, getKey: row => row.key,
  }));
  const strategy = throttleStrategy({ wait: 0, leading: true, trailing: true });
  let sequence = 0;
  const mutationFn: Parameters<typeof createPacedMutations<DraftWrite, Request>>[0]['mutationFn'] = async ({ transaction }) => {
    transaction.metadata.result = await dispatch(transaction.mutations[0].modified.command);
    // Local-only command rows record requests, even when item text is unchanged.
    requests.utils.acceptMutations(transaction as unknown as Parameters<typeof requests.utils.acceptMutations>[0]);
  };
  const createAction = () => {
    const key = String(++sequence);
    return createPacedMutations<DraftWrite, Request>({
      strategy, mutationFn,
      onMutate: command => {
        const revision = ++sequence;
        if (requests.has(key)) requests.update(key, row => {
          row.revision = revision; row.command = command;
        });
        else requests.insert({ key, revision, command });
      },
    });
  };
  let saves = createAction();
  return function write<W extends DraftWrite>(input: W): Promise<Results[W['type']]> {
    const command = draftWriteSchema.parse(input);
    const mutate = command.type === 'save' ? saves : createAction();
    // A command closes this save group. Later text cannot merge across it.
    if (command.type !== 'save') saves = createAction();
    const transaction = mutate(command);
    return transaction.when('settled').then(() => {
      if (command.type !== 'save') {
        // This command finished after every earlier save group. Drop those
        // completed request rows; later groups have larger keys.
        const completed = [...requests.keys()].filter(key => Number(key) <= Number(transaction.mutations[0].key));
        if (completed.length) void requests.delete(completed).when('settled').catch(() => undefined);
      }
      return transaction.metadata.result as Results[W['type']];
    });
  };
}
