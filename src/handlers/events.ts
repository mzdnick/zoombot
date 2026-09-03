import { Client, Discord, Once, On, ArgsOf, Guard } from 'discordx';
import {
  Events,
  ButtonStyle,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
} from 'discord.js';
import { readFileSync } from 'fs';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWikiPages } from '../wiki/fetcher.js';
import { buildIndex } from '../wiki/indexer.js';
import { setIndex, setInitFailed, getInitStatus, getIndex } from '../wiki/wiki.js';
import { searchWiki, formatWikiResults } from '../wiki/searcher.js';
import { WikiRateLimit } from './guards.js';
import { initTitleSync } from './report/title-sync.js';
import { initCloseScheduler } from './report/close-scheduler.js';
import { initSnoozeScheduler } from './report/snooze-scheduler.js';
import { initDormantScheduler } from './report/dormant-scheduler.js';
import { recoverFreeze } from './report/freeze-service.js';
import { getFreeze } from './report/freeze-state.js';
import { COLORS } from '../util.js';

const log = createLogger('events');

function getCommitHash(): string | null {
  try {
    const head = readFileSync('.git/HEAD', 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = '.git/' + head.slice(5);
      return readFileSync(refPath, 'utf-8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return null;
  }
}

@Discord()
export class BotEvents {
  @Once({ event: Events.ClientReady })
  async ready([client]: ArgsOf<Events.ClientReady>) {
    const config = loadConfig();

    log.info(`Logged in as ${client.user!.tag}`);

    const client_ = client as Client;
    try {
      await client_.initApplicationCommands();
    } catch (err) {
      log.error({ err }, 'Failed to init application commands');
    }

    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      log.error(`Guild ${config.guildId} not found`);
      return;
    }

    await this.ensureButtonMessage(
      guild, config.identificationChannelId,
      [
        { label: 'Set Nickname & Vehicle', customId: 'set_identity', style: ButtonStyle.Primary, emoji: '🎭' },
      ],
      'Welcome to **StarPilot Server**! To gain access to the rest of the community, please set your server nickname and register your primary vehicle.\n\nYou can click this button at any time to update your vehicle or name in the future.',
    ).catch(err => log.error({ err }, 'Failed to set up identification button'));

    await recoverFreeze(client);
    const frozen = await getFreeze();

    await this.ensureButtonMessage(
      guild, config.reportButtonChannelId,
      [
        { label: 'Bug Report', customId: 'report_bug', style: ButtonStyle.Primary, emoji: '🐛' },
        { label: 'Feedback', customId: 'report_feedback', style: ButtonStyle.Secondary, emoji: '💬' },
        { label: 'Feature Request', customId: 'report_feature', style: ButtonStyle.Success, emoji: '✨' },
        { label: 'View My Reports', customId: 'view_my_reports', style: ButtonStyle.Primary, emoji: '📋' },
      ],
      undefined,
      [
        new EmbedBuilder()
          .setDescription(
            '## ✨ Before You Submit...\n\n' +
            `**Note:** <#${config.forumChannelId}> serves as the official to-do list and triage queue for maintainers. To keep things manageable, actionable, and to reduce notification fatigue, please follow these guidelines before hitting submit.\n\n` +
              '### 🐛 Bug Reports\n\n' +
              '- **Fully Investigate First:** Ensure you have thoroughly tested and verified the bug before posting.\n' +
              '- **Actionable Items Only:** Do not submit reports that end with "more investigation is required on my end." If you are still troubleshooting, hold off on submitting until you have the final, concrete details.\n' +
              '- **Consolidate Your Thoughts:** Avoid treating reports like a live scratchpad. Gather all your findings into a single, comprehensive submission to avoid spamming the channel with self-corrections and stream-of-consciousness updates.\n\n' +
              '### 🎯 One Issue Per Ticket\n\n' +
              '- **Keep It Scoped:** Each report should cover a single issue, or a tightly related set of issues that share the same root cause or logical thread.\n' +
              '- **Why?** Combined reports make it harder to track, prioritize, and close individual problems. If you have multiple unrelated bugs or ideas, please submit them separately.\n\n' +
              '### 💡 Feature Requests & PRs\n\n' +
              '**Requests vs. Development:** Feature requests are designed to suggest ideas for the maintainers to review and potentially build.\n\n' +
              `**Developing it yourself?** We absolutely love contributors and think it is awesome when you want to tackle a feature. If you plan to build it yourself, there is no need to open a feature request here. Instead, jump over to <#${config.developmentChannelId}> and start a thread. We are always happy to provide feedback, help troubleshoot problems, and cheer you on there!\n\n` +
              '### 🆘 Route Logs!?\n\n' +
              'A quick overview of routes and how to upload logs can be found [here](https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting): https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting',
          )
          .setColor(5822093),
        new EmbedBuilder()
          .setDescription(
            '## 📝 Submit a Report\n\n' +
            'Encountered an issue with navigation? Have an idea for a new feature? Let us know!\n\n' +
              `> **Bug reports** _require_ a public **route ID** - visible only to <@&${config.staffRole}>`,
          )
          .setColor(5822093),
      ],
      frozen ? ['report_bug', 'report_feedback', 'report_feature'] : undefined,
    ).catch(err => log.error({ err }, 'Failed to set up report button'));

    // Initialize wiki search
    try {
      const wikiPages = await fetchWikiPages(config.wikiRepo, config.wikiCacheDir);
      if (wikiPages.length > 0) {
        const idx = await buildIndex(wikiPages, config.wikiCacheDir);
        setIndex(idx);
        log.info(`Wiki initialized with ${wikiPages.length} pages`);
      } else {
        log.info('Wiki fetch returned no pages');
        setInitFailed();
      }
    } catch (err) {
      log.error({ err }, 'Failed to initialize wiki');
      setInitFailed();
    }

    const status = getInitStatus();
    log.info(`Wiki status: ${status}`);
    log.info('StarPilot bot is ready');

    initTitleSync(client);
    initCloseScheduler(client);
    initSnoozeScheduler(client);
    initDormantScheduler(client);

    const commitHash = getCommitHash();
    if (commitHash) {
      client.user!.setActivity({ name: commitHash, type: ActivityType.Watching });
    }
  }

  @On({ event: Events.InteractionCreate })
  async interactionCreate([interaction]: ArgsOf<Events.InteractionCreate>) {
    const client = interaction.client as Client;
    client.executeInteraction(interaction);
  }

  @On({ event: Events.MessageCreate })
  @Guard(WikiRateLimit)
  async messageCreate([message]: ArgsOf<Events.MessageCreate>) {
    if (message.reference?.messageId) {
      try {
        const referenced = await message.channel.messages.fetch(message.reference.messageId);
        if (referenced.author.id === message.client.user!.id && referenced.content.startsWith('Clip shared by')) {
          return;
        }
      } catch { /* referenced message may not be accessible */ }
    }

    const query = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!query) {
      await message.reply('Mention me with a question to search the wiki.');
      return;
    }

    const index = getIndex();
    if (!index) {
      const status = getInitStatus();
      if (status === 'failed') {
        await message.reply('Wiki search is currently unavailable (initialization failed). Please try again later.');
      } else if (status === 'not_started') {
        await message.reply('Wiki search is still loading. Please try again in a moment.');
      } else {
        await message.reply('Wiki search is not available right now.');
      }
      return;
    }

    const reactionEmoji = '⏳';
    let reactionAdded = false;
    try {
      await message.react(reactionEmoji);
      reactionAdded = true;
    } catch (err) { log.warn({ err }, 'Failed to add reaction'); }

    try {
      const results = await searchWiki(index, query);
      if (results.length > 0) {
        const embed = new EmbedBuilder()
          .setTitle('📖 Wiki Results')
          .setDescription(formatWikiResults(results))
          .setColor(COLORS.blurple)
          .setTimestamp();
        await message.reply({ embeds: [embed] });
      } else {
        await message.reply("I couldn't find a relevant wiki page.");
      }
    } catch (err) {
      log.error({ err }, 'Wiki search error');
      await message.reply('Something went wrong while searching the wiki.');
    } finally {
      if (reactionAdded) {
        try {
          const reaction = message.reactions.cache.get(reactionEmoji);
          if (reaction) await reaction.users.remove(message.client.user!.id);
        } catch (err) { log.warn({ err }, 'Failed to remove reaction'); }
      }
    }
  }

  private async ensureButtonMessage(
    guild: import('discord.js').Guild,
    channelId: string,
    buttons: Array<{ label: string; customId: string; style: ButtonStyle; emoji: string }>,
    content?: string,
    embeds?: EmbedBuilder[],
    disabledButtonIds?: string[],
  ) {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      log.error(`Channel ${channelId} not found or not text-based`);
      return;
    }

    try {
      const { items } = await channel.messages.fetchPins();
      const existing = items.find(
        ({ message: m }) => m.author.id === guild.client.user!.id && m.components.length > 0,
      );
      if (existing) return;
    } catch (err) { log.warn({ err }, 'Failed to fetch pinned messages'); }

    const message = await channel.send({
      content,
      embeds,
      components: [this.buttonRow(buttons, disabledButtonIds)],
    });
    await message.pin().catch(err => log.error({ err }, 'Failed to pin button'));
  }

  private buttonRow(buttons: Array<{ label: string; customId: string; style: ButtonStyle; emoji: string }>, disabledButtonIds?: string[]) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...buttons.map(b =>
        new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(b.style).setEmoji(b.emoji)
          .setDisabled(disabledButtonIds?.includes(b.customId) ?? false),
      ),
    );
  }
}
