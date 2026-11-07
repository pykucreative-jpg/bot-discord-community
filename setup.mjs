import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ActionRowBuilder, AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType,
  ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, OverwriteType, PermissionsBitField, RESTJSONErrorCodes,
} from 'discord.js';
import { categories, categoryLabel, channelLabel, roles, starterMessages } from './plan.mjs';
import { communityButtons, staffButtons, verificationButton } from './panels.mjs';
import { makeRolePanel } from './role-panel.mjs';

const reason = 'Konfiguracja serwera społecznościowego';
const read = ['ViewChannel', 'ReadMessageHistory', 'UseApplicationCommands'];
const write = ['SendMessages', 'EmbedLinks'];
const noWrite = [...write, 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads'];
const voice = ['Connect', 'Speak'];
const moderators = ['admin', 'mod'];
const communityStaff = [...moderators, 'helper', 'organizer'];
const layoutVersion = 3;
const messageVersion = 4;

export const botPermissions = new PermissionsBitField([
  ...read, ...noWrite, ...voice, 'ViewAuditLog',
  ...roles.flatMap((role) => role.permissions ?? []),
]);

export const channelEntries = categories.flatMap((category) =>
  category.channels.map((channel) => ({ category, channel })),
);

export class SetupError extends Error {}

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

export async function inspect(guild, state) {
  const [serverRoles, serverChannels, bot] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
    guild.members.fetchMe({ force: true }),
  ]);
  const missing = bot.permissions.missing(botPermissions);
  if (missing.length) throw new SetupError(`Brak uprawnień bota: ${missing.join(', ')}.`);

  const newRoles = roles.filter(({ key, name }) => checkResource(
    state.roles[key], name, serverRoles,
    (role) => role && !role.managed,
    (role) => sameName(role.name, name),
  ));
  const newCategories = categories.filter((category) => checkResource(
    state.categories[category.key], categoryLabel(category), serverChannels,
    (channel) => channel?.type === ChannelType.GuildCategory,
    (channel) => channel.type === ChannelType.GuildCategory &&
      [category.name, categoryLabel(category), ...legacyCategoryLabels(category)].some((name) => sameName(channel.name, name)),
  ));
  const newChannels = channelEntries.filter(({ category, channel }) => {
    const parent = state.categories[category.key];
    const id = state.channels[channel.name];
    const legacyParent = channel.legacyCategory && state.layout[id] !== layoutVersion
      ? state.categories[channel.legacyCategory] : undefined;
    return checkResource(
      id, channelLabel(channel), serverChannels,
      (current) => current?.type === channelType(channel) &&
        (current.parentId === parent || (legacyParent && current.parentId === legacyParent)),
      (current) => parent && current.parentId === parent &&
        [channel.name, ...legacyChannelLabels(channel), channelLabel(channel)].some((name) => sameName(current.name, name)),
    );
  });
  if ((!state.ordered || newRoles.length) && roles.some(({ key }) => state.roles[key] && !serverRoles.get(state.roles[key]).editable)) {
    throw new SetupError('Przenieś rolę bota nad wszystkie role utworzone w trakcie konfiguracji.');
  }

  const migration = [
    ...categories.map((category) => ({
      id: state.categories[category.key], label: categoryLabel(category),
      oldLabels: legacyCategoryLabels(category), access: category.access,
    })),
    ...channelEntries.map(({ category, channel }) => ({
      id: state.channels[channel.name], label: channelLabel(channel),
      oldLabels: legacyChannelLabels(channel), access: channel.access ?? category.access,
      adult: channel.adult,
      parentKey: channel.legacyCategory ? category.key : undefined,
      topic: channel.label ? channel.topic : undefined,
    })),
  ].filter(({ id }) => id && state.layout[id] !== layoutVersion);
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
  const name = category.legacyName ?? category.name;
  return [name, categoryLabel({ ...category, name })];
}

function legacyChannelLabels(channel) {
  const emoji = channel.legacyEmoji ?? channel.emoji;
  return [`${emoji}・${channel.name}`, `${emoji}│${channel.name}`];
}

function overwrites(guild, state, access) {
  const allow = (id, permissions, type = OverwriteType.Role) => ({ id, type, allow: permissions, deny: [] });
  const everyone = guild.id;
  const bot = guild.client.user.id;
  const hide = { id: everyone, type: OverwriteType.Role, allow: [], deny: ['ViewChannel'] };
  const botAccess = allow(bot, [...read, ...write], OverwriteType.Member);
  if (access === 'mods') {
    return [
      hide,
      botAccess,
      ...moderators.map((key) => allow(state.roles[key], [...read, ...write])),
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
  const editors = access === 'events' ? [...moderators, 'organizer'] : moderators;
  return [
    readOnly ? { ...hide, deny: [...hide.deny, ...noWrite] }
      : access === 'stats' ? { ...hide, deny: [...hide.deny, 'Connect', 'SendMessages'] } : hide,
    botAccess,
    allow(state.roles.verified, permissions),
    ...communityStaff.map((key) => allow(state.roles[key], readOnly && editors.includes(key)
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
    state.layout[created.id] = layoutVersion;
    await save();
  }

  for (const item of plan.migration) {
    const current = await guild.channels.fetch(item.id, { force: true });
    const parent = item.parentKey && state.categories[item.parentKey];
    await current.edit({
      ...(current.name !== item.label && item.oldLabels.some((label) => sameName(current.name, label)) ? { name: item.label } : {}),
      ...(parent && parent !== current.parentId ? { parent, lockPermissions: false } : {}),
      ...(item.topic ? { topic: item.topic } : {}),
      ...(item.adult ? { nsfw: true } : {}),
      permissionOverwrites: overwrites(guild, state, item.access),
      reason,
    });
    state.layout[item.id] = layoutVersion;
    await save();
  }
  const adultChannel = await guild.channels.fetch(state.channels.nsfw, { force: true });
  if (!adultChannel?.nsfw) {
    await adultChannel.edit({ nsfw: true, reason: 'Przywrócenie ograniczenia wiekowego w strefie 18+' });
  }

  let messages = 0;
  for (const [name, render] of Object.entries(starterMessages)) {
    const isPanel = name !== 'regulamin';
    const needsUpdate = state.messageLayout[name] !== messageVersion;
    if (state.messages[name] && !isPanel && !needsUpdate) continue;
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
    const colors = { 'start-tutaj': 0x5865F2, regulamin: 0x2CA58D, 'wybierz-role': 0xA76DEC, weryfikacja: 0xE7A84C,
      'mod-log': 0x5865F2 };
    const embed = new EmbedBuilder()
      .setTitle(title).setDescription(description).setColor(colors[name])
      .setFooter({ text: 'CENTRUM SPOŁECZNOŚCI' });
    const components = name === 'wybierz-role' ? makeRolePanel() : [];
    if (name === 'start-tutaj') components.push(communityButtons());
    if (name === 'mod-log') components.push(...staffButtons());
    if (name === 'weryfikacja') {
      components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(verificationButton).setLabel('Akceptuję regulamin').setStyle(ButtonStyle.Success)));
    }
    if (saved?.author.id === guild.client.user.id) {
      await saved.edit({ content: '', embeds: [embed], components, allowedMentions: { parse: [] } });
      await pinStaffPanel(name, saved);
      state.messageLayout[name] = messageVersion;
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
    state.messageLayout[name] = messageVersion;
    await save();
    await pinStaffPanel(name, posted);
    if (!previous) messages++;
  }
  state.securityReady = true;
  await save();
  return messages;
}

async function pinStaffPanel(name, message) {
  if (name === 'mod-log' && message.pinnable && !message.pinned) {
    await message.pin('Przypięcie panelu moderatorów').catch((error) => {
      console.error('Nie udało się przypiąć panelu moderatorów:', error.code ?? error.name);
    });
  }
}

export async function privateModerationChannel(guild, state, force = true) {
  const id = state.channels['mod-log'];
  if (!id || !state.roles.mod || !state.roles.admin) {
    throw new SetupError('Najpierw ukończ konfigurację serwera.');
  }
  const channel = await guild.channels.fetch(id, { force });
  const expected = overwrites(guild, state, 'mods');
  const actual = channel?.permissionOverwrites?.cache;
  if (channel?.type !== ChannelType.GuildText || channel.parentId !== state.categories.moderation ||
      actual?.size !== expected.length || !expected.every((entry) => {
        const saved = actual.get(entry.id);
        return saved?.type === entry.type && saved.allow.equals(entry.allow) && saved.deny.equals(entry.deny);
      })) {
    throw new SetupError('Prywatny kanał modów wymaga sprawdzenia uprawnień przez administrację.');
  }
  return channel;
}

export async function installProtection(guild, state) {
  const channel = await privateModerationChannel(guild, state);
  const rules = await guild.autoModerationRules.fetch();
  const outcomes = [];
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
