const reads = ['getDictionary','getSyndication','listHelpers','catchUp','getShelf','listContacts','batchRead','getItemSummary','listItemVersions','listHopperMemberships','getReadingSummary','getSignalSummary','listItems','getItem','getSettings','listSubscriptions','getSubscription','listHoppers','getHopper','listSignals','listMentions','listMentionGroups','getMentionSummary','search','getVersion','listReading','listImportedReading','getImportedItem','getImportedHistory','getImportedVersion','getUpdateState','getMentionSource','listStaleThreads','getItemFreshness','getForkOptions','listInteractions','listThumbs','getAiModels','peekItem','classifyLinks','listBrowse'];
const privateReads = ['listPrivateVersions','listAgenticFeeds','getAgentic'];
// The Agentic feed's writes need both (Venkat, session 88): an edition may name any own item.
const privateManagement = ['putAgentic', 'regenerateAgentic'];
const drafting = ['createItem','updateItem','deleteItem','restoreItem','uploadMedia','generateItem','draftNote','summarizeChangelog','summarizeCatchUp','classifyChange','preview'];
const publishing = ['publishItem','withdrawItem','pinItem','putSyndication','refreshItem','deleteMedia'];
const management = ['setReadingPlacement','putDictionarySource','putShelf','createContact','updateContact','resolveContact','deleteContact','updateSettings','createSubscription','updateSubscription','resyncSubscription','pollAllSubscriptions','deleteSubscription','createHopper','updateHopper','deleteHopper','addHopperItem','removeHopperItem','setSignal','deleteSignal','updateMention'];
const readState = ['markRead','markReadBatch','markUnread','markUnreadBatch','logBrowse','clearBrowse'];
export const all = ['owner:read', 'owner:private', 'owner:draft', 'owner:publish', 'owner:manage', 'reading:state'];
// Each explicit scope contributes exactly its named verbs. Union the lists;
// never infer read access from draft/publish/manage. This finite reference owns
// the capability law, independently of the production tool registry.
export function expectedTools(scope: string[]) {
  return ['getCapabilities', ...(scope.includes('owner:read') ? reads : []), ...(scope.includes('owner:private') ? privateReads : []), ...(scope.includes('owner:draft') ? drafting : []), ...(scope.includes('owner:publish') ? publishing : []), ...(scope.includes('owner:manage') ? management : []), ...(scope.includes('owner:manage') && scope.includes('owner:private') ? privateManagement : []), ...(scope.includes('reading:state') ? readState : [])].sort();
}
