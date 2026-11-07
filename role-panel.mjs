import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { roleMenus, roles } from './plan.mjs';

export const menuPrefix = 'community-roles:';
export const clearRole = 'clear';

export function makeRolePanel() {
  return roleMenus.map((group) => {
    const options = roles.filter((role) => role.group === group.key)
      .map((role) => ({ label: role.name, value: role.key, ...(role.emoji ? { emoji: { name: role.emoji } } : {}) }));
    options.push({ label: 'Bez roli', value: clearRole, emoji: { name: '➖' } });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(menuPrefix + group.key)
      .setPlaceholder(group.label)
      .setMinValues(1)
      .setMaxValues(group.multiple ? options.length - 1 : 1)
      .addOptions(options);
    return new ActionRowBuilder().addComponents(menu);
  });
}
