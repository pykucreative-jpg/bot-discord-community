import { createHash, randomUUID } from 'node:crypto';
import {
  AuditLogEvent, ChannelType, EmbedBuilder, Events, GuildAuditLogsEntry, MessageType, PermissionFlagsBits,
  SlashCommandBuilder, SystemChannelFlagsBitField, escapeMarkdown,
} from 'discord.js';
import { channelLabel, musicChannelKey, musicPanelKey, verificationSeparators } from './plan.mjs';
import { confirmMessageClear, reviewButtons } from './panels.mjs';
import { isApplicationChannel, lockTicketChannel } from './tickets.mjs';
import {
  channelEntries, isStatsChannel, lockReadOnlyChannel, lockStatsChannel, privateModerationChannel,
  restrictChannelMentions, restrictRoleMentions, SetupError,
} from './setup.mjs';

const DAY = 86_400_000;
const newAccountAge = 7 * DAY;
const messageAgeLimit = 14 * DAY;
const clearPreviewDuration = 5 * 60_000;
const NO_MENTIONS = { parse: [] };
const memberNoticeChannels = ['witamy', 'pozegnania'];
const noticePermissions = ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'EmbedLinks'];
const departureTitle = '📤 Opuszczenie serwera';
const joinTitle = '📥 Wejście na serwer';
const kickTitle = '🧾 Wyrzucono członka';
const kickHistoryWindow = 30 * 60_000;
const auditActions = new Map(Object.entries({
  GuildUpdate: 'Zmieniono ustawienia serwera',
  ChannelCreate: 'Utworzono kanał', ChannelUpdate: 'Zmieniono ustawienia kanału', ChannelDelete: 'Usunięto kanał',
  ChannelOverwriteCreate: 'Dodano uprawnienia w kanale', ChannelOverwriteUpdate: 'Zmieniono uprawnienia w kanale',
  ChannelOverwriteDelete: 'Usunięto nadpisanie uprawnień w kanale',
  MemberKick: 'Wyrzucono członka', MemberPrune: 'Usunięto nieaktywnych członków',
  MemberBanAdd: 'Zbanowano użytkownika', MemberBanRemove: 'Zdjęto bana',
  MemberUpdate: 'Zmieniono ustawienia członka', MemberRoleUpdate: 'Zmieniono role członka',
  RoleCreate: 'Utworzono rolę', RoleUpdate: 'Zmieniono rolę', RoleDelete: 'Usunięto rolę',
  InviteCreate: 'Utworzono zaproszenie', InviteDelete: 'Usunięto zaproszenie',
  WebhookCreate: 'Utworzono webhook', WebhookUpdate: 'Zmieniono webhook', WebhookDelete: 'Usunięto webhook',
  MessageDelete: 'Usunięto wiadomość', MessageBulkDelete: 'Usunięto wiadomości zbiorczo',
  AutoModerationRuleCreate: 'Utworzono regułę AutoMod', AutoModerationRuleUpdate: 'Zmieniono regułę AutoMod',
  AutoModerationRuleDelete: 'Usunięto regułę AutoMod',
}).map(([key, description]) => [AuditLogEvent[key], description]));
const auditRoutes = new Map(Object.entries({
  'log-wiadomosci': ['MessageDelete', 'MessageBulkDelete'],
  'log-role': ['MemberRoleUpdate', 'RoleCreate', 'RoleUpdate', 'RoleDelete'],
  'log-moderacja': ['MemberKick', 'MemberPrune', 'MemberBanAdd', 'MemberBanRemove', 'MemberUpdate'],
  'log-ochrona': ['AutoModerationRuleCreate', 'AutoModerationRuleUpdate', 'AutoModerationRuleDelete'],
}).flatMap(([channel, actions]) => actions.map((action) => [AuditLogEvent[action], channel])));
const BOOST_TYPES = new Set([
  MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3,
]);
const boostChannelId = process.env.DISCORD_BOOST_CHANNEL_ID?.trim();

export function boostSystemSettings(guild, state) {
  if (!state.channels.witamy) throw new SetupError('Najpierw zbuduj kanał powitań.');
  const flags = SystemChannelFlagsBitField.Flags;
  const systemChannelFlags = new SystemChannelFlagsBitField(guild.systemChannelFlags?.bitfield ?? 0);
  systemChannelFlags.add(flags.SuppressJoinNotifications, flags.SuppressJoinNotificationReplies);
  systemChannelFlags.remove(flags.SuppressPremiumSubscriptions);
  return { systemChannel: state.channels.witamy, systemChannelFlags };
}

const userOption = (option) => option.setName('osoba').setDescription('Użytkownik serwera').setRequired(true);
const reasonOption = (option) => option.setName('powod').setDescription('Powód decyzji').setMinLength(3).setMaxLength(300).setRequired(true);
const personAction = (name, description) => (sub) => sub.setName(name).setDescription(description)
  .addUserOption(userOption).addStringOption(reasonOption);

export const securityCommands = [
  new SlashCommandBuilder().setName('weryfikacja').setDescription('Sprawdź lub zmień dostęp do społeczności.')
    .addSubcommand((sub) => sub.setName('status').setDescription('Sprawdź swój status weryfikacji.'))
    .addSubcommand(personAction('zatwierdz', 'Przyznaj dostęp osobie oczekującej na weryfikację.'))
    .addSubcommand(personAction('wstrzymaj', 'Odbierz dostęp lub wstrzymaj rozpatrzenie weryfikacji.'))
    .addSubcommand(personAction('odblokuj', 'Pozwól użytkownikowi ponownie przejść weryfikację.')),
  new SlashCommandBuilder().setName('moderacja').setDescription('Komendy dla moderatorów.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(personAction('ostrzez', 'Zapisz ostrzeżenie i wyślij informację użytkownikowi.'))
    .addSubcommand((sub) => personAction('timeout', 'Nałóż ograniczenie czasowe.')(sub)
      .addIntegerOption((option) => option.setName('minuty').setDescription('Czas od 1 minuty do 28 dni')
        .setMinValue(1).setMaxValue(40_320).setRequired(true)))
    .addSubcommand(personAction('untimeout', 'Zdejmij ograniczenie czasowe.'))
    .addSubcommand(personAction('wyrzuc', 'Wyrzuć użytkownika z serwera.'))
    .addSubcommand(personAction('zbanuj', 'Zablokuj użytkownika na serwerze.'))
    .addSubcommand((sub) => sub.setName('odbanuj').setDescription('Zdejmij blokadę z użytkownika po jego ID.')
      .addStringOption((option) => option.setName('id').setDescription('Identyfikator użytkownika Discord').setRequired(true))
      .addStringOption(reasonOption))
    .addSubcommand((sub) => sub.setName('wyczysc').setDescription('Usuń ostatnie wiadomości z tego kanału.')
      .addIntegerOption((option) => option.setName('liczba').setDescription('Od 1 do 100 wiadomości')
        .setMinValue(1).setMaxValue(100).setRequired(true))),
  new SlashCommandBuilder().setName('statystyki').setDescription('Pokaż liczbę osób online i offline.'),
];

function label(user) {
  return auditDisplayName(user);
}

function detail(value) {
  return escapeMarkdown(String(value ?? 'brak').slice(0, 350));
}

function auditDisplayName(user, displayName) {
  const name = displayName ?? user?.globalName ?? user?.username;
  if (!name) return 'Nazwa użytkownika niedostępna';
  return user?.username && name !== user.username ? detail(`${name} (@${user.username})`) : detail(name);
}

async function auditUserName(guild, id, known) {
  if (!id) return 'Discord lub automatyzacja';
  const member = guild.members.cache?.get(id);
  const user = known?.username ? known : (member?.user ?? guild.client.users?.cache.get(id) ??
    await guild.client.users?.fetch(id).catch(() => null));
  return auditDisplayName(user, member?.displayName);
}

function auditChannelName(guild, channel) {
  const name = channel?.name ?? guild.channels.cache?.get(channel?.id)?.name;
  return name ? `#${detail(name)}` : undefined;
}

async function auditTargetName(guild, entry) {
  const type = entry.targetType ?? GuildAuditLogsEntry.targetType(entry.action);
  const target = entry.target;
  const changedName = entry.changes?.find(({ key }) => key === 'name');
  const name = target?.name ?? changedName?.new ?? changedName?.old;
  if (type === 'User' || (type === 'Message' && entry.action === AuditLogEvent.MessageDelete)) {
    return entry.targetId ? auditUserName(guild, entry.targetId, target) : 'Członkowie serwera';
  }
  if (type === 'Guild') return detail(name ?? guild.name);
  if (type === 'Channel' || type === 'Thread' || entry.action === AuditLogEvent.MessageBulkDelete) {
    return name ? `#${detail(name)}` : auditChannelName(guild, { id: entry.targetId }) ?? 'Kanał niedostępny';
  }
  if (type === 'Role') return detail(name ?? guild.roles.cache?.get(entry.targetId)?.name ?? 'Rola niedostępna');
  if (type === 'Invite') {
    const channel = target?.channel ?? { id: entry.changes?.find(({ key }) => key === 'channel_id')?.new };
    return auditChannelName(guild, channel) ?? 'Zaproszenie do serwera';
  }
  return detail(name ?? (type === 'AutoModeration' ? 'Reguła AutoMod' : 'Cel niedostępny'));
}

function auditChange({ key, old, new: next }) {
  const value = (item) => item == null || item === '' ? 'brak' : detail(String(item).slice(0, 110));
  const change = (name) => `${name}: ${value(old)} → ${value(next)}`;
  switch (key) {
    case 'name': return change('Nazwa');
    case 'nick': return change('Pseudonim');
    case 'topic': return 'Zmieniono temat kanału.';
    case 'permissions':
    case 'permission_overwrites':
    case 'allow':
    case 'deny': return 'Zmieniono uprawnienia.';
    case 'rate_limit_per_user': return `Tryb powolny: ${old ?? 0} s → ${next ?? 0} s`;
    case 'enabled': return next ? 'Włączono regułę.' : 'Wyłączono regułę.';
    case 'nsfw': return next ? 'Włączono ograniczenie wiekowe.' : 'Wyłączono ograniczenie wiekowe.';
    case 'communication_disabled_until': {
      const time = Date.parse(next);
      return Number.isFinite(time) ? `Ograniczono pisanie do <t:${Math.floor(time / 1000)}:F>.` : 'Zdjęto ograniczenie pisania.';
    }
    case '$add':
    case '$remove': {
      const changes = next ?? old;
      const roles = Array.isArray(changes) ? changes.map((role) => role.name).filter(Boolean) : [];
      const verb = key === '$add' ? 'Dodano' : 'Zdjęto';
      return roles.length ? `${verb} role: ${value(roles.join(', '))}` : `${verb} role.`;
    }
    default: return undefined;
  }
}

function accountAge(user, now) {
  const age = Math.max(0, now - user.createdTimestamp);
  const days = Math.floor(age / DAY);
  const hours = Math.floor((age % DAY) / 3_600_000);
  const minutes = Math.floor((age % 3_600_000) / 60_000);
  if (days) return `${days} ${days === 1 ? 'dzień' : 'dni'} i ${hours} godz.`;
  return hours ? `${hours} godz. i ${minutes} min` : `${minutes} min`;
}

function card(title, description, color = 0x5865F2) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)
    .setTimestamp().setFooter({ text: 'CENTRUM SPOŁECZNOŚCI' });
}

function auditReason(interaction, reason) {
  return `Moderator ${interaction.user.id}: ${reason}`;
}

export function createSecurity({ client, guildId, getState, logError }) {
  const locks = new Set();
  const rates = new Map();
  const pendingClears = new Map();
  const joins = new Map();
  const kicksLogged = new Map();
  const kicksFarewells = new Map();
  const recentDepartures = new Map();
  const welcomeDeliveries = new Map();
  const joinLogDeliveries = new Map();
  let checkingKicks = false;
  let checkingJoins = false;
  let raidUntil = 0;

  function on(event, handler) {
    client.on(event, (...args) => Promise.resolve().then(() => handler(...args)).catch(logError));
  }

  function active(guild) {
    return guild?.id === guildId && getState().securityReady;
  }

  function isVerified(member) {
    const id = getState().roles.verified;
    return Boolean(id && member.roles.cache.has(id));
  }

  function tracked(channel) {
    if (isApplicationChannel(channel, getState())) return false;
    const { channels } = getState();
    const ids = channelEntries.map(({ channel }) => channels[channel.name]).filter(Boolean);
    if (channels[musicChannelKey]) ids.push(channels[musicChannelKey]);
    if (channels[musicPanelKey]) ids.push(channels[musicPanelKey]);
    ids.push(...Object.entries(channels).filter(([key]) => key.startsWith('plus-')).map(([, id]) => id));
    return ids.includes(channel?.id) || (channel?.isThread?.() && ids.includes(channel.parentId));
  }

  function isNoticeChannel(channel) {
    return [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type);
  }

  async function noticeChannel(guild, name, force = false) {
    const id = getState().channels[name];
    const saved = id && await guild.channels.fetch(id, { force }).catch((error) => {
      if (Number(error.code) !== 10003) throw error;
    });
    if (isNoticeChannel(saved)) return saved;
    const channels = await guild.channels.fetch();
    const matches = channels.filter((channel) => isNoticeChannel(channel) &&
      channel.name.toLowerCase().replaceAll('ż', 'z').replace(/[^\p{L}\p{N}]/gu, '') === name);
    if (matches.size === 1) return matches.first();
    throw new SetupError(`Nie można jednoznacznie odnaleźć kanału ${name}.`);
  }

  async function checkNoticeChannel(guild, name, bot) {
    let channel = await noticeChannel(guild, name, true);
    const permissions = channel.permissionsFor(bot);
    const missing = noticePermissions.filter((permission) => !permissions?.has(permission));
    if (missing.length) {
      await channel.permissionOverwrites.edit(bot, Object.fromEntries(missing.map((permission) => [permission, true])),
        { reason: 'Przywrócenie powitań i pożegnań bota' });
      channel = await noticeChannel(guild, name, true);
    }
    if (!channel.permissionsFor(bot)?.has(noticePermissions)) throw new SetupError('Brak uprawnień po zmianie.');
    console.log(`Powiadomienia ${name}: gotowe w kanale ${channel.id}.`);
    return channel;
  }

  function welcomeCard(guild, userId) {
    const rules = getState().channels.regulamin;
    return card(`👋 Witaj na ${guild.name.slice(0, 100)}!`,
      `Hej <@${userId}>! Fajnie, że do nas dołączasz. Przeczytaj i zaakceptuj zasady w <#${rules}>, żeby odblokować serwer. Do zobaczenia w grze! 🎮`, 0x2CA58D);
  }

  function joinDescription(member, when) {
    const { guild, user } = member;
    const created = Math.floor(user.createdTimestamp / 1000);
    const fresh = when - user.createdTimestamp < newAccountAge;
    return `${label(user)}\nWiek konta: **${accountAge(user, when)}**\nUtworzone: <t:${created}:F> (<t:${created}:R>).\nLiczba kont na serwerze: **${guild.memberCount}**.${!user.bot && fresh ? '\n⚠️ Nowe konto. Weryfikacja wymaga decyzji moderatora.' : ''}`;
  }

  function joinDeliveryKey(member) {
    return `${member.id ?? member.user.id}:${member.joinedTimestamp ?? 0}`;
  }

  function joinDeliveryOptions(member) {
    if (!member.joinedTimestamp) return {};
    return { nonce: createHash('sha256').update(joinDeliveryKey(member)).digest('hex').slice(0, 24), enforceNonce: true };
  }

  async function checkRecentJoins(guild, report = false) {
    if (!active(guild) || !getState().channels['log-wejscia'] || checkingJoins) return;
    checkingJoins = true;
    try {
      const now = Date.now();
      for (const recent of [welcomeDeliveries, joinLogDeliveries]) {
        for (const [key, time] of recent) if (now - time >= kickHistoryWindow) recent.delete(key);
      }
      const candidates = [];
      let after;
      for (;;) {
        const page = await guild.members.list({ limit: 1000, cache: false, ...(after ? { after } : {}) });
        candidates.push(...page.filter(({ joinedTimestamp }) =>
          now - joinedTimestamp >= 5000 && now - joinedTimestamp < kickHistoryWindow).values());
        if (page.size < 1000 || page.lastKey() === after) break;
        after = page.lastKey();
      }
      let welcomes = 0;
      let logs = 0;
      const missingWelcomes = candidates.filter((member) => !member.user.bot && !welcomeDeliveries.has(joinDeliveryKey(member)));
      const missingLogs = candidates.filter((member) => !joinLogDeliveries.has(joinDeliveryKey(member)));
      if (missingWelcomes.length) {
        await (async () => {
          const channel = await noticeChannel(guild, 'witamy');
          const history = await channel.messages.fetch({ limit: 100 });
          for (const member of missingWelcomes) {
            const key = joinDeliveryKey(member);
            if (welcomeDeliveries.has(key)) continue;
            const id = member.user.id;
            const known = history.some((message) => (message.type === MessageType.UserJoin && message.author.id === id &&
              Math.abs(message.createdTimestamp - member.joinedTimestamp) < 30_000) ||
              (message.author.id === client.user.id && message.embeds.some((embed) =>
                /witaj|dobrze, że jesteś/i.test(embed.title ?? '') && embed.description?.includes(`<@${id}>`) &&
                (Date.parse(embed.timestamp) === member.joinedTimestamp ||
                  Math.abs(message.createdTimestamp - member.joinedTimestamp) < 30_000))));
            if (!known) {
              await channel.send({
                embeds: [welcomeCard(guild, id).setTimestamp(member.joinedTimestamp)], allowedMentions: NO_MENTIONS,
                ...joinDeliveryOptions(member),
              });
              welcomes++;
            }
            welcomeDeliveries.set(key, now);
          }
        })().catch(logError);
      }
      if (missingLogs.length) {
        await (async () => {
          const state = getState();
          const channel = await privateModerationChannel(guild, state, { name: 'log-wejscia' }).catch((error) => {
            if (!(error instanceof SetupError)) throw error;
            return privateModerationChannel(guild, state);
          });
          const history = await channel.messages.fetch({ limit: 100 });
          for (const member of missingLogs) {
            const key = joinDeliveryKey(member);
            if (joinLogDeliveries.has(key)) continue;
            const known = history.some((message) => message.author.id === client.user.id &&
              message.embeds.some((embed) => embed.title === joinTitle && embed.description?.split('\n')[0] === label(member.user) &&
                (Date.parse(embed.timestamp) === member.joinedTimestamp ||
                  Math.abs(message.createdTimestamp - member.joinedTimestamp) < 30_000)));
            if (!known) {
              await channel.send({
                embeds: [card(joinTitle, joinDescription(member, member.joinedTimestamp)).setTimestamp(member.joinedTimestamp)],
                allowedMentions: NO_MENTIONS, ...joinDeliveryOptions(member),
              });
              logs++;
            }
            joinLogDeliveries.set(key, now);
          }
        })().catch(logError);
      }
      if (report || welcomes || logs) {
        console.log(`Sprawdzono ostatnie dołączenia: ${candidates.length}. Uzupełniono powitania: ${welcomes}, logi: ${logs}. Kanał wejść: ${getState().channels['log-wejscia']}.`);
      }
    } finally { checkingJoins = false; }
  }

  function farewellCard(user) {
    return card('🌙 Do zobaczenia!',
      `**${detail(user.username)}** opuścił(a) Centrum Graczy. Dzięki za wspólny czas i powodzenia w kolejnych rozgrywkach! 🎮`, 0x7767AF);
  }

  async function deliverKickLog(guild, entry, checkHistory = false) {
    if (kicksLogged.has(entry.id)) return false;
    kicksLogged.set(entry.id, entry.createdTimestamp);
    try {
      const state = getState();
      const fallback = 'log-moderacja';
      const destination = state.channels['log-wyrzucenia'] ? 'log-wyrzucenia' : fallback;
      const logChannel = await privateModerationChannel(guild, state, { name: destination }).catch((error) => {
        if (!(error instanceof SetupError) || destination === fallback) throw error;
        console.warn('Log wyrzuceń wymaga sprawdzenia. Używam prywatnego logu moderacji.');
        return privateModerationChannel(guild, state, { name: fallback });
      });
      const delegated = entry.executorId === client.user.id && /^Moderator (\d{17,20}):\s*(.*)$/s.exec(entry.reason ?? '');
      const [executor, target] = await Promise.all([
        auditUserName(guild, delegated ? delegated[1] : entry.executorId, delegated ? undefined : entry.executor),
        auditTargetName(guild, entry),
      ]);
      const description = `Wykonawca: **${executor}**\nCel: **${target}**\nPowód: ${detail((delegated ? delegated[2] : entry.reason) || 'Nie podano')}`;
      if (checkHistory) {
        const history = await logChannel.messages.fetch({ limit: 100 });
        if (history.some((message) => message.author.id === client.user.id && message.embeds.some((embed) =>
          embed.title === kickTitle && (Date.parse(embed.timestamp) === entry.createdTimestamp ||
            (embed.description === description && Math.abs(message.createdTimestamp - entry.createdTimestamp) < 30_000))))) return false;
      }
      await logChannel.send({
        embeds: [card(kickTitle, description).setTimestamp(entry.createdTimestamp)], allowedMentions: NO_MENTIONS,
        nonce: entry.id, enforceNonce: true,
      });
      return true;
    } catch (error) {
      kicksLogged.delete(entry.id);
      throw error;
    }
  }

  async function checkRecentKicks(guild, report = false) {
    if (!active(guild) || !getState().channels['log-wyrzucenia'] || checkingKicks) return;
    checkingKicks = true;
    try {
      const now = Date.now();
      for (const recent of [kicksLogged, kicksFarewells, recentDepartures]) {
        for (const [id, time] of recent) if (now - time >= kickHistoryWindow) recent.delete(id);
      }
      const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 25 });
      const entries = [...audit.entries.values()].reverse().filter((entry) =>
        entry.targetId && now - entry.createdTimestamp >= 5000 && now - entry.createdTimestamp < kickHistoryWindow);
      let logs = 0;
      let farewells = 0;
      let existingLogs = 0;
      let existingFarewells = 0;
      let bots = 0;
      for (const entry of entries) {
        const logged = await deliverKickLog(guild, entry, true).catch(logError);
        if (logged === true) logs++;
        if (logged === false) existingLogs++;
        if (kicksFarewells.has(entry.id)) continue;
        const departure = recentDepartures.get(entry.targetId);
        if (departure && Math.abs(departure - entry.createdTimestamp) < 30_000) {
          kicksFarewells.set(entry.id, entry.createdTimestamp);
          existingFarewells++;
          continue;
        }
        try {
          const user = entry.target?.username ? entry.target : await client.users.fetch(entry.targetId);
          if (!user.bot) {
            const channel = await noticeChannel(guild, 'pozegnania');
            const history = await channel.messages.fetch({ limit: 100 });
            const embed = farewellCard(user).setTimestamp(entry.createdTimestamp);
            if (!history.some((message) => message.author.id === client.user.id && message.embeds.some((item) =>
              item.title === embed.data.title && item.description?.startsWith(`**${detail(user.username)}**`) &&
              (Date.parse(item.timestamp) === entry.createdTimestamp ||
                Math.abs(message.createdTimestamp - entry.createdTimestamp) < 30_000)))) {
              await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS, nonce: entry.id, enforceNonce: true });
              farewells++;
            } else existingFarewells++;
          } else bots++;
          kicksFarewells.set(entry.id, entry.createdTimestamp);
        } catch (error) { logError(error); }
      }
      if (report || logs || farewells) {
        console.log(`Sprawdzono wyrzucenia z audytu: ${entries.length}. Uzupełniono logi: ${logs}, pożegnania: ${farewells}. Już zapisane: logi ${existingLogs}, pożegnania ${existingFarewells}. Konta botów: ${bots}. Kanał wyrzuceń: ${getState().channels['log-wyrzucenia']}.`);
      }
    } finally {
      checkingKicks = false;
    }
  }

  async function recoverMemberNotices(guild, welcome, farewell, from, to) {
    const inside = (timestamp) => timestamp >= from && timestamp < to;
    const noticeHistory = async (channel) => {
      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 100 && messages.last().createdTimestamp >= from) {
        throw new SetupError('Historia kanału nie obejmuje całego okresu odzyskiwania.');
      }
      return messages;
    };
    const logChannel = await privateModerationChannel(guild, getState());
    const [welcomes, farewells, entries, members] = await Promise.all([
      noticeHistory(welcome), noticeHistory(farewell), noticeHistory(logChannel), guild.members.list({ limit: 1000 }),
    ]);
    let joined = 0;
    let left = 0;
    const recover = (channel, embed, timestamp, footer) => channel.send({
      embeds: [embed.setTimestamp(timestamp).setFooter({ text: footer })], allowedMentions: NO_MENTIONS,
    });
    for (const member of members.values()) {
      const timestamp = member.joinedTimestamp;
      if (member.user.bot || !inside(timestamp)) continue;
      if (welcomes.some((message) =>
        message.createdTimestamp >= timestamp - 1000 && (
          (message.type === MessageType.UserJoin && message.author.id === member.id) ||
          (message.author.id === client.user.id && message.embeds.some((embed) =>
            /witaj|dobrze, że jesteś/i.test(embed.title ?? '') && embed.description?.includes(`<@${member.id}>`)))))) continue;
      await recover(welcome, welcomeCard(guild, member.id), timestamp, 'Uzupełnione powitanie');
      joined++;
    }
    for (const message of [...entries.values()].reverse()) {
      if (message.author.id !== client.user.id || !inside(message.createdTimestamp)) continue;
      const embed = message.embeds.find(({ title }) => title === departureTitle);
      const name = embed?.description?.split('\n')[0];
      if (!name || name === 'Nazwa użytkownika niedostępna') continue;
      if (farewells.some((existing) => existing.author.id === client.user.id && existing.embeds.some((item) =>
        /do zobaczenia/i.test(item.title ?? '') && (
          (item.footer?.text === 'Uzupełnione pożegnanie' && Date.parse(item.timestamp) === message.createdTimestamp) ||
          Math.abs(existing.createdTimestamp - message.createdTimestamp) < 30_000)))) continue;
      await recover(farewell, card('🌙 Do zobaczenia!',
        `**${name}** opuścił(a) serwer. Dzięki za wspólny czas! 🎮`, 0x7767AF),
      message.createdTimestamp, 'Uzupełnione pożegnanie');
      left++;
    }
    console.log(`Uzupełnienie powiadomień zakończone: powitania ${joined}, pożegnania ${left}.`);
  }

  async function prepareMemberNotices(guild) {
    if (!active(guild)) return;
    const bot = await guild.members.fetchMe();
    const [welcome, farewell] = await Promise.all(memberNoticeChannels.map((name) =>
      checkNoticeChannel(guild, name, bot).catch((error) => {
        console.warn(`Powiadomienia ${name}: kontrola kanału nie powiodła się.`);
        logError(error);
      })));
    const from = Date.parse(process.env.DISCORD_MEMBER_NOTICE_RECOVERY_FROM);
    const to = Date.parse(process.env.DISCORD_MEMBER_NOTICE_RECOVERY_TO);
    if (welcome && farewell && from < to && to <= Date.now()) {
      await recoverMemberNotices(guild, welcome, farewell, from, to);
    }
    await Promise.all([checkRecentKicks(guild, true).catch(logError), checkRecentJoins(guild, true).catch(logError)]);
  }

  async function post(guild, name, embed, options = {}) {
    const state = getState();
    const notice = memberNoticeChannels.includes(name);
    if (!active(guild) || (!notice && !state.channels[name])) return;
    try {
      const channel = notice ? await noticeChannel(guild, name) : name === 'logi-bota' || name.startsWith('log-')
        ? await privateModerationChannel(guild, state, { force: false, name })
        : await guild.channels.fetch(state.channels[name]);
      if (notice || channel?.type === ChannelType.GuildText) {
        return await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS, ...options });
      }
    } catch (error) {
      if (notice) console.warn(`Powiadomienia ${name}: wysyłka nie powiodła się.`);
      if (!(error instanceof SetupError)) logError(error);
    }
  }

  function log(guild, destination, title, description, color, options) {
    const exact = {
      [joinTitle]: 'log-wejscia',
      [departureTitle]: 'log-wyjscia',
      '✏️ Edycja wiadomości': 'log-edytowane',
      '🗑️ Usunięcie wiadomości': 'log-usuniete',
      '🧹 Zbiorcze usuwanie wiadomości': 'log-usuniete',
    }[title];
    return post(guild, getState().channels[exact] ? exact : destination, card(title, description, color), options);
  }

  function stats(guild) {
    const total = guild.memberCount;
    const online = Math.min(total, guild.presences.cache.filter(({ status }) => ['online', 'idle', 'dnd'].includes(status)).size);
    return { total, online, offline: Math.max(0, total - online) };
  }

  async function refreshStats(guild) {
    if (!active(guild)) return;
    const parent = getState().categories['live-stats'];
    if (!parent) return;
    const counts = stats(guild);
    const icons = { online: '🟢', offline: '🔴', total: '👥' };
    const suffix = /[0-9]+(?=\s*$)/u;
    const names = [];
    let renamed = false;
    for (const { channel } of channelEntries) {
      if (!channel.counter) continue;
      const id = getState().channels[channel.name];
      if (!id) continue;
      const current = await guild.channels.fetch(id, { force: true });
      if (current?.type !== ChannelType.GuildVoice || current.parentId !== parent) continue;
      const label = channelLabel(channel);
      const count = String(counts[channel.counter]);
      const previousDefault = current.name === label || current.name.replace(suffix, '').trimEnd() === `${label} -` ||
        (channel.counter === 'total' && /^📊│Statystyki(?: • |$)/u.test(current.name));
      const name = previousDefault ? `${icons[channel.counter]} ${count}`
        : suffix.test(current.name) ? current.name.replace(suffix, count) : `${current.name.trimEnd()} ${count}`;
      names.push(name);
      if (current.name !== name) {
        await current.setName(name, 'Aktualizacja licznika serwera');
        renamed = true;
      }
    }
    if (renamed) console.log(`Liczniki: ${names.join(', ')}.`);
  }

  async function syncPresence(guild) {
    await guild.members.fetch({ withPresences: true, time: 30_000 });
  }

  async function underLock(member, task) {
    if (locks.has(member.id)) throw new SetupError('Trwa zmiana weryfikacji tej osoby. Spróbuj za chwilę.');
    locks.add(member.id);
    try {
      return await task();
    } finally {
      locks.delete(member.id);
    }
  }

  async function gateRoles(guild, repair = false) {
    const state = getState();
    const serverRoles = await guild.roles.fetch();
    const gate = Object.fromEntries(['verified', 'review', 'blocked'].map((key) => [key, serverRoles.get(state.roles[key])]));
    for (const [key, role] of Object.entries(gate)) {
      if (!role?.editable) {
        console.warn(`Weryfikacja: bot nie może zarządzać rolą ${role?.name ?? key} (${role?.id ?? 'brak ID'}). Sprawdź hierarchię ról.`);
        throw new SetupError('Weryfikacja wymaga sprawdzenia ról przez administrację.');
      }
      if (role.permissions.bitfield !== 0n && repair) {
        gate[key] = await role.setPermissions(0n, 'Przywrócenie bezpiecznych uprawnień technicznej roli weryfikacji');
        console.log(`Przywrócono uprawnienia technicznej roli weryfikacji: ${role.name}.`);
      }
      if (gate[key].permissions.bitfield !== 0n) {
        console.warn(`Weryfikacja: techniczna rola ${role.name} ma dodatkowe uprawnienia serwerowe.`);
        throw new SetupError('Weryfikacja wymaga sprawdzenia ról przez administrację.');
      }
    }
    return gate;
  }

  async function accept(interaction) {
    const guild = interaction.guild;
    const state = getState();
    if (!active(guild) || interaction.channelId !== state.channels.regulamin ||
        interaction.message.id !== state.messages.regulamin) {
      throw new SetupError('Otwórz aktualny panel weryfikacji.');
    }
    return underLock(interaction.user, async () => {
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (member.pending || member.isCommunicationDisabled()) {
        throw new SetupError('Ukończ weryfikację Discorda lub poczekaj do końca ograniczenia konta.');
      }
      const gate = await gateRoles(guild);
      const has = (role) => member.roles.cache.has(role.id);
      if (has(gate.blocked)) throw new SetupError('Twoja weryfikacja została wstrzymana. Skontaktuj się z moderacją.');
      if (has(gate.verified)) {
        await syncVerificationSeparators(member, true, 'Uzupełnienie separatorów po weryfikacji');
        return 'Masz już dostęp do społeczności.';
      }
      if (has(gate.review)) return 'Twoje zgłoszenie czeka na decyzję moderacji.';
      const accountIsNew = Date.now() - member.user.createdTimestamp < newAccountAge;
      const raidActive = Date.now() < raidUntil;
      if (accountIsNew || raidActive) {
        const queue = await privateModerationChannel(guild, state, { name: 'log-moderacja' });
        await member.roles.add(gate.review.id, 'Akceptacja regulaminu i oczekiwanie na decyzję');
        try {
          await queue.send({
            embeds: [card('🛂 Konto do ręcznej oceny',
              `${label(member.user)}\n${accountIsNew ? 'Konto ma mniej niż 7 dni.\n' : ''}${raidActive ? 'Wykryto falę dołączeń.\n' : ''}Rozpatrz zgłoszenie przyciskami poniżej.`, 0xE7A84C)],
            components: [reviewButtons(member.id)],
            allowedMentions: NO_MENTIONS,
          });
        } catch (error) {
          await member.roles.remove(gate.review.id, 'Ponów zgłoszenie po błędzie dostarczenia').catch(logError);
          throw error;
        }
        return 'Regulamin przyjęty. Moderacja sprawdzi Twoje zgłoszenie przed odblokowaniem dostępu.';
      }
      await member.roles.add(gate.verified.id, 'Akceptacja regulaminu');
      await syncVerificationSeparators(member, true, 'Separatory po weryfikacji');
      await log(guild, 'log-moderacja', '✅ Weryfikacja zakończona', label(member.user));
      return 'Gotowe! Masz rolę **Zweryfikowany**. Odblokowano kanały społeczności.';
    });
  }

  async function syncVerificationSeparators(member, add, reason) {
    const state = getState();
    const staff = member.guild?.roles.cache?.get(state.roles['plus-separator-5']);
    if (!staff) return;
    for (const [key, title] of verificationSeparators) {
      const role = member.guild.roles.cache.get(state.roles[key]);
      if (!role?.editable || role.name !== title || member.roles.cache.has(role.id) === add) continue;
      if (add && (role.comparePositionTo(staff) >= 0 || role.permissions.bitfield !== 0n || role.hoist || role.mentionable ||
        member.guild.channels.cache.some((channel) => (channel.permissionOverwrites?.cache.get(role.id)?.allow.bitfield ?? 0n) !== 0n))) continue;
      await (add ? member.roles.add(role.id, reason) : member.roles.remove(role.id, reason)).catch(logError);
    }
  }

  function requirePermission(member, permission) {
    if (!member.permissions.has(permission)) throw new SetupError('Brakuje Ci uprawnień do tej komendy.');
  }

  async function targetMember(interaction, actor, id = interaction.options.getUser('osoba', true).id) {
    const target = await interaction.guild.members.fetch({ user: id, force: true });
    if (target.id === actor.id || target.id === interaction.client.user.id || !target.manageable ||
        (actor.id !== interaction.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)) {
      throw new SetupError('Hierarchia ról nie pozwala wykonać tej operacji na wybranej osobie.');
    }
    return target;
  }

  async function review(interaction, actor, panel) {
    const guild = interaction.guild;
    const action = panel?.action ?? interaction.options.getSubcommand();
    const state = getState();
    if (!active(guild)) throw new SetupError('Najpierw ukończ konfigurację serwera.');
    if (action === 'status') {
      if (actor.roles.cache.has(state.roles.blocked)) return 'Twoja weryfikacja została wstrzymana.';
      if (isVerified(actor)) return 'Masz rolę **Zweryfikowany**.';
      if (actor.roles.cache.has(state.roles.review)) return 'Zgłoszenie czeka na ocenę moderatora.';
      return `Przeczytaj regulamin i użyj przycisku w <#${state.channels.regulamin}>.`;
    }
    requirePermission(actor, PermissionFlagsBits.ModerateMembers);
    const target = await targetMember(interaction, actor, panel?.id);
    if (target.user.bot) throw new SetupError('Weryfikacja dotyczy kont użytkowników.');
    return underLock(target, async () => {
      const member = await guild.members.fetch({ user: target.id, force: true });
      const gate = await gateRoles(guild);
      const reason = panel?.reason ?? interaction.options.getString('powod', true);
      const note = auditReason(interaction, reason);
      if (panel?.queueOnly && !member.roles.cache.has(gate.review.id)) {
        throw new SetupError('To zgłoszenie zostało już rozpatrzone.');
      }
      if (action === 'zatwierdz') {
        if (member.pending || member.roles.cache.has(gate.blocked.id) || !member.roles.cache.has(gate.review.id)) {
          throw new SetupError('Zatwierdzić można osobę, która zaakceptowała regulamin i oczekuje na decyzję.');
        }
        await member.roles.add(gate.verified.id, note);
        await syncVerificationSeparators(member, true, note);
        await member.roles.remove(gate.review.id, note);
      } else if (action === 'wstrzymaj') {
        await member.roles.add(gate.blocked.id, note);
        await member.roles.remove(gate.verified.id, note);
        await syncVerificationSeparators(member, false, note);
        await member.roles.remove(gate.review.id, note);
      } else {
        await member.roles.remove(gate.blocked.id, note);
      }
      await log(guild, 'log-moderacja', '🛂 Decyzja weryfikacyjna',
        `Osoba: ${label(member.user)}\nAkcja: **${action}**\nModerator: ${label(actor.user)}\nPowód: ${detail(reason)}`);
      return 'Zapisano decyzję weryfikacyjną.';
    });
  }

  async function moderate(interaction, actor, panel) {
    const guild = interaction.guild;
    const action = panel?.action ?? interaction.options.getSubcommand();
    if (!active(guild)) throw new SetupError('Najpierw ukończ konfigurację serwera.');
    if (action === 'wyczysc') {
      const channel = panel ? await guild.channels.fetch(panel.channelId, { force: true }) : interaction.channel;
      requireClearAccess(channel, actor);
      const count = panel?.count ?? interaction.options.getInteger('liczba', true);
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new SetupError('Podaj liczbę od 1 do 100.');
      const removed = await channel.bulkDelete(count, true);
      await logClear(guild, channel.id, actor, removed.size);
      return `Usunięto ${removed.size} wiadomości. Discord pomija wiadomości starsze niż 14 dni.`;
    }
    const permissions = { wyrzuc: PermissionFlagsBits.KickMembers, zbanuj: PermissionFlagsBits.BanMembers,
      odbanuj: PermissionFlagsBits.BanMembers };
    requirePermission(actor, permissions[action] ?? PermissionFlagsBits.ModerateMembers);
    const reason = (panel?.reason ?? interaction.options.getString('powod', true)).trim();
    if (reason.length < 3 || reason.length > 300) throw new SetupError('Powód musi mieć od 3 do 300 znaków.');
    const note = auditReason(interaction, reason);
    if (action === 'odbanuj') {
      const id = (panel?.id ?? interaction.options.getString('id', true)).trim();
      if (!/^\d{17,20}$/.test(id)) throw new SetupError('Podaj poprawny identyfikator użytkownika.');
      await guild.bans.remove(id, note);
      return 'Blokada została zdjęta.';
    }
    const target = await targetMember(interaction, actor, panel?.id);
    if (action === 'ostrzez') {
      const channel = await privateModerationChannel(guild, getState(), { name: 'log-moderacja' });
      await channel.send({ embeds: [card('⚠️ Ostrzeżenie',
        `Osoba: ${label(target.user)}\nModerator: ${label(actor.user)}\nPowód: ${detail(reason)}`, 0xE7A84C)], allowedMentions: NO_MENTIONS });
      const sent = await target.send({ embeds: [card('⚠️ Ostrzeżenie od moderacji',
        `Serwer **${detail(guild.name)}**\nPowód: ${detail(reason)}`, 0xE7A84C)], allowedMentions: NO_MENTIONS }).catch(() => null);
      return sent ? 'Ostrzeżenie zapisane i wysłane w wiadomości prywatnej.'
        : 'Ostrzeżenie zapisane. Użytkownik ma niedostępne wiadomości prywatne.';
    }
    if (action === 'timeout' || action === 'untimeout') {
      if (!target.moderatable) throw new SetupError('Discord nie pozwala ograniczyć tego konta.');
      const minutes = action === 'timeout' ? (panel?.minutes ?? interaction.options.getInteger('minuty', true)) : 0;
      if (action === 'timeout' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 40_320)) {
        throw new SetupError('Wpisz liczbę minut od 1 do 40320.');
      }
      await target.timeout(minutes ? minutes * 60_000 : null, note);
    } else if (action === 'wyrzuc') {
      if (!target.kickable) throw new SetupError('Discord nie pozwala wyrzucić tego konta.');
      await target.kick(note);
    } else if (action === 'zbanuj') {
      if (!target.bannable) throw new SetupError('Discord nie pozwala zbanować tego konta.');
      await target.ban({ reason: note });
    }
    return 'Akcja moderacyjna wykonana.';
  }

  function requireClearAccess(channel, actor) {
    if (channel?.type !== ChannelType.GuildText) throw new SetupError('Wybierz kanał tekstowy.');
    if (!channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
      throw new SetupError('Brakuje Ci uprawnień do czyszczenia tego kanału.');
    }
  }

  function logClear(guild, channelId, actor, count) {
    return log(guild, 'log-wiadomosci', '🧹 Czyszczenie wiadomości',
      `Kanał: <#${channelId}>\nModerator: ${label(actor.user)}\nUsunięto: ${count}`);
  }

  async function clearCandidates(channel, limit) {
    const protectedIds = new Set(Object.values(getState().messages));
    const now = Date.now();
    const messages = await channel.messages.fetch({ limit });
    return messages.filter((message) => !message.pinned && message.deletable && !protectedIds.has(message.id) &&
      now - message.createdTimestamp < messageAgeLimit);
  }

  async function previewClear(guild, actor, channelId, count) {
    if (!active(guild)) throw new SetupError('Najpierw ukończ konfigurację serwera.');
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new SetupError('Podaj liczbę od 1 do 100.');
    const channel = await guild.channels.fetch(channelId, { force: true });
    requireClearAccess(channel, actor);
    const candidates = await clearCandidates(channel, count);
    pendingClears.delete(actor.id);
    if (!candidates.size) return 'W tym zakresie nie ma wiadomości do usunięcia.';
    const token = randomUUID();
    pendingClears.set(actor.id, { token, channelId, ids: [...candidates.keys()], expires: Date.now() + clearPreviewDuration });
    return {
      content: `**Do usunięcia: ${candidates.size} wiadomości z <#${channelId}>.** Pominięto przypięte wiadomości, panele bota i wiadomości starsze niż 14 dni. Potwierdzenie wygasa po 5 minutach.`,
      components: [confirmMessageClear(token)],
    };
  }

  async function confirmClear(guild, actor, token) {
    if (!active(guild)) throw new SetupError('Najpierw ukończ konfigurację serwera.');
    const preview = pendingClears.get(actor.id);
    if (!preview || preview.token !== token || Date.now() >= preview.expires) {
      throw new SetupError('Podgląd wygasł lub został zastąpiony. Utwórz nowy.');
    }
    pendingClears.delete(actor.id);
    const channel = await guild.channels.fetch(preview.channelId, { force: true });
    requireClearAccess(channel, actor);
    const available = await clearCandidates(channel, 100);
    const ids = preview.ids.filter((id) => available.has(id));
    if (!ids.length) return 'Wiadomości z podglądu nie są już dostępne do usunięcia.';
    const removed = await channel.bulkDelete(ids, true);
    await logClear(guild, channel.id, actor, removed.size);
    return `Usunięto ${removed.size} wiadomości z <#${channel.id}>.`;
  }

  async function boostChannel(guild) {
    if (!/^\d{17,20}$/.test(boostChannelId ?? '')) throw new SetupError('Nieprawidłowy kanał podziękowań za boost.');
    const channel = await guild.channels.fetch(boostChannelId);
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel?.type)) {
      throw new SetupError('Kanał podziękowań za boost musi być kanałem tekstowym.');
    }
    return channel;
  }

  async function prepareBoostThanks(guild) {
    if (!boostChannelId || !active(guild)) return;
    const channel = await boostChannel(guild);
    const bot = await guild.members.fetchMe();
    const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((permission) =>
      !channel.permissionsFor(bot)?.has(permission));
    if (missing.length) await channel.permissionOverwrites.edit(bot, Object.fromEntries(missing.map((permission) => [permission, true])),
      { reason: 'Dostęp bota do podziękowań za boosty' });
    const ready = (await guild.channels.fetch(channel.id, { force: true })).permissionsFor(bot)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']);
    if (!ready) throw new SetupError('Bot nie może wysyłać podziękowań w wybranym kanale.');
    const source = guild.systemChannelId && !guild.systemChannelFlags.has(SystemChannelFlagsBitField.Flags.SuppressPremiumSubscriptions);
    console.log(`Podziękowania za boost gotowe w kanale ${channel.id}; powiadomienia systemowe: ${source ? 'włączone' : 'wyłączone'}.`);
  }

  async function boost(guild, user) {
    if (!boostChannelId) return post(guild, 'witamy', card('💎 Dziękujemy za boost!',
      `<@${user.id}> właśnie wsparł serwer. Dzięki za pomoc w rozwijaniu społeczności! 💜`, 0xDA75D5));
    const channel = await boostChannel(guild);
    return channel.send({
      content: `<@${user.id}>`,
      embeds: [card('💎 Dziękujemy za boost!', 'Dzięki za wsparcie **Po Godzinach** i pomoc w rozwijaniu społeczności! 💜', 0xDA75D5)],
      allowedMentions: { parse: [], users: [user.id] },
    });
  }

  on(Events.GuildMemberAdd, async (member) => {
    const { guild, user } = member;
    if (!active(guild)) return;
    const now = Date.now();
    const accountIsNew = now - user.createdTimestamp < newAccountAge;
    if (!user.bot) {
      for (const [id, joined] of joins) if (now - joined.at > 20_000) joins.delete(id);
      joins.set(user.id, { at: now, fresh: accountIsNew });
      const freshCount = [...joins.values()].filter(({ fresh }) => fresh).length;
      if (joins.size >= 6 || freshCount >= 3) {
        const alert = now >= raidUntil;
        raidUntil = now + 10 * 60_000;
        if (alert) await log(guild, 'log-ochrona', '🚨 Wykryto falę dołączeń',
          `W ciągu 20 sekund dołączyło ${joins.size} różnych osób, w tym ${freshCount} z kontem młodszym niż 7 dni. Ręczna ocena weryfikacji przez 10 minut.`, 0xE85D75);
      }
      const welcome = await post(guild, 'witamy', welcomeCard(guild, user.id), joinDeliveryOptions(member));
      if (welcome) {
        welcomeDeliveries.set(joinDeliveryKey(member), now);
        console.log('Wysłano automatyczne powitanie w kanale witamy.');
      }
    }
    const logged = await log(guild, 'logi-bota', joinTitle, joinDescription(member, now), undefined, joinDeliveryOptions(member));
    if (logged) joinLogDeliveries.set(joinDeliveryKey(member), now);
  });
  on(Events.GuildMemberRemove, async (member) => {
    if (!active(member.guild)) return;
    rates.delete(member.id);
    if (!member.user.bot) {
      const farewell = await post(member.guild, 'pozegnania', farewellCard(member.user));
      if (farewell) {
        recentDepartures.set(member.id, Date.now());
        console.log('Wysłano automatyczne pożegnanie w kanale pozegnania.');
      }
    }
    await log(member.guild, 'logi-bota', departureTitle, label(member.user));
  });
  on(Events.GuildMemberUpdate, async (before, after) => {
    if (!active(after.guild) || before.partial || before.premiumSinceTimestamp || !after.premiumSinceTimestamp) return;
    if (!after.guild.systemChannelId ||
        after.guild.systemChannelFlags.has(SystemChannelFlagsBitField.Flags.SuppressPremiumSubscriptions)) {
      await boost(after.guild, after.user);
    }
  });

  on(Events.VoiceStateUpdate, async (before, after) => {
    const { guild, member } = after;
    if (!active(guild) || !member || member.user.bot || before.channelId === after.channelId ||
        (!tracked(before.channel) && !tracked(after.channel))) return;
    const from = before.channelId ? `<#${before.channelId}>` : 'poza głosowymi';
    const to = after.channelId ? `<#${after.channelId}>` : 'poza głosowymi';
    const title = !before.channelId ? '🔊 Wejście na kanał głosowy'
      : !after.channelId ? '🔇 Wyjście z kanału głosowego' : '🔀 Przejście między kanałami głosowymi';
    await log(guild, 'logi-bota', title, `${label(member.user)}\n${from} → ${to}`);
  });

  on(Events.ChannelUpdate, async (_before, channel) => {
    if (!active(channel.guild)) return;
    if (isStatsChannel(getState(), channel.id)) {
      await lockStatsChannel(channel);
      return;
    }
    await lockReadOnlyChannel(channel, getState());
    await lockTicketChannel(channel, getState());
    await restrictChannelMentions(channel, getState());
    if (channel.id !== getState().channels.nsfw || channel.type !== ChannelType.GuildText || channel.nsfw) return;
    await channel.edit({ nsfw: true, reason: 'Przywrócenie ograniczenia wiekowego w strefie 18+' });
    await log(channel.guild, 'log-ochrona', '🔞 Przywrócono ograniczenie wiekowe', `Kanał: <#${channel.id}>`, 0xE85D75);
  });
  on(Events.ChannelCreate, async (channel) => {
    if (active(channel.guild)) await restrictChannelMentions(channel, getState());
  });
  on(Events.GuildRoleUpdate, async (_before, role) => {
    if (active(role.guild)) await restrictRoleMentions(role, getState());
  });
  on(Events.GuildRoleCreate, async (role) => {
    if (active(role.guild)) await restrictRoleMentions(role, getState());
  });

  on(Events.MessageCreate, async (message) => {
    const { guild, author, member } = message;
    if (!active(guild) || !author || author.bot) return;
    if (BOOST_TYPES.has(message.type)) {
      await boost(guild, author);
      return;
    }
    if (!member || !isVerified(member) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    if (!tracked(message.channel)) return;
    const now = Date.now();
    const history = (rates.get(author.id) ?? []).filter((timestamp) => now - timestamp <= 8_000);
    history.push(now);
    rates.set(author.id, history.slice(-8));
    if (history.length < 8 || !member.moderatable || locks.has(author.id)) return;
    await underLock(member, async () => {
      if (member.isCommunicationDisabled()) return;
      rates.delete(author.id);
      await member.timeout(120_000, 'Automatyczna ochrona: 8 wiadomości w 8 sekund');
      await log(guild, 'log-ochrona', '🛡️ Zatrzymano flood',
        `${label(author)}\nKanał: <#${message.channelId}>\nOgraniczenie pisania: 2 minuty.`, 0xE85D75);
    });
  });
  on(Events.MessageUpdate, async (before, after) => {
    if (!active(after.guild) || after.author?.bot || !after.editedTimestamp || before.editedTimestamp === after.editedTimestamp) return;
    if (!tracked(after.channel)) return;
    await log(after.guild, 'log-wiadomosci', '✏️ Edycja wiadomości',
      `Kanał: <#${after.channelId}>\nID: \`${after.id}\`\nAutor: ${after.author ? label(after.author) : 'brak danych'}`);
  });
  on(Events.MessageDelete, async (message) => {
    if (!active(message.guild) || message.author?.bot || !tracked(message.channel)) return;
    await log(message.guild, 'log-wiadomosci', '🗑️ Usunięcie wiadomości',
      `Kanał: <#${message.channelId}>\nID: \`${message.id}\`\nAutor: ${message.author ? label(message.author) : 'brak danych'}`);
  });
  on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!active(channel.guild) || !tracked(channel)) return;
    await log(channel.guild, 'log-wiadomosci', '🧹 Zbiorcze usuwanie wiadomości',
      `Kanał: <#${channel.id}>\nLiczba wiadomości: ${messages.size}`);
  });
  on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    const action = auditActions.get(entry.action);
    if (!active(guild) || !action) return;
    const targetChannel = guild.channels.cache?.get(entry.targetId) ?? entry.target;
    if (isApplicationChannel(targetChannel, getState()) || isApplicationChannel(entry.extra?.channel, getState()) ||
        entry.executorId === guild.client.user.id && /^(Rekrutacja:|Punkty administracji:)/.test(entry.reason ?? '')) return;
    if (entry.action === AuditLogEvent.MemberKick && getState().channels['log-wyrzucenia']) {
      await deliverKickLog(guild, entry);
      return;
    }
    if (entry.reason === 'Aktualizacja licznika serwera') return;
    const delegated = entry.executorId === guild.client.user.id && /^Moderator (\d{17,20}):\s*(.*)$/s.exec(entry.reason ?? '');
    const [executor, target] = await Promise.all([
      auditUserName(guild, delegated ? delegated[1] : entry.executorId, delegated ? undefined : entry.executor),
      auditTargetName(guild, entry),
    ]);
    const channel = auditChannelName(guild, entry.extra?.channel);
    const extraTarget = entry.extra?.displayName ?? entry.extra?.name;
    const details = [...new Set((entry.changes ?? []).map(auditChange).filter(Boolean))].slice(0, 5);
    const lines = [
      `Wykonawca: **${executor}**`,
      `Cel: **${target}**`,
      `Powód: ${detail((delegated ? delegated[2] : entry.reason) || 'Nie podano')}`,
      ...(channel ? [`Kanał: ${channel}`] : []),
      ...(extraTarget ? [`Dotyczy: ${detail(extraTarget)}`] : []),
      ...(Number.isFinite(entry.extra?.count) ? [`Liczba wiadomości: ${entry.extra.count}`] : []),
      ...details.map((change) => `• ${change}`),
    ];
    const keys = (entry.changes ?? []).map(({ key }) => key);
    const exact = ({
      [AuditLogEvent.MemberKick]: 'log-wyrzucenia',
      [AuditLogEvent.MemberBanAdd]: 'log-bany',
      [AuditLogEvent.MemberBanRemove]: 'log-bany',
      [AuditLogEvent.MessageDelete]: 'log-usuniete',
      [AuditLogEvent.MessageBulkDelete]: 'log-usuniete',
      [AuditLogEvent.MemberRoleUpdate]: keys.includes('$add') && !keys.includes('$remove') ? 'log-nadane-role'
        : keys.includes('$remove') && !keys.includes('$add') ? 'log-zabrane-role' : undefined,
      [AuditLogEvent.MemberUpdate]: keys.includes('nick') ? 'log-pseudonimy' : undefined,
    })[entry.action];
    const destination = getState().channels[exact] ? exact : auditRoutes.get(entry.action) ?? 'logi-bota';
    await log(guild, destination, `🧾 ${action}`, lines.join('\n'));
  });

  setInterval(() => {
    const now = Date.now();
    for (const [user, history] of rates) if (now - history.at(-1) > 8_000) rates.delete(user);
    for (const [user, preview] of pendingClears) if (now >= preview.expires) pendingClears.delete(user);
  }, 30_000).unref();
  setInterval(() => {
    const guild = client.guilds.cache.get(guildId);
    checkRecentKicks(guild).catch(logError);
  }, 30_000).unref();
  setInterval(() => {
    const guild = client.guilds.cache.get(guildId);
    checkRecentJoins(guild).catch(logError);
  }, 60_000).unref();
  setInterval(() => {
    const guild = client.guilds.cache.get(guildId);
    if (active(guild)) refreshStats(guild).catch(logError);
  }, 15 * 60_000).unref();

  function statisticsReply(guild) {
    const { total, online, offline } = stats(guild);
    return `**📊 Statystyki serwera**\n👥 Razem: **${total}**\n🟢 Online: **${online}**\n⚫ Offline: **${offline}**`;
  }

  return { accept, confirmClear, gateRoles, isVerified, log, moderate, prepareBoostThanks, prepareMemberNotices, previewClear, refreshStats, review,
    statisticsReply, syncPresence };
}
