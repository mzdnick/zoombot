export interface ReportSummary {
  threadId: string;
  threadName: string;
  url: string;
  tagNames: string[];
  createdTimestamp: number;
  archived: boolean;
  snoozedUntil?: number;
}

export const CATEGORY_ORDER = [
  'Needs your Attention',
  'Waiting for Dev',
  'Snoozed',
  'Closed',
] as const;

export type ReportCategory = (typeof CATEGORY_ORDER)[number];

export function reportCategory(tagNames: string[], archived: boolean): ReportCategory {
  const tags = new Set(tagNames.map(name => name.toUpperCase()));
  // Status tags are never removed, so an explicit close wins over everything;
  // an archived thread is only a close signal when it isn't snoozed (snoozed
  // threads archive too).
  const closed = tags.has('CLOSED') || tags.has('FIXED') || (archived && !tags.has('SNOOZED'));
  if (closed) return 'Closed';
  if (tags.has('SNOOZED')) return 'Snoozed';
  if (tags.has('WAITING FOR USER')) return 'Needs your Attention';
  return 'Waiting for Dev';
}

export function sortReports<T extends ReportSummary>(reports: T[]): T[] {
  return [...reports].sort((a, b) => {
    const byCategory = CATEGORY_ORDER.indexOf(reportCategory(a.tagNames, a.archived))
      - CATEGORY_ORDER.indexOf(reportCategory(b.tagNames, b.archived));
    if (byCategory !== 0) return byCategory;
    return b.createdTimestamp - a.createdTimestamp;
  });
}

// Thread names carry their ticket id as a " (12345)" suffix; fall back to the
// numeric read of the thread id tail (matches updateThreadButtons).
export function extractTicketId(threadName: string, threadId: string): string {
  const match = threadName.match(/\((\d+)\)\s*$/);
  if (match) return match[1];
  return String(parseInt(threadId.slice(-7), 10));
}

export const PAGE_SIZE = 20;

export function paginateReports<T>(reports: T[], requestedPage: number): {
  pageItems: T[];
  page: number;
  totalPages: number;
} {
  const totalPages = Math.max(1, Math.ceil(reports.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  return {
    pageItems: reports.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    totalPages,
  };
}
