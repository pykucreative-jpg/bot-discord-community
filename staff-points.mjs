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

function pointCard({ kind, number, recipient, actor, note, outcome, demo = false }) {
  const title = kind === 'plus' ? '🌟 Przyznano plusa' : '⚠️ Przyznano minusa';
  const embed = new EmbedBuilder().setTitle(demo ? `🧪 Próba · ${title}` : title).setColor(color(kind)).setTimestamp()
    .addFields({ name: 'Odbiorca', value: `<@${recipient}>`, inline: true },
      { name: 'Przyznał(a)', value: `<@${actor}>`, inline: true },
      { name: kind === 'plus' ? 'Który plus?' : 'Który minus?', value: `**${number}/${limits[kind]}**`, inline: true },
      { name: 'Za co?', value: escapeMarkdown(note) })
    .setFooter({ text: 'Po Godzinach · Punkty administracji' });
  if (outcome) embed.addFields({ name: 'Wynik', value: outcome });
  return embed;
}

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
    const demo = target?.user.bot && id === guild.client.user.id;
    if (target?.user.bot && !demo) throw new SetupError('Punkty są przeznaczone dla osób z ekipy. Próbę wykonasz na bocie Po Godzinach.');
    if (!demo && !staffRoles.length) throw new SetupError('Ta osoba nie ma rangi ekipy.');
    if (!demo && !target.manageable) throw new SetupError('Hierarchia ról Discorda blokuje zmianę tej osobie.');
    const marks = levels(kind).map((number) => roles.get(state.roles[key(kind, number)]));
    if (!marks.every((role) => role?.editable && !role.managed && role.permissions.bitfield === 0n)) {
      throw new SetupError('Rangi punktów wymagają sprawdzenia przez właściciela.');
    }
    if (demo) {
      const consequence = kind === 'minus' ? '\nPrzy prawdziwym 3/3 bot zdejmuje najwyższą rangę ekipy, którą może zdjąć.' : '';
      return {
        content: `Prawdziwy wpis trafia do <#${channel.id}>.${consequence}`,
        embeds: [pointCard({ kind, number: 1, recipient: id, actor: actor.id, note, demo: true })],
      };
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
    await target.roles.set([...next], `Punkty administracji: ${title} · wykonawca ${actor.id}`);
    const outcome = degraded ? `Degradacja: zdjęto rangę „${degraded.name}”.`
      : kind === 'plus' && number === limit ? 'Osiągnięto maksymalną liczbę plusów.' : '';
    const embed = pointCard({ kind, number, recipient: id, actor: actor.id, note, outcome });
    const mention = kind === 'plus' ? `<@${id}>` : undefined;
    const canSeeLog = mention && channel.permissionsFor(target)?.has('ViewChannel');
    const logged = await channel.send({
      content: mention, embeds: [embed], allowedMentions: { parse: [], users: canSeeLog ? [id] : [] },
      nonce: interaction.id, enforceNonce: true,
    })
      .then(() => true).catch((error) => { logError(error); return false; });
    let notification;
    if (mention && (!canSeeLog || !logged)) {
      const sent = await target.send({ content: mention, embeds: [embed], allowedMentions: { parse: [], users: [id] } })
        .then(() => true).catch((error) => {
          if (Number(error.code) !== 50007) logError(error);
          return false;
        });
      notification = sent ? 'Odbiorca dostał kartę w wiadomości prywatnej.' : 'Bot nie mógł wysłać odbiorcy wiadomości prywatnej.';
    }
    return [`Przyznano **${title}** dla <@${id}>.`, outcome,
      logged ? `Zapis: <#${channel.id}>.` : 'Punkt przyznano, ale zapis w kanale się nie powiódł.',
      notification].filter(Boolean).join('\n');
  } finally {
    active.delete(id);
  }
}
