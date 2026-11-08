import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const idPattern = /^\d{17,20}$/;
const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const permissionNames = {
  ViewChannel: 'Widoczność kanałów', SendMessages: 'Pisanie', ReadMessageHistory: 'Czytanie historii',
  EmbedLinks: 'Podgląd linków', AttachFiles: 'Załączniki', AddReactions: 'Reakcje',
  Connect: 'Dołączanie do głosowych', Speak: 'Mówienie', MoveMembers: 'Przenoszenie osób',
  ManageMessages: 'Zarządzanie wiadomościami', ModerateMembers: 'Wyciszanie',
  KickMembers: 'Wyrzucanie', BanMembers: 'Banowanie', ViewAuditLog: 'Dostęp do audytu',
  ManageChannels: 'Zarządzanie kanałami', ManageRoles: 'Zarządzanie rolami', ManageGuild: 'Zarządzanie serwerem',
};
const editableMask = Object.keys(permissionNames).reduce((mask, name) => mask | PermissionFlagsBits[name], 0n);
const token = () => randomBytes(32).toString('base64url');
const clean = (value, max) => String(value ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, max);
const loginTtl = 120_000;
const sessionTtl = 30 * 60_000;
const commandName = 'panel-login';
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

export function createWebAdmin({ client, origin, port, log, logError }) {
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
    if (!guild || id !== guild.ownerId) return;
    const member = await guild.members.fetch({ user: id, force: true }).catch(() => undefined);
    return member && !member.user.bot && !member.pending && !member.isCommunicationDisabled() ? member : undefined;
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

  async function visibleChannel(actor, id, permission) {
    const channel = await guild.channels.fetch(entityId(id), { force: true }).catch(() => null);
    required(textTypes.includes(channel?.type), 'Kanał nie jest dostępny.', 404);
    required(channel.permissionsFor(actor)?.has(['ViewChannel', permission]));
    return channel;
  }

  async function managedRole(actor, id) {
    required(actor.permissions.has('ManageRoles'));
    const role = await guild.roles.fetch(entityId(id), { force: true }).catch(() => null);
    required(role && role.id !== guild.id && !role.managed && role.editable && above(actor, role), 'Tej roli nie można zmienić z panelu.');
    return role;
  }

  async function managedMember(actor, id) {
    const member = await guild.members.fetch({ user: entityId(id), force: true }).catch(() => null);
    required(member && member.id !== guild.ownerId && member.id !== actor.id && member.id !== client.user.id &&
      member.manageable && above(actor, member.roles.highest), 'Hierarchia ról blokuje tę operację.');
    return member;
  }

  async function action(actor, path, method, search, request) {
    const reason = (label) => `Moderator ${actor.id}: panel WWW · ${label}`;
    if (path === '/v1/overview' && method === 'GET') {
      const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
      return {
        actor: actor.displayName, guild: guild.name,
        channels: channels.filter((channel) => textTypes.includes(channel?.type) &&
          channel.permissionsFor(actor)?.has(['ViewChannel', 'ReadMessageHistory'])).sort((a, b) => a.rawPosition - b.rawPosition)
          .map((channel) => ({ id: channel.id, name: channel.name, group: channel.parent?.name ?? '', topic: channel.topic,
            slow: channel.rateLimitPerUser ?? 0,
            editable: channel.permissionsFor(actor)?.has('ManageChannels') })),
        roles: roles.filter((role) => role.id !== guild.id).sort((a, b) => b.comparePositionTo(a)).map((role) => ({
          id: role.id, name: role.name, color: role.hexColor,
          editable: actor.permissions.has('ManageRoles') && role.editable && !role.managed && above(actor, role),
          permissions: Object.keys(permissionNames).filter((permission) => role.permissions.has(permission, false)),
        })),
        permissionNames,
      };
    }
    if (path === '/v1/messages' && method === 'GET') {
      const channel = await visibleChannel(actor, search.get('channel'), 'ReadMessageHistory');
      required(channel.permissionsFor(guild.members.me)?.has(['ViewChannel', 'ReadMessageHistory']), 'Bot nie ma dostępu do historii tego kanału.');
      const before = search.get('before');
      const messages = await channel.messages.fetch({ limit: 25, cache: false, ...(before ? { before: entityId(before) } : {}) });
      return { before: messages.size === 25 ? messages.lastKey() : null, messages: messages.map((message) => ({
        author: message.author.globalName ?? message.author.username, at: message.createdTimestamp,
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
    if (path === '/v1/roles/permissions') {
      const role = await managedRole(actor, value.role);
      const selection = value.permissions;
      required(Array.isArray(selection) && selection.every((item) => Object.hasOwn(permissionNames, item)), 'Nieprawidłowe uprawnienia.', 400);
      const wanted = selection.reduce((mask, name) => mask | PermissionFlagsBits[name], 0n);
      const old = role.permissions.bitfield;
      const next = (old & ~editableMask) | wanted;
      const added = next & ~old;
      required(actor.permissions.has(added) && guild.members.me.permissions.has(added), 'Brakuje uprawnień do nadania tych ustawień.');
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
    if (path === '/v1/channels/edit') {
      const channel = await visibleChannel(actor, value.channel, 'ManageChannels');
      const name = clean(value.name, 100);
      const slow = Number(value.slow);
      required(name && Number.isInteger(slow) && slow >= 0 && slow <= 21600, 'Sprawdź nazwę i slowmode.', 400);
      await channel.edit({ name, topic: clean(value.topic, 1024), rateLimitPerUser: slow, reason: reason('edycja kanału') });
      return { ok: true };
    }
    if (path === '/v1/moderation') {
      const modes = { timeout: 'ModerateMembers', untimeout: 'ModerateMembers', kick: 'KickMembers', ban: 'BanMembers' };
      required(Object.hasOwn(modes, value.action) && actor.permissions.has(modes[value.action]));
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
        if (path === '/v1/health' && request.method === 'GET') return answer(200, { online: client.isReady() });
        required(request.headers.origin === allowedOrigin);
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
    server.listen(port, '0.0.0.0', () => console.log(`Panel WWW gotowy na porcie ${port}. Dostęp: właściciel serwera.`));
    return server;
  }

  return { handle, start };
}
