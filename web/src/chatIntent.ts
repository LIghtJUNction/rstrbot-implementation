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
  | { kind: 'corrupt' }
  | { kind: 'pending'; intent: ChatIntent };

const storageKey = (user: string, workspace: string, conversation: string) =>
  `rstrbot:chat-intent:${user}:${workspace}:${conversation}`;

export function readChatIntent(user: string, workspace: string, conversation: string): IntentState {
  let raw: string | null;
  try { raw = localStorage.getItem(storageKey(user, workspace, conversation)); }
  catch { return { kind: 'unavailable' }; }
  if (raw === null) return { kind: 'none' };
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || !('key' in data) || !('conversationId' in data) || !('text' in data) || !('modelId' in data) || !('agentId' in data)) return { kind: 'corrupt' };
    if (typeof data.key !== 'string' || !data.key || data.conversationId !== conversation || typeof data.text !== 'string' || !data.text || typeof data.modelId !== 'string' || !data.modelId || typeof data.agentId !== 'string') return { kind: 'corrupt' };
    return { kind: 'pending', intent: { key: data.key, conversationId: conversation, text: data.text, modelId: data.modelId, agentId: data.agentId } };
  } catch { return { kind: 'corrupt' }; }
}

export function saveChatIntent(user: string, workspace: string, intent: ChatIntent): boolean {
  try {
    const key = storageKey(user, workspace, intent.conversationId);
    localStorage.setItem(key, JSON.stringify(intent));
    return localStorage.getItem(key) === JSON.stringify(intent);
  } catch { return false; }
}

export function clearChatIntent(user: string, workspace: string, conversation: string, expectedKey?: string): boolean {
  try {
    if (expectedKey !== undefined) {
      const current = readChatIntent(user, workspace, conversation);
      if (current.kind !== 'pending' || current.intent.key !== expectedKey) return false;
    }
    const key = storageKey(user, workspace, conversation);
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
  } catch { return false; }
}
