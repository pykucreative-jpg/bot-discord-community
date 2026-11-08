import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { roleMenus, roles } from './plan.mjs';

export const menuPrefix = 'community-roles:';
export const clearRole = 'clear';

export function makeRolePanel() {
  return roleMenus.map((group) => {
    const options = roles.filter((role) => role.group === group.key)
      .map((role) => ({ label: role.name, value: role.key, ...(role.emoji ? { emoji: { name: role.emoji } } : {}) }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(menuPrefix + group.key)
      .setPlaceholder(group.label)
      .setMinValues(1)
      .setMaxValues(group.multiple ? options.length : 1)
      .addOptions(options);
    return new ActionRowBuilder().addComponents(menu);
  });
}

export async function refreshRoleMenu(guild, state) {
  if (!state.channels['wybierz-role'] || !state.messages['wybierz-role']) return;
  const channel = await guild.channels.fetch(state.channels['wybierz-role']);
  const message = await channel?.messages.fetch({ message: state.messages['wybierz-role'] });
  if (message?.author.id !== guild.client.user.id || !message.components.some(({ components }) =>
    components.some((component) => component.options?.some(({ value }) => value === clearRole)))) return;
  await message.edit({ components: makeRolePanel() });
  console.log('Usunięto opcję Bez roli z panelu wyboru ról.');
}
