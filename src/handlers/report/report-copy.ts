import { StoredReport } from './report-store.js';

export type ReportLabel = 'Bug Report' | 'Feature Request' | 'Feedback' | 'Split' | 'Report';

const TITLE_LABELS: ReportLabel[] = ['Bug Report', 'Feature Request', 'Feedback'];

/** Resolves a thread's report label from the store, falling back to its title. */
export async function labelForThread(threadId: string, threadName = ''): Promise<ReportLabel> {
  const stored = await StoredReport.get(threadId);
  const label = stored?.data.label as ReportLabel | undefined;
  if (label && label !== 'Split' && label !== 'Report') return label;
  for (const l of TITLE_LABELS) if (threadName.includes(l)) return l;
  return label ?? 'Report';
}

/** Lowercase noun phrase for use in sentences: "this bug report will close...". */
export function reportNoun(label: string): string {
  if (label === 'Bug Report') return 'bug report';
  if (label === 'Feature Request') return 'feature request';
  if (label === 'Feedback') return 'feedback';
  return 'report';
}

/** Label for the user-facing resolve button in the WaitUser flow. */
export function fixedButtonLabel(label: string): string {
  if (label === 'Bug Report') return 'My Issue is Fixed';
  if (label === 'Feature Request') return 'My Request is Fulfilled';
  if (label === 'Feedback') return 'My Feedback is Addressed';
  return 'My Report is Resolved';
}

/** Title for the resolve confirmation modal. */
export function fixedModalTitle(label: string): string {
  if (label === 'Bug Report') return 'Confirm - Issue Resolved?';
  if (label === 'Feature Request') return 'Confirm - Request Fulfilled?';
  if (label === 'Feedback') return 'Confirm - Feedback Addressed?';
  return 'Confirm - Resolved?';
}
