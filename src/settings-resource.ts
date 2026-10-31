// The settings resource as GET and PATCH /api/settings return it: the stored
// settings, plus two read-only members the Studio needs to present them.
import { settingsFields, SettingsSchema } from './contract/settings.ts';
import { feedOrderChoices } from "./feeds/available.ts";
import { settingDefaults } from "./model.ts";
import type { Settings } from "./types.ts";

export function settingsResource(settings: Settings) {
  const { setup: _setup, update_notice_ack: _ack, extensions: _extensions, ...defaults } = settingDefaults(settings.site_url);
  return SettingsSchema.parse({
    ...settingsFields(settings as unknown as Record<string, unknown>),
    feedOrders: feedOrderChoices(settings.extensions),
    // What "reset to default" restores (setup wizard). site_title's default is
    // derived from the address: the Studio shows the derived title and stores
    // "" when that is what is chosen, so it stays derived if the address moves.
    defaults: settingsFields(defaults),
  });
}
