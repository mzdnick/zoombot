// Report priority model: staff-classified 0 (highest) .. 5 (lowest), surfaced as
// a forum tag ("Priority N") and an emoji in the thread title right after the
// status color. Tickets without a priority have neither — the default state for
// everything created before this system.

export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const PRIORITY_EMOJIS: Record<PriorityLevel, string> = {
  0: '0️⃣',
  1: '1️⃣',
  2: '2️⃣',
  3: '3️⃣',
  4: '4️⃣',
  5: '5️⃣',
};

export const PRIORITY_LEVELS = Object.keys(PRIORITY_EMOJIS).map(Number) as PriorityLevel[];

/** New bug reports default to this; feedback/feature requests start unclassified. */
export const DEFAULT_BUG_PRIORITY = 3;

export const PRIORITY_TAG_NAMES = PRIORITY_LEVELS.map(p => `Priority ${p}`);

const PRIORITY_BY_EMOJI = new Map(
  Object.entries(PRIORITY_EMOJIS).map(([value, emoji]) => [emoji, Number(value) as PriorityLevel]),
);

/** Reads the priority emoji token right after the status emoji, if any. */
export function priorityFromTitle(name: string): PriorityLevel | null {
  const tokens = name.split(' ');
  if (tokens.length < 2) return null;
  return PRIORITY_BY_EMOJI.get(tokens[1]) ?? null;
}

const PRIORITY_TAG_RE = /^Priority ([0-9]+)$/;
const PRIORITY_LEVEL_SET = new Set<number>(PRIORITY_LEVELS);

/** Reads the priority from tag names — the reliable copy (titles are rate-limited). */
export function priorityFromTags(tagNames: string[]): PriorityLevel | null {
  for (const tag of tagNames) {
    const m = tag.match(PRIORITY_TAG_RE);
    if (m && PRIORITY_LEVEL_SET.has(Number(m[1]))) return Number(m[1]) as PriorityLevel;
  }
  return null;
}

/** Removes the priority emoji token (and its trailing space), preserving the rest. */
export function stripPriorityEmoji(name: string): string {
  const tokens = name.split(' ');
  if (tokens.length < 2 || !PRIORITY_BY_EMOJI.has(tokens[1])) return name;
  const rest = tokens.slice(2);
  return rest.length > 0 ? `${tokens[0]} ${rest.join(' ')}` : tokens[0];
}

/** Sets, replaces, or removes (null) the priority emoji after the status emoji. */
export function setPriorityInTitle(name: string, priority: PriorityLevel | null): string {
  const base = stripPriorityEmoji(name);
  if (priority == null) return base;
  const status = base.split(' ', 1)[0];
  const rest = base.slice(status.length).replace(/^ /, '');
  return `${status} ${PRIORITY_EMOJIS[priority]}${rest ? ` ${rest}` : ''}`;
}
