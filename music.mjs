import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer, createAudioResource,
  entersState, joinVoiceChannel, StreamType,
} from '@discordjs/voice';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Events, MessageFlags,
  ModalBuilder, OverwriteType, TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { isStatsChannel, SetupError } from './setup.mjs';
import { musicChannelKey as oldKey, musicPanelKey as key } from './plan.mjs';

const prefix = 'community:music:';
const channelName = '🎵│panel-muzyki';
const queueLimit = 50;
const importLimit = 20;
const api = 'https://api.audius.co/v1';
const noMentions = { parse: [] };
const inputLink = 'link';
const trackId = /^[a-zA-Z0-9]{3,30}$/;
const videoId = /^[a-zA-Z0-9_-]{11}$/;
const run = promisify(execFile);
const ytDlp = process.env.DISCORD_YT_DLP || 'yt-dlp';
const ytOptions = ['--ignore-config', '--no-cache-dir', '--js-runtimes', 'node', '--no-warnings',
  '--socket-timeout', '7', '--retries', '0', '--no-playlist', '--force-ipv4'];
const ytFormat = ['-f', 'bestaudio[protocol=https]'];
const youtubeUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const base = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const cleanVideoTitle = (value) => value.replace(/\s*[[(](?:(?:official )?(?:music video|video|audio|lyric video)|lyrics|visualizer)[\])]/gi, '').trim();
const safe = (value) => escapeMarkdown(String(value).slice(0, 100));

function readLink(value) {
  let url;
  const text = value.trim();
  if (!text) throw new SetupError('Wpisz tytuł albo wklej link.');
  try { url = new URL(text); } catch {
    if (/^\S+\.(?:com|co|be)\//i.test(text)) throw new SetupError('Wklej link razem z https://.');
    return { source: 'search', query: text.slice(0, 120) };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new SetupError('Użyj linku HTTPS.');
  if (url.hostname === 'open.spotify.com') {
    const match = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})\/?$/.exec(url.pathname);
    if (match) return { source: 'Spotify', kind: match[1], id: match[2] };
  }
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
    const id = url.pathname === '/watch' && url.hostname !== 'youtu.be'
      ? url.searchParams.get('v')
      : (url.hostname === 'youtu.be' ? /^\/([\w-]+)\/?$/ : /^\/(?:shorts|live)\/([\w-]+)\/?$/).exec(url.pathname)?.[1];
    if (videoId.test(id ?? '')) return { source: 'YouTube', id };
  }
  if (['audius.co', 'www.audius.co'].includes(url.hostname) && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
    return { source: 'Audius', url: `https://audius.co${url.pathname}` };
  }
  throw new SetupError('Wklej link do utworu YouTube, Spotify lub Audius albo do albumu lub playlisty Spotify.');
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

async function spotifyTracks({ kind, id }) {
  const response = await request(`https://open.spotify.com/embed/${kind}/${id}`);
  const page = await response.text();
  const data = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1];
  const entity = data && JSON.parse(data).props?.pageProps?.state?.data?.entity;
  const tracks = kind === 'track' ? [entity] : entity?.trackList ?? [];
  const available = tracks.filter((track) => track?.title && /^spotify:track:/.test(track.uri) &&
    (track.artists?.[0]?.name || track.subtitle));
  if (!available.length) throw new SetupError('Spotify nie udostępnił utworów dla tego linku.');
  return available.map((track) => ({
    title: track.title, artist: track.artists?.[0]?.name ?? track.subtitle.split(',\u00a0')[0].trim(),
    seconds: track.duration / 1000,
  }));
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

function matches(info, title, artists, seconds) {
  const titleKey = base(cleanVideoTitle(title));
  const artistKey = base(info.artist);
  if (!artistKey || !titleKey || (Number.isFinite(info.seconds) && Math.abs(info.seconds - seconds) > 12)) return false;
  return titleKey === artistKey + base(info.title) ||
    (titleKey === base(info.title) && artists.some((artist) =>
      base(artist?.replace(/\s+-\s+Topic$|VEVO$/i, '')) === artistKey));
}

async function audiusTrack(url, query, info) {
  const target = new URL(`${api}/${url ? 'resolve' : 'tracks/search'}`);
  target.search = url ? new URLSearchParams({ url }) : new URLSearchParams({ query, limit: '15' });
  const { data } = url ? await resolveAudius(target) : await (await request(target)).json();
  const track = (Array.isArray(data) ? data : [data]).find((candidate) => playable(candidate) &&
    (!info || matches(info, candidate.title, [candidate.user.name, candidate.user.handle], candidate.duration)));
  if (!track) return;
  return { source: 'Audius', id: track.id, title: track.title, artist: track.user.name,
    url: new URL(track.permalink, 'https://audius.co').href };
}

function fromVideo(track) {
  if (!videoId.test(track?.id ?? '') || typeof track.title !== 'string' || !track.duration ||
    track.duration > 900 || track.live_status === 'is_live' || track.availability === 'needs_auth') return;
  return { source: 'YouTube', id: track.id, title: track.title, artist: track.channel ?? track.uploader ?? 'YouTube',
    url: youtubeUrl(track.id) };
}

async function youtubeData(args, target) {
  const { stdout } = await run(ytDlp, [...ytOptions, ...args, '--', target], {
    timeout: 14_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function youtubeSearch(query, info) {
  const results = await youtubeData(['--flat-playlist', '--dump-single-json'], `ytsearch8:${query}`);
  return results.entries?.filter((item) => fromVideo(item)).find((item) => !info ||
    matches(info, item.title, [item.channel, item.uploader], item.duration));
}

async function verifiedVideo(id) {
  return fromVideo(await youtubeData([...ytFormat, '--check-formats', '--dump-single-json', '--skip-download'], youtubeUrl(id)));
}

async function findTrack(query, info) {
  const video = await youtubeSearch(query, info).then((result) => result && verifiedVideo(result.id)).catch(() => undefined);
  return video ?? await audiusTrack(undefined, query, info);
}

export async function findMusic(input, capacity = 1) {
  const link = readLink(input);
  if (link.source === 'Audius') {
    const track = await audiusTrack(link.url);
    if (!track) throw new SetupError('Ten utwór Audius jest niedostępny lub ma ponad 15 minut.');
    return { tracks: [track], skipped: 0 };
  }
  if (link.source === 'YouTube') {
    const track = await verifiedVideo(link.id).catch(() => undefined);
    if (track) return { tracks: [track], skipped: 0 };
    const info = await youtubeInfo(link.id);
    const alternative = await audiusTrack(undefined, `${info.artist} ${info.title}`, info);
    if (alternative) return { tracks: [alternative], skipped: 0 };
    throw new SetupError('YouTube nie udostępnił botowi dźwięku, a w Audius nie ma pasującego nagrania.');
  }
  if (link.source === 'search') {
    const track = await findTrack(link.query);
    if (!track) throw new SetupError('Nie znalazłem utworu. Spróbuj podać wykonawcę i tytuł.');
    return { tracks: [track], skipped: 0 };
  }
  const items = await spotifyTracks(link);
  const selected = items.slice(0, Math.min(capacity, importLimit));
  const found = [];
  for (let i = 0; i < selected.length; i += 3) {
    const batch = await Promise.allSettled(selected.slice(i, i + 3).map((info) =>
      findTrack(`${info.artist} ${info.title}`, info)));
    found.push(...batch.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []));
  }
  if (!found.length) throw new SetupError('Nie znalazłem dostępnego nagrania dla utworów z tego linku Spotify.');
  return { tracks: found, skipped: items.length - found.length };
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
const listing = (track) => `**${safe(track.artist)} – ${safe(track.title)}** · [${track.source}](<${track.url}>)`;
const isMusicPanel = (message, botId) => message?.author.id === botId &&
  message.components.some((row) => row.components.some((item) => item.customId === prefix + 'add'));

export async function removeMusicPanel(guild, { state, save }) {
  if (!state.channels[key] || !state.messages[key]) return;
  try {
    const channel = await guild.channels.fetch(state.channels[key]);
    if (channel?.type === ChannelType.GuildText) {
      const message = await channel.messages.fetch(state.messages[key]);
      if (isMusicPanel(message, guild.client.user.id)) {
        await message.delete();
        console.log(`Usunięto panel muzyczny z kanału ${channel.id}.`);
      }
    }
  } catch (error) {
    if (![10003, 10008].includes(Number(error.code))) throw error;
  }
  delete state.messages[key];
  await save();
}

function youtubeStream(track, signal, diagnostics = false) {
  return spawn(ytDlp, [...ytOptions, ...ytFormat, '--quiet', '-o', '-', '--', youtubeUrl(track.id)],
    { stdio: ['ignore', 'pipe', diagnostics ? 'pipe' : 'ignore'], signal });
}

export function createMusic({ client, getState, logError }) {
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
        'Wejdź na dowolny kanał głosowy i tutaj kliknij **Dodaj utwór**. Bot dołączy tam, gdzie jesteś.',
        'Wpisz tytuł lub wklej link do YouTube, Spotify albo Audius.',
        'Z albumów i playlist Spotify dodaję maksymalnie 20 utworów na raz. Przy każdym utworze pokazuję źródło nagrania.',
        current ? `🎶 ${playback[session.player.state.status] ?? 'Ładuję'} · ${listing(current)}` :
          session ? '🔌 Łączę się z kanałem głosowym.' : '🔇 Nic teraz nie gra.',
        `📋 Utwory w kolejce · **${session?.queue.length ?? 0}**`,
        ...(status ? [status] : []),
      ].join('\n\n'))], components: [new ActionRowBuilder().addComponents(
      button('add', 'Dodaj utwór', ButtonStyle.Primary), button('queue', 'Kolejka', ButtonStyle.Secondary),
      button('pause', 'Pauza / Wznów', ButtonStyle.Secondary), button('skip', 'Pomiń', ButtonStyle.Secondary),
      button('stop', 'Stop', ButtonStyle.Danger),
    )] };
  }

  function update() {
    updates = updates.then(() => panel?.edit(payload())).catch(logError);
  }

  const isPanel = (message) => isMusicPanel(message, client.user.id);

  async function setup(guild, { state, save }) {
    const parent = state.categories.voice;
    const channels = await guild.channels.fetch();
    if (channels.get(parent)?.type !== ChannelType.GuildCategory) throw new SetupError('Nie znaleziono kategorii głosowej dla muzyki.');
    const saved = channels.get(state.channels[key]);
    const existing = channels.filter((item) => item?.name === channelName && item.parentId === parent);
    if (existing.size > 1 || (saved && (saved.type !== ChannelType.GuildText || saved.parentId !== parent))) {
      throw new SetupError('Sprawdź kanał muzyczny. Discord zwrócił niejednoznaczne dopasowanie.');
    }
    channel = saved ?? existing.first();
    if (channel && channel.type !== ChannelType.GuildText) throw new SetupError('Panel muzyczny wymaga kanału tekstowego.');
    const read = ['ViewChannel', 'ReadMessageHistory'];
    const access = [...read, 'SendMessages', 'EmbedLinks'];
    const bot = await guild.members.fetchMe();
    if (!channel) {
      if (!state.roles.verified) throw new SetupError('Najpierw skonfiguruj weryfikację serwera.');
      const roles = [...new Set(['verified', 'admin', 'mod', 'helper', 'organizer'].map((role) => state.roles[role]).filter(Boolean))];
      channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent,
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, deny: ['ViewChannel', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads'] },
          { id: bot.id, type: OverwriteType.Member, allow: access },
          ...roles.map((id) => ({ id, type: OverwriteType.Role, allow: read })),
        ],
        reason: 'Kanał i panel muzyczny',
      });
    }
    if (!channel.permissionsFor(bot)?.has(access)) throw new SetupError('Bot potrzebuje dostępu do kanału panelu muzycznego.');
    const messages = await channel.messages.fetch({ limit: 25 });
    const savedPanel = messages.get(state.messages[key]);
    panel = isPanel(savedPanel) ? savedPanel : messages.find(isPanel);
    panel = panel ? await panel.edit(payload()) : await channel.send(payload());
    state.channels[key] = channel.id;
    state.messages[key] = panel.id;
    await save();
    console.log(`Panel muzyczny gotowy: kanał ${channel.id}, wiadomość ${panel.id}.`);
    const oldChannel = channels.get(state.channels[oldKey]);
    if (oldChannel?.type === ChannelType.GuildVoice && state.messages[oldKey]) {
      try {
        const oldPanel = await oldChannel.messages.fetch(state.messages[oldKey]);
        if (isPanel(oldPanel)) await oldPanel.delete();
      } catch (error) {
        if (Number(error.code) !== 10008) logError(error);
      }
    }
    const probe = process.env.DISCORD_MUSIC_PROBE;
    if (videoId.test(probe ?? '')) {
      const signal = AbortSignal.timeout(25_000);
      const child = youtubeStream({ id: probe }, signal, true);
      child.once('error', () => {});
      let diagnostic = '';
      child.stderr.on('data', (bytes) => { diagnostic = (diagnostic + bytes).slice(-3000); });
      try {
        for await (const bytes of child.stdout) {
          if (bytes.length) {
            console.log('Test muzyki: odebrano dźwięk YouTube na Railway.');
            return;
          }
        }
        const reasons = [
          [/sign in|not a bot|confirm your age/i, 'YouTube wymaga logowania'],
          [/HTTP Error (403|429)/i, 'YouTube odrzucił żądanie HTTP'],
          [/not available|not playable|requested format/i, 'brak formatu do odtwarzania'],
          [/connection|timed out|network/i, 'błąd połączenia'],
        ];
        const reason = reasons.find(([pattern]) => pattern.test(diagnostic))?.[1] ??
          (signal.aborted ? 'przekroczono czas' : diagnostic.replace(/https?:\/\/\S+/g, '[adres]').trim().slice(0, 320));
        console.warn(`Test muzyki: YouTube nie zwrócił dźwięku na Railway. ${reason}`);
      } finally {
        child.kill();
      }
    }
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
      if (track.source === 'YouTube') {
        const source = youtubeStream(track, abort.signal);
        source.once('error', fail);
        source.once('exit', (code) => { if (code !== 0) fail(); });
        await pipeline(source.stdout, ffmpeg.stdin, { signal: abort.signal });
        return;
      }
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

  async function enqueue(tracks, voice) {
    const accepted = tracks.slice(0, queueLimit - (session?.queue.length ?? 0));
    if (!accepted.length) throw new SetupError('Kolejka jest pełna.');
    if (session) {
      if (session.voice.id !== voice.id) throw new SetupError('Muzyka gra już na innym kanale głosowym.');
      session.queue.push(...accepted);
      update();
      await session.ready;
      return accepted.length;
    }
    const player = createAudioPlayer();
    const connection = joinVoiceChannel({ guildId: voice.guild.id, channelId: voice.id,
      adapterCreator: voice.guild.voiceAdapterCreator, selfDeaf: true });
    const active = { player, connection, voice, queue: accepted };
    const added = accepted.length;
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
    await active.ready;
    return added;
  }

  client.on(Events.VoiceStateUpdate, (before, after) => {
    const voice = session?.voice;
    if (!voice || before.channelId !== voice.id || after.channelId === voice.id) return;
    if (after.id === client.user.id || !voice.members.some((member) => !member.user.bot)) end(session);
  });

  function listenerVoice(interaction) {
    const voice = interaction.member.voice.channel;
    if (voice?.type !== ChannelType.GuildVoice || isStatsChannel(getState(), voice.id)) {
      throw new SetupError('Najpierw dołącz do kanału głosowego do rozmów.');
    }
    if (session && session.voice.id !== voice.id) throw new SetupError('Muzyka gra już na innym kanale głosowym.');
    if (!voice.permissionsFor(interaction.guild.members.me)?.has(['ViewChannel', 'Connect', 'Speak'])) {
      throw new SetupError('Bot potrzebuje dostępu do dołączania i mówienia na tym kanale głosowym.');
    }
    return voice;
  }

  async function handle(interaction) {
    if (!(interaction.isButton() || interaction.isModalSubmit()) || !interaction.customId.startsWith(prefix)) return false;
    const reply = (content) => (interaction.deferred || interaction.replied)
      ? interaction.editReply({ content, allowedMentions: noMentions })
      : interaction.reply({ content, allowedMentions: noMentions, flags: MessageFlags.Ephemeral });
    try {
      if (!channel || !panel || interaction.channelId !== channel.id ||
        (interaction.isButton() && interaction.message.id !== panel.id)) throw new SetupError('Otwórz aktualny panel muzyczny.');
      const action = interaction.customId.slice(prefix.length);
      if (interaction.isButton() && action === 'add') {
        listenerVoice(interaction);
        await interaction.showModal(new ModalBuilder().setCustomId(prefix + 'submit').setTitle('Dodaj utwór do kolejki')
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(inputLink)
            .setLabel('Tytuł lub link').setStyle(TextInputStyle.Short).setMaxLength(400).setRequired(true))));
      } else if (interaction.isModalSubmit() && action === 'submit') {
        const voice = listenerVoice(interaction);
        const id = interaction.user.id;
        const now = Date.now();
        if (pending.has(id) || now - (lastRequest.get(id) ?? 0) < 5000 || pending.size >= 5) {
          throw new SetupError('Poczekaj chwilę przed dodaniem kolejnego linku.');
        }
        pending.add(id);
        lastRequest.set(id, now);
        try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const capacity = queueLimit - (session?.queue.length ?? 0);
          if (!capacity) throw new SetupError('Kolejka jest pełna.');
          const { tracks, skipped } = await findMusic(interaction.fields.getTextInputValue(inputLink), capacity);
          if (listenerVoice(interaction).id !== voice.id) throw new SetupError('Kanał głosowy się zmienił. Dodaj utwór ponownie.');
          const added = await enqueue(tracks, voice);
          const omitted = skipped + tracks.length - added;
          const summary = added === 1 ? listing(tracks[0]) : `**${added}** utworów do kolejki`;
          await reply(`🎵 Dodano ${summary}.${omitted ? ` Pominięto: ${omitted} (brak nagrania lub limit importu).` : ''}`);
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
        listenerVoice(interaction);
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
