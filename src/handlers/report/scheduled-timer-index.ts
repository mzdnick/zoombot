import type { Client } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger, type ModuleLogger } from '../../logger.js';

const INDEX_KEY = 'pending';

// Extracted from close-scheduler/snooze-scheduler, which had duplicated this
// store/mutate-chain/timer bookkeeping and already drifted between copies.
// Subclasses only define the entry shape, `wakeAtOf`, and `fire`.
export abstract class ScheduledTimerIndex<TEntry> {
  protected readonly log: ModuleLogger;
  private readonly store: ReturnType<typeof createStore<Record<string, TEntry>>>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();
  protected client: Client | null = null;

  constructor(namespace: string, logNamespace: string) {
    this.store = createStore<Record<string, TEntry>>(namespace);
    this.log = createLogger(logNamespace);
  }

  protected async readIndex(): Promise<Record<string, TEntry>> {
    return (await this.store.get(INDEX_KEY)) ?? {};
  }

  protected mutate(fn: (index: Record<string, TEntry>) => void): Promise<void> {
    const run = this.chain.then(async () => {
      const index = await this.readIndex();
      fn(index);
      await this.store.set(INDEX_KEY, index);
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async get(threadId: string): Promise<TEntry | undefined> {
    return (await this.readIndex())[threadId];
  }

  // Atomically reads and removes an entry through the mutate chain, so two
  // concurrent claimants (e.g. a manual action racing an in-flight wake timer)
  // can never both observe the entry as present - the second always gets
  // undefined and no-ops.
  protected async claim(threadId: string): Promise<TEntry | undefined> {
    let claimed: TEntry | undefined;
    await this.mutate(index => {
      claimed = index[threadId];
      delete index[threadId];
    });
    return claimed;
  }

  protected clearTimer(threadId: string): void {
    const existing = this.timers.get(threadId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(threadId);
    }
  }

  protected armTimer(threadId: string, wakeAt: number): void {
    this.clearTimer(threadId);
    this.timers.set(threadId, setTimeout(() => {
      this.timers.delete(threadId);
      void this.fire(threadId);
    }, Math.max(0, wakeAt - Date.now())));
  }

  async cancel(threadId: string): Promise<void> {
    this.clearTimer(threadId);
    await this.mutate(index => { delete index[threadId]; });
  }

  init(c: Client): void {
    this.client = c;
    void this.recover();
  }

  private async recover(): Promise<void> {
    const index = await this.readIndex();
    const ids = Object.keys(index);
    if (ids.length === 0) return;
    this.log.info(`Recovering ${ids.length} scheduled item(s)`);
    for (const id of ids) this.armTimer(id, this.wakeAtOf(index[id]));
  }

  protected abstract wakeAtOf(entry: TEntry): number;
  protected abstract fire(threadId: string): Promise<void>;
}
