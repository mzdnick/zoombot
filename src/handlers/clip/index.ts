import {
  Discord,
  Slash,
  SlashGroup,
  SlashOption,
  SlashChoice,
  ModalComponent,
  Guild,
  ButtonComponent,
  SelectMenuComponent,
} from 'discordx';
import {
  ApplicationCommandOptionType,
  type CommandInteraction,
  type ModalSubmitInteraction,
  type ButtonInteraction,
  type AnySelectMenuInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
} from 'discord.js';
import {
  handleClipRequest,
  downloadOutput,
  getClipConfig,
  getAnonymizationOptions,
  ANONYMIZATION_LABELS,
  ANONYMIZATION_SLASH_CHOICES,
  PASSENGER_REDACTION_LABELS,
  PRS_SLASH_CHOICES,
  UI_ALT_SLASH_CHOICES,
  UI_ALT_VARIANT_LABELS,
  RENDER_TYPE_MAP,
  RENDER_TYPES_WITH_ANONYMIZATION,
  PASSENGER_REDACTION_STYLES,
  PROFILES_REQUIRING_PRS,
  RENDER_TYPE_OPTIONS,
  RENDER_TYPE_LABELS,
  VALID_RENDER_TYPES,
  type ClipJobInput,
} from './clip-service.js';
import { loadConfig } from '../../config.js';
import { COLORS } from '../../util.js';

const MODAL_ID = 'clip_form';
const guildId = loadConfig().guildId;

const URL_OPTION = {
  name: 'url',
  description: 'connect.comma.ai or stable.konik.ai route URL with time range',
  required: true,
  type: ApplicationCommandOptionType.String,
} as const;

const FILE_SIZE_OPTION = {
  name: 'file-size',
  description: 'Target file size in MB (5–200, default: 9)',
  required: false,
  type: ApplicationCommandOptionType.Integer,
} as const;

const INCLUDE_AUDIO_OPTION = {
  name: 'include-audio',
  description: 'Include audio from qcamera (fails if unavailable)',
  required: false,
  type: ApplicationCommandOptionType.Boolean,
} as const;

const ANON_PROFILE_OPTION = {
  name: 'anonymization-profile',
  description: 'Face anonymization for driver camera renders',
  required: false,
  type: ApplicationCommandOptionType.String,
} as const;

const PRS_OPTION = {
  name: 'passenger-redaction-style',
  description: 'How hidden passengers are obscured (blur by default)',
  required: false,
  type: ApplicationCommandOptionType.String,
} as const;

const pendingForm = new Map<string, { input: ClipJobInput; createdAt: number }>();

function setPendingForm(userId: string, input: ClipJobInput) {
  const now = Date.now();
  for (const [k, v] of pendingForm) {
    if (now - v.createdAt > 5 * 60 * 1000) pendingForm.delete(k);
  }
  pendingForm.set(userId, { input, createdAt: now });
}

function getPendingForm(userId: string): ClipJobInput | undefined {
  const entry = pendingForm.get(userId);
  if (!entry) return undefined;
  pendingForm.delete(userId);
  if (Date.now() - entry.createdAt > 5 * 60 * 1000) return undefined;
  return entry.input;
}

function validateAnonymization(profile: string | undefined): string | undefined {
  if (!profile) return undefined;
  const allowed = getAnonymizationOptions(getClipConfig());
  if (!allowed.includes(profile)) return undefined;
  return profile;
}

@Discord()
@Guild(guildId)
@SlashGroup({ description: 'Create replay clips from comma connect routes', name: 'clip' })
@SlashGroup('clip')
export class ClipCommands {

  @Slash({ description: 'Open a form with all clip options', name: 'form' })
  async form(interaction: CommandInteraction) {
    const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Create Clip');

    const urlInput = new TextInputBuilder({
      custom_id: 'clip_url',
      style: TextInputStyle.Short,
      placeholder: 'https://connect.comma.ai/.../start/end or https://stable.konik.ai/.../start/end',
      required: true,
      max_length: 512,
    });
    modal.addLabelComponents(
      new LabelBuilder().setLabel('Route URL').setTextInputComponent(urlInput),
    );

    const rtSelect = new StringSelectMenuBuilder()
      .setCustomId('clip_render_type')
      .setPlaceholder('Select a render type\u2026')
      .setMinValues(1)
      .addOptions(
        ...RENDER_TYPE_OPTIONS.map((o, i) => ({
          label: o.label,
          value: o.key,
          description: o.description,
          default: i === 0,
        })),
      );
    modal.addLabelComponents(
      new LabelBuilder().setLabel('Render Type').setStringSelectMenuComponent(rtSelect),
    );

    const fsInput = new TextInputBuilder({
      custom_id: 'clip_file_size',
      style: TextInputStyle.Short,
      placeholder: '5\u2013200, default: 9',
      required: false,
      max_length: 3,
    });
    modal.addLabelComponents(
      new LabelBuilder().setLabel('File Size (MB)').setTextInputComponent(fsInput),
    );

    const audioSelect = new StringSelectMenuBuilder()
      .setCustomId('clip_audio')
      .setPlaceholder('No')
      .addOptions(
        { label: 'No', value: 'false', default: true },
        { label: 'Yes', value: 'true' },
      );
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Include Audio')
        .setDescription('Copy audio from qcamera')
        .setStringSelectMenuComponent(audioSelect),
    );

    await interaction.showModal(modal);
  }

  @Slash({ description: 'openpilot UI overlay render', name: 'ui' })
  async ui(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'ui',
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Alternate UI composition (requires variant)', name: 'ui-alt' })
  async uiAlt(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashChoice(...UI_ALT_SLASH_CHOICES)
    @SlashOption({
      name: 'variant',
      description: 'UI composition variant',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    variant: string,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'ui-alt',
      uiAltVariant: variant,
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Raw driver camera', name: 'driver-debug' })
  async driverDebug(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashChoice(...ANONYMIZATION_SLASH_CHOICES)
    @SlashOption(ANON_PROFILE_OPTION)
    anonymizationProfile: string | undefined,
    @SlashChoice(...PRS_SLASH_CHOICES)
    @SlashOption(PRS_OPTION)
    passengerRedactionStyle: string | undefined,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'driver-debug',
      anonymizationProfile: validateAnonymization(anonymizationProfile),
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Road camera, fast transcode', name: 'forward' })
  async forward(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'forward',
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Wide-angle camera, fast transcode', name: 'wide' })
  async wide(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'wide',
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Driver camera, fast transcode', name: 'driver' })
  async driver(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashChoice(...ANONYMIZATION_SLASH_CHOICES)
    @SlashOption(ANON_PROFILE_OPTION)
    anonymizationProfile: string | undefined,
    @SlashChoice(...PRS_SLASH_CHOICES)
    @SlashOption(PRS_OPTION)
    passengerRedactionStyle: string | undefined,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'driver',
      anonymizationProfile: validateAnonymization(anonymizationProfile),
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Equirectangular 360\u00b0 sphere', name: '360' })
  async s360(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashChoice(...ANONYMIZATION_SLASH_CHOICES)
    @SlashOption(ANON_PROFILE_OPTION)
    anonymizationProfile: string | undefined,
    @SlashChoice(...PRS_SLASH_CHOICES)
    @SlashOption(PRS_OPTION)
    passengerRedactionStyle: string | undefined,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: '360',
      anonymizationProfile: validateAnonymization(anonymizationProfile),
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: '360\u00b0 with openpilot HUD overlay', name: '360-ui' })
  async s360Ui(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashChoice(...ANONYMIZATION_SLASH_CHOICES)
    @SlashOption(ANON_PROFILE_OPTION)
    anonymizationProfile: string | undefined,
    @SlashChoice(...PRS_SLASH_CHOICES)
    @SlashOption(PRS_OPTION)
    passengerRedactionStyle: string | undefined,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: '360-ui',
      anonymizationProfile: validateAnonymization(anonymizationProfile),
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: 'Forward camera overlaid on wide', name: 'forward-upon-wide' })
  async forwardUponWide(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: 'forward_upon_wide',
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @Slash({ description: '360\u00b0 + forward on wide', name: '360-forward-upon-wide' })
  async s360ForwardUponWide(
    @SlashOption(URL_OPTION)
    url: string,
    @SlashChoice(...ANONYMIZATION_SLASH_CHOICES)
    @SlashOption(ANON_PROFILE_OPTION)
    anonymizationProfile: string | undefined,
    @SlashChoice(...PRS_SLASH_CHOICES)
    @SlashOption(PRS_OPTION)
    passengerRedactionStyle: string | undefined,
    @SlashOption(FILE_SIZE_OPTION)
    fileSize: number | undefined,
    @SlashOption(INCLUDE_AUDIO_OPTION)
    includeAudio: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await handleClipRequest(interaction, {
      route: url,
      renderType: '360_forward_upon_wide',
      anonymizationProfile: validateAnonymization(anonymizationProfile),
      passengerRedactionStyle: passengerRedactionStyle || undefined,
      fileSize,
      includeAudio: includeAudio || undefined,
    });
  }

  @ModalComponent({ id: MODAL_ID })
  async handleFormModal(interaction: ModalSubmitInteraction) {
    const routeUrl = interaction.fields.getTextInputValue('clip_url').trim();
    const rtValues = interaction.fields.getStringSelectValues('clip_render_type');
    const rtRaw = rtValues.length > 0 ? rtValues[0] : 'ui';
    const fsRaw = interaction.fields.getTextInputValue('clip_file_size').trim();
    const audioValues = interaction.fields.getStringSelectValues('clip_audio');
    const includeAudio = audioValues.length > 0 ? audioValues[0] === 'true' : false;

    if (!(VALID_RENDER_TYPES as readonly string[]).includes(rtRaw)) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Invalid Render Type')
        .setDescription(
          `\`${rtRaw}\` is not valid.\n` +
          `Valid types: ${VALID_RENDER_TYPES.map(t => `\`${t}\``).join(', ')}`,
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const renderType = (RENDER_TYPE_MAP as Record<string, string>)[rtRaw];

    const input: ClipJobInput = {
      route: routeUrl,
      renderType,
      includeAudio: includeAudio || undefined,
    };

    if (fsRaw) {
      const size = parseInt(fsRaw, 10);
      if (isNaN(size) || size < 5 || size > 200) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.amber)
          .setTitle('Invalid File Size')
          .setDescription('File size must be a number between 5 and 200 MB.');
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }
      input.fileSize = size;
    }

    if (RENDER_TYPES_WITH_ANONYMIZATION.has(rtRaw)) {
      setPendingForm(interaction.user.id, input);
      const anonOptions = getAnonymizationOptions(getClipConfig());
      const anonSelect = new StringSelectMenuBuilder()
        .setCustomId('clip_followup_anon')
        .setPlaceholder('Select anonymization profile\u2026')
        .setMinValues(1)
        .addOptions(
          ...anonOptions.map(p => ({ label: ANONYMIZATION_LABELS[p], value: p })),
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(anonSelect);
      const embed = new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setTitle('Anonymization Profile')
        .setDescription('Select a face anonymization profile for this render.');
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      return;
    }

    if (rtRaw === 'ui-alt') {
      setPendingForm(interaction.user.id, input);
      const select = new StringSelectMenuBuilder()
        .setCustomId('clip_followup_variant')
        .setPlaceholder('Select a variant\u2026')
        .setMinValues(1)
        .addOptions(
          { label: UI_ALT_VARIANT_LABELS['device'], value: 'device', description: 'Standard device view' },
          { label: UI_ALT_VARIANT_LABELS['stacked_forward_over_wide'], value: 'stacked_forward_over_wide', description: 'Forward on top, wide below' },
          { label: UI_ALT_VARIANT_LABELS['stacked_wide_over_forward'], value: 'stacked_wide_over_forward', description: 'Wide on top, forward below' },
          { label: UI_ALT_VARIANT_LABELS['stacked_device_over_driver'], value: 'stacked_device_over_driver', description: 'Device view on top, driver camera below' },
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      const embed = new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setTitle('Choose Variant')
        .setDescription('Select a UI Alt composition variant.');
      await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      return;
    }

    await handleClipRequest(interaction, input);
  }

  @SelectMenuComponent({ id: 'clip_followup_anon' })
  async handleAnonSelect(interaction: AnySelectMenuInteraction) {
    const input = getPendingForm(interaction.user.id);
    if (!input) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Form Expired')
        .setDescription('Your previous form data expired. Please start over with `/clip form`.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const [profile] = interaction.values;
    if (profile && profile !== 'none') {
      input.anonymizationProfile = profile;

      const needsPrs = PROFILES_REQUIRING_PRS.has(profile);
      if (needsPrs) {
        setPendingForm(interaction.user.id, input);
        const prsSelect = new StringSelectMenuBuilder()
          .setCustomId('clip_followup_prs')
          .setPlaceholder('Blur (default)')
          .addOptions(
            ...PASSENGER_REDACTION_STYLES.map(s => ({ label: PASSENGER_REDACTION_LABELS[s], value: s })),
          );
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(prsSelect);
        const embed = new EmbedBuilder()
          .setColor(COLORS.blurple)
          .setTitle('Passenger Redaction Style')
          .setDescription('Choose how hidden passengers are obscured.');
        await interaction.update({ embeds: [embed], components: [row] });
        return;
      }
    }

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip\u2026')],
      components: [],
    });
    await handleClipRequest(interaction, input);
  }

  @SelectMenuComponent({ id: 'clip_followup_prs' })
  async handlePrsSelect(interaction: AnySelectMenuInteraction) {
    const input = getPendingForm(interaction.user.id);
    if (!input) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Form Expired')
        .setDescription('Your previous form data expired. Please start over with `/clip form`.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const [style] = interaction.values;
    if (style) input.passengerRedactionStyle = style;

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip\u2026')],
      components: [],
    });
    await handleClipRequest(interaction, input);
  }

  @SelectMenuComponent({ id: 'clip_followup_variant' })
  async handleVariantSelect(interaction: AnySelectMenuInteraction) {
    const input = getPendingForm(interaction.user.id);
    if (!input) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Form Expired')
        .setDescription('Your previous form data expired. Please start over with `/clip form`.');
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const [variant] = interaction.values;
    if (variant) input.uiAltVariant = variant;

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip\u2026')],
      components: [],
    });
    await handleClipRequest(interaction, input);
  }

  @ButtonComponent({ id: /^clip_pub_/ })
  async publishClip(interaction: ButtonInteraction) {
    await interaction.deferUpdate();

    const customIdParts = interaction.customId.slice('clip_pub_'.length).split(':');
    const jobId = customIdParts[0];
    const renderType = customIdParts[1];
    const config = getClipConfig();

    if (!config) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLORS.amber).setTitle('Service Unavailable').setDescription('Clip service is not configured.')],
        components: [],
      });
      return;
    }

    let data: ArrayBuffer;
    try {
      data = await downloadOutput(config, jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(COLORS.amber).setTitle('Clip Expired').setDescription(msg)],
        components: [],
      });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isSendable()) {
      await interaction.editReply({ content: 'Cannot send messages in this channel.', components: [] });
      return;
    }

    const attachment = new AttachmentBuilder(Buffer.from(data), { name: 'clip.mp4' });
    const friendlyType = renderType ? (RENDER_TYPE_LABELS[renderType] ?? renderType) : null;
    const content = friendlyType
      ? `Clip shared by <@${interaction.user.id}>\n-# Render Type: \`${friendlyType}\``
      : `Clip shared by <@${interaction.user.id}>`;
    await channel.send({ content, files: [attachment] });

    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLORS.green).setTitle('Published').setDescription('Your clip has been shared in the channel.')],
      components: [],
      attachments: [],
    });
  }
}
