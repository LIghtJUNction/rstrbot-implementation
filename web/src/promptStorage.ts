export type PromptVersion = { id: string; savedAt: string; content: string };
export type PromptState = { draft: string; versions: PromptVersion[] };
export const maxVersions = 20;

export function promptStorageKey({ origin, userId }: { origin: string; userId: string }): string {
  return `rstrbot.build-prompt.v2:${JSON.stringify([origin, userId])}`;
}

export function readPromptState(storage: Pick<Storage, 'getItem'>, key: string, baseline: string): PromptState {
  const stored: unknown = JSON.parse(storage.getItem(key) ?? 'null');
  if (!stored || typeof stored !== 'object' || !('draft' in stored) || typeof stored.draft !== 'string' || !('versions' in stored) || !Array.isArray(stored.versions)) return { draft: baseline, versions: [] };
  const versions = stored.versions.filter((item): item is PromptVersion => !!item && typeof item === 'object' &&
    typeof item.id === 'string' && item.id.length > 0 && typeof item.savedAt === 'string' && Number.isFinite(Date.parse(item.savedAt)) && typeof item.content === 'string');
  return { draft: stored.draft, versions: versions.slice(0, maxVersions) };
}
