import { ChannelType, EmbedBuilder, MessageFlags, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { ticketCloseButton } from './panels.mjs';
import { panelRoleId } from './plan.mjs';
import { privateModerationChannel, SetupError } from './setup.mjs';

const prefix = 'community-ticket';
const read = ['ViewChannel', 'ReadMessageHistory'];
const write = ['SendMessages', 'EmbedLinks'];
const noMentions = { parse: [] };
const archiveKey = 'log-archiwum-ticketow';
const categoryKey = 'ticket-active';
const applicationCategory = 'staff-applications';
const applicationArchive = 'staff-applications-archive';
const applicationPrefix = 'community-application';
const applicationTemplate = `# 📋 PODANIE DO ADMINISTRACJI

**PO GODZINACH** ━━━━━━━━━━━━━━━━━━━━

1. **Nick na Discordzie:**
2. **Wiek:**
3. **Na jakie stanowisko aplikujesz?** Administrator / Moderator / Pomocnik
4. **Ile czasu dziennie możesz poświęcić na serwer?**
5. **Czy posiadasz doświadczenie w administracji?**
6. **Czy byłeś już członkiem administracji na innym serwerze?**
7. **Dlaczego chcesz dołączyć do naszej ekipy?**
8. **Co wniesiesz do serwera Po Godzinach?**
9. **Jak poradzisz sobie z konfliktem między użytkownikami?**
10. **Co zrobisz, jeśli Twój znajomy złamie regulamin?**
11. **Jak zachowasz się wobec osoby, która prowokuje Cię na czacie?**
12. **Czy potrafisz pracować w zespole?**
13. **Jakie są Twoje mocne strony?**
14. **Dlaczego powinniśmy wybrać właśnie Ciebie?**
15. **Czy jesteś osobą aktywną i odpowiedzialną?**

━━━━━━━━━━━━━━━━━━━━
### 📌 INFORMACJE
- Odpowiadaj szczerze i samodzielnie.
- Nie przyjmujemy osób, które nadużywają uprawnień.
- Wymagana jest kultura osobista i odpowiedzialność.
- Każde podanie zostanie dokładnie rozpatrzone.

🌙 **PO GODZINACH – RAZEM TWORZYMY COMMUNITY!**`;
const archiveReason = 'Prywatna strefa pomocy i archiwum zgłoszeń';

export function ticketDetails(channel, state) {
  if (channel?.type !== ChannelType.GuildText || !channel.parentId) return null;
  const application = channel.parentId === state.categories[applicationCategory];
  if (!application && ![state.categories.moderation, state.categories[categoryKey]].includes(channel.parentId)) return null;
  const match = new RegExp(`^${application ? applicationPrefix : prefix}:(open|closed|closing|archived):(\\d{17,20})(?::(\\d{17,20}))?$`).exec(channel.topic ?? '');
  return match && (match[1] === 'archived') === Boolean(match[3])
    ? { open: match[1] === 'open', status: match[1], userId: match[2], archiveId: match[3], application } : null;
}

export function isApplicationChannel(channel, state) {
  return Boolean(channel && (channel.id === state.channels[applicationArchive] || channel.id === state.categories[applicationCategory] ||
    channel.parentId === state.categories[applicationCategory] && channel.parentId || channel.topic?.startsWith(applicationPrefix + ':')));
}

function ticketPermissions(guild, state, userId, open, application) {
  const member = OverwriteType.Member;
  const role = OverwriteType.Role;
  const staff = application ? [panelRoleId] : [...new Set([state.roles.mod, state.roles.admin])];
  return [
    { id: guild.id, type: role, deny: ['ViewChannel', 'SendMessages'] },
    { id: guild.client.user.id, type: member, allow: [...read, ...write] },
    ...staff.map((id) => ({ id, type: role, allow: open ? [...read, ...write] : read })),
    { id: userId, type: member, allow: open ? [...read, 'SendMessages'] : read },
  ];
}

function ticketIsPrivate(channel, guild, state, userId, open = true, application = false) {
  const expected = ticketPermissions(guild, state, userId, open, application);
  const actual = channel.permissionOverwrites.cache;
  return actual.size === expected.length && expected.every((entry) => {
    const saved = actual.get(entry.id);
    return saved?.type === entry.type && saved.allow.equals(entry.allow ?? []) && saved.deny.equals(entry.deny ?? []);
  });
}

export async function lockTicketChannel(channel, state) {
  const ticket = ticketDetails(channel, state);
  if (!ticket || ticketIsPrivate(channel, channel.guild, state, ticket.userId, ticket.open, ticket.application)) return;
  await channel.edit({
    permissionOverwrites: ticketPermissions(channel.guild, state, ticket.userId, ticket.open, ticket.application),
    reason: 'Przywrócenie prywatności zgłoszenia',
  });
}

export function createTickets({ getState, log, logError, archiveEnabled = false }) {
  const opening = new Set();
  const closing = new Set();
  const recentlyOpened = new Map();
  const removing = new Set();

  async function setup(guild, { state, save }) {
    if (!archiveEnabled || !state.securityReady) return;
    const all = await guild.channels.fetch();
    const logSource = await privateModerationChannel(guild, state, { name: 'log-tickety' });
    const staffSource = await privateModerationChannel(guild, state, { name: 'mod-log' });
    const copy = (source) => [...source.permissionOverwrites.cache.values()].map(({ id, type, allow, deny }) =>
      ({ id, type, allow: allow.bitfield, deny: deny.bitfield }));
    const privateAccess = copy(logSource);
    const archiveAccess = privateAccess.map((entry) => entry.id === guild.client.user.id
      ? { ...entry, allow: entry.allow | PermissionFlagsBits.AttachFiles } : entry);
    async function ensure(key, name, type, parent, permissionOverwrites) {
      const records = type === ChannelType.GuildCategory ? state.categories : state.channels;
      const saved = all.get(records[key]);
      if (saved?.type === type && (saved.parentId ?? null) === (parent ?? null)) return saved;
      const matching = all.filter((channel) => channel?.name === name && channel.type === type &&
        (channel.parentId ?? null) === (parent ?? null));
      if (saved || matching.size > 1) throw new SetupError(`Sprawdź ustawienia ${name}.`);
      const channel = matching.first() ?? await guild.channels.create({
        name, type, ...(parent ? { parent } : {}), permissionOverwrites, reason: archiveReason,
      });
      records[key] = channel.id;
      await save();
      return channel;
    }
    const help = await ensure('ticket-help', '╭━━ 🛟 POMOC I ADMINISTRACJA ━━╮', ChannelType.GuildCategory, null, privateAccess);
    const active = await ensure(categoryKey, '╭━━ 🎫 TICKETY ━━╮', ChannelType.GuildCategory, null, privateAccess);
    const admin = await ensure('ticket-admin', '🛠️│centrum-administracji', ChannelType.GuildText, help.id, copy(staffSource));
    const archive = await ensure(archiveKey, '📁│archiwum-ticketów', ChannelType.GuildText, help.id, archiveAccess);
    await privateModerationChannel(guild, state, { name: archiveKey });
    const expected = copy(staffSource);
    const identical = admin.permissionOverwrites.cache.size === expected.length && expected.every((entry) => {
      const actual = admin.permissionOverwrites.cache.get(entry.id);
      return actual?.type === entry.type && actual.allow.equals(entry.allow) && actual.deny.equals(entry.deny);
    });
    if (!identical) throw new SetupError('Sprawdź prywatność centrum administracji.');
    if (!state.messages['ticket-admin']) {
      const message = await admin.send({ embeds: [new EmbedBuilder().setColor(0x946CF2)
        .setTitle('🛟 Centrum administracji')
        .setDescription(`Otwarte zgłoszenia pojawiają się w osobnej kategorii.\n\n🛠️ Panel moderatorów: <#${state.channels['panel-moderacji']}>\n📁 Rozmowy zamkniętych ticketów: <#${archive.id}>\n📋 Zdarzenia ticketów: <#${logSource.id}>`)], allowedMentions: noMentions });
      state.messages['ticket-admin'] = message.id;
      await save();
    }
    for (const channel of all.values()) {
      const ticket = ticketDetails(channel, state);
      if (ticket?.archiveId) scheduleRemoval(guild, channel.id, ticket.archiveId);
    }
    const readable = await canArchive(guild);
    console.log(`Strefa pomocy gotowa: centrum ${admin.id}, tickety ${active.id}, archiwum ${archive.id}, treść rozmów: ${readable ? 'dostępna' : 'brak Message Content Intent'}.`);
  }

  async function canArchive(guild) {
    const app = await guild.client.application.fetch();
    return app.flags.has('GatewayMessageContent') || app.flags.has('GatewayMessageContentLimited');
  }

  function archiveMarker(id) {
    return `TICKET · ${id}`;
  }

  async function saveTranscript(channel, archive, ticket, actor) {
    const recent = await archive.messages.fetch({ limit: 100 });
    const existing = recent.find((message) => message.author.id === archive.client.user.id &&
      message.embeds.some((embed) => embed.footer?.text === archiveMarker(channel.id)) && message.attachments.size);
    if (existing) return existing;
    const batches = [];
    let before;
    let total = 0;
    let bytes = 0;
    for (;;) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
      if (!page.size) break;
      total += page.size;
      if (total > 5000) throw new SetupError('Rozmowa jest za długa do automatycznego zapisu. Kanał został zachowany.');
      const batch = [...page.values()].reverse().map((message) => {
        const author = message.author?.globalName ?? message.author?.username ?? 'Nieznany autor';
        const files = [...message.attachments.values()].map((attachment) => `[Załącznik: ${attachment.name}]`);
        return [`[${new Date(message.createdTimestamp).toISOString()}] ${author}`, message.content, ...files]
          .filter(Boolean).join('\n');
      }).join('\n\n');
      bytes += Buffer.byteLength(batch);
      if (bytes > 7_500_000) throw new SetupError('Archiwum jest za duże. Kanał został zachowany.');
      batches.unshift(batch);
      before = page.lastKey();
      if (page.size < 100) break;
    }
    const text = [`Zgłoszenie: ${channel.name}`, `Wiadomości: ${total}`, '', ...batches].join('\n\n');
    return archive.send({
      embeds: [new EmbedBuilder().setColor(0x946CF2).setTitle(`📁 ${channel.name}`)
        .setDescription(`Zgłaszający: <@${ticket.userId}>\nZamknął: <@${actor.id}>\nWiadomości: **${total}**\nZapis rozmowy jest w pliku poniżej.`)
        .setFooter({ text: archiveMarker(channel.id) }).setTimestamp()],
      files: [{ attachment: Buffer.from(text), name: `ticket-${channel.id}.txt` }],
      allowedMentions: noMentions, nonce: channel.id, enforceNonce: true,
    });
  }

  function scheduleRemoval(guild, channelId, archiveId) {
    if (removing.has(channelId)) return;
    removing.add(channelId);
    setTimeout(async () => {
      try {
        const state = getState();
        const channel = await guild.channels.fetch(channelId, { force: true });
        const ticket = ticketDetails(channel, state);
        if (ticket?.archiveId !== archiveId) return;
        const archive = await privateModerationChannel(guild, state, { name: ticket.application ? applicationArchive : archiveKey });
        const message = await archive.messages.fetch({ message: archiveId, force: true });
        if (message.author.id === guild.client.user.id && message.attachments.size &&
          message.embeds.some((embed) => embed.footer?.text === archiveMarker(channelId))) {
          await channel.delete(ticket.application ? 'Rekrutacja: podanie zapisano w archiwum' : 'Zgłoszenie zapisano w prywatnym archiwum');
        }
      } catch (error) {
        if (Number(error.code) !== 10003) logError(error);
      } finally { removing.delete(channelId); }
    }, 8000).unref();
  }

  async function open(interaction, text, application = false) {
    const description = text.trim();
    if (!application && (description.length < 5 || description.length > 1200)) throw new SetupError('Opis musi zawierać od 5 do 1200 znaków.');
    const { guild, user } = interaction;
    const state = getState();
    if (!state.securityReady || !state.categories.moderation || !state.roles.mod || !state.roles.admin) {
      throw new SetupError('Zgłoszenia będą dostępne po konfiguracji serwera.');
    }
    const requestKey = `${application}:${user.id}`;
    if (opening.has(requestKey)) throw new SetupError('Twój kanał zgłoszenia jest właśnie tworzony.');
    opening.add(requestKey);
    try {
      const channels = await guild.channels.fetch();
      const existing = channels.find((channel) => {
        const ticket = ticketDetails(channel, state);
        return ticket?.open && ticket.userId === user.id && ticket.application === application;
      });
      if (existing) {
        if (!ticketIsPrivate(existing, guild, state, user.id, true, application)) {
          throw new SetupError('Moderacja musi sprawdzić dostęp do Twojego kanału zgłoszenia.');
        }
        const recent = await existing.messages.fetch({ limit: 1 });
        if (!recent.size) await postOpening(existing, interaction, description, application);
        return `Masz już otwarte zgłoszenie: <#${existing.id}>. Dopisz szczegóły na tym kanale.`;
      }
      if (recentlyOpened.has(requestKey)) throw new SetupError('Odczekaj minutę przed otwarciem kolejnego zgłoszenia.');
      const parent = application ? state.categories[applicationCategory] : state.categories[categoryKey] ?? state.categories.moderation;
      if (!parent || application && !await guild.roles.fetch(panelRoleId, { force: true })) {
        throw new SetupError('Podania będą dostępne po skonfigurowaniu strefy rekrutacji.');
      }
      if (channels.filter(({ parentId }) => parentId === parent).size >= 48) {
        throw new SetupError('Brakuje miejsca na nowy kanał zgłoszenia. Poproś moderację o pomoc.');
      }
      const logsChannel = await privateModerationChannel(guild, state, { name: application ? applicationArchive : 'log-tickety' });
      const channel = await guild.channels.create({
        name: (application ? 'podanie-' : 'zgloszenie-') + user.id.slice(-6),
        parent,
        type: ChannelType.GuildText,
        topic: `${application ? applicationPrefix : prefix}:open:${user.id}`,
        permissionOverwrites: ticketPermissions(guild, state, user.id, true, application),
        rateLimitPerUser: 5,
        reason: application ? 'Rekrutacja: otwarcie podania' : `Prywatne zgłoszenie użytkownika ${user.id}`,
      });
      if (!ticketIsPrivate(channel, guild, state, user.id, true, application)) {
        throw new SetupError('Discord nie zapisał prywatnych uprawnień kanału zgłoszenia.');
      }
      recentlyOpened.set(requestKey, true);
      setTimeout(() => recentlyOpened.delete(requestKey), 60_000).unref();
      await postOpening(channel, interaction, description, application).catch(logError);
      await logsChannel.send({
        content: `📨 **${application ? 'Nowe podanie do administracji' : 'Nowe zgłoszenie'}** od <@${user.id}> — <#${channel.id}>.`,
        allowedMentions: noMentions,
      }).catch(logError);
      return application ? `Otwarto prywatne podanie: <#${channel.id}>. Odpowiedz tam na pytania.`
        : `Otwarto prywatne zgłoszenie: <#${channel.id}>. Możesz tam pisać z moderacją.`;
    } finally {
      opening.delete(requestKey);
    }
  }

  async function close(interaction, actor, { fromWebPanel = false } = {}) {
    const { guild } = interaction;
    const state = getState();
    const channel = await guild.channels.fetch(interaction.channelId, { force: true });
    const ticket = ticketDetails(channel, state);
    if (!ticket) throw new SetupError('Otwórz przycisk we właściwym kanale zgłoszenia.');
    const staff = [state.roles.mod, state.roles.admin].some((id) => actor.roles.cache.has(id));
    if (ticket.application && !actor.roles.cache.has(panelRoleId)) {
      throw new SetupError('Podanie może zamknąć tylko rola „Właściciel”.');
    }
    if (!ticket.application && !fromWebPanel && actor.id !== ticket.userId && actor.id !== guild.ownerId &&
        !actor.permissions.has(PermissionFlagsBits.Administrator) && !staff) {
      throw new SetupError('Zgłoszenie może zamknąć jego autor lub moderacja.');
    }
    if (closing.has(channel.id)) throw new SetupError('Zamykanie zgłoszenia już trwa.');
    if (ticket.archiveId) {
      scheduleRemoval(guild, channel.id, ticket.archiveId);
      return 'Zgłoszenie jest już zapisane w archiwum.';
    }
    if (!ticket.open && ticket.status !== 'closing') return 'Zgłoszenie jest już zamknięte.';
    closing.add(channel.id);
    try {
      const shouldArchive = archiveEnabled || ticket.application;
      const ticketPrefix = ticket.application ? applicationPrefix : prefix;
      await channel.edit({
        topic: `${ticketPrefix}:${shouldArchive ? 'closing' : 'closed'}:${ticket.userId}`,
        permissionOverwrites: ticketPermissions(guild, state, ticket.userId, false, ticket.application),
        reason: ticket.application ? 'Rekrutacja: zamknięcie podania' : `Zamknięcie zgłoszenia przez użytkownika ${actor.id}`,
      });
      if (shouldArchive) {
        if (!await canArchive(guild)) {
          return 'Zgłoszenie jest do odczytu. Kanał zostaje do czasu włączenia botowi dostępu do treści wiadomości i ponownego zamknięcia.';
        }
        const archive = await privateModerationChannel(guild, state, { name: ticket.application ? applicationArchive : archiveKey });
        const saved = await saveTranscript(channel, archive, ticket, actor);
        if (!saved.attachments.size) throw new SetupError('Zapis rozmowy się nie powiódł. Kanał został zachowany.');
        await channel.setTopic(`${ticketPrefix}:archived:${ticket.userId}:${saved.id}`, ticket.application ? 'Rekrutacja: zapisano podanie' : 'Zapisano historię zgłoszenia');
        if (!ticket.application) await log(guild, 'log-tickety', '🔒 Zamknięcie zgłoszenia', `Zamknął: <@${actor.id}>.\n[Zapis rozmowy](${saved.url})`);
        scheduleRemoval(guild, channel.id, saved.id);
        return ticket.application ? 'Podanie zapisano w archiwum roli „Właściciel”. Kanał zniknie za chwilę.'
          : 'Rozmowa została zapisana dla moderacji. Kanał zgłoszenia zniknie za chwilę.';
      }
      if (interaction.message) await interaction.message.edit({ components: [] }).catch(logError);
      await channel.send({ content: '🔒 Zgłoszenie zostało zamknięte. Historia jest dostępna do odczytu.',
        allowedMentions: noMentions }).catch(logError);
      await log(guild, 'log-tickety', '🔒 Zamknięcie zgłoszenia', `Kanał: <#${channel.id}>\nZamknął: <@${actor.id}>.`);
      return 'Zgłoszenie zamknięte.';
    } finally {
      closing.delete(channel.id);
    }
  }

  return { setup, open, openApplication: (interaction) => open(interaction, '', true), close,
    isTicket: (channel) => Boolean(ticketDetails(channel, getState())) };
}

function postOpening(channel, interaction, description, application) {
  return channel.send({
    content: application ? applicationTemplate : `📨 **Prywatne zgłoszenie**\nZgłaszający: <@${interaction.user.id}>\n\n>>> ${description}\n\nTu możesz dopisać szczegóły i porozmawiać z moderacją.`,
    components: [ticketCloseButton()],
    allowedMentions: noMentions,
    flags: MessageFlags.SuppressEmbeds,
    nonce: interaction.id,
    enforceNonce: true,
  });
}
