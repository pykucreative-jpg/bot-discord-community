import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Events, MessageFlags,
  ModalBuilder, OverwriteType, Routes, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, escapeMarkdown,
} from 'discord.js';
import { verificationButton } from './panels.mjs';
import { gamePingRoles, pingSeparator, plusLogs, roleLabel, roles } from './plan.mjs';
import { isStatsChannel, privateModerationChannel, SetupError } from './setup.mjs';

const ns = 'community:plus:';
const noMentions = { parse: [] };
const why = 'Rozbudowa społeczności Po Godzinach';
const day = 86_400_000;
const banHistorySeconds = 3 * 86400;
const banTitle = '⛔ NIE PISZ NA TYM KANALE';
const banTopic = 'NIE PISZ TUTAJ. Każda wiadomość = natychmiastowy bezterminowy ban na Po Godzinach i usunięcie wiadomości z ostatnich 3 dni.';
const banWarning = 'Jeśli wyślesz tutaj jakąkolwiek wiadomość, bot od razu nałoży na Ciebie **bezterminowego bana na serwerze Po Godzinach**.\n\nDiscord usunie też Twoje wiadomości z ostatnich **3 dni** na tym serwerze.';
const levelRoles = [[5, '🌱│Poziom 5'], [10, '✨│Poziom 10'], [20, '🔥│Poziom 20'], [40, '🏆│Poziom 40']];
const suggestionVotes = ['✅', '❌'];
const groups = [
  ['═════ 🔐 WERYFIKACJA ═════', ['verified', 'review', 'blocked']],
  ['═════ 👤 TOŻSAMOŚĆ ═════', ['lgbt', 'man', 'woman']],
  ['═════ 🎂 WIEK ═════', ['age35', 'age25', 'age18', 'age13']],
  ['═════ 🎮 ZAINTERESOWANIA ═════', ['events', 'tech', 'music', 'gaming']],
  ['═════ 💎 WYRÓŻNIENIA ═════', ['vip', 'member']],
  ['═════ 🛡️ EKIPA ═════', ['admin', 'mod', 'helper', 'organizer']],
  ['═════ 🤝 PARTNERZY ═════', []],
];
const isVoice = (channel) => channel?.type === ChannelType.GuildVoice;
const level = (xp) => Math.floor(Math.sqrt(xp / 100));
const xpNext = (xp) => 100 * (level(xp) + 1) ** 2;
const button = (key, label, style = ButtonStyle.Secondary) => new ButtonBuilder()
  .setCustomId(ns + key).setLabel(label).setStyle(style);
const row = (...items) => new ActionRowBuilder().addComponents(...items);
const modal = (key, title, label, max) => new ModalBuilder().setCustomId(ns + key).setTitle(title)
  .addComponents(row(new TextInputBuilder().setCustomId('value').setLabel(label)
    .setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true)));
const card = (title, description) => new EmbedBuilder().setColor(0x946CF2).setTitle(title)
  .setDescription(description).setFooter({ text: 'PO GODZINACH' });
const name = (user) => escapeMarkdown(user.globalName ?? user.username);
const human = (member) => member && !member.user.bot && !member.pending;

async function openProgress(guildId) {
  const folder = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? new URL('./data/', import.meta.url);
  await mkdir(folder, { recursive: true });
  const path = typeof folder === 'string' ? join(folder, `${guildId}-plus.json`) : new URL(`${guildId}-plus.json`, folder);
  const temp = typeof path === 'string' ? `${path}.tmp` : new URL(path.href + '.tmp');
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { players: {}, rooms: {}, count: 0, lastCounter: null };
  }
  let queue = Promise.resolve();
  return {
    read: () => data,
    update(action) {
      const next = queue.then(async () => {
        const draft = structuredClone(data);
        const result = action(draft);
        await writeFile(temp, JSON.stringify(draft));
        await rename(temp, path);
        data = draft;
        return result;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

function player(data, id) {
  return data.players[id] ??= { xp: 0, coins: 0, daily: 0, chat: 0, steal: 0, pvp: false };
}

function hands() {
  const deck = Array.from({ length: 52 }, (_, i) => 1 + i % 13);
  const draw = () => deck.splice(randomInt(deck.length), 1)[0];
  return { deck, user: [draw(), draw()], dealer: [draw(), draw()] };
}

function points(cards) {
  const total = cards.reduce((sum, card) => sum + Math.min(10, card), 0);
  return cards.includes(1) && total <= 11 ? total + 10 : total;
}

function showHand(cards) {
  return cards.map((card) => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[card] ?? card).join(' · ');
}

export function createCommunityPlus({ client, guildId, getState, security, logError }) {
  let progress;
  let liveGuild;
  const challenges = new Map();
  const creating = new Set();
  const removing = new Set();
  const warnings = new Map();
  let banActivatedAt = 0;
  const ready = (guild) => guild?.id === guildId && progress;
  const on = (event, task) => client.on(event, (...args) => Promise.resolve(task(...args)).catch(logError));
  const access = (state, guild, mode) => {
    const read = ['ViewChannel', 'ReadMessageHistory', 'UseApplicationCommands'];
    const user = [...read, ...(mode === 'write' ? ['SendMessages', 'EmbedLinks'] : []),
      ...(mode === 'voice' ? ['Connect', 'Speak'] : [])];
    const allow = (id, rights, type = OverwriteType.Role) => ({ id, type, allow: rights });
    return [
      { id: guild.id, type: OverwriteType.Role, deny: ['ViewChannel', 'SendMessages', 'Connect'] },
      allow(client.user.id, [...read, 'SendMessages', 'EmbedLinks',
        ...(mode === 'voice' ? ['Connect', 'Speak'] : [])], OverwriteType.Member),
      ...[...new Set([state.roles.verified, state.roles.admin, state.roles.mod].filter(Boolean))].map((id) =>
        allow(id, id === state.roles.verified ? user : [...new Set([...user, 'SendMessages'])])),
    ];
  };
  const roomAccess = (state, guild) => access(state, guild, 'voice').map((entry) =>
    entry.type === OverwriteType.Member ? { ...entry, allow: [...entry.allow, 'MoveMembers'] } : entry);
  const roomPermissions = ['ViewChannel', 'Connect', 'MoveMembers'];
  async function ensureRoomMove(channel, bot) {
    if (channel.permissionsFor(bot)?.has(roomPermissions)) return;
    await channel.permissionOverwrites.edit(bot, { ViewChannel: true, Connect: true, MoveMembers: true }, { reason: why });
    if (!channel.permissionsFor(bot)?.has(roomPermissions)) throw new SetupError('Bot nie może przenosić osób w pokoju głosowym.');
  }

  async function ensureChannel(guild, journal, all, key, options) {
    const { state, save } = journal;
    const map = options.type === ChannelType.GuildCategory ? state.categories : state.channels;
    const saved = all.get(map[key]);
    const matching = all.filter((item) => item?.name === options.name && item.type === options.type &&
      (item.parentId ?? null) === (options.parent ?? null));
    if (matching.size > 1 || (saved && saved.type !== options.type)) throw new SetupError(`Konflikt kanału ${options.name}.`);
    const channel = saved ?? matching.first() ?? await guild.channels.create({ ...options, reason: why });
    all.set(channel.id, channel);
    if (map[key] !== channel.id) { map[key] = channel.id; await save(); }
    return channel;
  }

  async function ensureRole(guild, journal, key, title, plainName) {
    const { state, save } = journal;
    const matching = guild.roles.cache.filter((role) => role.name === title || plainName && role.name.toLowerCase() === plainName.toLowerCase());
    const saved = guild.roles.cache.get(state.roles[key]);
    if (plainName && !saved && matching.size > 1) throw new SetupError(`Sprawdź powtórzone role „${plainName}”.`);
    const existing = saved ?? matching.find((role) => !role.managed && role.permissions.bitfield === 0n && (plainName || role.members.size === 0));
    if (plainName && !existing && matching.size) throw new SetupError(`Sprawdź uprawnienia roli „${plainName}”.`);
    const role = existing ?? await guild.roles.create({ name: title, permissions: [], reason: why });
    if (!role.editable || role.permissions.bitfield !== 0n) throw new SetupError(`Sprawdź rolę ${title}.`);
    if (state.roles[key] !== role.id) { state.roles[key] = role.id; await save(); }
    return role;
  }

  async function setupGameRoles(guild, journal) {
    const { state, save } = journal;
    await guild.roles.fetch();
    const identity = roles.find(({ key }) => key === 'lgbt');
    const lgbt = await ensureRole(guild, journal, identity.key, roleLabel(identity), identity.name);
    const gameRoles = [];
    for (const role of gamePingRoles) gameRoles.push(await ensureRole(guild, journal, role.key, roleLabel(role), role.name));
    const marker = await ensureRole(guild, journal, 'plus-separator-ping', pingSeparator);
    const current = await guild.roles.fetch();
    const ordered = [...gameRoles.toReversed(), marker].map(({ id }) => current.get(id));
    const bottom = Math.min(...ordered.map(({ position }) => position));
    if (ordered.some((role, index) => role.position !== bottom + index)) {
      await guild.roles.setPositions(ordered.map(({ id }, index) => ({ role: id, position: bottom + index })));
    }
    if (state.roles.nonbinary) {
      const previous = current.get(state.roles.nonbinary);
      if (previous && (previous.id === lgbt.id || !previous.editable || !['Osoba niebinarna', '「🌈」Osoba niebinarna'].includes(previous.name))) {
        throw new SetupError('Sprawdź zapisaną rolę „Osoba niebinarna” przed jej usunięciem.');
      }
      if (previous) await previous.delete('Zastąpienie starej roli opcjonalnym wyborem LGBT+');
      delete state.roles.nonbinary;
      await save();
    }
    console.log(`Role wyboru gotowe: LGBT+ ${lgbt.id}, separator PING ${marker.id}, gry ${gameRoles.length}.`);
  }

  async function setupSuggestions(guild, journal, all) {
    const { state, save } = journal;
    const matches = all.filter((channel) => channel?.type === ChannelType.GuildText &&
      /(?:^|[^\p{L}\p{N}])propozycje$/iu.test(channel.name.trim()));
    const saved = all.get(state.channels.propozycje);
    if (!saved && matches.size > 1) throw new SetupError('Znaleziono kilka kanałów „propozycje”.');
    if (!saved && !matches.size && !state.categories.community) throw new SetupError('Brakuje kategorii Społeczność.');
    const channel = saved ?? matches.first() ?? await guild.channels.create({
      name: '💡│propozycje', type: ChannelType.GuildText, parent: state.categories.community,
      topic: 'Dodaj propozycję. Głosuj ✅ lub ❌.', permissionOverwrites: access(state, guild, 'write'), reason: why,
    });
    if (channel.type !== ChannelType.GuildText) throw new SetupError('Kanał propozycji musi być tekstowy.');
    const bot = await guild.members.fetchMe();
    if (!channel.permissionsFor(bot)?.has(['ViewChannel', 'ReadMessageHistory', 'AddReactions', 'ManageMessages'])) {
      await channel.permissionOverwrites.edit(bot, { ViewChannel: true, ReadMessageHistory: true, AddReactions: true, ManageMessages: true }, { reason: why });
    }
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.id !== bot.id && overwrite.id !== guild.id && overwrite.allow.has('AddReactions', false)) {
        await channel.permissionOverwrites.edit(overwrite.id, { AddReactions: null }, { type: overwrite.type, reason: why });
      }
    }
    if (!channel.permissionOverwrites.cache.get(guild.id)?.deny.has('AddReactions', false)) {
      await channel.permissionOverwrites.edit(guild.id, { AddReactions: false }, { reason: why });
    }
    if (state.channels.propozycje !== channel.id) { state.channels.propozycje = channel.id; await save(); }
    console.log(`Głosowanie w propozycjach gotowe: ${channel.id}. Reakcje ✅ i ❌.`);
  }

  async function panel(channel, journal, key, embed, components = []) {
    const { state, save } = journal;
    const current = state.messages[key] && await channel.messages.fetch(state.messages[key]).catch((error) => {
      if (Number(error.code) !== 10008) throw error;
    });
    const payload = { embeds: [embed], components, allowedMentions: noMentions };
    const message = current?.author.id === client.user.id ? await current.edit(payload) : await channel.send(payload);
    if (state.messages[key] !== message.id) { state.messages[key] = message.id; await save(); }
  }

  async function invite(guild, journal, all, channel) {
    const { state, save } = journal;
    let code = guild.vanityURLCode;
    const slug = process.env.DISCORD_COMMUNITY_SLUG || 'po-godzinach';
    if (!code && guild.features.includes('VANITY_URL') && /^[a-z0-9-]{2,25}$/.test(slug)) {
      try {
        const result = await client.rest.patch(Routes.guildVanityUrl(guild.id), { body: { code: slug }, reason: why });
        code = result.code;
      } catch (error) { logError(error); }
    }
    if (!code) {
      const stored = state.communityInvite && await guild.invites.fetch(state.communityInvite).catch((error) => {
        if (Number(error.code) !== 10006) throw error;
      });
      code = stored?.code;
      if (!code) {
        const rules = all.get(state.channels.regulamin);
        if (!rules?.isTextBased()) throw new SetupError('Brakuje kanału z regulaminem do zaproszenia.');
        const created = await guild.invites.create(rules.id, { maxAge: 0, maxUses: 0, unique: false, reason: why });
        code = created.code;
        state.communityInvite = code;
        await save();
      }
    }
    await panel(channel, journal, 'plus-ad', card('🌙 Po Godzinach', [
      'Społeczność do pogadania, wspólnego grania i słuchania muzyki.',
      'Znajdziesz tu kanały głosowe, własne pokoje, poziomy i gry 4FUN.',
      `**Dołącz do nas** · https://discord.gg/${code}`,
    ].join('\n\n')));
    console.log(`Zaproszenie Po Godzinach: https://discord.gg/${code} (${code === state.communityInvite ? 'stałe' : 'własne'}).`);
  }

  async function setup(guild, journal) {
    if (!journal.state.securityReady) return;
    const { state } = journal;
    if (!progress) progress = await openProgress(guild.id);
    liveGuild = guild;
    const all = await guild.channels.fetch();
    const make = (key, label, type, mode, parent, extra = {}) => ensureChannel(guild, journal, all, key, {
      name: label, type, permissionOverwrites: access(state, guild, mode), ...(parent ? { parent } : {}), ...extra,
    });
    const category = (key, label) => make(key, label, ChannelType.GuildCategory, 'read');
    const text = (key, label, mode, parent, extra) => make(key, label, ChannelType.GuildText, mode, parent, extra);
    const fun = await category('plus-fun', '╭━━ 🎲 4FUN ━━╮');
    const partner = await category('plus-partner', '╭━━ 🤝 PARTNERSTWA ━━╮');
    const rooms = await category('plus-rooms', '╭━━ 🔊 POKOJE NA ŻĄDANIE ━━╮');
    const count = await text('plus-count', '🔢│liczenie', 'read', fun.id);
    const slow = await text('plus-slow', '🐢│raz-na-6h', 'write', fun.id, {
      topic: 'Jeden wpis na sześć godzin.', rateLimitPerUser: 21600,
    });
    if (slow.rateLimitPerUser !== 21600) await slow.setRateLimitPerUser(21600, why);
    const games = await text('plus-games', '🪙│gry-i-monety', 'read', fun.id);
    await text('plus-fun-chat', '🎭│luźne-teksty', 'write', fun.id, { topic: 'Żarty i lekki roast za zgodą. Bez nękania.' });
    const ad = await text('plus-ad', '📣│nasza-reklama', 'read', partner.id);
    await text('plus-partners', '🤝│partnerstwa', 'read', partner.id, { topic: 'Ogłoszenia partnerów publikuje ekipa.' });
    const warning = await text('plus-warning', '⚠️│nie-pisz-tutaj', 'write', null, {
      topic: 'Wiadomość w tym kanale powoduje ostrzeżenie i wpis do prywatnych logów.',
    });
    if (warning.position !== 0) await warning.setPosition(0, { reason: why });
    await panel(count, journal, 'plus-count', card('🔢 Liczymy razem', 'Kliknij **Podaj liczbę** i wpisz następną. Kolejne ruchy muszą być od różnych osób.'),
      [row(button('count', 'Podaj liczbę', ButtonStyle.Primary), button('count-state', 'Sprawdź wynik'))]);
    await panel(games, journal, 'plus-games', card('🪙 Gry i monety', 'Waluta jest wirtualna. Odbieraj bonus, graj w 21 i sprawdzaj swój poziom. Pojedynki o monety działają między chętnymi graczami.'),
      [row(button('profile', 'Mój poziom i saldo'), button('daily', 'Dzienna wypłata', ButtonStyle.Success),
        button('blackjack', 'Zagraj w 21', ButtonStyle.Primary), button('pvp', 'Włącz/wyłącz pojedynki'), button('rob', 'Skok na monety'))]);
    const tasks = [
      async () => invite(guild, journal, all, ad),
      async () => setupSuggestions(guild, journal, all),
      async () => setupGameRoles(guild, journal),
      async () => {
        const voice = (key, label) => make(key, label, ChannelType.GuildVoice, 'voice', rooms.id);
        const oldAfk = all.get(guild.afkChannelId);
        const afk = isVoice(oldAfk) ? oldAfk : await voice('plus-afk', '💤│AFK');
        if (guild.afkChannelId !== afk.id || guild.afkTimeout !== 300) {
          await guild.edit({ afkChannel: afk.id, afkTimeout: 300, reason: why });
        }
        const entry = await make('plus-create', '➕│Utwórz pokój', ChannelType.GuildVoice, 'voice', rooms.id,
          { permissionOverwrites: roomAccess(state, guild) });
        const bot = await guild.members.fetchMe();
        await ensureRoomMove(entry, bot);
        console.log(`AFK gotowe: ${afk.id}. Wejście do pokoi: ${entry.id}, przenoszenie: gotowe.`);
      },
      async () => {
        await guild.roles.fetch();
        const streamer = await ensureRole(guild, journal, 'plus-streamer', '🎥│Streamer');
        console.log(`Rola Streamer gotowa: ${streamer.id}.`);
      },
      async () => {
        await guild.roles.fetch();
        for (const [i, [title, keys]] of groups.entries()) {
          const marker = await ensureRole(guild, journal, `plus-separator-${i}`, title);
          const anchor = keys.map((key) => guild.roles.cache.get(state.roles[key])).filter(Boolean)
            .sort((a, b) => b.comparePositionTo(a))[0];
          if (anchor && marker.position !== anchor.position + 1) {
            await marker.setPosition(anchor.position + Number(marker.position > anchor.position), { reason: why });
          }
        }
        const ranks = [];
        for (const [threshold, title] of levelRoles) ranks.push(await ensureRole(guild, journal, `plus-level-${threshold}`, title));
        const marker = await ensureRole(guild, journal, 'plus-separator-levels', '═════ 🏅 POZIOMY ═════');
        const highest = ranks.sort((a, b) => b.comparePositionTo(a))[0];
        if (marker.position !== highest.position + 1) {
          await marker.setPosition(highest.position + Number(marker.position > highest.position), { reason: why });
        }
        console.log('Podziały ról i rangi poziomów gotowe.');
      },
      async () => {
        const parent = all.get(state.categories['bot-logs']);
        const source = await privateModerationChannel(guild, state);
        if (parent?.type !== ChannelType.GuildCategory || source?.parentId !== parent.id) throw new SetupError('Brakuje prywatnej kategorii logów.');
        const overwrites = [...source.permissionOverwrites.cache.values()].map(({ id, type, allow, deny }) =>
          ({ id, type, allow: allow.bitfield, deny: deny.bitfield }));
        for (const [key, label] of Object.entries(plusLogs)) {
          await ensureChannel(guild, journal, all, key, { name: label, type: ChannelType.GuildText,
            parent: parent.id, permissionOverwrites: overwrites });
        }
        console.log('Szczegółowe kanały logów gotowe.');
      },
      async () => {
        const role = await guild.roles.fetch(state.roles.mod);
        const bot = await guild.members.fetchMe();
        let logs = await privateModerationChannel(guild, state, { name: 'log-bany' });
        if (!bot.permissions.has('BanMembers') || !role) throw new SetupError('Kanał bana wymaga uprawnienia BanMembers i rangi Moderator.');
        if (!role.mentionable && !logs.permissionsFor(bot)?.has('MentionEveryone')) {
          await logs.permissionOverwrites.edit(bot, { MentionEveryone: true }, { reason: 'Alerty o banach dla Moderatorów' });
          logs = await privateModerationChannel(guild, state, { name: 'log-bany' });
        }
        if (!role.mentionable && !logs.permissionsFor(bot)?.has('MentionEveryone')) {
          throw new SetupError('Bot nie może oznaczać Moderatorów w prywatnym logu banów.');
        }
        if (warning.topic !== banTopic) await warning.setTopic(banTopic, 'Wyraźne ostrzeżenie przed automatycznym banem');
        await panel(warning, journal, 'plus-warning', card(banTitle, banWarning));
        banActivatedAt = Date.now();
        console.log(`Automatyczny ban aktywny w ${warning.id}; historia: 3 dni; alert Moderatorów w ${logs.id}.`);
      },
    ];
    for (const task of tasks) await task().catch(logError);
    for (const id of Object.keys(progress.read().rooms)) scheduleRoomRemoval(guild, id);
    console.log(`Rozbudowa Po Godzinach: 4FUN ${fun.id}, partnerstwa ${partner.id}, pokoje ${rooms.id}, ostrzeżenia ${warning.id}.`);
  }

  function scheduleRoomRemoval(guild, id) {
    if (!progress.read().rooms[id] || removing.has(id)) return;
    removing.add(id);
    setTimeout(async () => {
      let defer = false;
      try {
        const channel = guild.channels.cache.get(id);
        if (channel && (channel.parentId !== getState().categories['plus-rooms'] || channel.members.size)) return;
        defer = creating.has(progress.read().rooms[id]);
        if (defer) return;
        if (channel) await channel.delete('Tymczasowy pokój jest pusty').catch((error) => {
          if (Number(error.code) !== 10003) throw error;
        });
        await progress.update((data) => { delete data.rooms[id]; });
      } catch (error) { if (Number(error.code) !== 10003) logError(error); }
      finally {
        removing.delete(id);
        if (defer) scheduleRoomRemoval(guild, id);
      }
    }, 4000).unref();
  }

  on(Events.VoiceStateUpdate, async (before, after) => {
    const { guild, member, channelId } = after;
    if (!ready(guild) || before.channelId === channelId) return;
    if (before.channelId) scheduleRoomRemoval(guild, before.channelId);
    const state = getState();
    if (!human(member) || !security.isVerified(member) || !channelId ||
        channelId !== state.channels['plus-create'] || creating.has(member.id)) return;
    if (!after.channel?.permissionsFor(guild.members.me)?.has(roomPermissions)) return;
    creating.add(member.id);
    try {
      const found = Object.entries(progress.read().rooms).find(([, owner]) => owner === member.id);
      let room = found && guild.channels.cache.get(found[0]);
      if (!isVoice(room) || room.parentId !== state.categories['plus-rooms']) {
        room = await guild.channels.create({ name: `🎧│Pokój ${member.displayName.slice(0, 60)}`, type: ChannelType.GuildVoice,
          parent: state.categories['plus-rooms'], permissionOverwrites: roomAccess(state, guild), reason: why });
        try {
          await progress.update((data) => {
            if (found) delete data.rooms[found[0]];
            data.rooms[room.id] = member.id;
          });
        }
        catch (error) { await room.delete('Nie udało się zapisać pokoju').catch(logError); throw error; }
      }
      if (member.voice.channelId === channelId) {
        try {
          await ensureRoomMove(room, guild.members.me);
          if (member.voice.channelId === channelId) await member.voice.setChannel(room, 'Własny pokój głosowy');
          else scheduleRoomRemoval(guild, room.id);
        }
        catch (error) { scheduleRoomRemoval(guild, room.id); throw error; }
      } else scheduleRoomRemoval(guild, room.id);
    } finally { creating.delete(member.id); }
  });

  async function applyLevel(member, xp) {
    const state = getState();
    const allowed = levelRoles.filter(([threshold]) => threshold <= level(xp)).map(([threshold]) => state.roles[`plus-level-${threshold}`])
      .filter((id) => id && !member.roles.cache.has(id));
    if (allowed.length) await member.roles.add(allowed, 'Poziom aktywności Po Godzinach');
  }

  on(Events.MessageCreate, async (message) => {
    const { guild, member, author, channelId } = message;
    if (!ready(guild) || !human(member) || message.system) return;
    const state = getState();
    if (channelId === state.channels.propozycje) {
      for (const vote of suggestionVotes) await message.react(vote);
      return;
    }
    const now = Date.now();
    if (channelId === state.channels['plus-warning']) {
      if (!banActivatedAt || message.createdTimestamp < banActivatedAt || message.webhookId ||
        now - (warnings.get(author.id) ?? 0) < 60_000) return;
      warnings.set(author.id, now);
      setTimeout(() => warnings.delete(author.id), 60_000).unref();
      const warning = await guild.channels.fetch(channelId, { force: true });
      if (warning?.topic !== banTopic) return;
      const notice = await warning.messages.fetch({ message: state.messages['plus-warning'], force: true });
      if (notice.author.id !== client.user.id || !notice.embeds.some(({ title, description }) =>
        title === banTitle && description === banWarning)) return;
      const logs = await privateModerationChannel(guild, state, { name: 'log-bany' });
      const role = await guild.roles.fetch(state.roles.mod);
      if (!role || (!role.mentionable && !logs.permissionsFor(guild.members.me)?.has('MentionEveryone'))) return;
      let banned = false;
      if (member.bannable) {
        banned = await member.ban({
          deleteMessageSeconds: banHistorySeconds, reason: 'Automatyczny ban: wiadomość w kanale ostrzegawczym (historia 3 dni)',
        }).then(() => true).catch((error) => { logError(error); return false; });
      }
      await logs.send({
        content: `<@&${role.id}>`,
        embeds: [card(banned ? '🚨 Automatyczny ban' : '⚠️ Automatyczny ban niewykonany',
          `Osoba: **${name(author)}**\nKanał: <#${channelId}>\nPowód: wiadomość w kanale z ostrzeżeniem.\n${banned ? 'Discord otrzymał polecenie usunięcia wiadomości z ostatnich 3 dni.' : 'Sprawdź hierarchię ról lub uprawnienia bota.'}`)],
        allowedMentions: { parse: [], roles: [role.id] }, nonce: message.id, enforceNonce: true,
      });
      return;
    }
    if (!security.isVerified(member) || ![state.channels.ogolny, state.channels['media-i-memy'], state.channels['plus-fun-chat'], state.channels.gaming].includes(channelId) ||
        now - (progress.read().players[author.id]?.chat ?? 0) < 60_000) return;
    const xp = await progress.update((data) => {
      const user = player(data, author.id);
      if (now - user.chat >= 60_000) { user.chat = now; user.xp += 12; }
      return user.xp;
    });
    await applyLevel(member, xp);
  });

  on(Events.MessageReactionAdd, async (reaction) => {
    const { message, emoji } = reaction;
    if (!ready(message.guild) || message.channelId !== getState().channels.propozycje ||
        !emoji.id && suggestionVotes.includes(emoji.name?.replace(/\uFE0F/g, ''))) return;
    await reaction.remove();
  });

  setInterval(async () => {
    try {
      if (!liveGuild || !progress) return;
      const state = getState();
      const active = liveGuild.voiceStates.cache.filter((voice) => {
        const { channel, member } = voice;
        return isVoice(channel) && human(member) && security.isVerified(member) && channel.id !== liveGuild.afkChannelId &&
          channel.id !== state.channels['plus-create'] && !isStatsChannel(state, channel.id) &&
          !voice.mute && !voice.deaf && channel.members.filter(human).size > 1;
      });
      if (!active.size) return;
      const members = active.map(({ member }) => member);
      const totals = await progress.update((data) => members.map((member) => (player(data, member.id).xp += 3)));
      await Promise.all(members.map((member, index) => applyLevel(member, totals[index])));
    } catch (error) { logError(error); }
  }, 60_000).unref();

  function gamePayload(game, result) {
    const users = `Twoje karty: **${showHand(game.user)}** · ${points(game.user)}`;
    const house = result ? `Krupier: **${showHand(game.dealer)}** · ${points(game.dealer)}` : `Krupier: **${showHand(game.dealer.slice(0, 1))} · ?**`;
    return { embeds: [card('🃏 21 · stawka 25 monet', [users, house, result].filter(Boolean).join('\n'))],
      components: result ? [] : [row(button(`hit:${game.key}`, 'Dobierz', ButtonStyle.Primary), button(`stand:${game.key}`, 'Pas'))] };
  }

  async function economy(interaction, action, gameKey) {
    const id = interaction.user.id;
    if (action === 'profile') {
      const user = progress.read().players[id] ?? { xp: 0, coins: 0 };
      return { content: `🏅 Poziom **${level(user.xp)}** · ${user.xp}/${xpNext(user.xp)} XP\n🪙 Saldo **${user.coins}** monet.` };
    }
    if (action === 'rob' && interaction.isButton()) {
      return { content: 'Wybierz chętnego gracza. Skok ma 50% szans powodzenia. Przy niepowodzeniu tracisz 10 monet.',
        components: [row(new UserSelectMenuBuilder().setCustomId(ns + 'rob-target').setPlaceholder('Wybierz gracza'))] };
    }
    return progress.update((data) => {
      const user = player(data, id);
      const now = Date.now();
      if (action === 'daily') {
        if (now - user.daily < day) return { content: `Następna wypłata <t:${Math.ceil((user.daily + day) / 1000)}:R>.` };
        user.daily = now;
        user.coins += 100;
        return { content: `🪙 Odbierasz **100** monet. Saldo: **${user.coins}**.` };
      }
      if (action === 'pvp') {
        user.pvp = !user.pvp;
        return { content: user.pvp ? 'Pojedynki o monety włączone.' : 'Pojedynki o monety wyłączone.' };
      }
      if (action === 'rob-target' && interaction.isUserSelectMenu()) {
        const targetId = interaction.values[0];
        const target = data.players[targetId];
        if (targetId === id || !user.pvp || !target?.pvp || target.coins < 10 || user.coins < 10) {
          throw new SetupError('Oboje musicie mieć włączone pojedynki i przynajmniej 10 monet.');
        }
        if (now - user.steal < 3_600_000) throw new SetupError('Skok można zrobić raz na godzinę.');
        user.steal = now;
        const amount = randomInt(2) ? Math.min(target.coins, 25) : -10;
        target.coins -= amount;
        user.coins += amount;
        return { content: amount > 0 ? `Udało się! Zyskujesz **${amount}** monet.` : 'Skok się nie udał. Tracisz **10** monet.' };
      }
      if (action === 'blackjack') {
        if (user.game && now < user.game.expires) return gamePayload(user.game);
        if (user.coins < 25) throw new SetupError('Gra wymaga 25 monet. Odbierz dzienną wypłatę.');
        user.coins -= 25;
        user.game = { ...hands(), key: randomUUID(), expires: now + 10 * 60_000 };
        return gamePayload(user.game);
      }
      if (action !== 'hit' && action !== 'stand') throw new SetupError('Nieznana akcja.');
      const game = user.game;
      if (!game || game.key !== gameKey || now >= game.expires) throw new SetupError('Ta gra wygasła. Zacznij następną z panelu.');
      const draw = (hand) => hand.push(game.deck.splice(randomInt(game.deck.length), 1)[0]);
      if (action === 'hit') {
        draw(game.user);
        if (points(game.user) < 21) return gamePayload(game);
      }
      const score = points(game.user);
      while (score <= 21 && points(game.dealer) < 17) draw(game.dealer);
      const house = points(game.dealer);
      const won = score <= 21 && (house > 21 || score > house);
      const tie = score <= 21 && score === house;
      if (won || tie) user.coins += won ? 50 : 25;
      delete user.game;
      return gamePayload(game, won ? '✅ Wygrana. Otrzymujesz **50** monet.' : tie ? '🤝 Remis. Stawka wraca.' : 'Przegrana. Stawka przepada.');
    });
  }

  async function handle(interaction) {
    const fromMessage = interaction.isButton();
    const verifying = fromMessage && interaction.customId === verificationButton;
    const supported = fromMessage || interaction.isModalSubmit() || interaction.isUserSelectMenu();
    if (!ready(interaction.guild) || (!verifying && (!supported || !interaction.customId.startsWith(ns)))) return false;
    const [action, gameKey] = verifying ? ['verify'] : interaction.customId.slice(ns.length).split(':');
    const state = getState();
    const reply = (payload) => interaction.deferred
      ? interaction.editReply({ ...payload, allowedMentions: noMentions })
      : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
    try {
      if (action === 'verify' || action === 'check') {
        if (interaction.channelId !== state.channels.regulamin || interaction.message?.id !== state.messages.regulamin) {
          throw new SetupError('Otwórz aktualny panel weryfikacji.');
        }
        const id = interaction.user.id;
        if (action === 'verify') {
          if (security.isVerified(interaction.member)) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await reply({ content: await security.accept(interaction) });
            return true;
          }
          const now = Date.now();
          for (const [user, challenge] of challenges) if (challenge.expires <= now) challenges.delete(user);
          const code = String(randomInt(10000, 100000));
          challenges.set(id, { code, expires: now + 180_000 });
          await interaction.showModal(modal('check', 'Weryfikacja · krok 2 z 2', `Przepisz kod: ${code}`, 5));
        } else {
          const challenge = challenges.get(id);
          challenges.delete(id);
          if (!challenge || challenge.expires <= Date.now() || interaction.fields.getTextInputValue('value').trim() !== challenge.code) {
            throw new SetupError('Kod wygasł albo jest błędny. Kliknij ponownie przycisk pod regulaminem.');
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await reply({ content: await security.accept(interaction) });
        }
        return true;
      }
      if (!security.isVerified(interaction.member)) throw new SetupError('Najpierw ukończ weryfikację.');
      if (['count', 'count-state', 'count-submit'].includes(action)) {
        if (interaction.channelId !== state.channels['plus-count'] || interaction.message?.id !== state.messages['plus-count']) {
          throw new SetupError('Otwórz panel liczenia.');
        }
        if (action === 'count') {
          await interaction.showModal(modal('count-submit', 'Liczymy razem', 'Wpisz kolejną liczbę', 10));
        } else if (action === 'count-state') {
          await reply({ content: `Aktualny wynik: **${progress.read().count}**.` });
        } else {
          const value = interaction.fields.getTextInputValue('value').trim();
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const total = await progress.update((data) => {
            if (data.lastCounter === interaction.user.id) throw new SetupError('Poczekaj na ruch innej osoby.');
            if (value !== String(data.count + 1)) throw new SetupError(`Następna liczba to **${data.count + 1}**.`);
            data.lastCounter = interaction.user.id;
            return ++data.count;
          });
          await interaction.channel.send({ content: `🔢 **${total}** · ${name(interaction.user)}`, allowedMentions: noMentions });
          await reply({ content: 'Zapisano liczbę.' });
        }
      } else {
        if (interaction.channelId !== state.channels['plus-games']) throw new SetupError('Otwórz panel gier i monet.');
        if (['hit', 'stand', 'rob-target'].includes(action)) {
          await interaction.deferUpdate();
          await reply(await economy(interaction, action, gameKey));
        } else {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await reply(await economy(interaction, action));
        }
      }
    } catch (error) {
      if (!(error instanceof SetupError)) logError(error);
      const payload = { content: error instanceof SetupError ? error.message : 'Akcja nie powiodła się. Spróbuj ponownie.' };
      if (interaction.deferred && ['hit', 'stand', 'rob-target'].includes(action)) {
        await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral, allowedMentions: noMentions }).catch(logError);
      } else if (!interaction.replied) await reply(payload).catch(logError);
    }
    return true;
  }

  return { setup, handle, temporaryRooms: () => Object.keys(progress?.read().rooms ?? {}) };
}
