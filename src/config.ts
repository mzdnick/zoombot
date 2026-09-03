import dotenv from 'dotenv';
dotenv.config();

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
  staffRole: string;
  scholarRole?: string;
  wikiRepo: string;
  wikiCacheDir: string;
  mainRepo: string;
  openaiEndpoint?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  maxActiveReports: number;
  dormantCloseDays: number;
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

  const staffRole = process.env.STAFF_ROLE;
  if (!staffRole) throw new Error('STAFF_ROLE is required');

  const scholarRole = process.env.SCHOLAR_ROLE;

  const wikiRepo = process.env.WIKI_REPO || 'StarPilot-Docs/docs';
  const wikiCacheDir = process.env.WIKI_CACHE_DIR || 'data/wiki';

  const mainRepo = process.env.MAIN_REPO || 'firestar5683/openpilot';

  const openaiEndpoint = process.env.OPENAI_ENDPOINT;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL;

  const maxActiveReportsRaw = parseInt(process.env.MAX_ACTIVE_REPORTS ?? '', 10);
  const maxActiveReports = Number.isNaN(maxActiveReportsRaw) ? 2 : Math.max(0, maxActiveReportsRaw);
  const dormantCloseDays = Math.max(1, parseInt(process.env.DORMANT_CLOSE_DAYS ?? '', 10) || 14);

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
    staffRole,
    scholarRole,
    wikiRepo,
    wikiCacheDir,
    mainRepo,
    openaiEndpoint,
    openaiApiKey,
    openaiModel,
    maxActiveReports,
    dormantCloseDays,
  };
}
