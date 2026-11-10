import { ChannelType, EmbedBuilder, Events } from 'discord.js';
import { SetupError } from './setup.mjs';

const disboardId = '302050872383242240';
const recipientId = '1087775202395566232';
const hour = 60 * 60_000;
const footer = 'Po Godzinach · Bump';
const permissions = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks'];

function successfulBump(message) {
  return message.author?.id === disboardId && [
    message.content, ...message.embeds.flatMap(({ title, description }) => [title, description]),
  ].some((text) => /\b(?:bump done|bump wykonany|bump zakończony sukcesem|podbito serwer)\b/iu.test(text ?? ''));
}

export function createBumpReminder({ client, getProgress, logError }) {
  let channel;
  let queue = Promise.resolve();
  function run(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  function setup(guild, channels) {
    return run(async () => {
      const matches = channels.filter((item) => item?.type === ChannelType.GuildText &&
        /(?:^|[^\p{L}\p{N}])bump(?:$|[^\p{L}\p{N}])/iu.test(item.name));
      if (matches.size !== 1) throw new SetupError('Wskaż jeden kanał tekstowy z nazwą „bump”.');
      const selected = matches.first();
      const bot = await guild.members.fetchMe();
      if (!selected.permissionsFor(bot)?.has(permissions)) {
        await selected.permissionOverwrites.edit(bot, Object.fromEntries(permissions.map((permission) => [permission, true])),
          { reason: 'Przypomnienia DISBOARD na kanale bump' });
      }
      const recent = await selected.messages.fetch({ limit: 100, cache: false });
      const progress = getProgress();
      await progress.update((data) => {
        if (data.bump?.channelId !== selected.id) {
          data.bump = { channelId: selected.id, startedAt: Date.now(), lastBump: 0, lastReminder: 0 };
        }
        for (const message of recent.values()) {
          if (successfulBump(message)) data.bump.lastBump = Math.max(data.bump.lastBump, message.createdTimestamp);
          if (message.author?.id === client.user.id && message.embeds.some((embed) => embed.footer?.text === footer)) {
            data.bump.lastReminder = Math.max(data.bump.lastReminder, message.createdTimestamp);
          }
        }
      });
      channel = selected;
      const { lastBump } = progress.read().bump;
      console.log(`Przypomnienia DISBOARD gotowe: kanał ${channel.id}, odbiorca ${recipientId}, ostatni potwierdzony bump: ${lastBump ? new Date(lastBump).toISOString() : 'brak'}.`);
    });
  }

  function watch(message) {
    if (!channel || message.channelId !== channel.id || message.author?.id !== disboardId) return;
    run(async () => {
      const response = message.partial || (!message.content && !message.embeds.length)
        ? await channel.messages.fetch({ message: message.id, force: true, cache: false }) : message;
      const progress = getProgress();
      if (!successfulBump(response) || response.createdTimestamp <= progress.read().bump.lastBump) return;
      await progress.update((data) => { data.bump.lastBump = response.createdTimestamp; });
    }).catch(logError);
  }

  client.on(Events.MessageCreate, watch);
  client.on(Events.MessageUpdate, (_before, after) => watch(after));
  setInterval(() => {
    if (!channel) return;
    run(async () => {
      const progress = getProgress();
      const { startedAt, lastBump, lastReminder } = progress.read().bump;
      const due = lastReminder && lastReminder >= lastBump ? lastReminder + 3 * hour : (lastBump || startedAt) + 2 * hour;
      if (Date.now() < due) return;
      const last = lastBump ? `\nOstatni udany bump: <t:${Math.floor(lastBump / 1000)}:R>.` : '';
      const sent = await channel.send({
        content: `<@${recipientId}>`,
        embeds: [new EmbedBuilder().setColor(0x8B74FF).setTitle('🚀 Czas na bump!')
          .setDescription(`Użyj **/bump** aplikacji **DISBOARD** na tym kanale, żeby podbić Po Godzinach.${last}`)
          .setFooter({ text: footer }).setTimestamp()],
        allowedMentions: { parse: [], users: [recipientId] }, nonce: String(due), enforceNonce: true,
      });
      await progress.update((data) => { data.bump.lastReminder = sent.createdTimestamp; });
    }).catch(logError);
  }, 60_000).unref();
  return { setup };
}
