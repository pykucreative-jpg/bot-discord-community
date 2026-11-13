import { ChannelType, GuildExplicitContentFilter, GuildOnboardingPromptType, GuildVerificationLevel } from 'discord.js';
import { gamePingRoles } from './plan.mjs';
import { SetupError } from './setup.mjs';

const version = 1;
const welcomeChannels = ['ogolny', 'media-i-memy', 'tik-toki', 'propozycje', 'plus-fun-chat'];
const startingChannels = ['start-tutaj', 'regulamin', ...welcomeChannels];
const titles = ['🎮 W co grasz?', '✨ Co Cię interesuje?', '🔔 Chcesz powiadomienia o wydarzeniach?'];

export async function setupOnboarding(guild, journal) {
  const { state, save } = journal;
  if (!state.securityReady) throw new SetupError('Najpierw ukończ konfigurację serwera.');
  if (!guild.features.includes('COMMUNITY')) {
    const bot = await guild.members.fetchMe();
    if (!bot.permissions.has('Administrator')) {
      throw new SetupError('Najpierw właściciel musi włączyć funkcję Społeczność w ustawieniach Discorda. Bot nie ma Administratora wymaganego do tej zmiany.');
    }
    const rulesChannel = state.channels.regulamin;
    const publicUpdatesChannel = state.channels['logi-bota'];
    if (!rulesChannel || !publicUpdatesChannel) throw new SetupError('Brakuje kanału regulaminu lub prywatnych komunikatów administracji.');
    await guild.edit({
      features: [...guild.features, 'COMMUNITY'], rulesChannel, publicUpdatesChannel,
      verificationLevel: Math.max(guild.verificationLevel, GuildVerificationLevel.Low),
      explicitContentFilter: GuildExplicitContentFilter.AllMembers,
      reason: 'Włączenie Społeczności wymaganej do personalizacji nowych członków',
    });
  }
  const [channels, roles, current] = await Promise.all([
    guild.channels.fetch(), guild.roles.fetch(), guild.fetchOnboarding(),
  ]);
  if (state.onboardingVersion === version && current.enabled) {
    console.log(`Personalizacja Discorda aktywna: ${current.prompts.size} pytań, ${current.defaultChannels.size} kanałów startowych.`);
    return;
  }
  const defaults = startingChannels.map((key) => channels.get(state.channels[key]));
  if (defaults.some((channel) => channel?.type !== ChannelType.GuildText)) {
    throw new SetupError('Brakuje jednego z siedmiu kanałów startowych do personalizacji.');
  }
  function roleOption(key, title, emoji) {
    const role = roles.get(state.roles[key]);
    if (!role || role.managed || !role.editable || role.permissions.bitfield !== 0n ||
        channels.some((channel) => channel?.permissionOverwrites?.cache.has(role.id))) {
      throw new SetupError(`Sprawdź opcjonalną rolę „${title}” przed dodaniem do personalizacji.`);
    }
    return { title, roles: [role.id], channels: [], emoji };
  }
  const definitions = [
    { title: titles[0], type: GuildOnboardingPromptType.Dropdown,
      options: gamePingRoles.map(({ key, name }) => roleOption(key, name, '🎮')) },
    { title: titles[1], type: GuildOnboardingPromptType.MultipleChoice,
      options: [roleOption('gaming', 'Wspólne granie', '🎮'), roleOption('music', 'Muzyka i chill', '🎵'),
        roleOption('tech', 'Technologia', '💻')] },
    { title: titles[2], type: GuildOnboardingPromptType.MultipleChoice, singleSelect: true,
      options: [roleOption('events', 'Tak, chcę wiedzieć o wydarzeniach', '📅'),
        { title: 'Na razie bez powiadomień', roles: [], channels: [state.channels.regulamin], emoji: '🌙' }] },
  ];
  const preserved = current.prompts.filter((prompt) => !titles.includes(prompt.title)).map((prompt) => ({
    id: prompt.id, title: prompt.title, type: prompt.type, singleSelect: prompt.singleSelect,
    required: prompt.required, inOnboarding: prompt.inOnboarding,
    options: prompt.options.map((option) => ({
      id: option.id, title: option.title, description: option.description, emoji: option.emoji,
      roles: [...option.roles.keys()], channels: [...option.channels.keys()],
    })),
  }));
  const prompts = [...preserved, ...definitions.map((prompt) => {
    const previous = current.prompts.find(({ title }) => title === prompt.title);
    return { ...prompt, id: previous?.id, required: false, inOnboarding: true,
      singleSelect: prompt.singleSelect ?? false,
      options: prompt.options.map((option) => ({
        ...option, id: previous?.options.find(({ title }) => title === option.title)?.id,
      })) };
  })];
  const bot = await guild.members.fetchMe();
  if (!bot.permissions.has(['ManageGuild', 'ManageRoles', 'ManageChannels'])) {
    throw new SetupError('Bot potrzebuje uprawnień do serwera, ról i kanałów, aby włączyć personalizację.');
  }
  for (const channel of defaults.slice(2)) {
    if (!channel.permissionsFor(guild.roles.everyone)?.has(['ViewChannel', 'SendMessages'])) {
      await channel.permissionOverwrites.edit(guild.id, {
        ViewChannel: true, ReadMessageHistory: true, SendMessages: true, UseApplicationCommands: true,
      }, { reason: 'Kanał startowy Discorda dostępny przed weryfikacją za zgodą właściciela' });
    }
  }
  const writable = await guild.channels.fetch();
  if (!defaults.slice(2).every(({ id }) => writable.get(id)?.permissionsFor(guild.roles.everyone)?.has(['ViewChannel', 'SendMessages']))) {
    throw new SetupError('Discord nie zapisał dostępu do pięciu kanałów startowych.');
  }
  const result = await guild.editOnboarding({
    prompts, defaultChannels: defaults.map(({ id }) => id), enabled: true,
    reason: 'Po Godzinach — personalizacja nowego członka',
  });
  if (!result.enabled || !titles.every((title) => result.prompts.some((prompt) => prompt.title === title))) {
    throw new SetupError('Discord nie potwierdził włączenia pytań personalizacji.');
  }
  state.onboardingVersion = version;
  await save();
  console.log(`Personalizacja Discorda włączona: ${result.prompts.size} pytań, ${result.defaultChannels.size} kanałów startowych, pięć kanałów do pisania przed weryfikacją.`);
}
