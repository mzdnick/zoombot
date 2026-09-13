import dotenv from 'dotenv';
dotenv.config();

export interface VikunjaConfig {
  url: string;
  projectId: number;
  apiToken: string;
  webhookSecret: string;
  webhookPort: number;
  /** Vikunja user id -> Discord user id. */
  userMap: Record<string, string>;
}

export interface BotConfig {
  token: string;
  guildId: string;
  identificationChannelId: string;
  reportButtonChannelId: string;
  forumChannelId: string;
  developmentChannelId: string;
  routesChannelId: string;
  donateChannelId?: string;
  verifiedRole: string;
  pendingRole: string;
  staffRoles: string[];
  scholarRole?: string;
  wikiRepo: string;
  wikiCacheDir: string;
  mainRepo: string;
  githubToken?: string;
  uatWaitRepo?: string;
  uatWaitBranch?: string;
  uatPollMinutes: number;
  openaiEndpoint?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  maxActiveReports: number;
  dormantCloseDays: number;
  vikunja?: VikunjaConfig;
}

function loadVikunjaConfig(): VikunjaConfig | undefined {
  const values = {
    url: process.env.VIKUNJA_URL,
    projectId: process.env.VIKUNJA_PROJECT_ID,
    apiToken: process.env.VIKUNJA_API_TOKEN,
    webhookSecret: process.env.VIKUNJA_WEBHOOK_SECRET,
  };
  const coreNames = ['VIKUNJA_URL', 'VIKUNJA_PROJECT_ID', 'VIKUNJA_API_TOKEN', 'VIKUNJA_WEBHOOK_SECRET'];
  const present = Object.values(values).filter(value => value?.trim());
  if (present.length === 0) return undefined;
  if (present.length !== coreNames.length || Object.values(values).some(value => !value?.trim())) {
    throw new Error(`Vikunja configuration requires all of ${coreNames.join(', ')}`);
  }

  const projectId = Number(values.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error('VIKUNJA_PROJECT_ID must be a positive integer');
  }

  let webhookPort = 8787;
  const rawPort = process.env.VIKUNJA_WEBHOOK_PORT?.trim();
  if (rawPort) {
    webhookPort = Number(rawPort);
    if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
      throw new Error('VIKUNJA_WEBHOOK_PORT must be an integer between 1 and 65535');
    }
  }

  let userMap: Record<string, string> = {};
  const rawUserMap = process.env.VIKUNJA_USER_MAP?.trim();
  if (rawUserMap) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawUserMap);
    } catch {
      throw new Error('VIKUNJA_USER_MAP must be valid JSON');
    }
    if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.entries(parsed).some(([vikunjaId, discordId]) =>
        !/^\d+$/.test(vikunjaId) || typeof discordId !== 'string' || !/^\d+$/.test(discordId))) {
      throw new Error('VIKUNJA_USER_MAP must be a JSON object mapping numeric Vikunja ids to Discord ids');
    }
    userMap = parsed as Record<string, string>;
  }

  return {
    url: values.url!.trim().replace(/\/+$/, ''),
    projectId,
    apiToken: values.apiToken!.trim(),
    webhookSecret: values.webhookSecret!.trim(),
    webhookPort,
    userMap,
  };
}

export function loadConfig(): BotConfig {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is required');

  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error('GUILD_ID is required');

  const identificationChannelId = process.env.IDENTIFICATION_CHANNEL_ID;
  if (!identificationChannelId) throw new Error('IDENTIFICATION_CHANNEL_ID is required');

  const reportButtonChannelId = process.env.REPORT_BUTTON_CHANNEL_ID;
  if (!reportButtonChannelId) throw new Error('REPORT_BUTTON_CHANNEL_ID is required');

  const forumChannelId = process.env.FORUM_CHANNEL_ID;
  if (!forumChannelId) throw new Error('FORUM_CHANNEL_ID is required');

  const developmentChannelId = process.env.DEVELOPMENT_CHANNEL_ID;
  if (!developmentChannelId) throw new Error('DEVELOPMENT_CHANNEL_ID is required');

  const routesChannelId = process.env.ROUTES_CHANNEL_ID;
  if (!routesChannelId) throw new Error('ROUTES_CHANNEL_ID is required');

  const donateChannelId = process.env.DONATE_CHANNEL_ID;

  const verifiedRole = process.env.VERIFIED_ROLE;
  if (!verifiedRole) throw new Error('VERIFIED_ROLE is required');

  const pendingRole = process.env.PENDING_ROLE;
  if (!pendingRole) throw new Error('PENDING_ROLE is required');

  const staffRoles = (process.env.STAFF_ROLE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (staffRoles.length === 0) throw new Error('STAFF_ROLE is required');

  const scholarRole = process.env.SCHOLAR_ROLE;

  // 'n/a' is the sentinel meaning "wiki disabled" (WIKI_REPO unset); the
  // init guard in src/handlers/events.ts checks for it before fetching.
  const wikiRepo = process.env.WIKI_REPO || 'n/a';
  const wikiCacheDir = process.env.WIKI_CACHE_DIR || 'data/wiki';

  const mainRepo = process.env.MAIN_REPO || 'zoompilot/zoompilot';

  const githubToken = process.env.GITHUB_TOKEN;

  const uatWaitRepo = process.env.REPORTS_UAT_WAIT_REPO;
  const uatWaitBranch = process.env.REPORTS_UAT_WAIT_BRANCH;
  const uatPollMinutes = Math.max(1, parseInt(process.env.REPORTS_UAT_POLL_MINUTES ?? '', 10) || 5);

  const openaiEndpoint = process.env.OPENAI_ENDPOINT;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL;

  const maxActiveReportsRaw = parseInt(process.env.MAX_ACTIVE_REPORTS ?? '', 10);
  const maxActiveReports = Number.isNaN(maxActiveReportsRaw) ? 2 : Math.max(0, maxActiveReportsRaw);
  const dormantCloseDays = Math.max(1, parseInt(process.env.DORMANT_CLOSE_DAYS ?? '', 10) || 14);
  const vikunja = loadVikunjaConfig();

  return {
    token,
    guildId,
    identificationChannelId,
    reportButtonChannelId,
    forumChannelId,
    developmentChannelId,
    routesChannelId,
    donateChannelId,
    verifiedRole,
    pendingRole,
    staffRoles,
    scholarRole,
    wikiRepo,
    wikiCacheDir,
    mainRepo,
    githubToken,
    uatWaitRepo,
    uatWaitBranch,
    uatPollMinutes,
    openaiEndpoint,
    openaiApiKey,
    openaiModel,
    maxActiveReports,
    dormantCloseDays,
    ...(vikunja ? { vikunja } : {}),
  };
}
