import { ChannelType, MessageFlags, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { ticketCloseButton } from './panels.mjs';
import { privateModerationChannel, SetupError } from './setup.mjs';

const prefix = 'community-ticket';
const read = ['ViewChannel', 'ReadMessageHistory'];
const write = ['SendMessages', 'EmbedLinks'];
const noMentions = { parse: [] };

export function ticketDetails(channel, state) {
  if (channel?.type !== ChannelType.GuildText || channel.parentId !== state.categories.moderation) return null;
  const match = new RegExp(`^${prefix}:(open|closed):(\\d{17,20})$`).exec(channel.topic ?? '');
  return match ? { open: match[1] === 'open', userId: match[2] } : null;
}

function ticketPermissions(guild, state, userId, open) {
  const member = OverwriteType.Member;
  const role = OverwriteType.Role;
  const staff = [...new Set([state.roles.mod, state.roles.admin])];
  return [
    { id: guild.id, type: role, deny: ['ViewChannel', 'SendMessages'] },
    { id: guild.client.user.id, type: member, allow: [...read, ...write] },
    ...staff.map((id) => ({ id, type: role, allow: open ? [...read, ...write] : read })),
    { id: userId, type: member, allow: open ? [...read, 'SendMessages'] : read },
  ];
}

function ticketIsPrivate(channel, guild, state, userId, open = true) {
  const expected = ticketPermissions(guild, state, userId, open);
  const actual = channel.permissionOverwrites.cache;
  return actual.size === expected.length && expected.every((entry) => {
    const saved = actual.get(entry.id);
    return saved?.type === entry.type && saved.allow.equals(entry.allow ?? []) && saved.deny.equals(entry.deny ?? []);
  });
}

export async function lockTicketChannel(channel, state) {
  const ticket = ticketDetails(channel, state);
  if (!ticket || ticketIsPrivate(channel, channel.guild, state, ticket.userId, ticket.open)) return;
  await channel.edit({
    permissionOverwrites: ticketPermissions(channel.guild, state, ticket.userId, ticket.open),
    reason: 'Przywrócenie prywatności zgłoszenia',
  });
}

export function createTickets({ getState, log, logError }) {
  const opening = new Set();
  const closing = new Set();
  const recentlyOpened = new Map();

  async function open(interaction, text) {
    const description = text.trim();
    if (description.length < 5 || description.length > 1200) throw new SetupError('Opis musi zawierać od 5 do 1200 znaków.');
    const { guild, user } = interaction;
    const state = getState();
    if (!state.securityReady || !state.categories.moderation || !state.roles.mod || !state.roles.admin) {
      throw new SetupError('Zgłoszenia będą dostępne po konfiguracji serwera.');
    }
    if (opening.has(user.id)) throw new SetupError('Twój kanał zgłoszenia jest właśnie tworzony.');
    opening.add(user.id);
    try {
      const channels = await guild.channels.fetch();
      const existing = channels.find((channel) => {
        const ticket = ticketDetails(channel, state);
        return ticket?.open && ticket.userId === user.id;
      });
      if (existing) {
        if (!ticketIsPrivate(existing, guild, state, user.id)) {
          throw new SetupError('Moderacja musi sprawdzić dostęp do Twojego kanału zgłoszenia.');
        }
        const recent = await existing.messages.fetch({ limit: 1 });
        if (!recent.size) await postOpening(existing, interaction, description);
        return `Masz już otwarte zgłoszenie: <#${existing.id}>. Dopisz szczegóły na tym kanale.`;
      }
      if (recentlyOpened.has(user.id)) throw new SetupError('Odczekaj minutę przed otwarciem kolejnego zgłoszenia.');
      if (channels.filter(({ parentId }) => parentId === state.categories.moderation).size >= 48) {
        throw new SetupError('Brakuje miejsca na nowy kanał zgłoszenia. Poproś moderację o pomoc.');
      }
      const logsChannel = await privateModerationChannel(guild, state, { name: 'log-tickety' });
      const channel = await guild.channels.create({
        name: 'zgloszenie-' + user.id.slice(-6),
        parent: state.categories.moderation,
        type: ChannelType.GuildText,
        topic: `${prefix}:open:${user.id}`,
        permissionOverwrites: ticketPermissions(guild, state, user.id, true),
        rateLimitPerUser: 5,
        reason: `Prywatne zgłoszenie użytkownika ${user.id}`,
      });
      if (!ticketIsPrivate(channel, guild, state, user.id)) {
        throw new SetupError('Discord nie zapisał prywatnych uprawnień kanału zgłoszenia.');
      }
      recentlyOpened.set(user.id, true);
      setTimeout(() => recentlyOpened.delete(user.id), 60_000).unref();
      await postOpening(channel, interaction, description).catch(logError);
      await logsChannel.send({
        content: `📨 **Nowe zgłoszenie** od <@${user.id}> — <#${channel.id}>.`,
        allowedMentions: noMentions,
      }).catch(logError);
      return `Otwarto prywatne zgłoszenie: <#${channel.id}>. Możesz tam pisać z moderacją.`;
    } finally {
      opening.delete(user.id);
    }
  }

  async function close(interaction, actor) {
    const { guild } = interaction;
    const state = getState();
    const channel = await guild.channels.fetch(interaction.channelId, { force: true });
    const ticket = ticketDetails(channel, state);
    if (!ticket) throw new SetupError('Otwórz przycisk we właściwym kanale zgłoszenia.');
    if (!ticket.open) return 'Zgłoszenie jest już zamknięte.';
    const staff = [state.roles.mod, state.roles.admin].some((id) => actor.roles.cache.has(id));
    if (actor.id !== ticket.userId && actor.id !== guild.ownerId &&
        !actor.permissions.has(PermissionFlagsBits.Administrator) && !staff) {
      throw new SetupError('Zgłoszenie może zamknąć jego autor lub moderacja.');
    }
    if (closing.has(channel.id)) throw new SetupError('Zamykanie zgłoszenia już trwa.');
    closing.add(channel.id);
    try {
      await channel.edit({
        topic: `${prefix}:closed:${ticket.userId}`,
        permissionOverwrites: ticketPermissions(guild, state, ticket.userId, false),
        reason: `Zamknięcie zgłoszenia przez użytkownika ${actor.id}`,
      });
      await interaction.message.edit({ components: [] }).catch(logError);
      await channel.send({ content: '🔒 Zgłoszenie zostało zamknięte. Historia jest dostępna do odczytu.',
        allowedMentions: noMentions }).catch(logError);
      await log(guild, 'log-tickety', '🔒 Zamknięcie zgłoszenia', `Kanał: <#${channel.id}>\nZamknął: <@${actor.id}>.`);
      return 'Zgłoszenie zamknięte.';
    } finally {
      closing.delete(channel.id);
    }
  }

  return { open, close };
}

function postOpening(channel, interaction, description) {
  return channel.send({
    content: `📨 **Prywatne zgłoszenie**\nZgłaszający: <@${interaction.user.id}>\n\n>>> ${description}\n\nTu możesz dopisać szczegóły i porozmawiać z moderacją.`,
    components: [ticketCloseButton()],
    allowedMentions: noMentions,
    flags: MessageFlags.SuppressEmbeds,
    nonce: interaction.id,
    enforceNonce: true,
  });
}
