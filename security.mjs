import {
  AuditLogEvent, ChannelType, EmbedBuilder, Events, MessageType, PermissionFlagsBits,
  SlashCommandBuilder, SystemChannelFlagsBitField, escapeMarkdown,
} from 'discord.js';
import { channelLabel } from './plan.mjs';
import { reviewButtons } from './panels.mjs';
import { channelEntries, privateModerationChannel, SetupError } from './setup.mjs';

const DAY = 86_400_000;
const NO_MENTIONS = { parse: [] };
const AUDIT_EVENTS = new Set([
  'GuildUpdate', 'ChannelCreate', 'ChannelUpdate', 'ChannelDelete', 'ChannelOverwriteCreate',
  'ChannelOverwriteUpdate', 'ChannelOverwriteDelete', 'MemberKick', 'MemberPrune', 'MemberBanAdd',
  'MemberBanRemove', 'MemberUpdate', 'MemberRoleUpdate', 'RoleCreate', 'RoleUpdate', 'RoleDelete',
  'InviteCreate', 'InviteDelete', 'WebhookCreate', 'WebhookUpdate', 'WebhookDelete', 'MessageDelete',
  'MessageBulkDelete', 'AutoModerationRuleCreate', 'AutoModerationRuleUpdate', 'AutoModerationRuleDelete',
].map((key) => AuditLogEvent[key]));
const BOOST_TYPES = new Set([
  MessageType.GuildBoost, MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3,
]);

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
  return `${escapeMarkdown(user.username)} • \`${user.id}\``;
}

function detail(value) {
  return escapeMarkdown(String(value ?? 'brak').slice(0, 350));
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
  const joins = [];
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
    const { channels } = getState();
    const ids = channelEntries.map(({ channel }) => channels[channel.name]).filter(Boolean);
    return ids.includes(channel?.id) || (channel?.isThread?.() && ids.includes(channel.parentId));
  }

  async function post(guild, name, embed) {
    const state = getState();
    if (!active(guild) || !state.channels[name]) return;
    try {
      const channel = name === 'mod-log' ? await privateModerationChannel(guild, state, false)
        : await guild.channels.fetch(state.channels[name]);
      if (channel?.type === ChannelType.GuildText) return await channel.send({ embeds: [embed], allowedMentions: NO_MENTIONS });
    } catch (error) {
      if (!(error instanceof SetupError)) logError(error);
    }
  }

  function log(guild, title, description, color) {
    return post(guild, 'mod-log', card(title, description, color));
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

  async function gateRoles(guild) {
    const state = getState();
    const serverRoles = await guild.roles.fetch();
    const gate = Object.fromEntries(['verified', 'review', 'blocked'].map((key) => [key, serverRoles.get(state.roles[key])]));
    if (Object.values(gate).some((role) => !role?.editable || role.permissions.bitfield !== 0n)) {
      throw new SetupError('Weryfikacja wymaga sprawdzenia ról przez administrację.');
    }
    return gate;
  }

  async function accept(interaction) {
    const guild = interaction.guild;
    const state = getState();
    if (!active(guild) || interaction.channelId !== state.channels.weryfikacja ||
        interaction.message.id !== state.messages.weryfikacja) {
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
      if (has(gate.verified)) return 'Masz już dostęp do społeczności.';
      if (has(gate.review)) return 'Twoje zgłoszenie czeka na decyzję moderacji.';
      const accountIsNew = Date.now() - member.user.createdTimestamp < 7 * DAY;
      const raidActive = Date.now() < raidUntil;
      if (accountIsNew || raidActive) {
        const queue = await privateModerationChannel(guild, state);
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
      await log(guild, '✅ Weryfikacja zakończona', label(member.user));
      return 'Gotowe! Masz rolę **Zweryfikowany**. Odblokowano kanały społeczności.';
    });
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
      return `Przeczytaj regulamin i użyj przycisku w <#${state.channels.weryfikacja}>.`;
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
        await member.roles.remove(gate.review.id, note);
      } else if (action === 'wstrzymaj') {
        await member.roles.add(gate.blocked.id, note);
        await member.roles.remove(gate.verified.id, note);
        await member.roles.remove(gate.review.id, note);
      } else {
        await member.roles.remove(gate.blocked.id, note);
      }
      await log(guild, '🛂 Decyzja weryfikacyjna',
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
      if (channel?.type !== ChannelType.GuildText) throw new SetupError('Wybierz kanał tekstowy.');
      if (!channel.permissionsFor(actor)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
        throw new SetupError('Brakuje Ci uprawnień do czyszczenia tego kanału.');
      }
      const count = panel?.count ?? interaction.options.getInteger('liczba', true);
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new SetupError('Podaj liczbę od 1 do 100.');
      const removed = await channel.bulkDelete(count, true);
      await log(guild, '🧹 Czyszczenie wiadomości',
        `Kanał: <#${channel.id}>\nModerator: ${label(actor.user)}\nUsunięto: ${removed.size}`);
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
      const channel = await privateModerationChannel(guild, getState());
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

  const boost = (guild, user) => post(guild, 'witamy', card('💎 Dziękujemy za boost!',
    `<@${user.id}> właśnie wsparł serwer. Dzięki za pomoc w rozwijaniu społeczności! 💜`, 0xDA75D5));

  on(Events.GuildMemberAdd, async (member) => {
    const { guild, user } = member;
    if (!active(guild)) return;
    if (!user.bot) {
      const now = Date.now();
      while (joins.length && now - joins[0] > 20_000) joins.shift();
      joins.push(now);
      const alert = joins.length >= 6 && now >= raidUntil;
      if (joins.length >= 6) raidUntil = now + 10 * 60_000;
      if (alert) await log(guild, '🚨 Wykryto falę dołączeń',
        'Co najmniej 6 osób dołączyło w 20 sekund. Nowe weryfikacje trafiają do ręcznej oceny.', 0xE85D75);
      await post(guild, 'witamy', card('👋 Dobrze, że jesteś!',
        `Witamy <@${user.id}>! Rozgość się i zajrzyj do <#${getState().channels['start-tutaj']}>. Miło Cię widzieć w naszej społeczności.`, 0x2CA58D));
    }
    await log(guild, '📥 Dołączenie', `${label(user)}\nKonto utworzone <t:${Math.floor(user.createdTimestamp / 1000)}:R>.`);
  });
  on(Events.GuildMemberRemove, async (member) => {
    if (!active(member.guild)) return;
    rates.delete(member.id);
    if (!member.user.bot) {
      await post(member.guild, 'pozegnania', card('🌙 Do zobaczenia!',
        `**${detail(member.user.username)}** opuszcza społeczność. Dzięki za wspólnie spędzony czas!`, 0x7767AF));
    }
    await log(member.guild, '📤 Opuszczenie serwera', label(member.user));
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
    await log(guild, '🔊 Zmiana kanału głosowego', `${label(member.user)}\n${from} → ${to}`);
  });

  on(Events.ChannelUpdate, async (_before, channel) => {
    if (!active(channel.guild) || channel.id !== getState().channels.nsfw ||
        channel.type !== ChannelType.GuildText || channel.nsfw) return;
    await channel.edit({ nsfw: true, reason: 'Przywrócenie ograniczenia wiekowego w strefie 18+' });
    await log(channel.guild, '🔞 Przywrócono ograniczenie wiekowe', `Kanał: <#${channel.id}>`, 0xE85D75);
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
      await log(guild, '🛡️ Zatrzymano flood',
        `${label(author)}\nKanał: <#${message.channelId}>\nOgraniczenie pisania: 2 minuty.`, 0xE85D75);
    });
  });
  on(Events.MessageUpdate, async (before, after) => {
    if (!active(after.guild) || after.author?.bot || !after.editedTimestamp || before.editedTimestamp === after.editedTimestamp) return;
    if (!tracked(after.channel)) return;
    await log(after.guild, '✏️ Edycja wiadomości',
      `Kanał: <#${after.channelId}>\nID: \`${after.id}\`\nAutor: ${after.author ? label(after.author) : 'brak danych'}`);
  });
  on(Events.MessageDelete, async (message) => {
    if (!active(message.guild) || message.author?.bot || !tracked(message.channel)) return;
    await log(message.guild, '🗑️ Usunięcie wiadomości',
      `Kanał: <#${message.channelId}>\nID: \`${message.id}\`\nAutor: ${message.author ? label(message.author) : 'brak danych'}`);
  });
  on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!active(channel.guild) || !tracked(channel)) return;
    await log(channel.guild, '🧹 Zbiorcze usuwanie wiadomości',
      `Kanał: <#${channel.id}>\nLiczba wiadomości: ${messages.size}`);
  });
  on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    if (!active(guild) || !AUDIT_EVENTS.has(entry.action)) return;
    if (entry.reason === 'Aktualizacja licznika serwera') return;
    await log(guild, '🧾 Dziennik audytu Discorda',
      `Akcja: **${AuditLogEvent[entry.action]}**\nWykonawca: \`${entry.executorId ?? 'brak'}\`\nCel: \`${entry.targetId ?? 'brak'}\`\nPowód: ${detail(entry.reason)}`);
  });

  setInterval(() => {
    const now = Date.now();
    for (const [user, history] of rates) if (now - history.at(-1) > 8_000) rates.delete(user);
  }, 30_000).unref();
  setInterval(() => {
    const guild = client.guilds.cache.get(guildId);
    if (active(guild)) refreshStats(guild).catch(logError);
  }, 15 * 60_000).unref();

  function statisticsReply(guild) {
    const { total, online, offline } = stats(guild);
    return `**📊 Statystyki serwera**\n👥 Razem: **${total}**\n🟢 Online: **${online}**\n⚫ Offline: **${offline}**`;
  }

  return { accept, isVerified, log, moderate, refreshStats, review, statisticsReply, syncPresence };
}
