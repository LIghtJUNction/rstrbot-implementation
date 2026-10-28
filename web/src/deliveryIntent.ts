export type DeliveryIntent = { key: string; text: string; started: boolean; routeVersion: number; receiptId?: string };
type Result = { kind: 'ready'; intent: DeliveryIntent | null } | { kind: 'unavailable' | 'coordination' | 'corrupt' | 'conflict' };

function parse(raw: string): DeliveryIntent | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || !('key' in data) || !('text' in data) || !('started' in data) || !('routeVersion' in data)) return null;
    if (typeof data.key !== 'string' || !data.key || typeof data.text !== 'string' || typeof data.started !== 'boolean' || typeof data.routeVersion !== 'number' || !Number.isSafeInteger(data.routeVersion)) return null;
    if ('receiptId' in data && typeof data.receiptId !== 'string') return null;
    return { key: data.key, text: data.text, started: data.started, routeVersion: data.routeVersion, ...('receiptId' in data && typeof data.receiptId === 'string' ? { receiptId: data.receiptId } : {}) };
  } catch { return null; }
}
function same(a: DeliveryIntent, b: DeliveryIntent): boolean {
  return a.key === b.key && a.text === b.text && a.started === b.started && a.routeVersion === b.routeVersion && a.receiptId === b.receiptId;
}
function read(key: string): Result {
  try {
    const raw = localStorage.getItem(key); const legacy = sessionStorage.getItem(key);
    const current = raw === null ? null : parse(raw); const old = legacy === null ? null : parse(legacy);
    if ((raw !== null && !current) || (legacy !== null && !old)) return { kind: 'corrupt' };
    if (old?.started) {
      if (current && !same(current, old)) return { kind: 'conflict' };
      if (!current) { const serialized = JSON.stringify(old); localStorage.setItem(key, serialized); if (localStorage.getItem(key) !== serialized) return { kind: 'unavailable' }; }
      sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) !== null) return { kind: 'unavailable' };
      return { kind: 'ready', intent: old };
    }
    return { kind: 'ready', intent: current };
  } catch { return { kind: 'unavailable' }; }
}
async function locked(key: string, work: () => Result): Promise<Result> {
  try {
    if (!navigator.locks) return { kind: 'coordination' };
    return await navigator.locks.request(key, { mode: 'exclusive' }, work);
  } catch { return { kind: 'unavailable' }; }
}
export function loadDeliveryIntent(key: string): Promise<Result> { return locked(key, () => read(key)); }
export function writeDeliveryIntent(key: string, expected: DeliveryIntent | null, next: DeliveryIntent | null): Promise<Result> {
  return locked(key, () => {
    const current = read(key);
    if (current.kind !== 'ready') return current;
    if ((current.intent === null) !== (expected === null) || (current.intent && expected && !same(current.intent, expected))) return { kind: 'conflict' };
    try {
      if (next) { const raw = JSON.stringify(next); localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) return { kind: 'unavailable' }; }
      else {
        if (current.intent?.started) {
          const archived = current.intent;
          const historyKey = `${key}:history`; const raw = localStorage.getItem(historyKey);
          const history: unknown = raw === null ? [] : JSON.parse(raw);
          if (!Array.isArray(history) || history.some(item => !parse(JSON.stringify(item)))) return { kind: 'corrupt' };
          if (!history.some(item => { const parsed = parse(JSON.stringify(item)); return parsed && same(parsed, archived); })) history.push(archived);
          const saved = JSON.stringify(history); localStorage.setItem(historyKey, saved);
          if (localStorage.getItem(historyKey) !== saved) return { kind: 'unavailable' };
        }
        localStorage.removeItem(key); if (localStorage.getItem(key) !== null) return { kind: 'unavailable' };
      }
      return { kind: 'ready', intent: next };
    } catch { return { kind: 'unavailable' }; }
  });
}
