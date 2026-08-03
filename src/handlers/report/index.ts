import { Discord, ButtonComponent, ModalComponent, ContextMenu, Guild } from 'discordx';
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import {
  ModalBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ApplicationCommandType,
} from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { COLORS } from '../../util.js';
import {
  parseRouteComponents,
  parseRouteField,
  extractRouteIds,
  replaceRouteIds,
  validateRoute,
  type RouteComponents,
  type ExtractedRoute,
  type RouteValidation,
  type RlogCheckResult,
} from '../../comma.js';
import {
  routeNumberLabel,
  parseConfirmCustomId,
  handleRefreshRoutes,
  createRouteTrackerThread,
  addAdditionalRoutesToTracker,
  TRACKER_FIELD_PREFIX,
} from './route-tracker.js';
import {
  submitReport,
} from './report-service.js';
import { titleGenerator } from './title-generator.js';
import { konikViewerUrl } from '../../konik.js';

const log = createLogger('report');

function rlogFailureMessage(check: RlogCheckResult): string {
  if (check.mode === 'whole') {
    return 'All the logs must be uploaded. If you only have a few moments in the route to review, please use a route link / ID that is segmented.';
  }
  const segList = check.missing.join(', ');
  const noun = check.missing.length === 1 ? 'segment' : 'segments';
  return `The rlogs for ${noun} **${segList}** don't appear to be uploaded yet. Please upload the logs for ${noun} **${segList}** from your device, then check again.`;
}

interface BugReportInput {
  routeIdInput: string;
  observed: string;
  expected: string;
  reproIntent: string;
}

interface PendingBugReport extends BugReportInput {
  reporterId: string;
  actingUserId: string;
}

const PENDING_BUG_TTL_MS = 15 * 60 * 1000;
const pendingStore = createStore<PendingBugReport>('pending-bug-reports', { ttl: PENDING_BUG_TTL_MS });

const gateTokensInFlight = new Set<string>();

function reporterFromModalId(interaction: ModalSubmitInteraction): string {
  const match = interaction.customId.match(/_obo_(\d+)$/);
  return match ? match[1] : interaction.user.id;
}

@Discord()
export class BotReport {
  @ButtonComponent({ id: 'report_bug' })
  async bug(interaction: ButtonInteraction) {
    await showBugModal(interaction);
  }

  @ButtonComponent({ id: 'report_feedback' })
  async feedback(interaction: ButtonInteraction) {
    await showFeedbackModal(interaction, 'Feedback');
  }

  @ButtonComponent({ id: 'report_feature' })
  async feature(interaction: ButtonInteraction) {
    await showFeedbackModal(interaction, 'Feature Request');
  }

  @ButtonComponent({ id: /^cr_/ })
  async confirmRoute(interaction: ButtonInteraction) {
    await handleConfirmRoute(interaction);
  }

  @ButtonComponent({ id: /^rlogchk_/ })
  async rlogRecheck(interaction: ButtonInteraction) {
    await handleRlogGateButton(interaction, false);
  }

  @ButtonComponent({ id: /^rlogfrc_/ })
  async rlogForceProceed(interaction: ButtonInteraction) {
    await handleRlogGateButton(interaction, true);
  }

  @ButtonComponent({ id: 'refresh_routes' })
  async refreshRoutes(interaction: ButtonInteraction) {
    await handleRefreshRoutes(interaction);
  }

  @ModalComponent({ id: /^bug_modal/ })
  async bugModal(interaction: ModalSubmitInteraction) {
    await handleBugSubmit(interaction);
  }

  @ModalComponent({ id: /^feedback_modal/ })
  async feedbackModal(interaction: ModalSubmitInteraction) {
    await handleFeedbackSubmit(interaction, 'feedback');
  }

  @ModalComponent({ id: /^feature_modal/ })
  async featureModal(interaction: ModalSubmitInteraction) {
    await handleFeedbackSubmit(interaction, 'feature');
  }
}

@Discord()
export class BotReportOnBehalf {
  @ContextMenu({
    name: 'Open Report On Behalf Of',
    type: ApplicationCommandType.User,
    defaultMemberPermissions: PermissionFlagsBits.ManageThreads,
  })
  @Guild(loadConfig().guildId)
  async openOnBehalf(interaction: UserContextMenuCommandInteraction) {
    const target = interaction.targetUser;
    if (target.bot) {
      await interaction.reply({ content: "You can't open a report on behalf of a bot.", flags: MessageFlags.Ephemeral });
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`obo_bug_${target.id}`).setLabel('Bug Report').setStyle(ButtonStyle.Primary).setEmoji('🐛'),
      new ButtonBuilder().setCustomId(`obo_feedback_${target.id}`).setLabel('Feedback').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
      new ButtonBuilder().setCustomId(`obo_feature_${target.id}`).setLabel('Feature Request').setStyle(ButtonStyle.Success).setEmoji('✨'),
    );
    await interaction.reply({
      content: `Open a report on behalf of <@${target.id}>. Choose the type - they'll be credited as the reporter and pinged in the thread.`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  @ButtonComponent({ id: /^obo_/ })
  async oboChoice(interaction: ButtonInteraction) {
    const [, type, targetId] = interaction.customId.split('_');
    if (type === 'bug') {
      await showBugModal(interaction, targetId);
    } else if (type === 'feedback') {
      await showFeedbackModal(interaction, 'Feedback', targetId);
    } else if (type === 'feature') {
      await showFeedbackModal(interaction, 'Feature Request', targetId);
    } else {
      await interaction.reply({ content: 'Unknown report type.', flags: MessageFlags.Ephemeral });
    }
  }
}

async function showBugModal(interaction: ButtonInteraction, onBehalfOf?: string) {
  const modal = new ModalBuilder()
    .setCustomId(onBehalfOf ? `bug_modal_obo_${onBehalfOf}` : 'bug_modal')
    .setTitle(onBehalfOf ? 'Bug Report (On Behalf Of)' : 'Submit Bug Report');

  const routeIdInput = new TextInputBuilder({
    custom_id: 'route_id',
    style: TextInputStyle.Short,
    placeholder: 'dongle_id/route_name, connect.comma.ai, or stable.konik.ai URL',
    required: true,
    max_length: 256,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Route ID').setDescription('Visible only to server admins').setTextInputComponent(routeIdInput));

  const observedInput = new TextInputBuilder({
    custom_id: 'observed',
    style: TextInputStyle.Paragraph,
    placeholder: 'What happened?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Observed Behavior').setTextInputComponent(observedInput));

  const expectedInput = new TextInputBuilder({
    custom_id: 'expected',
    style: TextInputStyle.Paragraph,
    placeholder: 'What should have happened?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Expected Behavior').setTextInputComponent(expectedInput));

  const reproIntentInput = new TextInputBuilder({
    custom_id: 'reproducibility_intent',
    style: TextInputStyle.Paragraph,
    placeholder: 'Can you reproduce it? What is your ideal outcome? Any additional details?',
    required: true,
    min_length: 10,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Reproducibility, Intent & Details').setTextInputComponent(reproIntentInput));

  await interaction.showModal(modal);
}

async function showFeedbackModal(interaction: ButtonInteraction, type: string, onBehalfOf?: string) {
  const base = type === 'Feedback' ? 'feedback_modal' : 'feature_modal';
  const modal = new ModalBuilder()
    .setCustomId(onBehalfOf ? `${base}_obo_${onBehalfOf}` : base)
    .setTitle(type === 'Feedback' ? 'Submit Feedback' : 'Submit Feature Request');

  const input = new TextInputBuilder({
    custom_id: 'content',
    style: TextInputStyle.Paragraph,
    placeholder: `Tell us about your ${type.toLowerCase()}...`,
    required: true,
    min_length: 10,
    max_length: 2000,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Your Thoughts').setTextInputComponent(input));

  await interaction.showModal(modal);
}

async function handleBugSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reporterId = reporterFromModalId(interaction);

  const input: BugReportInput = {
    routeIdInput: interaction.fields.getTextInputValue('route_id').trim(),
    observed: interaction.fields.getTextInputValue('observed').trim(),
    expected: interaction.fields.getTextInputValue('expected').trim(),
    reproIntent: interaction.fields.getTextInputValue('reproducibility_intent').trim(),
  };

  log.info({
    userId: interaction.user.id,
    reporterId,
    onBehalf: reporterId !== interaction.user.id,
    type: 'bug',
    route: input.routeIdInput,
    observed: input.observed,
    expected: input.expected,
    reproIntent: input.reproIntent,
  }, 'Bug report submitted');

  await processBugReport(interaction, input, false, reporterId);
}

async function processBugReport(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  input: BugReportInput,
  force: boolean,
  reporterId: string,
): Promise<void> {
  const { routeIdInput, observed, expected, reproIntent } = input;

  const llmContent =
    `[Observed Behavior]\n${observed}\n\n` +
    `[Expected Behavior]\n${expected}\n\n` +
    `[Reproducibility, Intent & Details]\n${reproIntent}`;
  const titlePromise = titleGenerator.generate('Bug Report', llmContent, observed);

  const field = parseRouteField(routeIdInput);
  if (!field) {
    let message = 'Use the format `dongle_id/route_name`, a connect.comma.ai URL, or a stable.konik.ai URL.';
    try {
      parseRouteComponents(routeIdInput);
    } catch (err) {
      if (err instanceof Error) message = err.message;
    }
    await interaction.editReply({
      content: `Invalid route ID. You entered:\n\`${routeIdInput}\`\n\n${message}`,
    });
    return;
  }

  const components: RouteComponents = field.primary;
  const primaryRoute = field.routes[0];
  const dedicatedRoute: ExtractedRoute = {
    dongleId: components.dongleId,
    routeName: components.routeName,
    iteration: components.iteration,
    originalText: primaryRoute.originalText,
    isUrl: primaryRoute.isUrl,
    provider: components.provider,
  };

  const allRoutes: ExtractedRoute[] = [dedicatedRoute];
  const seenKeys = new Set<string>([(primaryRoute.originalText ?? '').toLowerCase()]);
  const allText = [observed, expected, reproIntent].join('\n');
  for (const r of [...field.routes.slice(1), ...extractRouteIds(allText)]) {
    const key = (r.originalText ?? '').toLowerCase();
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      allRoutes.push(r);
    }
  }

  const validations = await Promise.all(
    allRoutes.map((r, i) =>
      i === 0
        ? validateRoute(r.dongleId, r.routeName, components.startSegment, components.endSegment, r.provider)
        : validateRoute(r.dongleId, r.routeName, undefined, undefined, r.provider),
    ),
  );
  const validatedRoutes = allRoutes.map((r, i) => ({ ...r, ...validations[i] }));
  const dedicatedValidated = validatedRoutes[0];

  if (!dedicatedValidated.valid) {
    await interaction.editReply({
      content: `The route you entered doesn't appear to exist:\n\`${routeIdInput}\`\n\nPlease double-check the Route ID and try again.`,
    });
    return;
  }

  if (!force && dedicatedValidated.public && dedicatedValidated.rlogCheck && !dedicatedValidated.rlogsAvailable) {
    const token = interaction.id;
    await pendingStore.set(token, { ...input, reporterId, actingUserId: interaction.user.id });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rlogchk_${token}`)
        .setLabel('Check Again')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('\uD83D\uDD04'),
      new ButtonBuilder()
        .setLabel('Need help?')
        .setStyle(ButtonStyle.Link)
        .setURL('https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting'),
      new ButtonBuilder()
        .setCustomId(`rlogfrc_${token}`)
        .setLabel("I know what I'm doing, submit anyway")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({ content: rlogFailureMessage(dedicatedValidated.rlogCheck), components: [row] });
    return;
  }

  const numberedAdditional = validatedRoutes.slice(1).map((r, i) => ({ ...r, routeNumber: i + 1 }));

  const replacementRoutes: ExtractedRoute[] = [dedicatedValidated, ...numberedAdditional];
  const cleanObserved = replaceRouteIds(observed, replacementRoutes, routeNumberLabel);
  const cleanExpected = replaceRouteIds(expected, replacementRoutes, routeNumberLabel);
  const cleanReproIntent = replaceRouteIds(reproIntent, replacementRoutes, routeNumberLabel);

  const reportEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .addFields(
      { name: 'By', value: `<@${reporterId}>`, inline: true },
      { name: 'Observed Behavior', value: cleanObserved || '—' },
      { name: 'Expected Behavior', value: cleanExpected || '—' },
      { name: 'Reproducibility, Intent & Details', value: cleanReproIntent || '—' },
    )
    .setTimestamp();

  const primaryNonPublic = dedicatedValidated.valid && !dedicatedValidated.public ? dedicatedValidated : undefined;

  await submitReport(interaction, {
    embed: reportEmbed,
    title: titlePromise,
    wikiQuery: `${cleanObserved} ${cleanExpected} ${cleanReproIntent}`,
    dedicatedRoute: dedicatedValidated,
    additionalRoutes: numberedAdditional,
    label: 'Bug Report',
    tagNames: ['OPEN', 'BUG', 'WAITING FOR DEV'],
    primaryNonPublicRoute: primaryNonPublic,
    footerNote: ' with ticket ID / wiki / route link',
    reporterId,
  });
}

async function handleRlogGateButton(interaction: ButtonInteraction, force: boolean): Promise<void> {
  const token = interaction.customId.split('_')[1];

  if (gateTokensInFlight.has(token)) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  gateTokensInFlight.add(token);
  try {
    const pending = await pendingStore.get(token);
    if (!pending) {
      await interaction.reply({
        content: 'This request has expired. Please submit a new bug report.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== pending.actingUserId) {
      await interaction.reply({
        content: 'Only the person who started this report can use these buttons.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferUpdate();
    await processBugReport(interaction, pending, force, pending.reporterId);
  } finally {
    gateTokensInFlight.delete(token);
  }
}

async function handleConfirmRoute(interaction: ButtonInteraction) {
  const parsed = parseConfirmCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: 'Invalid or expired confirmation button.', flags: MessageFlags.Ephemeral });
    return;
  }

  const { ticketId, userId, dongleId, routeName, provider, iteration } = parsed;

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'Only the original reporter can confirm the route.', flags: MessageFlags.Ephemeral });
    return;
  }

  const routeUrl = provider === 'konik'
    ? konikViewerUrl(dongleId, routeName)
    : `https://connect.comma.ai/${dongleId}/${routeName}`;
  const platformName = provider === 'konik' ? 'stable.konik.ai' : 'connect.comma.ai';

  const confirmCheck = await validateRoute(dongleId, routeName, undefined, undefined, provider);
  const nowPublic = confirmCheck.public;

  const thread = interaction.channel;
  if (!thread || !thread.isThread()) {
    await interaction.reply({ content: 'This button can only be used from the report thread.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!nowPublic) {
    await interaction.reply({
      content: `Your route is still not public. Make sure it's accessible on [${platformName}](${routeUrl}) and try again.\n\nFollow [these instructions](<https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting>) to make your route public.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const config = loadConfig();

  const starter = await thread.fetchStarterMessage();
  if (!starter) {
    await interaction.reply({ content: 'Could not find the report starter message.', flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = starter.embeds[0];
  if (!embed) {
    await interaction.reply({ content: 'Could not find the report embed.', flags: MessageFlags.Ephemeral });
    return;
  }

  const updated = EmbedBuilder.from(embed);

  const guild = interaction.guild;
  let routesThreadUrl: string | null = null;
  if (guild) {
    const route = { dongleId, routeName, iteration, provider, public: true, rlogsAvailable: confirmCheck.rlogsAvailable };
    const existingUrl = embed.fields?.find(f => f.value?.startsWith(TRACKER_FIELD_PREFIX))?.value?.match(/\]\((.+?)\)/)?.[1];
    const existingId = existingUrl?.split('/').pop();
    if (existingUrl && existingId) {
      await addAdditionalRoutesToTracker(guild, existingId, [route]);
      routesThreadUrl = existingUrl;
    } else {
      const result = await createRouteTrackerThread(guild, config, route, thread.url, thread.name);
      if (result) {
        routesThreadUrl = result.url;
        updated.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${result.url})` });
      }
    }
  }

  await starter.edit({ embeds: [updated] });

  const content = `\u2705 Route confirmed and linked to **${ticketId}**.${routesThreadUrl ? ` [Mods Route Tracker \u2192](${routesThreadUrl})` : ''}`;
  await interaction.update({ content, components: [] });
}

async function handleFeedbackSubmit(interaction: ModalSubmitInteraction, type: 'feedback' | 'feature') {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const reporterId = reporterFromModalId(interaction);
  const content = interaction.fields.getTextInputValue('content');

  const label = type === 'feedback' ? 'Feedback' : 'Feature Request';

  const titlePromise = titleGenerator.generate(label, content, content);

  log.info({
    userId: interaction.user.id,
    reporterId,
    onBehalf: reporterId !== interaction.user.id,
    type,
    content,
  }, `${label} submitted`);

  const routes = extractRouteIds(content);
  const validatedRoutes: Array<ExtractedRoute & RouteValidation> = [];
  for (const v of await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName, undefined, undefined, r.provider)))) {
    validatedRoutes.push({ ...routes[validatedRoutes.length], ...v });
  }
  const numberedRoutes = validatedRoutes.map((r, i) => ({ ...r, routeNumber: i + 1 }));
  const cleanContent = replaceRouteIds(content, numberedRoutes, routeNumberLabel);

  const embed = new EmbedBuilder()
    .setColor(type === 'feedback' ? COLORS.green : COLORS.blurple)
    .setTitle(label)
    .setDescription(cleanContent.length > 4096 ? cleanContent.slice(0, 4093) + '...' : cleanContent)
    .addFields({ name: 'By', value: `<@${reporterId}>`, inline: true })
    .setTimestamp();

  await submitReport(interaction, {
    embed,
    title: titlePromise,
    wikiQuery: cleanContent,
    additionalRoutes: numberedRoutes,
    label,
    tagNames: type === 'feedback' ? ['OPEN', 'FEEDBACK', 'WAITING FOR DEV'] : ['OPEN', 'FEATURE REQUEST', 'WAITING FOR DEV'],
    reporterId,
  });
}
