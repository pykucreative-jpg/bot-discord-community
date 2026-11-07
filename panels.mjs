import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, LabelBuilder, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
} from 'discord.js';
import { roles } from './plan.mjs';

export const controls = 'community:auto:';
export const verificationButton = 'community:verify:2';
export const manualRoles = roles.filter(({ key }) => ['admin', 'mod', 'helper', 'organizer', 'member', 'vip'].includes(key));

function button(action, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(controls + action).setLabel(label).setStyle(style);
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

export function communityButtons() {
  return row(button('report', 'Zgłoś sprawę'));
}

export function staffButtons() {
  return [
    row(button('status', 'Stan serwera'),
      button('announce:ogloszenia', 'Ogłoszenie'), button('announce:wydarzenia', 'Wydarzenie'),
      button('unban', 'Odbanuj po ID')),
    row(new UserSelectMenuBuilder().setCustomId(controls + 'moderate').setPlaceholder('Wybierz osobę do moderacji')),
    row(new ChannelSelectMenuBuilder().setCustomId(controls + 'clear-channel')
      .setPlaceholder('Wybierz kanał do czyszczenia').addChannelTypes(ChannelType.GuildText)),
  ];
}

export function confirmCleanup(code) {
  return row(button('delete:' + code, 'Trwale usuń kanały z podglądu', ButtonStyle.Danger));
}

export function confirmMessageClear(token) {
  return row(button('confirm-clear:' + token, 'Usuń wiadomości z podglądu', ButtonStyle.Danger));
}

export function reviewButtons(id) {
  return row(button('approve-queue:' + id, 'Zatwierdź dostęp', ButtonStyle.Success),
    button('hold-queue:' + id, 'Wstrzymaj dostęp', ButtonStyle.Danger));
}

export function moderationButtons(id, owner) {
  const rows = [row(
    button('action:ostrzez:' + id, 'Ostrzeż'), button('action:timeout:' + id, 'Ogranicz pisanie'),
    button('action:untimeout:' + id, 'Zdejmij ograniczenie'),
    button('action:wyrzuc:' + id, 'Wyrzuć', ButtonStyle.Danger),
    button('action:zbanuj:' + id, 'Zbanuj', ButtonStyle.Danger),
  ), row(
    button('approve:' + id, 'Zatwierdź dostęp', ButtonStyle.Success),
    button('hold:' + id, 'Wstrzymaj dostęp', ButtonStyle.Danger),
    button('unlock:' + id, 'Odblokuj weryfikację'),
  )];
  if (owner) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(controls + 'role:' + id)
      .setPlaceholder('Nadaj lub zdejmij rangę')
      .addOptions(manualRoles.flatMap(({ name, key }) => [
        { label: 'Nadaj · ' + name, value: 'add:' + key },
        { label: 'Zdejmij · ' + name, value: 'remove:' + key },
      ]))));
  }
  return rows;
}

const input = (id, label, min, max, style = TextInputStyle.Short) =>
  new LabelBuilder().setLabel(label).setTextInputComponent(
    new TextInputBuilder().setCustomId(id).setMinLength(min).setMaxLength(max).setStyle(style).setRequired(true),
  );

export function panelModal(action, key, id) {
  const modal = new ModalBuilder();
  if (action === 'report') {
    return modal.setCustomId(controls + 'send-report').setTitle('Prywatne zgłoszenie')
      .addLabelComponents(input('opis', 'Opisz sytuację i wklej link, jeśli możesz', 5, 1200, TextInputStyle.Paragraph));
  }
  if (action === 'announce') {
    return modal.setCustomId(controls + 'publish:' + key).setTitle(key === 'ogloszenia' ? 'Opublikuj ogłoszenie' : 'Opublikuj wydarzenie')
      .addLabelComponents(input('tytul', 'Tytuł', 1, 120), input('tresc', 'Treść', 1, 1400, TextInputStyle.Paragraph));
  }
  if (action === 'unban') {
    return modal.setCustomId(controls + 'lift-ban').setTitle('Zdejmij ban')
      .addLabelComponents(input('id', 'Identyfikator użytkownika Discord', 17, 20),
        input('powod', 'Powód decyzji', 3, 300, TextInputStyle.Paragraph));
  }
  if (action === 'clear-channel') {
    return modal.setCustomId(controls + 'clear:' + key).setTitle('Podgląd czyszczenia wiadomości')
      .addLabelComponents(input('liczba', 'Ile ostatnich wiadomości sprawdzić (1–100)?', 1, 3));
  }
  modal.setCustomId(controls + 'apply:' + key + ':' + id).setTitle('Potwierdź decyzję moderatora')
    .addLabelComponents(input('powod', 'Powód decyzji', 3, 300, TextInputStyle.Paragraph));
  if (key === 'timeout') modal.addLabelComponents(input('minuty', 'Liczba minut (1–40320)', 1, 5));
  return modal;
}
