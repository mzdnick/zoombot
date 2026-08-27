import { Discord, Slash, ButtonComponent, ModalComponent, Guild } from 'discordx';
import type { CommandInteraction, ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildMember, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import { loadConfig } from '../../config.js';
import { getFreeze, DEFAULT_FREEZE_MESSAGE } from './freeze-state.js';
import { startFreeze, thawFreeze, bannerLink } from './freeze-service.js';

function isAdmin(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function expiryNote(expiresAt: number | null): string {
  return expiresAt ? ` It thaws <t:${Math.floor(expiresAt / 1000)}:R>.` : ' It has no expiration.';
}

@Discord()
@Guild(loadConfig().guildId)
export class FreezeCommands {
  @Slash({
    description: 'Freeze all report activity (admin only)',
    name: 'freeze-reports',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  })
  async freezeReports(interaction: CommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !isAdmin(interaction.member)) {
      await interaction.reply({ content: 'Only admins can manage report freezes.', flags: MessageFlags.Ephemeral });
      return;
    }
    const active = await getFreeze();
    if (active) {
      const config = loadConfig();
      const link = active.bannerMessageId
        ? ` Looking to thaw the freeze? Go here: ${bannerLink(config.guildId, config.reportButtonChannelId, active.bannerMessageId)}`
        : '';
      await interaction.reply({
        content: `A freeze is already active.${expiryNote(active.expiresAt)}${link}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId('freeze_modal')
      .setTitle('Freeze Reports')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Duration in hours (0 = no expiry)')
            .setStyle(TextInputStyle.Short)
            .setValue('24')
            .setRequired(false)
            .setPlaceholder('Hours - 0 or empty means no expiration'),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('message')
            .setLabel('Message')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(DEFAULT_FREEZE_MESSAGE)
            .setRequired(true)
            .setMaxLength(500),
        ),
      );
    await interaction.showModal(modal);
  }

  @ModalComponent({ id: 'freeze_modal' })
  async freezeModal(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !isAdmin(interaction.member)) {
      await interaction.reply({ content: 'Only admins can manage report freezes.', flags: MessageFlags.Ephemeral });
      return;
    }
    const rawDuration = (interaction.fields.getTextInputValue('duration') ?? '').trim();
    const message = interaction.fields.getTextInputValue('message').trim() || DEFAULT_FREEZE_MESSAGE;
    if (rawDuration !== '' && !/^\d+$/.test(rawDuration)) {
      await interaction.reply({ content: 'Duration must be a whole number of hours (or 0 / empty for no expiration).', flags: MessageFlags.Ephemeral });
      return;
    }
    const hours = rawDuration === '' ? 0 : parseInt(rawDuration, 10);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = await startFreeze(interaction.client, { hours, message, initiatedBy: interaction.user.id });
    if (!record) {
      await interaction.editReply({ content: 'A freeze is already active.' });
      return;
    }
    await interaction.editReply({ content: `Reports are now frozen.${expiryNote(record.expiresAt)}` });
  }

  @ButtonComponent({ id: 'freeze_thaw' })
  async thaw(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !isAdmin(interaction.member)) {
      await interaction.reply({ content: 'Only admins can thaw a freeze.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await getFreeze())) {
      await interaction.reply({ content: 'No freeze is active.', flags: MessageFlags.Ephemeral });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('freeze_thaw_confirm').setLabel('Confirm Thaw').setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ content: 'Thaw the freeze now? This re-enables reports immediately.', components: [row], flags: MessageFlags.Ephemeral });
  }

  @ButtonComponent({ id: 'freeze_thaw_confirm' })
  async thawConfirm(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !isAdmin(interaction.member)) {
      await interaction.reply({ content: 'Only admins can thaw a freeze.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    await thawFreeze(interaction.client);
    await interaction.editReply({ content: 'Reports thawed - new reports are welcome again.', components: [] });
  }
}
