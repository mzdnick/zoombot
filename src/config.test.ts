import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const REQUIRED_VARS = [
  'DISCORD_TOKEN', 'GUILD_ID', 'IDENTIFICATION_CHANNEL_ID', 'REPORT_BUTTON_CHANNEL_ID',
  'FORUM_CHANNEL_ID', 'DEVELOPMENT_CHANNEL_ID', 'ROUTES_CHANNEL_ID', 'VERIFIED_ROLE',
  'PENDING_ROLE', 'STAFF_ROLE',
] as const;

const saved: Record<string, string | undefined> = {};
for (const v of REQUIRED_VARS) saved[v] = process.env[v];

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
