import { Discord, ButtonComponent, ModalComponent } from 'discordx';
import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  MessageFlags,
} from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('identification');

@Discord()
export class BotIdentification {
  @ButtonComponent({ id: 'set_identity' })
  async identity(interaction: ButtonInteraction) {
    const modal = new ModalBuilder()
      .setCustomId('identity_modal')
      .setTitle('Set Your Nickname');

    const yearInput = new TextInputBuilder({
      custom_id: 'identity_year',
      style: TextInputStyle.Short,
      placeholder: 'e.g. 2024',
      required: true,
      max_length: 4,
      min_length: 4,
    });
    modal.addLabelComponents(new LabelBuilder().setLabel('Year').setTextInputComponent(yearInput));

    const modelInput = new TextInputBuilder({
      custom_id: 'identity_model',
      style: TextInputStyle.Short,
      placeholder: 'e.g. Bolt, Model 3, F-150',
      required: true,
      max_length: 30,
    });
    modal.addLabelComponents(new LabelBuilder().setLabel('Model').setTextInputComponent(modelInput));

    const nicknameInput = new TextInputBuilder({
      custom_id: 'identity_nickname',
      style: TextInputStyle.Short,
      placeholder: 'e.g. CoolPilot42',
      required: false,
      max_length: 30,
    });
    modal.addLabelComponents(new LabelBuilder().setLabel('Nickname (optional)').setTextInputComponent(nicknameInput));

    await interaction.showModal(modal);
  }

  @ModalComponent({ id: 'identity_modal' })
  async identitySubmit(interaction: ModalSubmitInteraction) {
    const config = loadConfig();
    const nicknameRaw = interaction.fields.getTextInputValue('identity_nickname');
    const year = interaction.fields.getTextInputValue('identity_year');
    const model = interaction.fields.getTextInputValue('identity_model');

    // Nickname + role changes are three REST calls. Defer first so a slow host
    // still answers inside the 3-second interaction window (10062 otherwise).
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!/^\d{4}$/.test(year)) {
      await interaction.editReply({ content: 'Please enter a valid 4-digit year.' });
      return;
    }

    const baseName = (nicknameRaw || interaction.user.username).trim();
    const yearShort = year.slice(-2);
    let nickname = `${baseName} ('${yearShort} ${model})`;
    if (nickname.length > 32) {
      nickname = nickname.slice(0, 31) + ')';
    }

    if (!(interaction.member instanceof GuildMember)) {
      await interaction.editReply({ content: 'Could not identify your member record.' });
      return;
    }

    try {
      await interaction.member.setNickname(nickname);
    } catch {
      await interaction.editReply({
        content: 'Failed to set nickname. Make sure the bot has **Manage Nicknames** permission and its role is above yours in the server settings.',
      });
      return;
    }

    try {
      await interaction.member.roles.add(config.verifiedRole);
    } catch (err) {
      log.error({ err }, 'Failed to assign verified role');
      await interaction.editReply({
        content: `Nickname set to **${nickname}**, but I couldn't assign the verified role. Make sure the bot has **Manage Roles** permission and its role is above yours.`,
      });
      return;
    }

    try {
      await interaction.member.roles.remove(config.pendingRole);
    } catch (err) {
      log.error({ err }, 'Failed to remove pending role');
    }

    await interaction.editReply({ content: `Nickname set to **${nickname}**` });
  }
}
