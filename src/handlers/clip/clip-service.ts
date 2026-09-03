import type { CommandInteraction, ModalSubmitInteraction, AnySelectMenuInteraction } from 'discord.js';
import {
  AttachmentBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { EventSource } from 'eventsource';
import { createLogger } from '../../logger.js';
import { COLORS } from '../../util.js';

const log = createLogger('clip');

export interface ClipConfig {
  endpoint: string;
  apiKey: string;
  maxDuration: number;
  allowFaceSwap: boolean;
}

export interface ClipJobInput {
  route: string;
  renderType?: string;
  uiAltVariant?: string;
  fileSize?: number;
  includeAudio?: boolean;
  anonymizationProfile?: string;
  passengerRedactionStyle?: string;
}

export const RENDER_TYPE_OPTIONS = [
  { key: 'ui', label: 'UI', apiValue: 'ui', description: 'openpilot UI overlay (default)' },
  { key: 'ui-alt', label: 'UI Alt', apiValue: 'ui-alt', description: 'Alternate UI composition' },
  { key: 'driver-debug', label: 'Driver Debug', apiValue: 'driver-debug', description: 'Raw driver camera' },
  { key: 'forward', label: 'Forward', apiValue: 'forward', description: 'Road camera, fast transcode' },
  { key: 'wide', label: 'Wide', apiValue: 'wide', description: 'Wide-angle camera, fast transcode' },
  { key: 'driver', label: 'Driver', apiValue: 'driver', description: 'Driver camera, fast transcode' },
  { key: '360', label: '360\u00b0', apiValue: '360', description: 'Equirectangular 360\u00b0 sphere' },
  { key: '360-ui', label: '360\u00b0 UI', apiValue: '360-ui', description: '360\u00b0 with HUD overlay' },
  { key: 'forward-upon-wide', label: 'Forward Upon Wide', apiValue: 'forward_upon_wide', description: 'Forward overlaid on wide' },
  { key: '360-forward-upon-wide', label: '360\u00b0 Forward Upon Wide', apiValue: '360_forward_upon_wide', description: '360\u00b0 + forward on wide (8K)' },
] as const;

export const RENDER_TYPE_MAP: Record<string, string> = Object.fromEntries(
  RENDER_TYPE_OPTIONS.map(o => [o.key, o.apiValue]),
);

export const RENDER_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  RENDER_TYPE_OPTIONS.map(o => [o.apiValue, o.label]),
);

export const VALID_RENDER_TYPES = RENDER_TYPE_OPTIONS.map(o => o.key);

export function getAnonymizationOptions(config: ClipConfig | null): string[] {
  if (config?.allowFaceSwap) return [...ANONYMIZATION_PROFILES];
  return ANONYMIZATION_PROFILES.filter(p => !p.includes('face swap'));
}

export const ANONYMIZATION_LABELS: Record<string, string> = {
  'none': 'None',
  'driver unchanged, passenger hidden': 'Driver Unchanged, Passenger Hidden',
  'driver unchanged, passenger face swap': 'Driver Unchanged, Passenger Face Swap',
  'driver face swap, passenger unchanged': 'Driver Face Swap, Passenger Unchanged',
  'driver face swap, passenger hidden': 'Driver Face Swap, Passenger Hidden',
  'driver face swap, passenger face swap': 'Driver Face Swap, Passenger Face Swap',
};

export const ANONYMIZATION_PROFILES = Object.keys(ANONYMIZATION_LABELS);

export const PASSENGER_REDACTION_LABELS: Record<string, string> = {
  'blur': 'Blur',
  'silhouette': 'Silhouette',
  'black_silhouette': 'Black Silhouette',
  'ir_tint': 'IR Tint',
};

export const PASSENGER_REDACTION_STYLES = Object.keys(PASSENGER_REDACTION_LABELS);

export const ANONYMIZATION_SLASH_CHOICES: { name: string; value: string }[] = (() => {
  const allowFaceSwap = process.env.OP_REPLAY_CLIPPER_ALLOW_FACE_SWAP === 'true';
  return ANONYMIZATION_PROFILES
    .filter(p => allowFaceSwap || !p.includes('face swap'))
    .map(value => ({ name: ANONYMIZATION_LABELS[value], value }));
})();

export const PRS_SLASH_CHOICES: { name: string; value: string }[] = Object.entries(PASSENGER_REDACTION_LABELS).map(
  ([value, name]) => ({ name, value }),
);

export const UI_ALT_VARIANT_LABELS: Record<string, string> = {
  'device': 'Device',
  'stacked_forward_over_wide': 'Stacked Forward / Wide',
  'stacked_wide_over_forward': 'Stacked Wide / Forward',
  'stacked_device_over_driver': 'Stacked Device / Driver',
};

export const UI_ALT_VARIANTS = Object.keys(UI_ALT_VARIANT_LABELS);

export const UI_ALT_SLASH_CHOICES: { name: string; value: string }[] = Object.entries(UI_ALT_VARIANT_LABELS).map(
  ([value, name]) => ({ name, value }),
);

export const RENDER_TYPES_WITH_ANONYMIZATION = new Set([
  'driver-debug', 'driver', '360', '360-ui', '360-forward-upon-wide',
]);

export const PROFILES_REQUIRING_PRS = new Set([
  'driver unchanged, passenger hidden',
  'driver face swap, passenger hidden',
]);

const activeUsers = new Set<string>();

export function acquireUserLock(userId: string): boolean {
  if (activeUsers.has(userId)) return false;
  activeUsers.add(userId);
  return true;
}

export function releaseUserLock(userId: string): void {
  activeUsers.delete(userId);
}

export function getClipConfig(): ClipConfig | null {
  const endpoint = process.env.OP_REPLAY_CLIPPER_ENDPOINT;
  const apiKey = process.env.OP_REPLAY_CLIPPER_API_KEY;
  if (!endpoint || !apiKey) return null;
  const raw = parseInt(process.env.OP_REPLAY_CLIPPER_MAX_DURATION || '60', 10);
  const maxDuration = isNaN(raw) || raw <= 0 ? 60 : raw;
  const allowFaceSwap = process.env.OP_REPLAY_CLIPPER_ALLOW_FACE_SWAP === 'true';
  return { endpoint: endpoint.replace(/\/+$/, ''), apiKey, maxDuration, allowFaceSwap };
}

const CLIP_ROUTE_HOSTS = new Set(['connect.comma.ai', 'stable.konik.ai']);

export function parseRouteUrl(url: string): { route: string; duration: number } | null {
  try {
    const parsed = new URL(url.trim());
    if (!CLIP_ROUTE_HOSTS.has(parsed.hostname)) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 3) return null;

    const end = parseInt(segments[segments.length - 1], 10);
    const start = parseInt(segments[segments.length - 2], 10);
    if (isNaN(end) || isNaN(start) || end <= start) return null;

    const diff = end - start;
    const durationSec = start > 1e10 ? diff / 1000 : diff;
    if (durationSec <= 0) return null;

    return { route: url.trim(), duration: durationSec };
  } catch {
    return null;
  }
}


interface SubmitResponse {
  job_id: string;
  status: 'queued';
  queue: 'pending' | 'slow';
  queue_position: number;
  estimated_wait_seconds: number | null;
}

interface SseQueuedEvent {
  position: number;
  eta_seconds: number | null;
  queue: string;
}

interface SseRequeuedEvent {
  reason: string;
  attempts: number;
  max_attempts: number;
  queue_position: number;
  queue: string;
}


interface SseProgressEvent {
  pct: number;
  fps: number | null;
  detail: string;
}

interface SseCompletedEvent {
  output_url: string;
  expires_at: number | null;
}

interface SseFailedEvent {
  error: string;
}

async function submitJob(config: ClipConfig, input: ClipJobInput): Promise<SubmitResponse> {
  const res = await fetch(`${config.endpoint}/predict`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Clip API returned ${res.status}: ${text || res.statusText}`);
  }

  return res.json() as Promise<SubmitResponse>;
}

export async function downloadOutput(config: ClipConfig, jobId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${config.endpoint}/jobs/${jobId}/output`, {
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error('Clip output expired (TTL is 1 hour). Please try again.');
    throw new Error(`Failed to download clip (${res.status})`);
  }

  return res.arrayBuffer();
}

function progressBar(pct: number): string {
  const filled = Math.min(20, Math.round(pct / 5));
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${Math.round(pct)}%`;
}

export interface ProgressUpdate {
  pct: number | null;
  detail: string;
  queuePosition?: number;
  queue?: string | null;
  eta?: number | null;
  fps?: number | null;
  force?: boolean;
}

export type ProgressCallback = (update: ProgressUpdate) => Promise<void>;

export function createProgressUpdater(
  interaction: CommandInteraction | ModalSubmitInteraction | AnySelectMenuInteraction,
): ProgressCallback {
  let lastUpdate = 0;
  return async (update) => {
    const now = Date.now();
    if (!update.force && now - lastUpdate < 4000) return;
    lastUpdate = now;
    try {
      const embed = new EmbedBuilder().setColor(COLORS.blurple).setTitle('Creating Clip');

      if (update.queuePosition !== undefined) {
        const queueLabel = update.queue === 'slow' ? 'Slow Queue' : 'Queue';
        embed.addFields(
          { name: 'Status', value: queueLabel, inline: true },
          { name: 'Position', value: `${update.queuePosition}`, inline: true },
          { name: 'ETA', value: update.eta != null ? `~${Math.ceil(update.eta)}s` : '\u2014', inline: true },
        );
        if (update.detail !== 'Queued') {
          embed.setDescription(update.detail);
        }
      } else if (update.pct !== null) {
        let detail = update.detail;
        if (update.fps != null) {
          detail = detail.replace(/\s*\|\s*[\d.]+ fps$/i, '');
        }
        const detailStr = update.fps != null
          ? `\`${detail}\` (${update.fps.toFixed(2)} fps)`
          : `\`${detail}\``;
        embed.addFields(
          { name: 'Progress', value: progressBar(update.pct), inline: false },
          { name: 'Detail', value: detailStr, inline: false },
        );
      } else {
        embed.setDescription(`\`${update.detail}\``);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch { /* rate-limited or interaction expired */ }
  };
}

export async function processClip(
  config: ClipConfig,
  input: ClipJobInput,
  onProgress: ProgressCallback,
): Promise<{ data: ArrayBuffer; jobId: string; expiresAt: number | null }> {
  const submitRes = await submitJob(config, input);
  const jobId = submitRes.job_id;
  const pos = submitRes.queue_position === -1 ? 0 : submitRes.queue_position;
  await onProgress({ pct: null, detail: 'Queued', queuePosition: pos, queue: submitRes.queue, eta: submitRes.estimated_wait_seconds });

  return new Promise<{ data: ArrayBuffer; jobId: string; expiresAt: number | null }>((resolve, reject) => {
    const MAX_TIME = 10 * 60 * 1000;
    const timeout = setTimeout(() => {
      es.close();
      reject(new Error('Clip processing timed out after 10 minutes'));
    }, MAX_TIME);

    const url = `${config.endpoint}/jobs/${jobId}/stream`;
    const es = new EventSource(url, {
      fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, 'Authorization': `Bearer ${config.apiKey}` } }),
    });

    es.addEventListener('queued', (e: Event | MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data) as SseQueuedEvent;
      onProgress({ pct: null, detail: 'Queued', queuePosition: d.position, queue: d.queue, eta: d.eta_seconds }).catch(() => {});
    });

    es.addEventListener('requeued', (e: Event | MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data) as SseRequeuedEvent;
      onProgress({ pct: null, detail: `Retrying (${d.attempts}/${d.max_attempts}): ${d.reason}`, queuePosition: d.queue_position, queue: d.queue, force: true }).catch(() => {});
    });

    es.addEventListener('started', (_e: Event | MessageEvent) => {
      onProgress({ pct: null, detail: 'Processing\u2026', force: true }).catch(() => {});
    });

    es.addEventListener('progress', (e: Event | MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data) as SseProgressEvent;
      onProgress({ pct: d.pct, detail: d.detail, fps: d.fps }).catch(() => {});
    });

    es.addEventListener('completed', async (e: Event | MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data) as SseCompletedEvent;
      clearTimeout(timeout);
      es.close();
      try {
        const data = await downloadOutput(config, jobId);
        resolve({ data, jobId, expiresAt: d.expires_at });
      } catch (err) {
        reject(err);
      }
    });

    es.addEventListener('failed', (e: Event | MessageEvent) => {
      const d = JSON.parse((e as MessageEvent).data) as SseFailedEvent;
      clearTimeout(timeout);
      es.close();
      reject(new Error(d.error || 'Clip processing failed'));
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(timeout);
        reject(new Error('Lost connection to clip service'));
      }
    };
  });
}

async function sendEphemeral(
  interaction: CommandInteraction | ModalSubmitInteraction | AnySelectMenuInteraction,
  title: string,
  description: string,
): Promise<void> {
  const embed = new EmbedBuilder().setColor(COLORS.amber).setTitle(title).setDescription(description);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] as [MessageFlags.Ephemeral] });
  }
}

export async function handleClipRequest(
  interaction: CommandInteraction | ModalSubmitInteraction | AnySelectMenuInteraction,
  input: ClipJobInput,
): Promise<void> {
  const config = getClipConfig();
  if (!config) {
    await sendEphemeral(interaction, 'Service Unavailable', 'Clip service is not configured. Contact an admin.');
    return;
  }

  const parsed = parseRouteUrl(input.route);
  if (!parsed) {
    await sendEphemeral(interaction,
      'Invalid Route URL',
      'Must be a connect.comma.ai or stable.konik.ai URL with a time range:\n' +
      '`https://connect.comma.ai/{dongle_id}/{route_id}/{start}/{end}`\n' +
      '`https://stable.konik.ai/{dongle_id}/{route_id}/{start}/{end}`',
    );
    return;
  }

  if (parsed.duration > config.maxDuration) {
    await sendEphemeral(interaction,
      'Duration Exceeds Limit',
      `Requested **${Math.round(parsed.duration)}s** - maximum is **${config.maxDuration}s**.`,
    );
    return;
  }

  const userId = interaction.user.id;
  if (!acquireUserLock(userId)) {
    await sendEphemeral(interaction,
      'Clip In Progress',
      'You already have a clip being processed. Wait for it to finish before requesting another.',
    );
    return;
  }

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const onProgress = createProgressUpdater(interaction);
    const { data, jobId, expiresAt } = await processClip(config, input, onProgress);

    const rawMaxMb = parseInt(process.env.GUILD_MAX_FILE_MB || '25', 10);
    const maxFileMb = isNaN(rawMaxMb) || rawMaxMb <= 0 ? 25 : rawMaxMb;
    const maxBytes = maxFileMb * 1024 * 1024;
    if (data.byteLength > maxBytes) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.amber)
        .setTitle('Clip Too Large')
        .setDescription(
          `Result is **${(data.byteLength / 1024 / 1024).toFixed(1)} MB** - Discord limit is ${maxFileMb} MB.\n` +
          `Try a lower \`file-size\` value (target was ${input.fileSize ?? 9} MB).`,
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const renderLabel = input.renderType ?? 'ui';
    const sizeLabel = `${(data.byteLength / 1024 / 1024).toFixed(1)} MB`;

    const embed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle('Clip Ready')
      .addFields(
        { name: 'Type', value: `\`${renderLabel}\``, inline: true },
        { name: 'Size', value: sizeLabel, inline: true },
        ...(expiresAt ? [{ name: 'Expires', value: `<t:${Math.floor(expiresAt)}:R>`, inline: true }] : []),
      )
      .setFooter({ text: 'Click Publish to share in channel' });

    const attachment = new AttachmentBuilder(Buffer.from(data), { name: 'clip.mp4' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`clip_pub_${jobId}:${renderLabel}`)
        .setLabel('Publish')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.editReply({ embeds: [embed], files: [attachment], components: [row] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err }, msg);
    try {
      const embed = new EmbedBuilder()
        .setColor(COLORS.red)
        .setTitle('Clip Failed')
        .setDescription(msg);
      await interaction.editReply({ embeds: [embed] });
    } catch { /* interaction may have expired */ }
  } finally {
    releaseUserLock(userId);
  }
}
