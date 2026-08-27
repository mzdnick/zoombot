import { createStore } from './store.js';

// Runtime-writable config, persisted in the shared KV store. Intended to grow
// into the home for settings that migrate off env vars over time.
const configStore = createStore<unknown>('runtime-config');

export async function readConfigKey<T>(key: string): Promise<T | undefined> {
  return configStore.get(key) as T | undefined;
}

export async function writeConfigKey(key: string, value: unknown): Promise<void> {
  await configStore.set(key, value);
}

export async function deleteConfigKey(key: string): Promise<void> {
  await configStore.delete(key);
}
