import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ActionRowBuilder, AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType,
  ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, OverwriteType, PermissionsBitField, RESTJSONErrorCodes,
} from 'discord.js';
import { categories, categoryLabel, channelLabel, panelRoleId, plusLogs, roleLabel, roles, starterMessages } from './plan.mjs';
import { communityButtons, staffButtons, verificationButton } from './panels.mjs';
import { makeRolePanel } from './role-panel.mjs';

const reason = 'Konfiguracja serwera społecznościowego';
const read = ['ViewChannel', 'ReadMessageHistory', 'UseApplicationCommands'];
const write = ['SendMessages', 'EmbedLinks'];
const noWrite = [...write, 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'];
const postingMask = new PermissionsBitField(noWrite).bitfield;
const writeMask = new PermissionsBitField(write).bitfield;
export const voicePermissions = ['Connect', 'Speak', 'UseVAD', 'Stream'];
const voice = voicePermissions;
const statsBlocked = ['Connect', 'SendMessages'];
const statsMask = new PermissionsBitField(statsBlocked).bitfield;
const moderators = ['admin', 'mod'];
const communityStaff = [...moderators, 'helper', 'organizer'];
const layoutVersion = 3;
const messageVersion = 7;

export const botPermissions = new PermissionsBitField([
  ...read, ...noWrite, ...voice, 'ViewAuditLog',
  ...roles.flatMap((role) => role.permissions ?? []),
]);

export const channelEntries = categories.flatMap((category) =>
  category.channels.map((channel) => ({ category, channel })),
);

export class SetupError extends Error {}

export function configuredCleanupRole() {
  const id = process.env.DISCORD_CLEANUP_ROLE_ID?.trim() ?? '';
  return /^\d{17,20}$/.test(id) ? id : undefined;
}

const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dataFolder = volumePath ? pathToFileURL(resolve(volumePath) + sep) : new URL('./data/', import.meta.url);

export async function withSetupLock(guildId, task) {
  const lock = new URL(`${guildId}.lock/`, dataFolder);
  await mkdir(dataFolder, { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new SetupError('Konfiguracja jest zablokowana. Sprawdź, czy nie działa druga kopia bota. Instrukcja odzyskiwania jest w README.');
  }
  try {
    return await task();
  } finally {
    await rmdir(lock);
  }
}

export async function loadState(guildId) {
  const file = new URL(`${guildId}.json`, dataFolder);
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { guildId, roles: {}, categories: {}, channels: {}, messages: {}, ordered: false };
  }
  state.layout ??= {};
  state.messageLayout ??= {};
  if (state.guildId !== guildId || !state.roles || !state.categories || !state.channels || !state.messages) {
    throw new SetupError('Plik danych serwera jest uszkodzony. Przywróć jego kopię przed dalszą konfiguracją.');
  }

  return {
    state,
    async save() {
      await mkdir(dataFolder, { recursive: true });
      const temp = new URL(`${guildId}.tmp`, dataFolder);
      await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      await rename(temp, file);
    },
  };
}

function channelType(channel) {
  return channel.voice ? ChannelType.GuildVoice : ChannelType.GuildText;
}

function sameName(a, b) {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

function checkResource(id, name, collection, valid, conflicts) {
  if (id) {
    if (!valid(collection.get(id))) {
      throw new SetupError(`Brakuje zapisanego elementu „${name}” lub zmienił się jego typ albo kategoria. Sprawdź go przed ponowną konfiguracją.`);
    }
    return false;
  }
  if (collection.some(conflicts)) {
    throw new SetupError(`Istnieje już element „${name}” spoza zapisanej konfiguracji. Zmień jego nazwę, jeśli chcesz utworzyć osobny element bota.`);
  }
  return true;
}

export async function inspect(guild, state, categoryScope, channelScope) {
  const [serverRoles, serverChannels, bot] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
    guild.members.fetchMe({ force: true }),
  ]);
  const missing = bot.permissions.missing(botPermissions);
  if (missing.length) throw new SetupError(`Brak uprawnień bota: ${missing.join(', ')}.`);

  const scopedCategories = categoryScope ? categories.filter(({ key }) => key === categoryScope) : categories;
  const scopedChannels = categoryScope
    ? channelEntries.filter(({ category, channel }) => category.key === categoryScope && (!channelScope || channel.name === channelScope))
    : channelEntries;
  if (categoryScope && moderators.some((key) => !serverRoles.has(state.roles[key]))) {
    throw new SetupError('Do prywatnych logów potrzebne są istniejące role Moderator i Administrator.');
  }
  const newRoles = categoryScope ? [] : roles.filter((definition) => checkResource(
    state.roles[definition.key], definition.name, serverRoles,
    (role) => role && !role.managed,
    (role) => sameName(role.name, definition.name) || sameName(role.name, roleLabel(definition)),
  ));
  const newCategories = scopedCategories.filter((category) => checkResource(
    state.categories[category.key], categoryLabel(category), serverChannels,
    (channel) => channel?.type === ChannelType.GuildCategory,
    (channel) => channel.type === ChannelType.GuildCategory &&
      [category.name, categoryLabel(category), ...legacyCategoryLabels(category)].some((name) => sameName(channel.name, name)),
  ));
  const newChannels = scopedChannels.filter(({ category, channel }) => {
    const parent = state.categories[category.key];
    const id = state.channels[channel.name];
    const legacyParent = channel.legacyCategory && state.layout[id] !== (channel.layout ?? layoutVersion)
      ? state.categories[channel.legacyCategory] : undefined;
    return checkResource(
      id, channelLabel(channel), serverChannels,
      (current) => current?.type === channelType(channel) &&
        (current.parentId === parent || (legacyParent && current.parentId === legacyParent)),
      (current) => parent && current.parentId === parent &&
        [channel.name, ...legacyChannelLabels(channel), channelLabel(channel)].some((name) => sameName(current.name, name)),
    );
  });
  if (!categoryScope && (!state.ordered || newRoles.length) &&
      roles.some(({ key }) => state.roles[key] && !serverRoles.get(state.roles[key]).editable)) {
    throw new SetupError('Przenieś rolę bota nad wszystkie role utworzone w trakcie konfiguracji.');
  }

  const migration = [
    ...scopedCategories.map((category) => ({
      id: state.categories[category.key], label: categoryLabel(category),
      oldLabels: legacyCategoryLabels(category), access: category.access, version: layoutVersion,
    })),
    ...scopedChannels.map(({ category, channel }) => ({
      id: state.channels[channel.name], label: channelLabel(channel),
      oldLabels: legacyChannelLabels(channel), access: channel.access ?? category.access,
      adult: channel.adult,
      counter: channel.counter,
      parentKey: channel.legacyCategory ? category.key : undefined,
      topic: channel.label ? channel.topic : undefined,
      version: channel.layout ?? layoutVersion,
    })),
  ].filter(({ id, version }) => id && state.layout[id] !== version);
  const oldTargets = new Set([guild.id, guild.client.user.id, ...communityStaff.map((key) => state.roles[key])]);
  for (const item of migration) {
    const current = serverChannels.get(item.id);
    if (current.permissionOverwrites.cache.some((entry) => !oldTargets.has(entry.id) && entry.id !== state.roles.verified)) {
      throw new SetupError(`Kanał „${current.name}” ma dodatkowe reguły dostępu. Sprawdź je w Discordzie przed aktualizacją.`);
    }
  }
  return { newRoles, newCategories, newChannels, migration };
}

function legacyCategoryLabels(category) {
  const names = new Set([category.name, category.legacyName ?? category.name]);
  return [...new Set([...names].flatMap((name) => {
    const styled = categoryLabel({ ...category, name });
    return [name, styled, styled.replace('━━ ', '─ ').replace(' ━━', ' ─')];
  }))];
}

function legacyChannelLabels(channel) {
  const emoji = channel.legacyEmoji ?? channel.emoji;
  return emoji ? [`${emoji}・${channel.name}`, `${emoji}│${channel.name}`] : [];
}

export function isStatsChannel(state, id) {
  return id === state.categories['live-stats'] ||
    channelEntries.some(({ channel }) => channel.counter && state.channels[channel.name] === id);
}

function statsLocked(channel) {
  const overwrites = channel?.permissionOverwrites?.cache;
  return overwrites?.get(channel.guild.id)?.deny.has(statsMask, false) &&
    !overwrites.some(({ allow }) => (allow.bitfield & statsMask) !== 0n);
}

export async function lockStatsChannel(channel) {
  if (statsLocked(channel)) return;
  const everyone = channel.guild.id;
  const entries = [...channel.permissionOverwrites.cache.values()];
  if (!entries.some(({ id }) => id === everyone)) {
    entries.push({ id: everyone, type: OverwriteType.Role, allow: new PermissionsBitField(), deny: new PermissionsBitField() });
  }
  await channel.edit({
    permissionOverwrites: entries.map(({ id, type, allow, deny }) => ({
      id, type, allow: allow.bitfield & ~statsMask,
      deny: id === everyone ? deny.bitfield | statsMask : deny.bitfield,
    })),
    reason: 'Ustawienie liczników jako kanałów do podglądu',
  });
}

export async function lockReadOnlyChannel(channel, state) {
  const item = channelEntries.find(({ channel: definition }) => state.channels[definition.name] === channel.id);
  const access = item?.channel.access ?? item?.category.access;
  const guild = channel.guild;
  if (['mods', 'logs', 'staff-records', 'owner-records'].includes(access)) {
    const permissionOverwrites = overwrites(guild, state, access);
    if (!matchesOverwrites(channel.permissionOverwrites.cache, permissionOverwrites)) {
      await channel.edit({ permissionOverwrites, reason: 'Prywatny dostęp do kanału tylko dla moderacji' });
    }
    return;
  }
  if (!['lobby', 'read', 'events'].includes(access)) return;

  const cache = channel.permissionOverwrites.cache;
  const editors = new Map([[guild.client.user.id, OverwriteType.Member]]);
  for (const key of moderators) {
    if (state.roles[key]) editors.set(state.roles[key], OverwriteType.Role);
  }
  const ids = new Set([...cache.keys(), guild.id, ...editors.keys()]);
  let changed = false;
  const permissionOverwrites = [...ids].map((id) => {
    const existing = cache.get(id);
    const allow = existing?.allow.bitfield ?? 0n;
    const deny = existing?.deny.bitfield ?? 0n;
    const canPost = editors.has(id);
    const nextAllow = canPost ? allow | writeMask : allow & ~postingMask;
    const nextDeny = id === guild.id ? deny | postingMask : canPost ? deny & ~writeMask : deny;
    if (nextAllow !== allow || nextDeny !== deny) changed = true;
    return { id, type: existing?.type ?? editors.get(id) ?? OverwriteType.Role, allow: nextAllow, deny: nextDeny };
  });
  if (changed) await channel.edit({ permissionOverwrites, reason: 'Pisanie tylko dla ekipy w kanałach informacyjnych' });
}

function matchesOverwrites(actual, expected) {
  return actual?.size === expected.length && expected.every((entry) => {
    const saved = actual.get(entry.id);
    return saved?.type === entry.type && saved.allow.equals(entry.allow) && saved.deny.equals(entry.deny);
  });
}

async function positionStats(guild, state) {
  const definition = categories.find(({ key }) => key === 'live-stats');
  const channels = await guild.channels.fetch();
  const category = channels.get(state.categories[definition.key]);
  await lockStatsChannel(category);
  if (category.position !== 0) await category.setPosition(0, { reason });
  for (const [index, item] of definition.channels.entries()) {
    const channel = channels.get(state.channels[item.name]);
    await lockStatsChannel(channel);
    if (channel.position !== index) await channel.setPosition(index, { reason });
  }
  const updated = await guild.channels.fetch();
  const top = updated.get(category.id)?.position === 0;
  const locked = statsLocked(updated.get(category.id)) &&
    definition.channels.every(({ name }) => statsLocked(updated.get(state.channels[name])));
  const ordered = definition.channels.every(({ name }, index) => {
    const channel = updated.get(state.channels[name]);
    return channel?.parentId === category.id && channel.position === index;
  });
  if (!top || !ordered) throw new SetupError('Discord nie zapisał kolejności kategorii STATYSTYKI i liczników.');
  console.log('STATYSTYKI są na górze. Kolejność liczników: Online, Offline, Osoby.');
  if (!locked) throw new SetupError('Discord nie zapisał blokady dołączania do liczników.');
  console.log('Liczniki STATYSTYKI tylko do podglądu: zablokowano połączenie i pisanie.');
}

function overwrites(guild, state, access) {
  const allow = (id, permissions, type = OverwriteType.Role) => ({ id, type, allow: permissions, deny: [] });
  const everyone = guild.id;
  const bot = guild.client.user.id;
  const hide = { id: everyone, type: OverwriteType.Role, allow: [], deny: ['ViewChannel'] };
  const botAccess = allow(bot, [...read, ...write], OverwriteType.Member);
  if (access === 'owner-records') {
    return [
      { ...hide, deny: [...hide.deny, ...noWrite] },
      allow(bot, [...read, ...write, 'AttachFiles'], OverwriteType.Member),
      ...(guild.roles.cache.has(panelRoleId) ? [allow(panelRoleId, read)] : []),
    ];
  }
  if (access === 'staff-records') {
    return [
      { ...hide, deny: [...hide.deny, ...noWrite] },
      botAccess,
      ...[...new Set([state.roles.admin, guild.roles.cache.has(panelRoleId) ? panelRoleId : undefined])]
        .filter(Boolean).map((id) => allow(id, read)),
    ];
  }
  if (access === 'mods' || access === 'logs') {
    return [
      { ...hide, deny: [...hide.deny, ...noWrite] },
      botAccess,
      ...moderators.map((key) => allow(state.roles[key], access === 'logs' ? read : [...read, ...write])),
    ];
  }
  if (access === 'lobby') {
    return [
      { id: everyone, type: OverwriteType.Role, allow: read, deny: noWrite },
      botAccess,
      ...moderators.map((key) => allow(state.roles[key], write)),
    ];
  }
  const readOnly = access === 'read' || access === 'events';
  const permissions = [...read, ...(readOnly || access === 'stats' ? [] : write), ...(access === 'voice' ? voice : [])];
  return [
    readOnly ? { ...hide, deny: [...hide.deny, ...noWrite] }
      : access === 'stats' ? { ...hide, deny: [...hide.deny, ...statsBlocked] } : hide,
    access === 'stats' ? allow(bot, read, OverwriteType.Member) : botAccess,
    allow(state.roles.verified, permissions),
    ...communityStaff.map((key) => allow(state.roles[key], readOnly && moderators.includes(key)
      ? [...permissions, ...write] : permissions)),
  ];
}

async function orderRoles(guild, state) {
  const current = await guild.roles.fetch();
  const managed = roles.map(({ key }) => current.get(state.roles[key]));
  if (managed.some((role) => !role?.editable)) {
    throw new SetupError('Przenieś rolę bota nad role utworzone przez konfigurator.');
  }
  const inOrder = (list) => list.every((role, index) => index === 0 || role.comparePositionTo(list[index - 1]) > 0);
  if (inOrder(managed)) return;

  const positions = managed.map((role) => role.position).sort((a, b) => a - b);
  await guild.roles.setPositions(managed.map((role, index) => ({ role: role.id, position: positions[index] })));
  const updated = await guild.roles.fetch();
  if (!inOrder(managed.map(({ id }) => updated.get(id)))) {
    throw new SetupError('Discord nie zapisał hierarchii ról. Sprawdź pozycję roli bota i uruchom konfigurację ponownie.');
  }
}

export async function styleManagedRoles(guild, state) {
  const current = await guild.roles.fetch();
  let styled = 0;
  const skipped = [];
  for (const definition of roles) {
    const role = current.get(state.roles[definition.key]);
    if (!role || role.name !== definition.name) continue;
    if (!role.editable) {
      skipped.push(role.name);
      continue;
    }
    try {
      await role.setName(roleLabel(definition), 'Ozdobna nazwa rangi bota');
      styled++;
    } catch (error) {
      console.warn(`Zmiana nazwy rangi ${definition.name}: ${error.code ?? error.name}.`);
      skipped.push(definition.name);
    }
  }
  console.log(`Ozdobiono rangi bota: ${styled}.`);
  if (skipped.length) console.warn(`Rangi niedostępne do edycji: ${skipped.join(', ')}.`);
}

export async function applySetup(guild, journal, plan) {
  const { state, save } = journal;
  if (plan.newRoles.length && state.ordered) {
    state.ordered = false;
    await save();
  }
  for (const role of plan.newRoles.toReversed()) {
    const created = await guild.roles.create({
      name: role.name,
      ...(role.color ? { colors: { primaryColor: role.color } } : {}),
      permissions: role.permissions ?? [],
      hoist: role.hoist ?? false,
      mentionable: false,
      reason,
    });
    state.roles[role.key] = created.id;
    await save();
  }
  if (!state.ordered) {
    await orderRoles(guild, state);
    state.ordered = true;
    await save();
  }
  await applyChannels(guild, journal, plan);
  return finishSetup(guild, journal);
}

export async function applyChannels(guild, { state, save }, plan) {
  for (const category of plan.newCategories) {
    const created = await guild.channels.create({
      name: categoryLabel(category),
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites(guild, state, category.access),
      reason,
    });
    state.categories[category.key] = created.id;
    state.layout[created.id] = layoutVersion;
    await save();
  }

  for (const { category, channel } of plan.newChannels) {
    const created = await guild.channels.create({
      name: channelLabel(channel),
      parent: state.categories[category.key],
      type: channelType(channel),
      ...(channel.voice ? { userLimit: channel.limit ?? 0 } : {
        topic: channel.topic,
        rateLimitPerUser: channel.slow ?? 0,
        nsfw: channel.adult ?? false,
      }),
      permissionOverwrites: overwrites(guild, state, channel.access ?? category.access),
      reason,
    });
    state.channels[channel.name] = created.id;
    state.layout[created.id] = channel.layout ?? layoutVersion;
    await save();
  }

  for (const item of plan.migration) {
    const current = await guild.channels.fetch(item.id, { force: true });
    const parent = item.parentKey && state.categories[item.parentKey];
    await current.edit({
      ...(current.name !== item.label && !item.counter &&
        item.oldLabels.some((label) => sameName(current.name, label)) ? { name: item.label } : {}),
      ...(parent && parent !== current.parentId ? { parent, lockPermissions: false } : {}),
      ...(item.topic ? { topic: item.topic } : {}),
      ...(item.adult ? { nsfw: true } : {}),
      permissionOverwrites: overwrites(guild, state, item.access),
      reason,
    });
    state.layout[item.id] = item.version;
    await save();
  }
  const current = await guild.channels.fetch();
  for (const category of categories) {
    const saved = current.get(state.categories[category.key]);
    const label = categoryLabel(category);
    if (saved?.type === ChannelType.GuildCategory && saved.name !== label &&
        legacyCategoryLabels(category).includes(saved.name)) {
      await saved.setName(label, 'Ozdobny układ kategorii serwera');
    }
  }
}

export async function syncStarterMessages(guild, { state, save }, names = Object.keys(starterMessages)) {
  let messages = 0;
  for (const name of names) {
    const render = starterMessages[name];
    const version = ['regulamin', 'wybierz-role'].includes(name) ? 8 : messageVersion;
    const needsUpdate = state.messageLayout[name] !== version;
    const channel = await guild.channels.fetch(state.channels[name], { force: true });
    let saved;
    if (state.messages[name]) {
      try {
        saved = await channel.messages.fetch({ message: state.messages[name], force: true });
        if (!needsUpdate) {
          await pinStaffPanel(name, saved);
          continue;
        }
      } catch (error) {
        if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      }
    }
    const [title, ...lines] = render((key) => `<#${state.channels[key]}>`).split('\n');
    const description = lines.join('\n');
    const colors = { 'start-tutaj': 0x5865F2, regulamin: 0x2CA58D, 'wybierz-role': 0xA76DEC,
      'panel-moderacji': 0x5865F2 };
    const embed = new EmbedBuilder()
      .setTitle(title).setDescription(description).setColor(colors[name])
      .setFooter({ text: 'CENTRUM SPOŁECZNOŚCI' });
    const components = name === 'wybierz-role' ? makeRolePanel() : [];
    if (name === 'start-tutaj') components.push(communityButtons());
    if (name === 'panel-moderacji') components.push(...staffButtons());
    if (name === 'regulamin') {
      components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(verificationButton).setLabel('Akceptuję regulamin').setStyle(ButtonStyle.Success)));
    }
    if (saved?.author.id === guild.client.user.id) {
      await saved.edit({ content: '', embeds: [embed], components, allowedMentions: { parse: [] } });
      await pinStaffPanel(name, saved);
      state.messageLayout[name] = version;
      await save();
      continue;
    }
    const recent = await channel.messages.fetch({ limit: 30 });
    const previous = recent.find((message) => message.author.id === guild.client.user.id &&
      message.embeds[0]?.title === title && message.embeds[0]?.description === description &&
      message.components.length === components.length);
    const posted = previous ?? await channel.send({
      embeds: [embed], components, allowedMentions: { parse: [] },
      nonce: state.messages[name] ?? channel.id, enforceNonce: true,
    });
    state.messages[name] = posted.id;
    state.messageLayout[name] = version;
    await save();
    await pinStaffPanel(name, posted);
    if (!previous) messages++;
  }
  return messages;
}

async function finishSetup(guild, { state, save }) {
  await positionStats(guild, state);
  const currentChannels = await guild.channels.fetch();
  for (const { category, channel } of channelEntries) {
    if (['lobby', 'read', 'events', 'mods', 'logs', 'staff-records', 'owner-records'].includes(channel.access ?? category.access)) {
      await lockReadOnlyChannel(currentChannels.get(state.channels[channel.name]), state);
    }
  }
  console.log('Kanały informacyjne do odczytu dla członków. Pisanie dla Moderatorów i Administratorów. Kanał modzi jest prywatny.');
  const bot = await guild.members.fetchMe();
  const messageChannels = await Promise.all(['witamy', 'pozegnania'].map((name) =>
    guild.channels.fetch(state.channels[name], { force: true })));
  if (messageChannels.every((channel) => channel?.permissionsFor(bot)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']))) {
    console.log('Automatyczne powitania i pożegnania gotowe w kanałach witamy i pozegnania.');
  } else {
    console.warn('Sprawdź uprawnienia bota do pisania i osadzania kart w kanałach witamy i pozegnania.');
  }
  const adultChannel = await guild.channels.fetch(state.channels.nsfw, { force: true });
  if (!adultChannel?.nsfw) {
    await adultChannel.edit({ nsfw: true, reason: 'Przywrócenie ograniczenia wiekowego w strefie 18+' });
  }

  const messages = await syncStarterMessages(guild, { state, save });
  state.staffPanelRedirects ??= {};
  for (const name of ['mod-log', 'logi-bota']) {
    if (!state.messages[name] || state.staffPanelRedirects[name]) continue;
    const oldChannel = currentChannels.get(state.channels[name]);
    try {
      const oldPanel = await oldChannel?.messages.fetch({ message: state.messages[name], force: true });
      if (oldPanel?.author.id === guild.client.user.id) {
        await oldPanel.edit({
          content: `Panel moderatorów jest teraz w <#${state.channels['panel-moderacji']}>.`,
          embeds: [], components: [], allowedMentions: { parse: [] },
        });
        if (oldPanel.pinned && oldPanel.pinnable) {
          await oldPanel.unpin('Przeniesienie panelu moderatorów').catch((error) => {
            console.error('Nie udało się odpiąć starego panelu moderatorów:', error.code ?? error.name);
          });
        }
      }
    } catch (error) {
      if (error.code !== RESTJSONErrorCodes.UnknownMessage && error.code !== RESTJSONErrorCodes.UnknownChannel) throw error;
    }
    state.staffPanelRedirects[name] = true;
    await save();
  }
  const oldVerificationId = state.channels.weryfikacja;
  if (oldVerificationId && state.layout[oldVerificationId] !== 'retired') {
    const retired = currentChannels.get(oldVerificationId);
    if (retired?.type === ChannelType.GuildText) {
      await retired.edit({ name: '📁│stara-weryfikacja',
        permissionOverwrites: overwrites(guild, state, 'mods'), reason: 'Połączenie regulaminu i weryfikacji' });
    }
    state.layout[oldVerificationId] = 'retired';
    await save();
  }
  state.securityReady = true;
  await save();
  console.log('Regulamin i przycisk akceptacji są w jednym kanale. Na karcie startowej pozostało zgłoszenie.');
  return messages;
}

async function pinStaffPanel(name, message) {
  if (name === 'panel-moderacji' && message.pinnable && !message.pinned) {
    await message.pin('Przypięcie panelu moderatorów').catch((error) => {
      console.error('Nie udało się przypiąć panelu moderatorów:', error.code ?? error.name);
    });
  }
}

export async function privateModerationChannel(guild, state, { force = true, name = 'logi-bota' } = {}) {
  const id = state.channels[name];
  if (!id || !state.roles.mod || !state.roles.admin) {
    throw new SetupError('Najpierw ukończ konfigurację serwera.');
  }
  const channel = await guild.channels.fetch(id, { force });
  const item = channelEntries.find(({ channel }) => channel.name === name);
  const extraLog = Object.hasOwn(plusLogs, name);
  const ticketArchive = name === 'log-archiwum-ticketow';
  const access = extraLog || ticketArchive ? 'logs' : item?.channel.access ?? item?.category.access;
  const expected = overwrites(guild, state, access);
  if (ticketArchive) expected.find(({ id }) => id === guild.client.user.id).allow.push('AttachFiles');
  const actual = channel?.permissionOverwrites?.cache;
  const botMentionAccess = name === 'log-bany' && expected.map((entry) => entry.id === guild.client.user.id
    ? { ...entry, allow: [...entry.allow, 'MentionEveryone'] } : entry);
  if (!['logs', 'mods', 'staff-records', 'owner-records'].includes(access) || channel?.type !== ChannelType.GuildText ||
      channel.parentId !== state.categories[ticketArchive ? 'ticket-help' : extraLog ? 'bot-logs' : item.category.key] ||
      !(matchesOverwrites(actual, expected) || (botMentionAccess && matchesOverwrites(actual, botMentionAccess)))) {
    throw new SetupError('Prywatny kanał modów wymaga sprawdzenia uprawnień przez administrację.');
  }
  return channel;
}

export async function installProtection(guild, state) {
  const channel = await privateModerationChannel(guild, state, { name: 'log-ochrona' });
  const rules = await guild.autoModerationRules.fetch();
  const outcomes = [];
  let moved = 0;
  for (const rule of rules.values()) {
    const sendsToStaff = (action) => action.type === AutoModerationActionType.SendAlertMessage &&
      [state.channels['mod-log'], state.channels['logi-bota']].includes(action.metadata?.channelId);
    if (!rule.actions?.some(sendsToStaff)) continue;
    await rule.edit({
      actions: rule.actions.map((action) => ({
        type: action.type,
        metadata: {
          channel: sendsToStaff(action) ? channel.id : action.metadata?.channelId ?? undefined,
          durationSeconds: action.metadata?.durationSeconds ?? undefined,
          customMessage: action.metadata?.customMessage ?? undefined,
        },
      })),
      reason: 'Przeniesienie alertów do kanału ochrony',
    });
    moved++;
  }
  if (moved) outcomes.push(`Przeniesiono alerty ${moved} reguł AutoMod do <#${channel.id}>.`);
  const filters = [
    { label: 'Masowe oznaczenia', triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: 5, mentionRaidProtectionEnabled: true } },
    { label: 'Typowy spam', triggerType: AutoModerationRuleTriggerType.Spam },
  ];
  for (const { label, ...filter } of filters) {
    const existing = rules.find((rule) => rule.triggerType === filter.triggerType);
    if (existing) {
      outcomes.push(`**${label}** — istniejąca reguła jest ${existing.enabled ? 'włączona' : 'wyłączona'}.`);
      continue;
    }
    try {
      await guild.autoModerationRules.create({
        ...filter,
        name: `Community • ${label}`,
        eventType: AutoModerationRuleEventType.MessageSend,
        enabled: true,
        actions: [
          { type: AutoModerationActionType.BlockMessage },
          { type: AutoModerationActionType.SendAlertMessage, metadata: { channel: channel.id } },
        ],
        reason,
      });
      outcomes.push(`**${label}** — włączono blokadę i alerty w <#${channel.id}>.`);
    } catch (error) {
      console.error('AutoMod:', filter.triggerType, error.code ?? error.name);
      outcomes.push(`**${label}** — Discord odmówił zapisu. Sprawdź ustawienia AutoMod i uprawnienia bota.`);
    }
  }
  return outcomes.join('\n');
}

export async function restrictRoleMentions(role, state) {
  if (role.managed) return;
  const permitted = moderators.some((key) => role.id === state.roles[key]);
  const bit = PermissionsBitField.Flags.MentionEveryone;
  const old = role.permissions.bitfield;
  const next = permitted ? old | bit : old & ~bit;
  if (old === next) return;
  if (!role.editable) throw new SetupError(`Hierarchia blokuje ustawienie oznaczeń roli „${role.name}”.`);
  await role.setPermissions(next, 'Ograniczenie @everyone i @here do moderatorów i administratorów');
}

export async function installInviteProtection(guild, state) {
  const name = 'Community • Zaproszenia na inne serwery Discord';
  const exemptRoles = [state.roles.mod, state.roles.admin].filter(Boolean);
  if (exemptRoles.length !== 2) throw new SetupError('Brakuje ról Moderator i Administrator.');
  const hosts = ['discord.gg/', 'discord.com/invite/', 'discordapp.com/invite/'];
  const codes = [...new Set([state.communityInvite, guild.vanityURLCode])]
    .filter((code) => /^[a-z0-9_-]{1,25}$/i.test(code ?? ''));
  const regexPatterns = [String.raw`(?i)(?:^|[^a-z0-9_.@/-])(?:https?://)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com/invite)/[a-z0-9_-]+`];
  const allowList = codes.flatMap((code) => hosts.map((host) => host + code));
  const customMessage = 'Zaproszenia na inne serwery Discord może wysyłać tylko moderacja. Wyciszenie trwa 10 minut.';
  const actions = [
    { type: AutoModerationActionType.BlockMessage, metadata: { customMessage } },
    { type: AutoModerationActionType.Timeout, metadata: { durationSeconds: 600 } },
  ];
  const rules = await guild.autoModerationRules.fetch();
  const existing = rules.find((rule) => rule.name === name && rule.creatorId === guild.client.user.id);
  const sameItems = (left, right) => [...left].sort().join('\n') === [...right].sort().join('\n');
  const options = { name, enabled: true, triggerMetadata: { regexPatterns, allowList }, actions,
    exemptRoles, exemptChannels: [], reason: 'Blokada obcych zaproszeń z wyciszeniem na 10 minut' };
  if (!existing) {
    return guild.autoModerationRules.create({ ...options, triggerType: AutoModerationRuleTriggerType.Keyword,
      eventType: AutoModerationRuleEventType.MessageSend });
  }
  if (existing.enabled && sameItems(existing.exemptRoles.keys(), exemptRoles) && !existing.exemptChannels.size &&
      sameItems(existing.triggerMetadata.regexPatterns, regexPatterns) && sameItems(existing.triggerMetadata.allowList, allowList) &&
      !existing.triggerMetadata.keywordFilter.length && existing.actions.length === actions.length &&
      existing.actions.some(({ type, metadata }) => type === AutoModerationActionType.BlockMessage && metadata.customMessage === customMessage) &&
      existing.actions.some(({ type, metadata }) => type === AutoModerationActionType.Timeout && metadata.durationSeconds === 600)) return existing;
  return existing.edit({ ...options, triggerMetadata: { ...options.triggerMetadata, keywordFilter: [] } });
}

export async function restrictChannelMentions(channel, state) {
  const entries = channel?.permissionOverwrites?.cache;
  if (!entries) return;
  const allowed = new Set([channel.guild.client.user.id, ...moderators.map((key) => state.roles[key])]);
  for (const overwrite of entries.values()) {
    if (!allowed.has(overwrite.id) && overwrite.allow.has('MentionEveryone', false)) {
      await channel.permissionOverwrites.edit(overwrite.id, { MentionEveryone: null },
        { type: overwrite.type, reason: 'Ograniczenie @everyone i @here do ekipy' });
    }
  }
}

export async function repairVoiceCommunication(guild, state) {
  const [channels, serverRoles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
  const participants = ['verified', ...communityStaff].map((key) => serverRoles.get(state.roles[key])).filter(Boolean);
  const targets = channels.filter((channel) => channel && !isStatsChannel(state, channel.id) &&
    channel.id !== guild.afkChannelId && channel.id !== state.channels['plus-afk'] &&
    (channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildCategory && [state.categories.voice, state.categories['plus-rooms']].includes(channel.id)));
  let changed = 0;
  for (const channel of targets.values()) {
    const affected = [];
    for (const role of participants) {
      const permissions = channel.permissionsFor(role);
      if (!permissions?.has(['ViewChannel', 'Connect']) || permissions.has(voicePermissions)) continue;
      await channel.permissionOverwrites.edit(role, { Speak: true, UseVAD: true, Stream: true },
        { reason: 'Naprawa mówienia, kamery i udostępniania ekranu' });
      affected.push(role);
      changed++;
    }
    if (!affected.length) continue;
    const updated = await guild.channels.fetch(channel.id, { force: true });
    if (!affected.every((role) => updated.permissionsFor(role)?.has(voicePermissions))) {
      throw new SetupError(`Discord nie zapisał pełnych uprawnień głosowych w „${channel.name}”.`);
    }
    console.log(`Naprawiono głosowe: ${channel.name} (${channel.id}), role: ${affected.map(({ name }) => name).join(', ')}.`);
  }
  console.log(`Sprawdzono komunikację głosową: ${targets.size} kanałów i kategorii, naprawiono ${changed} ustawień ról.`);
}
