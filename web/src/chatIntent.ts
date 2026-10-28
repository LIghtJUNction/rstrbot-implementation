export type ChatIntent = {
  key: string;
  conversationId: string;
  text: string;
  modelId: string;
  agentId: string;
};

export type IntentState =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'coordination' }
  | { kind: 'corrupt'; raw: string }
  | { kind: 'pending'; intent: ChatIntent };

export const chatIntentStorageKey = (user: string, workspace: string, conversation: string) =>
  `rstrbot:chat-intent:${user}:${workspace}:${conversation}`;

export function readChatIntent(user: string, workspace: string, conversation: string): IntentState {
  let raw: string | null;
  try { raw = localStorage.getItem(chatIntentStorageKey(user, workspace, conversation)); }
  catch { return { kind: 'unavailable' }; }
  if (raw === null) return { kind: 'none' };
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || !('key' in data) || !('conversationId' in data) || !('text' in data) || !('modelId' in data) || !('agentId' in data)) return { kind: 'corrupt', raw };
    if (typeof data.key !== 'string' || !data.key || data.conversationId !== conversation || typeof data.text !== 'string' || !data.text || typeof data.modelId !== 'string' || !data.modelId || typeof data.agentId !== 'string') return { kind: 'corrupt', raw };
    return { kind: 'pending', intent: { key: data.key, conversationId: conversation, text: data.text, modelId: data.modelId, agentId: data.agentId } };
  } catch { return { kind: 'corrupt', raw }; }
}

// All tabs use the same browser lock for a conversation. Never hold it across
// network calls; the core remains responsible for authoritative idempotency.
async function withIntentLock<T>(user: string, workspace: string, conversation: string, work: () => T): Promise<T | null> {
  try {
    if (!navigator.locks) return null;
    return await navigator.locks.request(chatIntentStorageKey(user, workspace, conversation), { mode: 'exclusive' }, work);
  } catch { return null; }
}

export async function prepareChatIntent(user: string, workspace: string, proposed: Omit<ChatIntent, 'key'>): Promise<IntentState> {
  const result = await withIntentLock(user, workspace, proposed.conversationId, () => {
    const current = readChatIntent(user, workspace, proposed.conversationId);
    if (current.kind !== 'none') return current;
    const intent: ChatIntent = { ...proposed, key: crypto.randomUUID() };
    try {
      const key = chatIntentStorageKey(user, workspace, proposed.conversationId);
      const raw = JSON.stringify(intent);
      localStorage.setItem(key, raw);
      return localStorage.getItem(key) === raw ? { kind: 'pending', intent } as const : { kind: 'unavailable' } as const;
    } catch { return { kind: 'unavailable' } as const; }
  });
  return result ?? { kind: 'coordination' };
}

type ClearResult = { kind: 'cleared' } | { kind: 'changed'; current: IntentState } | { kind: 'unavailable' } | { kind: 'coordination' };
export async function clearChatIntent(user: string, workspace: string, conversation: string, expected: IntentState): Promise<ClearResult> {
  const result = await withIntentLock(user, workspace, conversation, () => {
    const current = readChatIntent(user, workspace, conversation);
    if (current.kind === 'unavailable') return { kind: 'unavailable' } as const;
    const same = (expected.kind === 'pending' && current.kind === 'pending' && expected.intent.key === current.intent.key && expected.intent.text === current.intent.text && expected.intent.modelId === current.intent.modelId && expected.intent.agentId === current.intent.agentId) ||
      (expected.kind === 'corrupt' && current.kind === 'corrupt' && expected.raw === current.raw);
    if (!same) return { kind: 'changed', current } as const;
    try {
      const key = chatIntentStorageKey(user, workspace, conversation);
      localStorage.removeItem(key);
      return localStorage.getItem(key) === null ? { kind: 'cleared' } as const : { kind: 'unavailable' } as const;
    } catch { return { kind: 'unavailable' } as const; }
  });
  return result ?? { kind: 'coordination' };
}
