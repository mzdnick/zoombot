import { LRUCache } from 'lru-cache';
import { createLogger } from './logger.js';
import { validateKonikRoute, getKonikRouteInfo } from './konik.js';

const log = createLogger('comma');

export type RouteProvider = 'comma' | 'konik';

// Fully decomposed route input: identity plus optional sub-route and segment bounds.
export interface RouteComponents {
  dongleId: string;
  routeName: string;
  iteration?: string;
  startSegment?: number;
  endSegment?: number;
  provider?: RouteProvider;
}

export interface ExtractedRoute {
  dongleId: string;
  routeName: string;
  iteration?: string;
  // Identity for dedup and replacement is the lowercased originalText, so distinct text
  // forms of the same drive get separate route numbers.
  originalText?: string;
  isUrl?: boolean;
  routeNumber?: number;
  public?: boolean;
  rlogsAvailable?: boolean;
  provider?: RouteProvider;
}

export interface RlogCheckResult {
  mode: 'whole' | 'segment';
  missing: number[];
}

export interface RouteValidation {
  valid: boolean;
  public: boolean;
  rlogsAvailable: boolean;
  rlogCheck?: RlogCheckResult;
}

// Matches dongle/route or dongle|route with optional iteration (used for scanning free-form text).
export const ROUTE_REGEX = /([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10})(?:\/(?:[a-f0-9]{8}--[a-f0-9]{10}|\d+(?:\/\d+)?))?/gi;

// Anchored regex for validating a single normalized route string (dongle_id/route_name[/iter_or_seg[/seg]]).
const ROUTE_ID_REGEX = /^([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10})(?:\/([a-f0-9]{8}--[a-f0-9]{10}|\d+(?:\/\d+)?))?$/i;

// Matches connect.comma.ai URLs with optional start[/end] seconds.
const CONNECT_URL_REGEX = /https:\/\/connect\.comma\.ai\/([a-f0-9]{16})\/([a-f0-9]{8}--[a-f0-9]{10})(?:\/(\d+)(?:\/(\d+))?)?/gi;

// Captures: 1+2 = comma URL; 3+4 = konik URL; 5+6 = bare form (dongle, route).
const ANY_ROUTE_REGEX = /(?:https:\/\/connect\.comma\.ai\/([a-f0-9]{16})\/([a-f0-9]{8}--[a-f0-9]{10})|https:\/\/(?:useradmin\.konik\.ai\/\?onebox=|stable\.konik\.ai\/)([a-f0-9]{16})(?:%7C|[|\/])([a-f0-9]{8}--[a-f0-9]{10})|([a-f0-9]{16})[\/|]([a-f0-9]{8}--[a-f0-9]{10}))(?:\/(?:[a-f0-9]{8}--[a-f0-9]{10}|\d+(?:\/\d+)?))?/gi;

// Lenient enough to catch malformed connect URLs so PII is stripped even if parsing fails.
const CONNECT_URL_STRIP_REGEX = /https?:\/\/connect\.comma\.ai\/[^\s)<>"']*/gi;
const KONIK_URL_STRIP_REGEX = /https?:\/\/(?:useradmin|stable)\.konik\.ai\/[^\s)<>"']*/gi;

// connect.comma.ai URLs measure position in seconds; segments are 60s each.
export function secondsToSegment(secStr: string): number {
  return Math.floor(parseInt(secStr, 10) / 60);
}

export function segmentToSeconds(segment: number): number {
  return segment * 60;
}

// Deconstruct any accepted route form into dongle/route plus optional sub-route or segment bounds.
// Seconds (connect URLs) are converted to segment numbers; bare/pipe forms already use segments.
// Throws with a user-facing message on malformed input.
export function parseRouteComponents(input: string): RouteComponents {
  input = input.trim();

  const konikMatch = input.match(/^https:\/\/(?:useradmin\.konik\.ai\/\?onebox=|stable\.konik\.ai\/)([a-f0-9]{16})(?:%7C|[|\/])([a-f0-9]{8}--[a-f0-9]{10})(\/.*)?$/i);
  if (konikMatch) {
    const [, dongleId, routeName, rest] = konikMatch;
    const segStr = rest?.replace(/^\/+/, '').replace(/\/+$/, '') || '';
    if (!segStr) return { dongleId, routeName, provider: 'konik' };
    const [startStr, endStr, extra] = segStr.split('/');
    if (extra !== undefined) throw new Error(`Invalid Konik URL format`);
    if (!/^\d+$/.test(startStr)) throw new Error(`Invalid seconds value in URL: "${startStr}"`);
    if (endStr === undefined) return { dongleId, routeName, startSegment: secondsToSegment(startStr), provider: 'konik' };
    if (!/^\d+$/.test(endStr)) throw new Error(`Invalid end seconds value in URL: "${endStr}"`);
    return { dongleId, routeName, startSegment: secondsToSegment(startStr), endSegment: secondsToSegment(endStr), provider: 'konik' };
  }

  if (input.startsWith('https://connect.comma.ai/')) {
    const path = input.slice('https://connect.comma.ai/'.length).replace(/\/+$/, '');
    const parts = path.split('/');
    const [dongleId, routeName] = parts;
    if (!/^[a-f0-9]{16}$/i.test(dongleId ?? ''))
      throw new Error(`Invalid dongle ID "${dongleId}": expected 16 hex characters.`);
    if (!/^[a-f0-9]{8}--[a-f0-9]{10}$/i.test(routeName ?? ''))
      throw new Error(`Invalid route name "${routeName}": expected format like \`0000aaaa--1234567890\`.`);
    if (parts.length === 2) return { dongleId, routeName };
    if (parts.length === 3) {
      const secStr = parts[2];
      if (!/^\d+$/.test(secStr)) throw new Error(`Invalid seconds value in URL: "${secStr}"`);
      return { dongleId, routeName, startSegment: secondsToSegment(secStr) };
    }
    if (parts.length === 4) {
      const [, , startStr, endStr] = parts;
      if (!/^\d+$/.test(startStr)) throw new Error(`Invalid start seconds value in URL: "${startStr}"`);
      if (!/^\d+$/.test(endStr)) throw new Error(`Invalid end seconds value in URL: "${endStr}"`);
      return { dongleId, routeName, startSegment: secondsToSegment(startStr), endSegment: secondsToSegment(endStr) };
    }
    throw new Error(`Invalid connect.comma.ai URL format`);
  }

  const pipeMatch = input.match(/^([a-f0-9]{16})\|([a-f0-9]{8}--[a-f0-9]{10})$/i);
  if (pipeMatch) return { dongleId: pipeMatch[1], routeName: pipeMatch[2] };

  const parts = input.split('/');
  if (parts.length >= 2 && parts.length <= 4) {
    if (!/^[a-f0-9]{16}$/i.test(parts[0]))
      throw new Error(`Invalid dongle ID "${parts[0]}": expected 16 hex characters.`);
    if (!/^[a-f0-9]{8}--[a-f0-9]{10}$/i.test(parts[1]))
      throw new Error(`Invalid route name "${parts[1]}": expected format like \`0000aaaa--1234567890\`.`);
    const result: RouteComponents = { dongleId: parts[0], routeName: parts[1] };
    if (parts.length >= 3) {
      const third = parts[2];
      if (/^[a-f0-9]{8}--[a-f0-9]{10}$/i.test(third)) {
        result.iteration = third;
        if (parts.length === 4)
          throw new Error(`Unrecognized route format: a sub-route cannot be followed by a segment.`);
      } else if (/^\d+$/.test(third)) {
        result.startSegment = parseInt(third, 10);
        if (parts.length === 4) {
          if (!/^\d+$/.test(parts[3]))
            throw new Error(`Invalid segment value "${parts[3]}": expected a number.`);
          result.endSegment = parseInt(parts[3], 10);
        }
      } else {
        throw new Error(`Invalid segment "${third}": expected a number or a sub-route ID.`);
      }
    }
    return result;
  }

  throw new Error(`Unrecognized route format: expected "dongleId/routeName[/seg]" or a connect.comma.ai URL`);
}

// Canonical `dongle/route[/iteration|/startSegment]` string used for identity parsing.
export function normalizeRouteInput(input: string): string {
  const c = parseRouteComponents(input);
  let out = `${c.dongleId}/${c.routeName}`;
  if (c.iteration) out += `/${c.iteration}`;
  else if (c.startSegment !== undefined) out += `/${c.startSegment}`;
  return out;
}

export function parseNormalizedRoute(input: string): ExtractedRoute | null {
  const match = input.match(ROUTE_ID_REGEX);
  if (!match) return null;
  // Numeric time-segments aren't part of route identity; only hex sub-routes count.
  const iter = match[3] && /^[a-f0-9]{8}--[a-f0-9]{10}$/i.test(match[3]) ? match[3] : undefined;
  return {
    dongleId: match[1],
    routeName: match[2],
    iteration: iter,
  };
}

export function extractRouteIds(text: string): ExtractedRoute[] {
  const results: ExtractedRoute[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(ANY_ROUTE_REGEX.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const original = m[0];
    const key = original.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let dongle: string, route: string, provider: RouteProvider, isUrl: boolean;
    if (m[1] !== undefined) {
      dongle = m[1]; route = m[2]; provider = 'comma'; isUrl = true;
    } else if (m[3] !== undefined) {
      dongle = m[3]; route = m[4]; provider = 'konik'; isUrl = true;
    } else {
      dongle = m[5]; route = m[6]; provider = 'comma'; isUrl = false;
    }
    const iterMatch = !isUrl ? original.match(/\/([a-f0-9]{8}--[a-f0-9]{10})$/i) : null;
    results.push({
      dongleId: dongle,
      routeName: route,
      iteration: iterMatch?.[1],
      originalText: original,
      isUrl,
      provider,
    });
  }
  return results;
}

export function parseRouteField(input: string): { primary: RouteComponents; routes: ExtractedRoute[] } | null {
  const routes = extractRouteIds(input);
  if (routes.length === 0) return null;
  // Re-parse the primary alone so its connect-URL segment bounds survive (extractRouteIds drops them).
  let primary: RouteComponents;
  try {
    primary = parseRouteComponents(routes[0].originalText ?? input);
  } catch {
    primary = { dongleId: routes[0].dongleId, routeName: routes[0].routeName, iteration: routes[0].iteration };
  }
  return { primary, routes };
}

export function replaceRouteIds(
  text: string,
  routes: ExtractedRoute[],
  // Renders the replacement for a numbered route; unnumbered routes (dedicated) are
  // stripped to '' - already shown as the primary tracker entry. Left to the caller so
  // this module stays agnostic of the destination's markup (e.g. Discord markdown).
  formatLabel: (routeNumber: number) => string,
): string {
  const labelByText = new Map<string, string>();
  for (const r of routes) {
    if (!r.originalText) continue;
    const key = r.originalText.toLowerCase();
    if (labelByText.has(key)) continue;
    labelByText.set(key, r.routeNumber ? formatLabel(r.routeNumber) : '');
  }
  return text
    .replace(new RegExp(ANY_ROUTE_REGEX.source, 'gi'), match => labelByText.get(match.toLowerCase()) ?? '')
    .replace(CONNECT_URL_STRIP_REGEX, '')
    .replace(KONIK_URL_STRIP_REGEX, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

export function stripRouteIds(text: string): string {
  return text
    .replace(CONNECT_URL_REGEX, '')
    .replace(KONIK_URL_STRIP_REGEX, '')
    .replace(ROUTE_REGEX, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim();
}

// The /files response embeds the source filename (e.g. `dongle_route--6--rlog.zst`) in each
// URL, so a substring match on `dongle_route--<seg>--rlog` tells us that segment's rlog exists.
function segmentHasRlog(logs: string[], dongleId: string, routeName: string, seg: number): boolean {
  const needle = `${dongleId}_${routeName}--${seg}--rlog`.toLowerCase();
  return logs.some(u => u.toLowerCase().includes(needle));
}

export interface RouteSegmentMetadata {
  /* 0 indexed, so maxqlog of 1 means there were 2 segments in the route */
  maxqlog: number;
  start_time_utc_millis: number;
  end_time_utc_millis: number;
  git_remote: string;
  git_branch: string;
  git_commit: string;
  git_commit_date: string;
  git_dirty: boolean;
}

const METADATA_CACHE_TTL_MS = 3 * 60_000;
const metadataCache = new LRUCache<string, RouteSegmentMetadata>({ max: 200, ttl: METADATA_CACHE_TTL_MS });

export async function fetchRouteMetadata(dongleId: string, routeName: string): Promise<RouteSegmentMetadata | null> {
  const key = `${dongleId}|${routeName}`;
  const cached = metadataCache.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://api.comma.ai/v1/devices/${dongleId}/routes_segments?route_str=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return null;
    const data = await res.json() as RouteSegmentMetadata[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const entry = data[0];
    const meta: RouteSegmentMetadata = {
      maxqlog: entry.maxqlog,
      start_time_utc_millis: entry.start_time_utc_millis,
      end_time_utc_millis: entry.end_time_utc_millis,
      git_remote: entry.git_remote,
      git_branch: entry.git_branch,
      git_commit: entry.git_commit,
      git_commit_date: entry.git_commit_date,
      git_dirty: entry.git_dirty,
    };
    metadataCache.set(key, meta);
    return meta;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch route metadata');
    return null;
  }
}

export interface RouteCommitInfo {
  git_commit: string;
  git_commit_date: string;
}

// Konik's route info has no commit-date field, so we hand back an empty one -
// isStaleBuild() already treats an unparsable date as "can't verify, don't block".
export async function fetchRouteCommitInfo(
  dongleId: string,
  routeName: string,
  provider: RouteProvider = 'comma',
): Promise<RouteCommitInfo | null> {
  if (provider === 'konik') {
    const info = await getKonikRouteInfo(dongleId, routeName);
    if (!info.valid || !info.metadata?.gitCommit) return null;
    return { git_commit: info.metadata.gitCommit, git_commit_date: '' };
  }
  const meta = await fetchRouteMetadata(dongleId, routeName);
  if (!meta) return null;
  return { git_commit: meta.git_commit, git_commit_date: meta.git_commit_date };
}

export async function validateRoute(
  dongleId: string,
  routeName: string,
  startSegment?: number,
  endSegment?: number,
  provider: RouteProvider = 'comma',
): Promise<RouteValidation> {
  if (provider === 'konik') return validateKonikRoute(dongleId, routeName, startSegment, endSegment);
  try {
    const res = await fetch(`https://api.comma.ai/v1/route/${dongleId}|${routeName}/files`);
    if (res.ok) {
      let rlogsAvailable = false;
      let rlogCheck: RlogCheckResult | undefined;
      try {
        const data = await res.json() as { logs?: string[]; qlogs?: string[] };
        const logs = Array.isArray(data.logs) ? data.logs : [];
        const qlogs = Array.isArray(data.qlogs) ? data.qlogs : [];
        if (startSegment !== undefined) {
          const lo = Math.min(startSegment, endSegment ?? startSegment);
          const hi = Math.max(startSegment, endSegment ?? startSegment);
          const missing: number[] = [];
          for (let s = lo; s <= hi; s++) {
            if (!segmentHasRlog(logs, dongleId, routeName, s)) missing.push(s);
          }
          rlogsAvailable = missing.length === 0;
          rlogCheck = { mode: 'segment', missing };
        } else {
          const meta = await fetchRouteMetadata(dongleId, routeName);
          const expectedSegments = meta != null ? meta.maxqlog + 1 : qlogs.length;
          rlogsAvailable = expectedSegments > 0 && logs.length === expectedSegments;
          rlogCheck = { mode: 'whole', missing: [] };
        }
      } catch (err) {
        log.warn({ err }, 'Failed to parse route files response');
      }
      return { valid: true, public: true, rlogsAvailable, rlogCheck };
    }
    if (res.status === 403 || res.status === 401) return { valid: true, public: false, rlogsAvailable: false };
  } catch (err) {
    log.warn({ err }, 'Route validation API unreachable');
  }
  return { valid: false, public: false, rlogsAvailable: false };
}

export type RouteLogIssueInput = Pick<ExtractedRoute, 'originalText' | 'public' | 'rlogsAvailable'> & {
  rlogCheck?: RlogCheckResult;
};

// Discord caps message content at 2000 chars, so compress runs ("1414–2155")
// and truncate pathological lists rather than joining every segment number.
const SEGMENT_LIST_MAX = 400;

function pushRange(ranges: string[], start: number, prev: number): void {
  if (start === prev) ranges.push(`${start}`);
  else if (prev - start >= 2) ranges.push(`${start}–${prev}`);
  else ranges.push(`${start}, ${prev}`);
}

export function formatSegmentList(segments: number[]): string {
  const ranges: string[] = [];
  let start = segments[0]!;
  let prev = start;
  for (const s of segments.slice(1)) {
    if (s === prev + 1) {
      prev = s;
      continue;
    }
    pushRange(ranges, start, prev);
    start = prev = s;
  }
  pushRange(ranges, start, prev);

  let list = ranges.join(', ');
  while (list.length > SEGMENT_LIST_MAX && ranges.length > 1) {
    ranges.pop();
    list = `${ranges.join(', ')}, …and more`;
  }
  return list;
}

export function computeRouteLogIssues(routes: RouteLogIssueInput[]): string[] {
  const issues: string[] = [];
  for (const r of routes) {
    if (!r.public) {
      issues.push(`\`${r.originalText}\` is **private**. Make it public, then check again.`);
    } else if (r.rlogCheck?.mode === 'whole' && !r.rlogsAvailable) {
      issues.push(`\`${r.originalText}\` is missing some logs. Upload all logs from your device, then check again.`);
    } else if (r.rlogCheck?.mode === 'segment' && r.rlogCheck.missing.length > 0) {
      const segList = formatSegmentList(r.rlogCheck.missing);
      issues.push(`\`${r.originalText}\` is missing logs for segment(s) **${segList}**. Upload them, then check again.`);
    }
  }
  return issues;
}
