// Messages contain only an invalidation nonce, never an identity or credential.
const channelName = 'rstrbot:auth-change';
const sender = crypto.randomUUID();

export function notifySessionChange() {
  try { localStorage.setItem(channelName, crypto.randomUUID()); } catch { /* BroadcastChannel also works without local storage. */ }
  try {
    if (typeof window.BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(channelName);
      channel.postMessage({ sender }); channel.close();
    }
  } catch { /* Session changes also revalidate on focus. */ }
}

export function listenForSessionChange(invalidate: () => void) {
  const storageChanged = (event: StorageEvent) => { if (event.key === channelName) invalidate(); };
  window.addEventListener('storage', storageChanged);
  let channel: BroadcastChannel | null = null;
  try {
    channel = typeof window.BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
    if (channel) channel.onmessage = (event: MessageEvent<unknown>) => { if (event.data && typeof event.data === 'object' && 'sender' in event.data && event.data.sender !== sender) invalidate(); };
  } catch { /* Storage events and focus remain available. */ }
  return () => { window.removeEventListener('storage', storageChanged); channel?.close(); };
}
