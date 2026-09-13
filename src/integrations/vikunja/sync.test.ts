import { describe, expect, it, vi } from 'vitest';

vi.mock('../../store.js', () => ({
  createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => true }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  expectedIntegrationLabels,
  extractDiscordAssignee,
  formatDiscordComment,
  labelChanges,
  reverseUserMap,
  resolveReportType,
  stateLabelForCategory,
  taskTitleForThread,
} from './sync.js';

describe('Vikunja projection helpers', () => {
  it('maps the existing report category reduction to the configured state labels', () => {
    expect(stateLabelForCategory('Waiting for Dev')).toBe('Waiting for Developer');
    expect(stateLabelForCategory('Needs your Attention')).toBe('Waiting for User');
    expect(stateLabelForCategory('Snoozed')).toBe('Snoozed');
    expect(stateLabelForCategory('Closed')).toBe('Closed');
  });

  it('uses canonical stored report labels directly', () => {
    expect(resolveReportType({ label: 'Bug Report', tagNames: [] })).toBe('Bug Report');
    expect(resolveReportType({ label: 'Feedback', tagNames: [] })).toBe('Feedback');
    expect(resolveReportType({ label: 'Feature Request', tagNames: [] })).toBe('Feature Request');
    expect(resolveReportType({ label: 'Split', tagNames: [] })).toBe('Split');
  });

  it('resolves an unambiguous legacy Report type from its stored tags', () => {
    expect(resolveReportType({ label: 'Report', tagNames: ['OPEN', 'Bug Report'] })).toBe('Bug Report');
    expect(resolveReportType({ label: 'Report', tagNames: ['OPEN', 'BUG'] })).toBe('Bug Report');
    expect(resolveReportType({ label: 'Report', tagNames: ['FEEDBACK'] })).toBe('Feedback');
    expect(resolveReportType({ label: 'Report', tagNames: ['FEATURE REQUEST'] })).toBe('Feature Request');
    expect(resolveReportType({ label: 'Report', tagNames: ['SPLIT'] })).toBe('Split');
    expect(resolveReportType({ label: 'Report', tagNames: ['OPEN'] })).toBeNull();
    expect(resolveReportType({ label: 'Report', tagNames: ['constructor'] })).toBeNull();
    expect(resolveReportType({ label: 'Report', tagNames: ['Feedback', 'Feature Request'] })).toBeNull();
  });

  it('keeps the ticket id integration-owned while reusing Starbot title parsing', () => {
    expect(taskTitleForThread('🔴 Bug Report - Steering alert remains (1234567)', '1234567', 'Bug Report'))
      .toBe('#1234567 — Steering alert remains');
    expect(taskTitleForThread('✂️ Split - 🟠 Bug Report - Follow-up (42)', '42', 'Split'))
      .toBe('#42 — Follow-up');
  });

  it('only replaces integration-owned labels', () => {
    expect(expectedIntegrationLabels('Bug Report', 'Waiting for Developer'))
      .toEqual(['Bug Report', 'Waiting for Developer']);
    expect(labelChanges([
      { id: 1, title: 'Bug Report' },
      { id: 2, title: 'Waiting for User' },
      { id: 3, title: 'Staff note' },
    ], ['Bug Report', 'Waiting for Developer'])).toEqual({
      remove: [2],
      add: ['Waiting for Developer'],
    });
  });

  it('reads the canonical Discord assignee and reverses explicit user mappings', () => {
    expect(extractDiscordAssignee([{ name: '👤 Assigned to', value: '<@123456789012345678>' }]))
      .toBe('123456789012345678');
    expect(extractDiscordAssignee([])).toBeNull();
    expect(reverseUserMap({ '5': '123456789012345678' })).toEqual({ '123456789012345678': 5 });
  });

  it('redacts route ids before formatting a Discord comment for Vikunja', () => {
    expect(formatDiscordComment({
      displayName: 'Ada',
      content: 'Please inspect a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8 and this behavior.',
      url: 'https://discord.com/channels/1/2/3',
      attachments: [{ name: 'screenshot.png', url: 'https://cdn.discordapp.com/file' }],
    })).toBe('**Discord · Ada**\n\nPlease inspect and this behavior.\n\n[screenshot.png](https://cdn.discordapp.com/file)\n\n[Open in Discord](https://discord.com/channels/1/2/3)');
  });
});
