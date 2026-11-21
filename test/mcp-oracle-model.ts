// getChanges remains an owner:read tool during its two-release deprecation
// (Kyle Mathews, GitHub KyleAMathews, 2026-11-19); other capability laws are unchanged.
const reads = ['getDictionary','getShelf','listContacts','batchRead','getChanges','getItemSummary','listItemVersions','listHopperMemberships','getReadingSummary','getSignalSummary','listItems','getItem','getSettings','listSubscriptions','getSubscription','listHoppers','getHopper','listSignals','listMentions','listMentionGroups','getMentionSummary','search','getVersion','listReading','listImportedReading','getImportedItem','getImportedHistory','getImportedVersion','getUpdateState','getMentionSource','listStaleThreads','getItemFreshness','getForkOptions','listInteractions','listThumbs','getAiModels','peekItem','classifyLinks','listBrowse'];
const drafting = ['createItem','updateItem','deleteItem','restoreItem','uploadMedia','generateItem','draftNote','summarizeChangelog','classifyChange','preview'];
const publishing = ['publishItem','withdrawItem','pinItem','refreshItem','deleteMedia'];
const management = ['setReadingPlacement','putDictionarySource','putShelf','createContact','updateContact','resolveContact','deleteContact','updateSettings','createSubscription','updateSubscription','resyncSubscription','pollAllSubscriptions','deleteSubscription','createHopper','updateHopper','deleteHopper','addHopperItem','removeHopperItem','setSignal','deleteSignal','updateMention'];
const readState = ['markRead','markReadBatch','markUnread','markUnreadBatch','logBrowse','clearBrowse'];
export const all = ['owner:read', 'owner:draft', 'owner:publish', 'owner:manage', 'reading:state'];
// Each explicit scope contributes exactly its named verbs. Union the lists;
// never infer read access from draft/publish/manage. This finite reference owns
// the capability law, independently of the production tool registry.
export function expectedTools(scope: string[]) {
  return ['getCapabilities', ...(scope.includes('owner:read') ? reads : []), ...(scope.includes('owner:draft') ? drafting : []), ...(scope.includes('owner:publish') ? publishing : []), ...(scope.includes('owner:manage') ? management : []), ...(scope.includes('reading:state') ? readState : [])].sort();
}
