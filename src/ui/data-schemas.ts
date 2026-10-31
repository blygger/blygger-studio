import { z } from 'zod';
import {
  zListItemsResponse,
  zGetItemResponse,
  zHopper,
  zGetHopperResponse,
  zImportedItem,
  zReadingEntry,
  zListReadingResponse,
  zSubscription,
  zMention,
  zGetMentionSourceResponse,
  zGetUpdateStateResponse,
  zAuthorization,
  zSettings,
  zSignal,
  zHopperMembership,
  zOutboundMention,
} from '../../sdk/dist/schemas.js';

const rank = z.number().int().nonnegative();
export const sourceSchemas = {
  items: zListItemsResponse.shape.items.element,
  itemHistory: zGetItemResponse.pick({
    id: true,
    media: true,
    publishedMedia: true,
    versions: true,
    published: true,
  }),
  settings: zSettings.extend({ key: z.literal('settings') }),
  subscriptions: zSubscription,
  hoppers: zHopper,
  hopperStats: zGetHopperResponse.pick({ total: true, sourceCount: true })
    .extend({ id: zHopper.shape.id }),
  hopperEntries: z.object({ hopperId: zHopper.shape.id, rank, item: zImportedItem }),
  hopperMemberships: zHopperMembership.extend({ rank }),
  reading: zReadingEntry.extend({ view: z.string(), rank }),
  signals: zSignal,
  updates: zGetUpdateStateResponse.and(z.object({ key: z.literal('updates') })),
  authorizations: zAuthorization,
  inbound: zMention,
  outbound: zOutboundMention,
  mentionSources: zGetMentionSourceResponse.extend({ key: z.string() }),
};
export const readingResponseSchema = zListReadingResponse.extend({ view: z.string() });
