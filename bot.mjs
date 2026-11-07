import {
  Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits,
  Routes, SlashCommandBuilder,
} from 'discord.js';
import { categoryLabel, channelLabel, roleMenus, roles } from './plan.mjs';
import { clearRole, menuPrefix } from './role-panel.mjs';
import { cleanupCommand, createCleanup } from './cleanup.mjs';
import { controls, manualRoles, moderationButtons, panelModal, verificationButton } from './panels.mjs';
import { boostSystemSettings, createSecurity, securityCommands } from './security.mjs';
import { createTickets } from './tickets.mjs';
import {
  applySetup, botPermissions, configuredCleanupRole, inspect, installProtection, loadState,
  SetupError, withSetupLock,
} from './setup.mjs';

const snowflake = /^\d{17,20}$/;
if (process.argv[2] === '--link') {
  const appId = process.argv[3] ?? '';
  if (!snowflake.test(appId)) throw new Error('Podaj Application ID skopiowane z Discord Developer Portal.');
  const query = new URLSearchParams({
    client_id: appId, scope: 'bot applications.commands',
    permissions: (botPermissions.bitfield | (PermissionFlagsBits.PinMessages ?? 0n)).toString(),
    integration_type: '0',
  });
  console.log('https://discord.com/oauth2/authorize?' + query);
  process.exit(0);
}

const token = process.env.DISCORD_TOKEN?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim() ?? '';
if (!token || !snowflake.test(guildId)) {
  console.error('Uzupełnij DISCORD_TOKEN i DISCORD_GUILD_ID w ustawieniach Railway lub lokalnym pliku .env.');
  process.exit(1);
}
if (process.env.RAILWAY_PROJECT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.error('Podłącz trwały dysk Railway do usługi bota przed uruchomieniem.');
  process.exit(1);
}

const interestRoles = roles.filter((role) => role.group === 'tematy');
const ownerCommand = (name, description) => new SlashCommandBuilder()
  .setName(name).setDescription(description).setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const commands = [
  ownerCommand('serwer-plan', 'Sprawdź, jakie role i kanały doda konfigurator.'),
  ownerCommand('serwer-zbuduj', 'Utwórz strukturę serwera społecznościowego.')
    .addStringOption((option) => option.setName('potwierdzenie')
      .setDescription('Wpisz BUDUJ, aby uruchomić konfigurację.').setRequired(true)),
  ownerCommand('serwer-ochrona', 'Włącz blokadę masowych oznaczeń i alerty w kanale logów.')
    .addStringOption((option) => option.setName('potwierdzenie')
      .setDescription('Wpisz WLACZ, aby dodać regułę AutoMod.').setRequired(true)),
  ownerCommand('serwer-boosty', 'Ustaw nowy kanał jako kanał systemowy dla powiadomień o boostach.')
    .addStringOption((option) => option.setName('potwierdzenie')
      .setDescription('Wpisz WLACZ, aby zmienić kanał systemowy Discorda.').setRequired(true)),
  ownerCommand('serwer-rola', 'Przydziel lub zdejmij skonfigurowaną rolę ekipy lub wyróżnienia.')
    .addUserOption((option) => option.setName('osoba').setDescription('Użytkownik serwera').setRequired(true))
    .addStringOption((option) => option.setName('ranga').setDescription('Rola z szablonu serwera').setRequired(true)
      .addChoices(...manualRoles.map(({ key, name }) => ({ name, value: key }))))
    .addStringOption((option) => option.setName('akcja').setDescription('Dodaj lub usuń').setRequired(true)
      .addChoices({ name: 'Dodaj', value: 'add' }, { name: 'Usuń', value: 'remove' })),
  cleanupCommand,
  ...securityCommands,
  new SlashCommandBuilder().setName('ogloszenie').setDescription('Opublikuj kartę ogłoszenia lub wydarzenia.')
    .addStringOption((option) => option.setName('kanal').setDescription('Gdzie opublikować kartę').setRequired(true)
      .addChoices({ name: 'Ogłoszenia', value: 'ogloszenia' }, { name: 'Wydarzenia i turnieje', value: 'wydarzenia' }))
    .addStringOption((option) => option.setName('tytul').setDescription('Tytuł karty').setMaxLength(120).setRequired(true))
    .addStringOption((option) => option.setName('tresc').setDescription('Treść karty').setMaxLength(1400).setRequired(true)),
  new SlashCommandBuilder().setName('rola').setDescription('Dodaj sobie lub usuń wybraną rolę społecznościową.')
    .addStringOption((option) => option.setName('wybor').setDescription('Rola do zmiany').setRequired(true)
      .addChoices(...interestRoles.map((role) => ({ name: role.name, value: role.key }))))
    .addStringOption((option) => option.setName('akcja').setDescription('Dodaj lub usuń').setRequired(true)
      .addChoices({ name: 'Dodaj', value: 'add' }, { name: 'Usuń', value: 'remove' })),
  new SlashCommandBuilder().setName('zglos').setDescription('Wyślij prywatne zgłoszenie do moderacji.')
    .addStringOption((option) => option.setName('opis').setDescription('Opisz sytuację. Możesz dodać link do wiadomości.')
      .setRequired(true).setMinLength(5).setMaxLength(1200)),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Message, Partials.GuildMember, Partials.User],
});
let journal = await loadState(guildId);
const cleanup = createCleanup();
const security = createSecurity({ client, guildId, getState: () => journal.state, logError });
const tickets = createTickets({ getState: () => journal.state, log: security.log, logError });
const changingRoles = new Set();
let building = false;
let startupSummary = 'Bot uruchamia konfigurację.';
const manualActions = ['ostrzez', 'timeout', 'untimeout', 'wyrzuc', 'zbanuj'];

async function withConfiguration(task) {
  if (building) throw new SetupError('Konfiguracja jest już w toku.');
  building = true;
  try {
    return await withSetupLock(guildId, async () => {
      journal = await loadState(guildId);
      return task();
    });
  } finally {
    building = false;
  }
}

async function runSetup(guild, notify = async () => {}) {
  return withConfiguration(async () => {
    const plan = await inspect(guild, journal.state);
    await notify();
    const messages = await applySetup(guild, journal, plan);
    const verificationStatus = await security.gateRoles(guild, true).then(() => {
      console.log('Role weryfikacji są gotowe do nadawania.');
      return '';
    }).catch((error) => {
      logError(error);
      return '\nWeryfikacja wymaga sprawdzenia hierarchii lub uprawnień ról.';
    });
    const cleanupRoleId = configuredCleanupRole();
    if (cleanupRoleId) {
      const role = await guild.roles.fetch(cleanupRoleId, { force: true }).catch(logError);
      if (role && role.id !== guild.id) {
        const name = process.env.DISCORD_CLEANUP_ROLE_NAME?.trim();
        const labelKey = (label) => label.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('pl');
        let activeName = role.name;
        if (name && labelKey(name) !== labelKey(activeName)) {
          try {
            const renamed = await role.setName(name, 'Nazwa roli wyznaczonej do sprzątania starych kanałów');
            activeName = renamed.name;
          } catch (error) {
            logError(error);
            console.warn('Nie udało się zmienić nazwy roli sprzątania. Sprawdź jej pozycję względem roli bota.');
          }
        }
        console.log(`Rola sprzątania starych kanałów aktywna: ${role.id} (${activeName.replace(/[\r\n]/g, ' ').trim()}).`);
      } else {
        console.warn(`Nie znaleziono roli do sprzątania starych kanałów: ${cleanupRoleId}.`);
      }
    }
    const protectionStatus = await installProtection(guild, journal.state).catch((error) => {
      logError(error);
      return 'AutoMod wymaga sprawdzenia ustawień i uprawnień w Discordzie.';
    });
    let boostStatus = '';
    if (!journal.state.boostSystemConfigured) {
      try {
        await guild.edit(boostSystemSettings(guild, journal.state));
        journal.state.boostSystemConfigured = true;
        await journal.save();
      } catch (error) {
        logError(error);
        boostStatus = '\nPowiadomienia o kolejnych boostach wymagają ustawienia kanału systemowego.';
      }
    }
    security.refreshStats(guild).catch(logError);
    startupSummary = `Gotowe. Dodano role (${plan.newRoles.length}), kategorie (${plan.newCategories.length}), kanały (${plan.newChannels.length}) i karty (${messages}).\n\n${protectionStatus}${boostStatus}${verificationStatus}`;
    return startupSummary;
  });
}

async function authorizedCleanup(interaction, action, code, { panel = false } = {}) {
  const guild = await interaction.guild.fetch();
  if (interaction.user.id !== guild.ownerId) {
    const roleId = configuredCleanupRole();
    const member = roleId && roleId !== guild.id && await guild.members.fetch({ user: interaction.user.id, force: true });
    if (!member || member.pending || member.isCommunicationDisabled() || !member.roles.cache.has(roleId)) {
      throw new SetupError('Usuwanie starych kanałów jest dostępne tylko dla właściciela lub osoby z wyznaczoną rolą.');
    }
  }
  return withConfiguration(() => cleanup(guild, journal.state, {
    action, code, panel, channelId: interaction.channelId, requesterId: interaction.user.id,
  }));
}

async function setManagedRole(guild, actorId, targetId, key, action) {
  if (actorId !== guild.ownerId) throw new SetupError('Rangi ekipy może zmieniać tylko właściciel.');
  const roleId = journal.state.roles[key];
  if (!roleId || !manualRoles.some((role) => role.key === key) || !['add', 'remove'].includes(action)) {
    throw new SetupError('Wybierz rolę ekipy lub wyróżnienie z listy.');
  }
  const member = await guild.members.fetch({ user: targetId, force: true });
  const role = await guild.roles.fetch(roleId, { force: true });
  if (!member.manageable || !role?.editable) throw new SetupError('Hierarchia ról blokuje tę zmianę.');
  await member.roles[action](role.id, `Zmiana rangi przez właściciela ${actorId}`);
  return `${action === 'add' ? 'Przyznano' : 'Zdjęto'} rolę „${role.name}”.`;
}

function planText({ newRoles, newCategories, newChannels, migration }) {
  const list = (items) => items.length ? items.join(', ') : 'brak';
  return [
    '**Elementy do utworzenia**',
    `Role (${newRoles.length}) — ${list(newRoles.map(({ name }) => name))}`,
    `Kategorie (${newCategories.length}) — ${list(newCategories.map(categoryLabel))}`,
    `Kanały (${newChannels.length}) — ${list(newChannels.map(({ channel }) => channelLabel(channel)))}`,
    `Aktualizacje zapisanych kategorii i kanałów: ${migration.length}.`,
    'Konfigurator doda też brakujące wiadomości startowe. Uruchom **/serwer-zbuduj** z potwierdzeniem **BUDUJ**.',
  ].join('\n');
}

async function configure(interaction) {
  if (interaction.commandName === 'serwer-porzadki') {
    return authorizedCleanup(interaction, interaction.options.getSubcommand(), interaction.options.getString('kod')?.trim());
  }
  const guild = await interaction.guild.fetch();
  if (interaction.user.id !== guild.ownerId) {
    throw new SetupError('Tę komendę może wykonać tylko właściciel serwera.');
  }
  if (building) throw new SetupError('Konfiguracja jest już w toku.');
  if (interaction.commandName === 'serwer-plan') return planText(await inspect(guild, (await loadState(guildId)).state));
  if (interaction.commandName === 'serwer-rola') {
    const user = interaction.options.getUser('osoba', true);
    return setManagedRole(guild, interaction.user.id, user.id, interaction.options.getString('ranga', true),
      interaction.options.getString('akcja', true));
  }
  const protection = interaction.commandName === 'serwer-ochrona';
  const boostSetup = interaction.commandName === 'serwer-boosty';
  const confirmation = protection || boostSetup ? 'WLACZ' : 'BUDUJ';
  if (interaction.options.getString('potwierdzenie', true).trim() !== confirmation) {
    throw new SetupError(`Wpisz dokładnie ${confirmation} w polu potwierdzenia.`);
  }

  if (protection) return withConfiguration(() => installProtection(guild, journal.state));
  if (boostSetup) return withConfiguration(async () => {
    await guild.edit(boostSystemSettings(guild, journal.state));
    journal.state.boostSystemConfigured = true;
    await journal.save();
    return `Ustawiono <#${journal.state.channels.witamy}> jako kanał systemowy dla powiadomień o boostach.`;
  });
  return runSetup(guild, () => interaction.editReply('Tworzę elementy na Discordzie. To może chwilę potrwać.'));
}

async function announce(interaction, member, key = interaction.options.getString('kanal', true),
  title = interaction.options.getString('tytul', true), text = interaction.options.getString('tresc', true)) {
  if (!['ogloszenia', 'wydarzenia'].includes(key)) throw new SetupError('Wybierz kanał z listy.');
  const id = journal.state.channels[key];
  if (!id) throw new SetupError('Najpierw ukończ konfigurację serwera.');
  const channel = await interaction.guild.channels.fetch(id, { force: true });
  if (!channel?.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new SetupError('Brakuje Ci uprawnień do publikacji na tym kanale.');
  }
  const embed = new EmbedBuilder().setColor(key === 'ogloszenia' ? 0x5865F2 : 0xA76DEC)
    .setTitle(title).setDescription(text)
    .setFooter({ text: 'CENTRUM SPOŁECZNOŚCI' }).setTimestamp();
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  await security.log(interaction.guild, '📣 Publikacja ogłoszenia', `Osoba: <@${member.id}>\nKanał: <#${id}>`);
  return `Ogłoszenie opublikowano w <#${id}>.`;
}

async function safeRoles(guild, definitions) {
  if (definitions.some(({ key }) => !journal.state.roles[key])) {
    throw new SetupError('Role do wyboru będą dostępne po konfiguracji serwera.');
  }
  const [serverRoles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const selected = definitions.map(({ key }) => serverRoles.get(journal.state.roles[key]));
  if (selected.some((role) => !role?.editable || role.permissions.bitfield !== 0n ||
      channels.some((channel) => channel.permissionOverwrites?.cache.has(role.id)))) {
    throw new SetupError('Administracja musi sprawdzić uprawnienia tej roli.');
  }
  return selected;
}

async function changeRole(interaction, member) {
  const key = interaction.options.getString('wybor', true);
  const action = interaction.options.getString('akcja', true);
  const definition = interestRoles.find((role) => role.key === key);
  if (!definition || !['add', 'remove'].includes(action)) {
    throw new SetupError('Wybierz rolę i akcję z listy.');
  }
  const [role] = await safeRoles(interaction.guild, [definition]);
  await member.roles[action](role.id, 'Samodzielna zmiana roli');
  return `${action === 'add' ? 'Dodano' : 'Usunięto'} rolę „${role.name}”.`;
}

async function usePanel(interaction, member) {
  if (interaction.channelId !== journal.state.channels['wybierz-role'] ||
      interaction.message.id !== journal.state.messages['wybierz-role']) {
    throw new SetupError('Otwórz aktualny panel na kanale #wybierz-role.');
  }
  const group = roleMenus.find(({ key }) => menuPrefix + key === interaction.customId);
  if (!group) throw new SetupError('To menu wyboru ról jest nieaktualne.');
  const definitions = roles.filter((role) => role.group === group.key);
  const values = interaction.values;
  const clear = values.length === 1 && values[0] === clearRole;
  if (!clear && (!values.length || (!group.multiple && values.length !== 1) ||
      !values.every((value) => definitions.some(({ key }) => key === value)))) {
    throw new SetupError('Wybierz role z listy albo samą opcję Bez roli.');
  }

  const choices = await safeRoles(interaction.guild, definitions);
  const wantedIds = new Set(values.map((key) => journal.state.roles[key]).filter(Boolean));
  for (const role of choices) {
    if (member.roles.cache.has(role.id) && !wantedIds.has(role.id)) {
      await member.roles.remove(role.id, 'Zmiana w panelu wyboru ról');
    }
  }
  for (const role of choices) {
    if (wantedIds.has(role.id) && !member.roles.cache.has(role.id)) {
      await member.roles.add(role.id, 'Zmiana w panelu wyboru ról');
    }
  }
  const names = choices.filter((role) => wantedIds.has(role.id)).map((role) => role.name);
  return names.length ? `Zapisano wybór: ${names.join(', ')}.` : 'Usunięto role z tej grupy.';
}

async function submitReport(interaction, text = interaction.options.getString('opis', true)) {
  return tickets.open(interaction, text);
}

function logError(error) {
  console.error('Błąd Discorda lub konfiguracji:', error.name, error.code ?? '', error.status ?? '');
  if (Number(error.code) !== 50035 || !error.rawError?.errors) return;
  const fields = [];
  function collect(node, path = '') {
    for (const { code } of node._errors ?? []) {
      if (/^[A-Z0-9_]+$/.test(code)) fields.push(`${path || '(root)'}=${code}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== '_errors' && /^[a-zA-Z0-9_]+$/.test(key) && value && typeof value === 'object') {
        collect(value, path ? `${path}.${key}` : key);
      }
    }
  }
  collect(error.rawError.errors);
  const route = /^https:\/\/discord\.com\/api\/v\d+\/(guilds|channels)\/\d+(\/roles|\/channels|\/messages)?$/.exec(error.url ?? '');
  console.error('Odrzucone pola Discorda:', route ? [route[1], route[2] ?? ''].join('') : 'formularz', fields.slice(0, 20).join(', '));
}

function loginFailure(error) {
  if (error.message === 'Used disallowed intents' || Number(error.code) === 4014) {
    return 'Discord odrzucił logowanie (4014). W Discord Developer Portal → Bot → Privileged Gateway Intents włącz Server Members Intent i Presence Intent.';
  }
  if (error.message === 'Authentication failed' || error.code === 'TokenInvalid' ||
      Number(error.code) === 4004 || error.status === 401) {
    return 'Discord odrzucił token. Ustaw aktualny token z zakładki Bot w zmiennej DISCORD_TOKEN na Railway.';
  }
  return 'Logowanie bota nie powiodło się. Sprawdź połączenie z Discordem i ustawienia aplikacji.';
}

function validateControl(interaction, action) {
  const state = journal.state;
  if (action === 'ticket-close' && state.securityReady && interaction.message?.author?.id === interaction.client.user.id) return;
  const legacyReview = ['approve-queue', 'hold-queue'].includes(action) && interaction.channelId === state.channels['mod-log'];
  const publicPanel = ['report', 'send-report'].includes(action);
  const key = publicPanel ? 'start-tutaj' : legacyReview ? 'mod-log' : 'logi-bota';
  const mainPanel = publicPanel || ['status', 'announce', 'publish', 'moderate',
    'unban', 'lift-ban', 'clear-channel', 'clear'].includes(action);
  if (!state.securityReady || interaction.channelId !== state.channels[key] ||
      interaction.message?.author?.id !== interaction.client.user.id ||
      (mainPanel && interaction.message.id !== state.messages[key])) {
    throw new SetupError('Otwórz aktualny panel na właściwym kanale.');
  }
}

async function useControl(interaction, action, key, id) {
  if (action === 'delete' && /^\d{6}$/.test(key)) {
    return authorizedCleanup(interaction, 'usun', key, { panel: true, fromStart: action === 'delete-start' });
  }

  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (member.pending || member.isCommunicationDisabled()) {
    throw new SetupError('Panel jest niedostępny podczas weryfikacji Discorda lub ograniczenia konta.');
  }
  if (action === 'send-report' && interaction.isModalSubmit()) {
    return submitReport(interaction, interaction.fields.getTextInputValue('opis'));
  }
  if (action === 'ticket-close' && interaction.isButton()) return tickets.close(interaction, member);
  if (action === 'status') return startupSummary + '\n\n' + security.statisticsReply(interaction.guild);
  if (action === 'publish' && interaction.isModalSubmit()) {
    return announce(interaction, member, key, interaction.fields.getTextInputValue('tytul'),
      interaction.fields.getTextInputValue('tresc'));
  }
  if (action === 'lift-ban' && interaction.isModalSubmit()) {
    return security.moderate(interaction, member, { action: 'odbanuj',
      id: interaction.fields.getTextInputValue('id'), reason: interaction.fields.getTextInputValue('powod') });
  }
  if (action === 'clear' && interaction.isModalSubmit() && snowflake.test(key)) {
    return security.previewClear(interaction.guild, member, key, Number(interaction.fields.getTextInputValue('liczba').trim()));
  }
  if (action === 'confirm-clear' && interaction.isButton()) {
    return security.confirmClear(interaction.guild, member, key);
  }
  if (action === 'moderate' && interaction.isUserSelectMenu()) {
    if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      throw new SetupError('Brakuje Ci uprawnień do moderacji.');
    }
    const selected = interaction.values[0];
    return { content: `Wybrana osoba: <@${selected}>. Wybierz działanie.`,
      components: moderationButtons(selected, member.id === interaction.guild.ownerId) };
  }
  if (action === 'role' && interaction.isStringSelectMenu() && snowflake.test(key)) {
    const [change, role] = interaction.values[0].split(':');
    return setManagedRole(await interaction.guild.fetch(), member.id, key, role, change);
  }
  if (action === 'apply' && interaction.isModalSubmit() && manualActions.includes(key) && snowflake.test(id)) {
    return security.moderate(interaction, member, {
      action: key, id, reason: interaction.fields.getTextInputValue('powod'),
      minutes: key === 'timeout' ? Number(interaction.fields.getTextInputValue('minuty').trim()) : undefined,
    });
  }
  const reviewActions = { approve: 'zatwierdz', 'approve-queue': 'zatwierdz', hold: 'wstrzymaj',
    'hold-queue': 'wstrzymaj', unlock: 'odblokuj' };
  if (Object.hasOwn(reviewActions, action) && interaction.isButton() && snowflake.test(key)) {
    const queueOnly = action.endsWith('-queue');
    const result = await security.review(interaction, member, {
      action: reviewActions[action], id: key, reason: 'Rozpatrzono w panelu weryfikacji', queueOnly,
    });
    if (queueOnly) await interaction.message.edit({ components: [] }).catch(logError);
    return result;
  }
  throw new SetupError('Ta opcja panelu jest nieaktualna.');
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inCachedGuild() || interaction.guildId !== guildId) return;
  const panel = interaction.isStringSelectMenu() && interaction.customId.startsWith(menuPrefix);
  const verifying = interaction.isButton() && interaction.customId === verificationButton;
  const control = (interaction.isButton() || interaction.isStringSelectMenu() ||
    interaction.isUserSelectMenu() || interaction.isChannelSelectMenu() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith(controls);
  const command = interaction.isChatInputCommand() && commands.some(({ name }) => name === interaction.commandName);
  if (!panel && !verifying && !control && !command) return;
  const user = interaction.user.id;
  const roleChange = panel || interaction.commandName === 'rola';
  let acquired = false;
  try {
    const [action, key, id] = control ? interaction.customId.slice(controls.length).split(':') : [];
    if (control) {
      validateControl(interaction, action);
      if (building) throw new SetupError('Konfiguracja jest w toku. Spróbuj za chwilę.');
      if (interaction.isButton() && (['report', 'unban'].includes(action) ||
        (action === 'announce' && ['ogloszenia', 'wydarzenia'].includes(key)) ||
        (action === 'action' && manualActions.includes(key) && snowflake.test(id)))) {
        await interaction.showModal(panelModal(action, key, id));
        return;
      }
      if (interaction.isChannelSelectMenu() && action === 'clear-channel' && snowflake.test(interaction.values[0])) {
        await interaction.showModal(panelModal(action, interaction.values[0]));
        return;
      }
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let result;
    if (command && interaction.commandName.startsWith('serwer-')) {
      result = await configure(interaction);
    } else if (control) {
      result = await useControl(interaction, action, key, id);
    } else if (verifying) {
      if (building) throw new SetupError('Konfiguracja jest w toku. Spróbuj za chwilę.');
      result = await security.accept(interaction);
    } else {
      if (building) throw new SetupError('Konfiguracja jest w toku. Spróbuj za chwilę.');
      if (roleChange) {
        if (changingRoles.has(user)) throw new SetupError('Trwa zmiana Twoich ról. Spróbuj za chwilę.');
        changingRoles.add(user);
        acquired = true;
      }
      const member = await interaction.guild.members.fetch({ user, force: true });
      if (member.pending || member.isCommunicationDisabled()) {
        throw new SetupError('Komenda jest niedostępna podczas weryfikacji lub ograniczenia konta na serwerze.');
      }
      if (roleChange && !security.isVerified(member)) {
        throw new SetupError('Najpierw zaakceptuj regulamin i uzyskaj rolę Zweryfikowany.');
      }
      if (panel) result = await usePanel(interaction, member);
      else if (roleChange) result = await changeRole(interaction, member);
      else if (interaction.commandName === 'zglos') result = await submitReport(interaction);
      else if (interaction.commandName === 'weryfikacja') result = await security.review(interaction, member);
      else if (interaction.commandName === 'moderacja') result = await security.moderate(interaction, member);
      else if (interaction.commandName === 'ogloszenie') result = await announce(interaction, member);
      else result = security.statisticsReply(interaction.guild);
    }
    await interaction.editReply({ ...(typeof result === 'string' ? { content: result } : result),
      allowedMentions: { parse: [] } });
  } catch (error) {
    if (!(error instanceof SetupError)) logError(error);
    const fallback = interaction.commandName === 'serwer-zbuduj'
      ? 'Konfiguracja została przerwana. Sprawdź uprawnienia i dziennik bota, a potem uruchom ją ponownie.'
      : 'Operacja została przerwana. Spróbuj ponownie lub skontaktuj się z administracją.';
    const response = { content: error instanceof SetupError ? error.message : fallback, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(response).catch(logError);
    else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral }).catch(logError);
  } finally {
    if (acquired) changingRoles.delete(user);
  }
});

client.on(Events.Error, logError);
client.once(Events.ClientReady, async (readyClient) => {
  let guild;
  try {
    guild = await readyClient.guilds.fetch(guildId);
  } catch (error) {
    logError(error);
    console.error('Nie udało się otworzyć serwera. Sprawdź jego ID i czy bot został zaproszony.');
    client.destroy();
    process.exitCode = 1;
    return;
  }
  const registeredCommands = process.env.DISCORD_SLASH_COMMANDS === 'true' ? commands
    : configuredCleanupRole() ? [cleanupCommand] : [];
  if (registeredCommands.length) {
    const route = Routes.applicationGuildCommands(readyClient.application.id, guild.id);
    for (const command of registeredCommands) {
      await readyClient.rest.post(route, { body: command.toJSON() }).catch(logError);
    }
  }
  console.log(`Bot połączył się z serwerem „${guild.name}”. Rozpoczynam automatyczną konfigurację.`);
  security.syncPresence(guild).then(() => security.refreshStats(guild)).catch(logError);
  try {
    console.log(await runSetup(guild));
    console.log('Panele znajdziesz na kanale startowym i w logi-bota. Modzi służy do rozmów ekipy.');
  } catch (error) {
    logError(error);
    startupSummary = error instanceof SetupError ? error.message
      : 'Automatyczna konfiguracja została przerwana. Sprawdź połączenie i uprawnienia bota.';
    console.error(startupSummary);
  }
});

try {
  await client.login(token);
} catch (error) {
  logError(error);
  console.error(loginFailure(error));
  client.destroy();
  process.exitCode = 1;
}
