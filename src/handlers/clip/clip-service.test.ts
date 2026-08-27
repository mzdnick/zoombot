import { describe, expect, it } from 'vitest';
import { parseRouteUrl } from './clip-service.js';

describe('parseRouteUrl', () => {
  it('accepts a connect.comma.ai relative-seconds clip URL', () => {
    const result = parseRouteUrl('https://connect.comma.ai/a2a0ccea32023010/2023-07-27--13-01-19/7/124');
    expect(result).toEqual({ route: 'https://connect.comma.ai/a2a0ccea32023010/2023-07-27--13-01-19/7/124', duration: 117 });
  });

  it('accepts a stable.konik.ai relative-seconds clip URL', () => {
    const result = parseRouteUrl('https://stable.konik.ai/a818613ca4cdcfa5/00000067--cde15f929d/0/100');
    expect(result).toEqual({ route: 'https://stable.konik.ai/a818613ca4cdcfa5/00000067--cde15f929d/0/100', duration: 100 });
  });

  it('accepts a connect.comma.ai absolute-ms clip URL', () => {
    const result = parseRouteUrl('https://connect.comma.ai/a2a0ccea32023010/1690488084000/1690488085000');
    expect(result).toEqual({ route: 'https://connect.comma.ai/a2a0ccea32023010/1690488084000/1690488085000', duration: 1 });
  });

  it('rejects an unknown hostname', () => {
    expect(parseRouteUrl('https://example.com/a818613ca4cdcfa5/00000067--cde15f929d/0/100')).toBeNull();
  });

  it('rejects a non-positive or reversed time range', () => {
    expect(parseRouteUrl('https://stable.konik.ai/a818613ca4cdcfa5/00000067--cde15f929d/100/0')).toBeNull();
  });
});
