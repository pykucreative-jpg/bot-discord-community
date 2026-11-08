import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { musicPanelKey } from './plan.mjs';
import { isStatsChannel, SetupError } from './setup.mjs';

const jockieIds = ['411916947773587456', '412347257233604609', '412347553141751808', '412347780841865216'];
const prefix = 'community:jockie:';
const messageKey = 'jockie-panel';
const docs = 'https://www.jockiemusic.com/commands';
const noMentions = { parse: [] };
const controls = {
  queue: ['📋', 'Kolejka', 'queue'],
  playing: ['🎶', 'Teraz gra', 'now playing'],
  pause: ['⏸️', 'Pauza', 'pause'],
  resume: ['▶️', 'Wznów', 'resume'],
  skip: ['⏭️', 'Pomiń', 'skip'],
  leave: ['⏹️', 'Rozłącz', 'leave'],
};

function shortcut(action, emoji, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(prefix + action).setEmoji(emoji).setLabel(label).setStyle(style);
}

function panelPayload() {
  return {
    allowedMentions: noMentions,
    embeds: [new EmbedBuilder().setColor(0x9266F0).setTitle('🎧  Jockie Music · Po Godzinach')
      .setDescription([
        '**1.** Dołącz do kanału głosowego.',
        '**2.** Wybierz **Dodaj utwór** i wpisz tytuł albo wklej link Spotify.',
        '**3.** Skopiuj gotową komendę i wyślij ją tutaj. Jockie dołączy do Twojego głosowego.',
      ].join('\n'))
      .addFields(
        { name: '🎵 Szybki start', value: '`m!play wykonawca i tytuł`', inline: true },
        { name: '📋 Obsługa kolejki', value: 'Przyciski pokazują komendy do skopiowania.', inline: true },
      )
      .setFooter({ text: 'PO GODZINACH · WSPÓLNE SŁUCHANIE' })],
    components: [
      new ActionRowBuilder().addComponents(
        shortcut('play', '🎵', 'Dodaj utwór', ButtonStyle.Primary),
        shortcut('queue', ...controls.queue.slice(0, 2)),
        shortcut('playing', ...controls.playing.slice(0, 2)),
        new ButtonBuilder().setLabel('Komendy Jockie').setStyle(ButtonStyle.Link).setURL(docs),
      ),
      new ActionRowBuilder().addComponents(...['pause', 'resume', 'skip', 'leave'].map((action) =>
        shortcut(action, ...controls[action].slice(0, 2), action === 'leave' ? ButtonStyle.Danger : ButtonStyle.Secondary))),
    ],
  };
}

async function grant(channel, target, permissions) {
  const missing = permissions.filter((permission) => !channel.permissionsFor(target)?.has(permission));
  if (missing.length) {
    await channel.permissionOverwrites.edit(target, Object.fromEntries(missing.map((permission) => [permission, true])),
      { reason: 'Dostęp do panelu i odtwarzania Jockie Music' });
  }
}

export function createJockiePanel({ logError }) {
  let panel;

  async function setup(guild, { state, save }) {
    const id = state.channels[musicPanelKey];
    const channel = id && await guild.channels.fetch(id);
    if (channel?.type !== ChannelType.GuildText) throw new SetupError('Brakuje zapisanego kanału panel-muzyki.');
    const verified = state.roles.verified && await guild.roles.fetch(state.roles.verified);
    if (!verified) throw new SetupError('Brakuje roli zweryfikowanych do panelu muzycznego.');
    const members = await Promise.all(jockieIds.map((botId) => guild.members.fetch(botId).catch((error) => {
      if (Number(error.code) !== 10007) throw error;
    })));
    const bots = members.filter((member) => member?.user.bot);
    if (!bots.length) throw new SetupError('Nie znaleziono Jockie Music na serwerze.');
    await grant(channel, verified, ['SendMessages']);
    const channels = await guild.channels.fetch();
    const voiceChannels = channels.filter((voice) => voice?.type === ChannelType.GuildVoice &&
      !isStatsChannel(state, voice.id) && voice.permissionsFor(verified)?.has(['ViewChannel', 'Connect']));
    for (const bot of bots) {
      await grant(channel, bot, ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'EmbedLinks']);
      for (const voice of voiceChannels.values()) await grant(voice, bot, ['ViewChannel', 'Connect', 'Speak']);
    }
    const isPanel = (message) => message?.author.id === guild.client.user.id &&
      message.components.some((row) => row.components.some((item) => item.customId === prefix + 'play'));
    const history = await channel.messages.fetch({ limit: 25 });
    const saved = history.get(state.messages[messageKey]);
    panel = isPanel(saved) ? saved : history.find(isPanel);
    if (!panel && state.messages[messageKey]) {
      const previous = await channel.messages.fetch(state.messages[messageKey]).catch((error) => {
        if (Number(error.code) !== 10008) throw error;
      });
      if (isPanel(previous)) panel = previous;
    }
    panel = panel ? await panel.edit(panelPayload()) : await channel.send(panelPayload());
    state.messages[messageKey] = panel.id;
    await save();
    console.log(`Panel Jockie Music gotowy: kanał ${channel.id}, wiadomość ${panel.id}; boty ${bots.length}, głosowe ${voiceChannels.size}.`);
  }

  async function handle(interaction) {
    if (!(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith(prefix)) return false;
    const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
    try {
      if (!panel || interaction.channelId !== panel.channelId || interaction.message?.id !== panel.id) {
        await reply('Otwórz aktualny panel Jockie Music.');
        return true;
      }
      const action = interaction.customId.slice(prefix.length);
      if (interaction.isButton() && action === 'play') {
        await interaction.showModal(new ModalBuilder().setCustomId(prefix + 'track').setTitle('🎵 Dodaj utwór w Jockie')
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('track')
            .setLabel('Tytuł i wykonawca lub link Spotify').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(350))));
      } else if (interaction.isModalSubmit() && action === 'track') {
        const input = interaction.fields.getTextInputValue('track').replace(/[`\s]+/g, ' ').trim();
        if (!input) await reply('Wpisz tytuł lub wklej link do Spotify.');
        else await reply(`Skopiuj komendę i wyślij ją w tym kanale. Jockie dołączy, gdy jesteś na głosowym.\n\n\`\`\`\nm!play ${input}\n\`\`\``);
      } else if (interaction.isButton() && Object.hasOwn(controls, action)) {
        await reply(`Skopiuj komendę i wyślij ją w tym kanale.\n\n\`\`\`\nm!${controls[action][2]}\n\`\`\``);
      }
    } catch (error) {
      logError(error);
      if (!interaction.replied) await reply('Panel chwilowo nie odpowiada. Spróbuj ponownie.').catch(logError);
    }
    return true;
  }

  return { setup, handle };
}
