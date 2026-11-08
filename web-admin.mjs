import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ChannelType, MessageFlags, PermissionFlagsBits, Routes, SlashCommandBuilder } from 'discord.js';

const idPattern = /^\d{17,20}$/;
const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const channelKinds = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory };
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/assets/avatar.png': ['assets/avatar.png', 'image/png'],
};
const permissionNames = {
  ViewChannel: 'Widoczność kanałów', SendMessages: 'Pisanie', ReadMessageHistory: 'Czytanie historii',
  EmbedLinks: 'Podgląd linków', AttachFiles: 'Załączniki', AddReactions: 'Reakcje',
  Connect: 'Dołączanie do głosowych', Speak: 'Mówienie', MoveMembers: 'Przenoszenie osób',
  ManageMessages: 'Zarządzanie wiadomościami', ModerateMembers: 'Wyciszanie',
  KickMembers: 'Wyrzucanie', BanMembers: 'Banowanie', ViewAuditLog: 'Dostęp do audytu',
  ManageChannels: 'Zarządzanie kanałami', ManageRoles: 'Zarządzanie rolami', ManageGuild: 'Zarządzanie serwerem',
};
const editableMask = Object.keys(permissionNames).reduce((mask, name) => mask | PermissionFlagsBits[name], 0n);
const channelPermissions = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak'];
const token = () => randomBytes(32).toString('base64url');
const clean = (value, max) => String(value ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, max);
const loginTtl = 120_000;
const sessionTtl = 30 * 60_000;
const commandName = 'panel-login';
const panelRoleId = '1568431258550272087';
export const webLoginCommand = new SlashCommandBuilder().setName(commandName)
  .setDescription('Potwierdź jednorazowy kod logowania do panelu Po Godzinach.')
  .addStringOption((option) => option.setName('kod').setDescription('Kod wyświetlony na stronie').setRequired(true));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const required = (condition, message = 'Brak uprawnień do tej operacji.', status = 403) => {
  if (!condition) throw new HttpError(status, message);
};
const entityId = (id) => { required(idPattern.test(id), 'Nieprawidłowy identyfikator.', 400); return id; };

async function json(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    required(body.length <= 16000, 'Żądanie jest za duże.', 413);
  }
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Nieprawidłowe dane.'); }
}

export function createWebAdmin({ client, origin, port, log, logError, closeTicket, isTicket }) {
  if (!origin) return;
  const allowedOrigin = new URL(origin).origin;
  if (allowedOrigin !== origin || !origin.startsWith('https://')) throw new Error('Panel wymaga poprawnego adresu HTTPS.');
  let guild;
  const challenges = new Map();
  const codes = new Map();
  const sessions = new Map();
  const rates = new Map();

  function sweep() {
    const now = Date.now();
    for (const [key, challenge] of challenges) {
      if (challenge.until <= now) { challenges.delete(key); codes.delete(challenge.code); }
    }
    for (const [key, session] of sessions) if (session.until <= now) sessions.delete(key);
    for (const [key, rate] of rates) if (rate.until <= now) rates.delete(key);
  }
  setInterval(sweep, 30_000).unref();

  async function authorized(id) {
    if (!guild) return;
    const member = await guild.members.fetch({ user: id, force: true }).catch(() => undefined);
    return member && member.roles.cache.has(panelRoleId) && !member.user.bot && !member.pending && !member.isCommunicationDisabled() ? member : undefined;
  }

  async function handle(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== commandName) return false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const actor = interaction.guildId === guild?.id && await authorized(interaction.user.id);
    if (!actor) { await interaction.editReply('To konto nie ma dostępu do panelu klienta.'); return true; }
    const key = codes.get(interaction.options.getString('kod', true).trim().toUpperCase());
    const challenge = challenges.get(key);
    if (!challenge || challenge.until < Date.now() || challenge.actor) {
      await interaction.editReply('Kod jest nieprawidłowy albo wygasł. Pobierz nowy na stronie.');
      return true;
    }
    codes.delete(challenge.code);
    challenge.actor = actor.id;
    await interaction.editReply('Logowanie potwierdzone. Wróć do karty ze stroną.');
    return true;
  }

  function issue(request) {
    sweep();
    const ip = String(request.headers['x-real-ip'] ?? request.socket.remoteAddress ?? '').slice(0, 64);
    const now = Date.now();
    const rate = rates.get(ip) ?? { count: 0, until: now + 60_000 };
    required(rate.count < 5 && challenges.size < 500, 'Spróbuj ponownie za minutę.', 429);
    rate.count++;
    rates.set(ip, rate);
    let code;
    do { code = randomBytes(4).toString('hex').toUpperCase(); } while (codes.has(code));
    const key = token();
    challenges.set(key, { code, until: now + loginTtl });
    codes.set(code, key);
    return { key, code, expiresIn: loginTtl / 1000 };
  }

  function verifyLogin(value) {
    const challenge = challenges.get(value?.key);
    required(challenge && challenge.until > Date.now(), 'Kod wygasł. Pobierz nowy.', 404);
    if (!challenge.actor) return { pending: true };
    challenges.delete(value.key);
    const secret = token();
    sessions.set(secret, { id: challenge.actor, until: Date.now() + sessionTtl });
    return { token: secret };
  }

  const above = (actor, role) => actor.id === guild.ownerId || actor.roles.highest.comparePositionTo(role) > 0;
  const account = (member) => ({ id: member.id, name: member.displayName, roles: member.roles.cache.map(({ id }) => id) });

  async function visibleChannel(id, permission, types = textTypes) {
    const channel = await guild.channels.fetch(entityId(id), { force: true }).catch(() => null);
    required(types.includes(channel?.type), 'Kanał nie jest dostępny.', 404);
    required(channel.permissionsFor(guild.members.me)?.has(['ViewChannel', permission]));
    return channel;
  }

  async function managedRole(actor, id) {
    const role = await guild.roles.fetch(entityId(id), { force: true }).catch(() => null);
    required(role && role.id !== guild.id && role.id !== panelRoleId && !role.managed && role.editable && above(actor, role), 'Tej roli nie można zmienić z panelu.');
    return role;
  }

  async function managedMember(actor, id) {
    const member = await guild.members.fetch({ user: entityId(id), force: true }).catch(() => null);
    required(member && member.id !== guild.ownerId && member.id !== actor.id && member.id !== client.user.id &&
      !member.roles.cache.has(panelRoleId) && member.manageable && above(actor, member.roles.highest), 'Hierarchia ról blokuje tę operację.');
    return member;
  }

  async function action(actor, path, method, search, request) {
    const reason = (label) => `Moderator ${actor.id}: panel WWW · ${label}`;
    if (path === '/v1/overview' && method === 'GET') {
      const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
      return {
        actor: actor.displayName, guild: guild.name,
        channels: channels.filter((channel) => [...Object.values(channelKinds), ChannelType.GuildAnnouncement].includes(channel?.type) &&
          channel.permissionsFor(guild.members.me)?.has('ViewChannel')).sort((a, b) => a.rawPosition - b.rawPosition)
          .map((channel) => ({ id: channel.id, name: channel.name, group: channel.parent?.name ?? '', topic: channel.topic,
            slow: channel.rateLimitPerUser ?? 0, category: channel.type === ChannelType.GuildCategory,
            text: textTypes.includes(channel.type), ticket: isTicket(channel),
            editable: channel.manageable })),
        roles: roles.filter((role) => role.id !== guild.id).sort((a, b) => b.comparePositionTo(a)).map((role) => ({
          id: role.id, name: role.name, color: role.hexColor,
          editable: role.id !== panelRoleId && role.editable && !role.managed && above(actor, role),
          permissions: Object.keys(permissionNames).filter((permission) => role.permissions.has(permission, false)),
        })),
        permissionNames, channelPermissions, everyone: guild.id,
      };
    }
    if (path === '/v1/channels/access' && method === 'GET') {
      const channel = await visibleChannel(search.get('channel'), 'ManageRoles', [...Object.values(channelKinds), ChannelType.GuildAnnouncement]);
      required(!isTicket(channel));
      const roleId = entityId(search.get('role'));
      const overwrite = channel.permissionOverwrites.cache.get(roleId);
      return Object.fromEntries(channelPermissions.map((permission) => [permission, overwrite?.allow.has(permission, false) ? 'allow' :
        overwrite?.deny.has(permission, false) ? 'deny' : 'inherit']));
    }
    if (path === '/v1/messages' && method === 'GET') {
      const channel = await visibleChannel(search.get('channel'), 'ReadMessageHistory');
      const before = search.get('before');
      const messages = await channel.messages.fetch({ limit: 25, cache: false, ...(before ? { before: entityId(before) } : {}) });
      return { before: messages.size === 25 ? messages.lastKey() : null, messages: messages.map((message) => ({
        id: message.id, author: message.author.globalName ?? message.author.username, at: message.createdTimestamp,
        text: message.content, attachments: message.attachments.map(({ name }) => name),
        embeds: message.embeds.map(({ title, description }) => clean(title || description, 300)).filter(Boolean),
      })) };
    }
    if (path === '/v1/members' && method === 'GET') {
      const query = clean(search.get('q'), 40);
      required(query.length >= 2, 'Wpisz co najmniej 2 znaki.', 400);
      return { members: (await guild.members.search({ query, limit: 10, cache: false })).map(account) };
    }
    if (method !== 'POST') throw new HttpError(404, 'Brak takiej funkcji.');
    const value = await json(request);
    required(value && typeof value === 'object' && !Array.isArray(value), 'Nieprawidłowe dane.', 400);
    if (path === '/v1/roles/create') {
      required(guild.members.me.permissions.has('ManageRoles'));
      const name = clean(value.name, 100);
      required(name && /^#[\da-f]{6}$/i.test(value.color), 'Sprawdź nazwę i kolor roli.', 400);
      const role = await guild.roles.create({ name, color: value.color, permissions: [], reason: reason('utworzenie roli') });
      return { id: role.id };
    }
    if (path === '/v1/roles/edit' || path === '/v1/roles/delete') {
      const role = await managedRole(actor, value.role);
      if (path.endsWith('/delete')) await role.delete(reason('usunięcie roli'));
      else {
        const name = clean(value.name, 100);
        required(name && /^#[\da-f]{6}$/i.test(value.color), 'Sprawdź nazwę i kolor roli.', 400);
        await role.edit({ name, color: value.color, reason: reason('edycja roli') });
      }
      return { ok: true };
    }
    if (path === '/v1/roles/permissions') {
      const role = await managedRole(actor, value.role);
      const selection = value.permissions;
      required(Array.isArray(selection) && selection.every((item) => Object.hasOwn(permissionNames, item)), 'Nieprawidłowe uprawnienia.', 400);
      const wanted = selection.reduce((mask, name) => mask | PermissionFlagsBits[name], 0n);
      const old = role.permissions.bitfield;
      const next = (old & ~editableMask) | wanted;
      const added = next & ~old;
      required(guild.members.me.permissions.has(added), 'Brakuje uprawnień do nadania tych ustawień.');
      await role.setPermissions(next, reason('zmiana uprawnień roli'));
      return { ok: true };
    }
    if (path === '/v1/roles/member') {
      const [role, member] = await Promise.all([managedRole(actor, value.role), managedMember(actor, value.member)]);
      required(typeof value.add === 'boolean', 'Wybierz działanie.', 400);
      if (value.add) {
        required(actor.permissions.has(role.permissions), 'Ta rola ma dodatkowe uprawnienia.');
        await member.roles.add(role, reason('nadanie roli'));
      } else await member.roles.remove(role, reason('zdjęcie roli'));
      return { ok: true };
    }
    if (path === '/v1/channels/create') {
      required(guild.members.me.permissions.has('ManageChannels'));
      const name = clean(value.name, 100);
      required(name && Object.hasOwn(channelKinds, value.kind), 'Sprawdź nazwę i typ kanału.', 400);
      const parent = value.parent ? await visibleChannel(value.parent, 'ManageChannels', [ChannelType.GuildCategory]) : undefined;
      required(!parent || value.kind !== 'category', 'Kategoria nie może mieć kategorii nadrzędnej.', 400);
      const channel = await guild.channels.create({ name, type: channelKinds[value.kind], parent, reason: reason('utworzenie kanału') });
      return { id: channel.id };
    }
    if (path === '/v1/channels/access') {
      const channel = await visibleChannel(value.channel, 'ManageRoles', [...Object.values(channelKinds), ChannelType.GuildAnnouncement]);
      required(!isTicket(channel), 'Kanały zgłoszeń mają własne zasady dostępu.');
      const role = value.role === guild.id ? guild.roles.everyone : await managedRole(actor, value.role);
      const permission = value.permission;
      required(channelPermissions.includes(permission) && ['allow', 'deny', 'inherit'].includes(value.access), 'Sprawdź ustawienie dostępu.', 400);
      const botPermissions = channel.permissionsFor(guild.members.me);
      required(botPermissions?.has(permission));
      const state = value.access === 'inherit' ? null : value.access === 'allow';
      await channel.permissionOverwrites.edit(role, { [permission]: state }, { reason: reason('zmiana dostępu do kanału') });
      return { ok: true };
    }
    if (path === '/v1/channels/edit' || path === '/v1/channels/delete') {
      const channel = await visibleChannel(value.channel, 'ManageChannels', [...Object.values(channelKinds), ChannelType.GuildAnnouncement]);
      required(channel.manageable);
      required(!isTicket(channel), 'Zarządzaj tym kanałem przez zamknięcie zgłoszenia i zapis w archiwum.');
      if (path.endsWith('/delete')) {
        required(channel.deletable, 'Discord nie pozwala usunąć tego kanału.');
        await channel.delete(reason('usunięcie kanału'));
        return { ok: true };
      }
      const name = clean(value.name, 100);
      const slow = Number(value.slow);
      required(name && Number.isInteger(slow) && slow >= 0 && slow <= 21600, 'Sprawdź nazwę i slowmode.', 400);
      const text = textTypes.includes(channel.type) ? { topic: clean(value.topic, 1024), rateLimitPerUser: slow } : {};
      await channel.edit({ name, ...text, reason: reason('edycja kanału') });
      return { ok: true };
    }
    if (path === '/v1/messages/delete') {
      const channel = await visibleChannel(value.channel, 'ManageMessages');
      await client.rest.delete(Routes.channelMessage(channel.id, entityId(value.message)), { reason: reason('usunięcie wiadomości') });
      return { ok: true };
    }
    if (path === '/v1/tickets/close') {
      const channel = await visibleChannel(value.channel, 'ManageChannels');
      required(isTicket(channel), 'Ten kanał nie jest zgłoszeniem.', 400);
      return { message: await closeTicket({ guild, channelId: channel.id }, actor) };
    }
    if (path === '/v1/moderation') {
      const modes = { timeout: 'ModerateMembers', untimeout: 'ModerateMembers', kick: 'KickMembers', ban: 'BanMembers' };
      required(Object.hasOwn(modes, value.action) && guild.members.me.permissions.has(modes[value.action]));
      const member = await managedMember(actor, value.member);
      const note = clean(value.reason, 280);
      required(note.length >= 3, 'Wpisz powód operacji.', 400);
      if (value.action === 'kick') { required(member.kickable); await member.kick(reason(note)); }
      else if (value.action === 'ban') { required(member.bannable); await member.ban({ reason: reason(note) }); }
      else {
        required(member.moderatable);
        await member.timeout(value.action === 'timeout' ? 10 * 60_000 : null, reason(note));
      }
      await log(guild, 'log-moderacja', '🖥️ Moderacja z panelu WWW',
        `Moderator: <@${actor.id}>\nOsoba: <@${member.id}>\nAkcja: **${value.action}**\nPowód: ${note}`);
      return { ok: true };
    }
    throw new HttpError(404, 'Brak takiej funkcji.');
  }

  function start(serverGuild) {
    guild = serverGuild;
    const server = createServer(async (request, response) => {
      const answer = (status, value) => {
        response.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        response.end(status === 204 ? undefined : JSON.stringify(value));
      };
      try {
        const { pathname: path, searchParams } = new URL(request.url, 'http://panel.local');
        if (request.method === 'GET' && Object.hasOwn(staticFiles, path)) {
          const [file, type] = staticFiles[path];
          const body = await readFile(new URL(`./web/${file}`, import.meta.url));
          response.writeHead(200, {
            'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          });
          return response.end(body);
        }
        if (path === '/v1/health' && request.method === 'GET') return answer(200, { online: client.isReady() });
        if (!path.startsWith('/v1/')) return answer(404, { error: 'Nie znaleziono strony.' });
        required(request.headers.origin === allowedOrigin || (request.method === 'GET' && !request.headers.origin));
        if (request.method === 'OPTIONS') return answer(204);
        if (path === '/v1/login' && request.method === 'POST') return answer(200, issue(request));
        if (path === '/v1/login/check' && request.method === 'POST') return answer(200, verifyLogin(await json(request)));
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
        const session = sessions.get(bearer);
        required(session && session.until > Date.now(), 'Sesja wygasła. Zaloguj się ponownie.', 401);
        if (path === '/v1/logout' && request.method === 'POST') {
          sessions.delete(bearer);
          return answer(200, { ok: true });
        }
        const actor = await authorized(session.id);
        required(actor, 'Twoje konto utraciło dostęp do panelu.', 401);
        return answer(200, await action(actor, path, request.method, searchParams, request));
      } catch (error) {
        if (error instanceof HttpError) return answer(error.status, { error: error.message });
        logError(error);
        return answer(502, { error: 'Discord nie wykonał tej operacji. Sprawdź uprawnienia i spróbuj ponownie.' });
      }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.on('error', logError);
    server.listen(port, '0.0.0.0', () => console.log(`Panel WWW gotowy na porcie ${port}. Dostęp: rola ${panelRoleId}.`));
    return server;
  }

  return { handle, start };
}
