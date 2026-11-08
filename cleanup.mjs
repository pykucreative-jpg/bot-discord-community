import { randomInt } from 'node:crypto';
import { AttachmentBuilder, ChannelType, GuildFeature, SlashCommandBuilder } from 'discord.js';
import { categories, musicChannelKey, musicPanelKey } from './plan.mjs';
import { confirmCleanup } from './panels.mjs';
import { channelEntries, inspect, SetupError } from './setup.mjs';
import { boostSystemSettings } from './security.mjs';
import { ticketDetails } from './tickets.mjs';

export const cleanupCommand = new SlashCommandBuilder()
  .setName('serwer-porzadki').setDescription('Usuń stare kanały i kategorie po zbudowaniu nowej struktury.')
  .addSubcommand((sub) => sub.setName('podglad').setDescription('Pokaż pełną listę elementów do usunięcia.'))
  .addSubcommand((sub) => sub.setName('usun').setDescription('Usuń kanały z ostatniego podglądu.')
    .addStringOption((option) => option.setName('kod').setDescription('Kod z podglądu, ważny przez 5 minut.').setRequired(true)));

export function createCleanup() {
  const confirmations = new Map();
  const order = (items) => items.sort((a, b) => Number(a.type === ChannelType.GuildCategory) -
    Number(b.type === ChannelType.GuildCategory) || a.id.localeCompare(b.id));
  const fingerprint = ({ id, name, parentId, type }) => JSON.stringify([id, name, parentId, type]);

  return async function cleanup(guild, state, { action, code, channelId, requesterId, panel = false }) {
    if (!state.securityReady) throw new SetupError('Poczekaj, aż bot zakończy budowę nowej struktury.');
    const { newRoles, newCategories, newChannels, migration } = await inspect(guild, state);
    if (newRoles.length || newCategories.length || newChannels.length || migration.length) {
      throw new SetupError('Nowa struktura jest niekompletna. Sprawdź komunikat startowy bota.');
    }
    const kept = new Set([
      ...categories.map(({ key }) => state.categories[key]),
      ...channelEntries.map(({ channel }) => state.channels[channel.name]),
      state.channels[musicChannelKey],
      state.channels[musicPanelKey],
    ]);
    const channels = await guild.channels.fetch();
    const obsolete = order([...channels.values()].filter((channel) => !kept.has(channel.id) && !ticketDetails(channel, state)));
    const now = Date.now();
    for (const [id, pending] of confirmations) {
      if (now >= pending.expires) confirmations.delete(id);
    }
    if (action === 'podglad') {
      confirmations.delete(requesterId);
      if (!obsolete.length) return 'Nie ma starych kanałów ani kategorii do usunięcia.';
      const previewCode = randomInt(100_000, 1_000_000).toString();
      confirmations.set(requesterId, { code: previewCode, list: obsolete.map(fingerprint), expires: now + 5 * 60_000 });
      const list = obsolete.map((channel) => {
        const parent = channels.get(channel.parentId);
        return `${parent ? parent.name + ' / ' : ''}${channel.name} [${channel.id}]`;
      }).join('\n');
      return {
        content: `**Do trwałego usunięcia: ${obsolete.length} kanałów i kategorii.** Pełna lista jest w załączniku. Usunięcie kanału usuwa też jego historię, wątki i posty na forum. ${panel
          ? 'Po sprawdzeniu listy możesz użyć przycisku. Potwierdzenie jest ważne 5 minut.'
          : `Po sprawdzeniu listy użyj **/serwer-porzadki usun** z kodem **${previewCode}**. Kod jest ważny 5 minut.`}`,
        files: [new AttachmentBuilder(Buffer.from(list, 'utf8'), { name: 'kanaly-do-usuniecia.txt' })],
        ...(panel ? { components: [confirmCleanup(previewCode)] } : {}),
      };
    }

    if (!kept.has(channelId)) {
      throw new SetupError('Potwierdź usuwanie w jednym z nowych kanałów.');
    }
    const snapshot = confirmations.get(requesterId);
    if (!snapshot || code !== snapshot.code) {
      throw new SetupError('Kod jest nieprawidłowy lub wygasł. Wygeneruj nowy podgląd.');
    }
    confirmations.delete(requesterId);
    if (obsolete.length !== snapshot.list.length || obsolete.some((channel, i) => fingerprint(channel) !== snapshot.list[i])) {
      throw new SetupError('Lista kanałów zmieniła się od podglądu. Wygeneruj nowy podgląd.');
    }

    const obsoleteIds = new Set(obsolete.map(({ id }) => id));
    const references = {};
    if (guild.features.includes(GuildFeature.Community)) {
      if (obsoleteIds.has(guild.rulesChannelId)) references.rulesChannel = state.channels.regulamin;
      if (obsoleteIds.has(guild.publicUpdatesChannelId)) references.publicUpdatesChannel = state.channels['mod-log'];
      if (obsoleteIds.has(guild.safetyAlertsChannelId)) references.safetyAlertsChannel = state.channels['log-ochrona'];
    }
    if (!guild.systemChannelId || obsoleteIds.has(guild.systemChannelId)) Object.assign(references, boostSystemSettings(guild, state));
    if (obsoleteIds.has(guild.afkChannelId)) references.afkChannel = null;
    if (Object.keys(references).length) await guild.edit(references);

    let removed = 0;
    for (const channel of obsolete) {
      try {
        if (channel.type === ChannelType.GuildCategory) {
          const latest = await guild.channels.fetch();
          if (latest.some(({ parentId }) => parentId === channel.id)) {
            throw new SetupError('W kategorii pojawił się kanał.');
          }
        }
        await channel.delete(`Porządki po budowie serwera potwierdzone przez użytkownika ${requesterId}`);
        removed++;
      } catch (error) {
        throw new SetupError(`Usunięto ${removed} z ${obsolete.length} elementów. Operacja zatrzymała się na „${channel.name}”. Sprawdź ustawienia kanału i wygeneruj nowy podgląd.`, { cause: error });
      }
    }
    return `Usunięto ${removed} starych kanałów i kategorii. Nowa struktura jest gotowa.`;
  };
}
