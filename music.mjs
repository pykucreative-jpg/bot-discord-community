import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer, createAudioResource,
  entersState, joinVoiceChannel, StreamType,
} from '@discordjs/voice';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Events, MessageFlags,
  ModalBuilder, OverwriteType, TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { SetupError } from './setup.mjs';
import { musicChannelKey as key } from './plan.mjs';

const prefix = 'community:music:';
const channelName = '🎵│muzyka';
const queueLimit = 15;
const api = 'https://api.audius.co/v1';
const noMentions = { parse: [] };
const inputLink = 'link';
const trackId = /^[a-zA-Z0-9]{3,30}$/;
const base = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const cleanVideoTitle = (value) => value.replace(/\s*[[(](?:(?:official )?(?:music video|video|audio|lyric video)|lyrics|visualizer)[\])]/gi, '').trim();
const safe = (value) => escapeMarkdown(String(value).slice(0, 100));

function readLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new SetupError('Wklej pełny link HTTPS do pojedynczego utworu.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new SetupError('Użyj linku HTTPS.');
  if (url.hostname === 'open.spotify.com') {
    const id = /^\/(?:intl-[a-z-]+\/)?track\/([a-zA-Z0-9]{22})\/?$/.exec(url.pathname)?.[1];
    if (id) return { source: 'Spotify', id };
  }
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
    const id = url.pathname === '/watch' && url.hostname !== 'youtu.be'
      ? url.searchParams.get('v')
      : (url.hostname === 'youtu.be' ? /^\/([\w-]+)\/?$/ : /^\/(?:shorts|live)\/([\w-]+)\/?$/).exec(url.pathname)?.[1];
    if (/^[a-zA-Z0-9_-]{11}$/.test(id ?? '')) return { source: 'YouTube', id };
  }
  if (['audius.co', 'www.audius.co'].includes(url.hostname) && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
    return { source: 'Audius', url: `https://audius.co${url.pathname}` };
  }
  throw new SetupError('Wklej link do pojedynczego utworu z YouTube, Spotify lub Audius.');
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6500), redirect: 'error' });
  if (!response.ok) throw new SetupError('Nie udało się odczytać utworu ze źródła. Sprawdź, czy link jest publiczny.');
  return response;
}

async function resolveAudius(target) {
  const response = await fetch(target, { signal: AbortSignal.timeout(6500), redirect: 'manual' });
  if (response.ok) return response.json();
  const location = response.headers.get('location');
  await response.body?.cancel();
  const next = location && new URL(location, target);
  if (response.status !== 302 || next?.origin !== target.origin || !/^\/v1\/tracks\/[\w]+$/.test(next.pathname)) {
    throw new SetupError('Audius nie udostępnia tego utworu.');
  }
  return (await request(next)).json();
}

async function spotifyInfo(id) {
  const response = await request(`https://open.spotify.com/embed/track/${id}`);
  const page = await response.text();
  const data = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1];
  const entity = data && JSON.parse(data).props?.pageProps?.state?.data?.entity;
  const artist = entity?.artists?.[0]?.name;
  if (!entity?.title || !artist) throw new SetupError('Spotify nie zwrócił tytułu i wykonawcy dla tego linku.');
  return { title: entity.title, artist, seconds: entity.duration / 1000 };
}

async function youtubeInfo(id) {
  const target = new URL('https://www.youtube.com/oembed');
  target.search = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' });
  const video = await (await request(target)).json();
  if (!video.title || !video.author_name) throw new SetupError('YouTube nie zwrócił tytułu tego filmu.');
  const title = cleanVideoTitle(video.title);
  const split = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  return split ? { title: split[2], artist: split[1] } :
    { title, artist: video.author_name.replace(/\s+-\s+Topic$|VEVO$/i, '') };
}

function playable(track) {
  return trackId.test(track?.id ?? '') && track.is_streamable === true && !track.is_stream_gated &&
    !track.stream_conditions && track.duration > 0 && track.duration <= 900 &&
    typeof track.title === 'string' && typeof track.user?.name === 'string' &&
    typeof track.permalink === 'string' && /^\/[^/]+\/[^/]+$/.test(track.permalink);
}

export async function findMusic(link) {
  const input = readLink(link);
  const target = new URL(`${api}/${input.source === 'Audius' ? 'resolve' : 'tracks/search'}`);
  let info;
  if (input.source === 'Audius') {
    target.searchParams.set('url', input.url);
  } else {
    info = await (input.source === 'Spotify' ? spotifyInfo(input.id) : youtubeInfo(input.id));
    target.search = new URLSearchParams({ query: `${info.artist} ${info.title}`.slice(0, 200), limit: '15' });
  }
  const { data } = input.source === 'Audius' ? await resolveAudius(target) : await (await request(target)).json();
  const track = (Array.isArray(data) ? data : [data]).find((candidate) =>
    playable(candidate) && (!info || (
      [base(info.title), base(info.artist + info.title)].includes(base(candidate.title)) &&
      [candidate.user.name, candidate.user.handle].some((artist) => base(artist) === base(info.artist)) &&
      (!Number.isFinite(info.seconds) || Math.abs(candidate.duration - info.seconds) <= 10)
    )));
  if (!track) throw new SetupError(info
    ? `Audius nie znalazł pasującego nagrania dla **${safe(info.artist)} – ${safe(info.title)}**.`
    : 'Ten utwór Audius jest niedostępny lub ma ponad 15 minut.');
  return { id: track.id, title: track.title, artist: track.user.name, url: new URL(track.permalink, 'https://audius.co').href };
}

export async function openMusicStream(id, signal) {
  if (!trackId.test(id)) throw new Error('Nieprawidłowy identyfikator utworu.');
  let url = new URL(`${api}/tracks/${id}/stream`);
  for (let count = 0; count < 4; count++) {
    const response = await fetch(url, { signal, redirect: 'manual' });
    if (response.ok && response.body && /^audio\//i.test(response.headers.get('content-type') ?? '')) return response.body;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    url = new URL(location, url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(^|\.)(audius\.co|cloudflarestorage\.com)$/.test(url.hostname)) break;
  }
  throw new Error('Audius nie udostępnił strumienia audio.');
}

const button = (action, label, style) => new ButtonBuilder().setCustomId(prefix + action).setLabel(label).setStyle(style);
const listing = (track) => `**${safe(track.artist)} – ${safe(track.title)}** · [Audius](<${track.url}>)`;

export function createMusic({ client, logError }) {
  let channel;
  let panel;
  let session;
  let status;
  let updates = Promise.resolve();
  const pending = new Set();
  const lastRequest = new Map();

  function payload() {
    const current = session?.current;
    const playback = { [AudioPlayerStatus.Paused]: 'Pauza', [AudioPlayerStatus.Playing]: 'Teraz gra' };
    return { allowedMentions: noMentions, embeds: [new EmbedBuilder()
      .setColor(0x836CFF).setTitle('🎵 Muzyka · Po Godzinach')
      .setDescription([
        'Wejdź na ten kanał głosowy i kliknij **Wklej link**. Obsługuję pojedyncze utwory z YouTube, Spotify i Audius.',
        'Dźwięk odtwarzam z katalogu Audius, gdy znajdę pasujące nagranie.',
        current ? `🎶 ${playback[session.player.state.status] ?? 'Ładuję'} · ${listing(current)}` :
          session ? '🔌 Łączę się z kanałem głosowym.' : '🔇 Nic teraz nie gra.',
        `📋 Utwory w kolejce · **${session?.queue.length ?? 0}**`,
        ...(status ? [status] : []),
      ].join('\n\n'))], components: [new ActionRowBuilder().addComponents(
      button('add', 'Wklej link', ButtonStyle.Primary), button('queue', 'Kolejka', ButtonStyle.Secondary),
      button('pause', 'Pauza / Wznów', ButtonStyle.Secondary), button('skip', 'Pomiń', ButtonStyle.Secondary),
      button('stop', 'Stop', ButtonStyle.Danger),
    )] };
  }

  function update() {
    updates = updates.then(() => panel?.edit(payload())).catch(logError);
  }

  async function setup(guild, { state, save }) {
    const parent = state.categories.voice;
    const channels = await guild.channels.fetch();
    if (channels.get(parent)?.type !== ChannelType.GuildCategory) throw new SetupError('Nie znaleziono kategorii głosowej dla muzyki.');
    const saved = channels.get(state.channels[key]);
    const existing = channels.filter((item) => item?.name === channelName && item.parentId === parent);
    if (existing.size > 1 || (saved && (saved.type !== ChannelType.GuildVoice || saved.parentId !== parent))) {
      throw new SetupError('Sprawdź kanał muzyczny. Discord zwrócił niejednoznaczne dopasowanie.');
    }
    channel = saved ?? existing.first();
    if (channel && channel.type !== ChannelType.GuildVoice) throw new SetupError('Kanał muzyczny musi być głosowy.');
    const access = ['ViewChannel', 'Connect', 'Speak', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks'];
    const bot = await guild.members.fetchMe();
    if (!channel) {
      if (!state.roles.verified) throw new SetupError('Najpierw skonfiguruj weryfikację serwera.');
      const roles = [...new Set(['verified', 'admin', 'mod', 'helper', 'organizer'].map((role) => state.roles[role]).filter(Boolean))];
      channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildVoice, parent,
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: ['ViewChannel'] },
          { id: bot.id, type: OverwriteType.Member, allow: access },
          ...roles.map((id) => ({ id, type: OverwriteType.Role, allow: access })),
        ],
        reason: 'Kanał i panel muzyczny',
      });
    }
    if (!channel.permissionsFor(bot)?.has(access)) throw new SetupError('Bot potrzebuje uprawnień do głosowego i czatu muzycznego.');
    const messages = await channel.messages.fetch({ limit: 25 });
    panel = messages.get(state.messages[key]) ?? messages.find((message) => message.author.id === client.user.id &&
      message.components.some((row) => row.components.some((item) => item.customId === prefix + 'add')));
    if (panel?.author.id !== client.user.id) panel = undefined;
    panel = panel ? await panel.edit(payload()) : await channel.send(payload());
    state.channels[key] = channel.id;
    state.messages[key] = panel.id;
    await save();
    console.log(`Panel muzyczny gotowy: kanał ${channel.id}, wiadomość ${panel.id}.`);
  }

  function end(active) {
    if (session !== active) return;
    session = undefined;
    active.abort?.abort();
    active.player.stop(true);
    if (active.connection.state.status !== VoiceConnectionStatus.Destroyed) active.connection.destroy();
    update();
  }

  function advance(active) {
    if (session !== active) return;
    active.abort?.abort();
    const track = active.queue.shift();
    active.current = track;
    if (!track) return end(active);
    const abort = new AbortController();
    active.abort = abort;
    status = undefined;
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0',
      '-vn', '-t', '900', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'], signal: abort.signal });
    const fail = () => {
      if (abort.signal.aborted || session !== active || active.current !== track) return;
      status = `⚠️ Nie udało się odtworzyć ${safe(track.title)}.`;
      if (!active.player.stop(true)) advance(active);
      update();
    };
    ffmpeg.once('error', fail);
    ffmpeg.once('exit', (code) => { if (code !== 0) fail(); });
    const input = async () => {
      const stream = await openMusicStream(track.id, AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60_000)]));
      await pipeline(Readable.fromWeb(stream), ffmpeg.stdin, { signal: abort.signal });
    };
    const startup = setTimeout(fail, 15_000).unref();
    ffmpeg.stdout.once('data', () => clearTimeout(startup));
    abort.signal.addEventListener('abort', () => clearTimeout(startup), { once: true });
    active.player.play(createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, metadata: track }));
    input().catch(fail);
    update();
  }

  async function enqueue(track) {
    if (session) {
      if (session.queue.length >= queueLimit) throw new SetupError('Kolejka jest pełna.');
      session.queue.push(track);
      update();
      return session.ready;
    }
    const player = createAudioPlayer();
    const connection = joinVoiceChannel({ guildId: channel.guild.id, channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    const active = { player, connection, queue: [track] };
    session = active;
    update();
    player.on(AudioPlayerStatus.Idle, (old) => { if (old.resource?.metadata === active.current) advance(active); });
    player.on(AudioPlayerStatus.Playing, update);
    player.on('error', (error) => {
      logError(error);
      if (session === active) status = '⚠️ Odtwarzanie utworu zostało przerwane.';
    });
    connection.on('error', (error) => { logError(error); end(active); });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      entersState(connection, VoiceConnectionStatus.Ready, 10_000).catch(() => end(active));
    });
    active.ready = entersState(connection, VoiceConnectionStatus.Ready, 15_000).then(() => {
      if (session !== active) throw new SetupError('Sesja muzyczna została zakończona.');
      connection.subscribe(player);
      advance(active);
    }).catch((error) => {
      end(active);
      if (!(error instanceof SetupError)) logError(error);
      throw new SetupError('Bot nie zdołał połączyć się z kanałem głosowym.');
    });
    return active.ready;
  }

  client.on(Events.VoiceStateUpdate, (before, after) => {
    if (!session || before.channelId !== channel.id || after.channelId === channel.id) return;
    if (after.id === client.user.id || !channel.members.some((member) => !member.user.bot)) end(session);
  });

  async function handle(interaction) {
    if (!(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith(prefix)) return false;
    const reply = (content) => (interaction.deferred || interaction.replied)
      ? interaction.editReply({ content, allowedMentions: noMentions })
      : interaction.reply({ content, allowedMentions: noMentions, flags: MessageFlags.Ephemeral });
    try {
      if (!channel || !panel || interaction.channelId !== channel.id ||
        (interaction.isButton() && interaction.message.id !== panel.id)) throw new SetupError('Otwórz aktualny panel muzyczny.');
      const action = interaction.customId.slice(prefix.length);
      if (interaction.member.voice.channelId !== channel.id) throw new SetupError('Najpierw dołącz do kanału głosowego muzyki.');
      if (interaction.isButton() && action === 'add') {
        await interaction.showModal(new ModalBuilder().setCustomId(prefix + 'submit').setTitle('Dodaj utwór do kolejki')
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(inputLink)
            .setLabel('Link do utworu').setStyle(TextInputStyle.Short).setMaxLength(400).setRequired(true))));
      } else if (interaction.isModalSubmit() && action === 'submit') {
        const id = interaction.user.id;
        const now = Date.now();
        if (pending.has(id) || now - (lastRequest.get(id) ?? 0) < 5000 || pending.size >= 5) {
          throw new SetupError('Poczekaj chwilę przed dodaniem kolejnego linku.');
        }
        pending.add(id);
        lastRequest.set(id, now);
        try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const track = await findMusic(interaction.fields.getTextInputValue(inputLink));
          if (interaction.member.voice.channelId !== channel.id) throw new SetupError('Wróć na kanał głosowy przed dodaniem utworu.');
          await enqueue(track);
          await reply(`🎵 Dodano ${listing(track)}.`);
        } finally {
          pending.delete(id);
          for (const [user, time] of lastRequest) if (now - time >= 5000) lastRequest.delete(user);
        }
      } else if (interaction.isButton() && action === 'queue') {
        const lines = [session?.current && `Teraz gra · ${listing(session.current)}`,
          ...(session?.queue.map((track, i) => `${i + 1}. ${safe(track.artist)} – ${safe(track.title)}`) ?? [])].filter(Boolean);
        await reply(lines.join('\n').slice(0, 1950) || 'Kolejka jest pusta.');
      } else if (interaction.isButton() && ['pause', 'skip', 'stop'].includes(action)) {
        if (!session) throw new SetupError('Nic teraz nie gra.');
        if (action === 'stop') {
          end(session);
          await reply('Zatrzymano odtwarzanie i wyczyszczono kolejkę.');
        } else if (action === 'skip') {
          if (!session.player.stop(true)) throw new SetupError('Odtwarzanie jeszcze się uruchamia.');
          await reply('Pominięto utwór.');
        } else {
          const resumed = session.player.state.status === AudioPlayerStatus.Paused;
          if (!(resumed ? session.player.unpause() : session.player.pause())) throw new SetupError('Odtwarzanie jeszcze się uruchamia.');
          update();
          await reply(resumed ? 'Wznowiono odtwarzanie.' : 'Wstrzymano odtwarzanie.');
        }
      }
    } catch (error) {
      if (!(error instanceof SetupError)) logError(error);
      await reply(error instanceof SetupError ? error.message : 'Muzyka chwilowo nie odpowiada. Spróbuj ponownie.').catch(logError);
    }
    return true;
  }

  return { setup, handle };
}
