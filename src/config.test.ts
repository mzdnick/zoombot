import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const REQUIRED_VARS = [
  'DISCORD_TOKEN', 'GUILD_ID', 'IDENTIFICATION_CHANNEL_ID', 'REPORT_BUTTON_CHANNEL_ID',
  'FORUM_CHANNEL_ID', 'DEVELOPMENT_CHANNEL_ID', 'ROUTES_CHANNEL_ID', 'VERIFIED_ROLE',
  'PENDING_ROLE', 'STAFF_ROLE',
] as const;

const VIKUNJA_VARS = [
  'VIKUNJA_URL', 'VIKUNJA_PROJECT_ID', 'VIKUNJA_API_TOKEN', 'VIKUNJA_WEBHOOK_SECRET',
  'VIKUNJA_USER_MAP',
] as const;

const saved: Record<string, string | undefined> = {};
for (const v of REQUIRED_VARS) saved[v] = process.env[v];
const savedVikunja: Record<string, string | undefined> = {};
for (const v of VIKUNJA_VARS) savedVikunja[v] = process.env[v];

describe('maxActiveReports parsing', () => {
  beforeEach(() => {
    for (const v of REQUIRED_VARS) process.env[v] = 'x';
  });

  afterEach(() => {
    for (const v of REQUIRED_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    delete process.env.MAX_ACTIVE_REPORTS;
  });

  // Regression: parseInt('0') || 2 coerced an explicit 0 to the default.
  it('MAX_ACTIVE_REPORTS=0 disables the cap instead of falling back to 2', () => {
    process.env.MAX_ACTIVE_REPORTS = '0';
    expect(loadConfig().maxActiveReports).toBe(0);
  });

  it('unset or invalid values fall back to 2', () => {
    delete process.env.MAX_ACTIVE_REPORTS;
    expect(loadConfig().maxActiveReports).toBe(2);
    process.env.MAX_ACTIVE_REPORTS = 'not-a-number';
    expect(loadConfig().maxActiveReports).toBe(2);
  });

  it('valid values pass through', () => {
    process.env.MAX_ACTIVE_REPORTS = '5';
    expect(loadConfig().maxActiveReports).toBe(5);
  });
});

describe('Vikunja configuration', () => {
  beforeEach(() => {
    for (const v of REQUIRED_VARS) process.env[v] = 'x';
    for (const v of VIKUNJA_VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const v of REQUIRED_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    for (const v of VIKUNJA_VARS) {
      if (savedVikunja[v] === undefined) delete process.env[v];
      else process.env[v] = savedVikunja[v];
    }
  });

  it('is disabled when every Vikunja variable is absent', () => {
    const config = loadConfig();
    expect(config.vikunja).toBeUndefined();
    expect('vikunja' in config).toBe(false);
  });

  it('is also disabled when optional Vikunja variables are all blank', () => {
    for (const v of VIKUNJA_VARS.slice(0, 4)) process.env[v] = '  ';
    expect(loadConfig().vikunja).toBeUndefined();
  });

  it('parses a complete Vikunja configuration', () => {
    process.env.VIKUNJA_URL = 'http://vikunja:3456';
    process.env.VIKUNJA_PROJECT_ID = '2';
    process.env.VIKUNJA_API_TOKEN = 'token';
    process.env.VIKUNJA_WEBHOOK_SECRET = 'secret';
    process.env.VIKUNJA_USER_MAP = '{"5":"123456789012345678"}';

    expect(loadConfig().vikunja).toEqual({
      url: 'http://vikunja:3456',
      projectId: 2,
      apiToken: 'token',
      webhookSecret: 'secret',
      webhookPort: 8787,
      userMap: { '5': '123456789012345678' },
    });
  });

  it('accepts a custom webhook port and rejects out-of-range values', () => {
    process.env.VIKUNJA_URL = 'http://vikunja:3456';
    process.env.VIKUNJA_PROJECT_ID = '2';
    process.env.VIKUNJA_API_TOKEN = 'token';
    process.env.VIKUNJA_WEBHOOK_SECRET = 'secret';
    process.env.VIKUNJA_WEBHOOK_PORT = '9000';
    expect(loadConfig().vikunja?.webhookPort).toBe(9000);

    process.env.VIKUNJA_WEBHOOK_PORT = '70000';
    expect(() => loadConfig()).toThrow(/VIKUNJA_WEBHOOK_PORT must be an integer between 1 and 65535/);
  });

  it('ignores the webhook port when the core Vikunja config is absent', () => {
    process.env.VIKUNJA_WEBHOOK_PORT = '9000';
    expect(loadConfig().vikunja).toBeUndefined();
  });

  it('rejects a partial Vikunja configuration', () => {
    process.env.VIKUNJA_URL = 'http://vikunja:3456';
    expect(() => loadConfig()).toThrow(/Vikunja configuration requires all of/);
  });

  it('requires a positive integer project id', () => {
    process.env.VIKUNJA_URL = 'http://vikunja:3456';
    process.env.VIKUNJA_PROJECT_ID = '0';
    process.env.VIKUNJA_API_TOKEN = 'token';
    process.env.VIKUNJA_WEBHOOK_SECRET = 'secret';
    expect(() => loadConfig()).toThrow(/VIKUNJA_PROJECT_ID must be a positive integer/);
  });

  it('rejects an invalid user map clearly', () => {
    process.env.VIKUNJA_URL = 'http://vikunja:3456';
    process.env.VIKUNJA_PROJECT_ID = '2';
    process.env.VIKUNJA_API_TOKEN = 'token';
    process.env.VIKUNJA_WEBHOOK_SECRET = 'secret';
    process.env.VIKUNJA_USER_MAP = 'not-json';
    expect(() => loadConfig()).toThrow(/VIKUNJA_USER_MAP must be valid JSON/);
  });
});
