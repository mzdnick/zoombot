import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeRouteLogIssues,
  parseRouteField,
  extractRouteIds,
  replaceRouteIds,
  parseRouteComponents,
  fetchRouteCommitInfo,
  type RouteLogIssueInput,
} from './comma.js';

describe('parseRouteField', () => {
  const d1 = '0123456789abcdef';
  const r1 = '0000aaaa--1234567890';
  const d2 = 'fedcba9876543210';
  const r2 = '1111bbbb--0987654321';
  const d3 = 'aaaabbbbccccdddd';
  const r3 = '2222cccc--1122334455';

  it('parses a single bare route as the primary', () => {
    const result = parseRouteField(`${d1}/${r1}`);
    expect(result?.routes).toHaveLength(1);
    expect(result?.primary).toMatchObject({ dongleId: d1, routeName: r1 });
    expect(result?.primary.startSegment).toBeUndefined();
  });

  it('preserves connect-URL segment bounds on the primary', () => {
    const result = parseRouteField(`https://connect.comma.ai/${d1}/${r1}/120/240`);
    expect(result?.routes).toHaveLength(1);
    expect(result?.primary).toMatchObject({ dongleId: d1, routeName: r1, startSegment: 2, endSegment: 4 });
  });

  it.each([
    ['space', ' '],
    ['bare comma', ','],
    ['bare semicolon', ';'],
    ['comma-space', ', '],
    ['newline', '\n'],
    ['tab', '\t'],
  ])('extracts two routes separated by a %s, primary first', (_label, sep) => {
    const result = parseRouteField(`${d1}/${r1}${sep}${d2}/${r2}`);
    expect(result?.routes).toHaveLength(2);
    expect(result?.routes[0]).toMatchObject({ dongleId: d1, routeName: r1 });
    expect(result?.routes[1]).toMatchObject({ dongleId: d2, routeName: r2 });
    expect(result?.primary).toMatchObject({ dongleId: d1, routeName: r1 });
  });

  it('extracts mixed URL, pipe, and slash forms', () => {
    const result = parseRouteField(`https://connect.comma.ai/${d1}/${r1} ${d2}|${r2} ${d3}/${r3}`);
    expect(result?.routes).toHaveLength(3);
    expect(result?.routes.map(r => `${r.dongleId}/${r.routeName}`)).toEqual([
      `${d1}/${r1}`,
      `${d2}/${r2}`,
      `${d3}/${r3}`,
    ]);
  });

  it('dedupes a repeated route', () => {
    const result = parseRouteField(`${d1}/${r1} ${d1}/${r1}`);
    expect(result?.routes).toHaveLength(1);
  });

  it('returns null when no route is found', () => {
    expect(parseRouteField('not a route')).toBeNull();
    expect(parseRouteField('')).toBeNull();
  });
});

describe('Konik route handling', () => {
  const d = '59679e5e40b60ce0';
  const r = '0000091b--316e931f07';
  const onebox = `https://useradmin.konik.ai/?onebox=${d}|${r}`;
  const viewer = `https://stable.konik.ai/${d}/${r}`;

  it('extracts a Konik onebox URL as a whole konik route', () => {
    const routes = extractRouteIds(`wheel shake ${onebox} thanks`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ dongleId: d, routeName: r, provider: 'konik', isUrl: true, originalText: onebox });
  });

  it('extracts a stable.konik.ai viewer URL as a konik route', () => {
    expect(extractRouteIds(viewer)[0]).toMatchObject({ dongleId: d, routeName: r, provider: 'konik', isUrl: true });
  });

  it('handles a url-encoded pipe in the onebox URL', () => {
    const enc = `https://useradmin.konik.ai/?onebox=${d}%7C${r}`;
    expect(extractRouteIds(enc)[0]).toMatchObject({ dongleId: d, routeName: r, provider: 'konik' });
  });

  it('handles a slash separator in the onebox URL', () => {
    const slash = `https://useradmin.konik.ai/?onebox=${d}/${r}`;
    expect(extractRouteIds(slash)[0]).toMatchObject({ dongleId: d, routeName: r, provider: 'konik', isUrl: true, originalText: slash });
    expect(replaceRouteIds(slash, extractRouteIds(slash).map((x, i) => ({ ...x, routeNumber: i + 1 })), n => `**[Route ${n}]**`)).toBe('**[Route 1]**');
  });

  it('does not truncate a Konik onebox URL when numbering routes', () => {
    const routes = extractRouteIds(onebox).map((x, i) => ({ ...x, routeNumber: i + 1 }));
    const out = replaceRouteIds(`see ${onebox}`, routes, n => `**[Route ${n}]**`);
    expect(out).toBe('see **[Route 1]**');
    expect(out).not.toContain('onebox=');
    expect(out).not.toContain('konik.ai');
  });

  it('strips an unnumbered Konik URL with no leftover shell', () => {
    expect(replaceRouteIds(onebox, extractRouteIds(onebox), n => `**[Route ${n}]**`)).toBe('');
  });

  it('parseRouteComponents tags konik URLs', () => {
    expect(parseRouteComponents(onebox)).toMatchObject({ dongleId: d, routeName: r, provider: 'konik' });
    expect(parseRouteComponents(viewer)).toMatchObject({ dongleId: d, routeName: r, provider: 'konik' });
  });

  it('parseRouteComponents extracts a start/end segment range from a stable.konik.ai URL', () => {
    expect(parseRouteComponents(`${viewer}/0/100`)).toMatchObject({
      dongleId: d, routeName: r, provider: 'konik', startSegment: 0, endSegment: 1,
    });
  });

  it('parseRouteComponents extracts a start-only segment from a stable.konik.ai URL', () => {
    expect(parseRouteComponents(`${viewer}/150`)).toMatchObject({
      dongleId: d, routeName: r, provider: 'konik', startSegment: 2,
    });
  });

  it('treats a bare id as comma, not konik', () => {
    expect(extractRouteIds(`${d}|${r}`)[0].provider).toBe('comma');
  });
});

describe('computeRouteLogIssues', () => {
  const publicWhole = (originalText: string, rlogsAvailable: boolean): RouteLogIssueInput => ({
    originalText,
    public: true,
    rlogsAvailable,
    rlogCheck: { mode: 'whole', missing: [] },
  });

  it('returns no issues for a public route with logs available', () => {
    expect(computeRouteLogIssues([publicWhole('abc/def', true)])).toEqual([]);
  });

  it('flags a private route', () => {
    expect(computeRouteLogIssues([{ originalText: 'abc/def', public: false, rlogsAvailable: false }])).toEqual([
      '`abc/def` is **private**. Make it public, then check again.',
    ]);
  });

  it('flags a public route missing whole-route logs', () => {
    expect(computeRouteLogIssues([publicWhole('abc/def', false)])).toEqual([
      '`abc/def` is missing some logs. Upload all logs from your device, then check again.',
    ]);
  });

  it('flags a public route missing specific segments', () => {
    expect(computeRouteLogIssues([{
      originalText: 'abc/def',
      public: true,
      rlogsAvailable: false,
      rlogCheck: { mode: 'segment', missing: [2, 3] },
    }])).toEqual([
      '`abc/def` is missing logs for segment(s) **2, 3**. Upload them, then check again.',
    ]);
  });

  it('compresses long consecutive segment runs into ranges', () => {
    const missing = [];
    for (let s = 1414; s <= 2155; s++) missing.push(s);
    const issues = computeRouteLogIssues([{
      originalText: 'f676264ba0837425/0000004d--ef579ff974/1414/2155',
      public: true,
      rlogsAvailable: false,
      rlogCheck: { mode: 'segment', missing },
    }]);
    expect(issues).toEqual([
      '`f676264ba0837425/0000004d--ef579ff974/1414/2155` is missing logs for segment(s) **1414–2155**. Upload them, then check again.',
    ]);
  });

  it('truncates a segment list that is still too long after range compression', () => {
    const missing = [];
    for (let i = 0; i < 200; i++) missing.push(i * 2);
    const issues = computeRouteLogIssues([{
      originalText: 'abc/def',
      public: true,
      rlogsAvailable: false,
      rlogCheck: { mode: 'segment', missing },
    }]);
    expect(issues[0]!.length).toBeLessThan(500);
    expect(issues[0]).toMatch(/…and more/);
  });

  it('does not flag a segment route when nothing is missing', () => {
    expect(computeRouteLogIssues([{
      originalText: 'abc/def',
      public: true,
      rlogsAvailable: true,
      rlogCheck: { mode: 'segment', missing: [] },
    }])).toEqual([]);
  });

  it('collects an issue per offending route', () => {
    const issues = computeRouteLogIssues([
      publicWhole('ok/route', true),
      { originalText: 'priv/route', public: false, rlogsAvailable: false },
      publicWhole('nolog/route', false),
    ]);
    expect(issues).toEqual([
      '`priv/route` is **private**. Make it public, then check again.',
      '`nolog/route` is missing some logs. Upload all logs from your device, then check again.',
    ]);
  });
});

describe('fetchRouteCommitInfo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a commit from Konik route info, with an empty (unverifiable) commit date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        is_public: true, git_remote: null, git_branch: null,
        git_commit: 'abc123def456', git_dirty: null, platform: null, maxqlog: 0,
      }),
    }));
    const info = await fetchRouteCommitInfo('59679e5e40b60ce0', '0000091b--316e931f07', 'konik');
    expect(info).toEqual({ git_commit: 'abc123def456', git_commit_date: '' });
  });

  it('returns null for a Konik route with no commit info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    const info = await fetchRouteCommitInfo('59679e5e40b60ce0', '0000091b--316e931f08', 'konik');
    expect(info).toBeNull();
  });

  it('reads a commit + date from comma route metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{
        maxqlog: 0, start_time_utc_millis: 0, end_time_utc_millis: 0,
        git_remote: 'https://github.com/foo/openpilot.git', git_branch: 'master',
        git_commit: 'deadbeef', git_commit_date: '2026-01-01 00:00:00 -0000', git_dirty: false,
      }]),
    }));
    const info = await fetchRouteCommitInfo('59679e5e40b60ce0', '0000091b--316e931f07', 'comma');
    expect(info).toEqual({ git_commit: 'deadbeef', git_commit_date: '2026-01-01 00:00:00 -0000' });
  });
});
