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
  staffRoles: string[];
  scholarRole?: string;
  wikiRepo: string;
  wikiCacheDir: string;
  mainRepo: string;
  openaiEndpoint?: string;
  openaiApiKey?: string;
  openaiModel?: string;
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

  const openaiEndpoint = process.env.OPENAI_ENDPOINT;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiModel = process.env.OPENAI_MODEL;

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
    openaiEndpoint,
    openaiApiKey,
    openaiModel,
  };
}
