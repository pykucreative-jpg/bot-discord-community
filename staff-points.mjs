import { EmbedBuilder, escapeMarkdown, SlashCommandBuilder } from 'discord.js';
import { panelRoleId } from './plan.mjs';
import { privateModerationChannel, SetupError } from './setup.mjs';

const limits = { plus: 5, minus: 3 };
const staff = ['admin', 'mod', 'helper', 'organizer'];
const active = new Set();
const kindLabel = (kind) => kind === 'plus' ? 'Plus' : 'Minus';
const color = (kind) => kind === 'plus' ? 0x2ECC71 : 0xE74C3C;
const key = (kind, number) => `staff-${kind}-${number}`;
const levels = (kind) => Array.from({ length: limits[kind] }, (_, index) => index + 1);

export const staffPointCommands = Object.keys(limits).map((kind) => new SlashCommandBuilder()
  .setName(kind).setDescription(`Przyznaj ${kind} członkowi administracji.`)
  .addUserOption((option) => option.setName('osoba').setDescription('Członek administracji').setRequired(true))
  .addStringOption((option) => option.setName('za-co').setDescription('Powód przyznania punktu')
    .setRequired(true).setMinLength(3).setMaxLength(400)));

export async function setupStaffPoints(guild, journal) {
  const existing = await guild.roles.fetch();
  for (const kind of Object.keys(limits)) {
    for (const number of levels(kind)) {
      const id = key(kind, number);
      const name = `${kind === 'plus' ? '➕' : '➖'}│${kindLabel(kind)} ${number}/${limits[kind]}`;
      const current = existing.get(journal.state.roles[id]);
      if (current) continue;
      const matching = existing.filter((role) => role.name === name && role.editable && !role.managed && role.permissions.bitfield === 0n);
      if (matching.size > 1) throw new SetupError(`Usuń powtórzone rangi „${name}”.`);
      const role = matching.first() ?? await guild.roles.create({
        name, colors: { primaryColor: color(kind) }, permissions: [], reason: 'Punkty administracji',
      });
      journal.state.roles[id] = role.id;
      await journal.save();
    }
  }
}

export async function giveStaffPoint(interaction, actor, state, logError) {
  if (!actor.roles.cache.has(panelRoleId)) throw new SetupError('Punkty może przyznawać tylko rola z dostępem do panelu WWW.');
  const { guild, commandName: kind } = interaction;
  const { id } = interaction.options.getUser('osoba', true);
  const note = interaction.options.getString('za-co', true).trim();
  if (id === actor.id || id === guild.ownerId || note.length < 3) {
    throw new SetupError('Wybierz inną osobę z ekipy i podaj powód. Właściciel serwera jest chroniony.');
  }
  if (active.has(id)) throw new SetupError('Trwa przyznawanie punktu tej osobie. Spróbuj za chwilę.');
  active.add(id);
  try {
    const [target, roles, channel] = await Promise.all([
      guild.members.fetch({ user: id, force: true }).catch(() => null),
      guild.roles.fetch(),
      privateModerationChannel(guild, state, { name: 'staff-records' }),
    ]);
    const staffRoles = staff.map((name) => target?.roles.cache.get(state.roles[name])).filter(Boolean);
    if (!target || target.user.bot || !staffRoles.length) throw new SetupError('Ta osoba nie ma rangi ekipy.');
    if (!target.manageable) throw new SetupError('Hierarchia ról Discorda blokuje zmianę tej osobie.');
    const marks = levels(kind).map((number) => roles.get(state.roles[key(kind, number)]));
    if (!marks.every((role) => role?.editable && !role.managed && role.permissions.bitfield === 0n)) {
      throw new SetupError('Rangi punktów wymagają sprawdzenia przez właściciela.');
    }
    const current = marks.findLastIndex(({ id: roleId }) => target.roles.cache.has(roleId)) + 1;
    const limit = limits[kind];
    if (current >= limit) throw new SetupError(`Ta osoba ma już ${limit}/${limit}.`);
    const number = current + 1;
    const degraded = kind === 'minus' && number === limit
      ? staffRoles.filter((role) => role.id !== panelRoleId).sort((a, b) => b.comparePositionTo(a))[0] : null;
    if (kind === 'minus' && number === limit && !degraded?.editable) {
      throw new SetupError('Bot nie może zdjąć najwyższej rangi ekipy. Sprawdź hierarchię ról.');
    }
    const next = new Set(target.roles.cache.keys());
    next.delete(guild.id);
    for (const mark of marks) next.delete(mark.id);
    if (degraded) next.delete(degraded.id);
    next.add(marks[number - 1].id);
    const title = `${kindLabel(kind)} ${number}/${limit}`;
    await target.roles.set([...next], `${title} · wykonawca ${actor.id} · ${note}`);
    const outcome = degraded ? `Degradacja: zdjęto rangę „${degraded.name}”.`
      : kind === 'plus' && number === limit ? 'Osiągnięto maksymalną liczbę plusów.' : '';
    const embed = new EmbedBuilder().setTitle(title).setColor(color(kind)).setTimestamp()
      .addFields({ name: 'Osoba', value: `<@${id}>`, inline: true },
        { name: 'Wykonawca', value: `<@${actor.id}>`, inline: true },
        { name: 'Powód', value: escapeMarkdown(note) });
    if (outcome) embed.addFields({ name: 'Wynik', value: outcome });
    const logged = await channel.send({ embeds: [embed], allowedMentions: { parse: [] }, nonce: interaction.id, enforceNonce: true })
      .then(() => true).catch((error) => { logError(error); return false; });
    return [`Przyznano **${title}** dla <@${id}>.`, outcome,
      logged ? `Zapis: <#${channel.id}>.` : 'Punkt przyznano, ale zapis w kanale się nie powiódł.'].filter(Boolean).join('\n');
  } finally {
    active.delete(id);
  }
}
