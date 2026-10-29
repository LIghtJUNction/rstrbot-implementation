import { notifySessionChange } from './sessionChange.ts';

export type Json = Record<string, unknown>;
export type User = { id: string; username: string; is_admin?: boolean; instance_admin?: boolean };
export type Workspace = { id: string; name: string; role: string };
export type Resource = {
  id: string; workspace_id: string; owner_id: string; kind: string;
  visibility: 'private' | 'workspace'; version: number; data: Json;
  created_at: string | number; updated_at: string | number;
};
export type Setup = { initialized: boolean; database?: string; valkey?: string | boolean; valkey_status?: string; data_dir?: string; database_selection?: boolean };
export type Message = { id?: string; role: string; content: string; tool_call_id?: string; name?: string; created_at?: string | number; citations?: unknown; attachments?: unknown; images?: unknown };
export type Event = { id: number; resource_id?: string; kind?: string; event_type?: string; data: Json; created_at?: string | number };

export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export class TransportError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); this.name = 'TransportError'; }
}

// A network failure may leave a readable cached view. An explicit access or
// existence failure must not keep showing a resource that the server denied.
export function isResourceUnavailable(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/v1${path}`, {
    ...options, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(options.method && options.method !== 'GET' ? { 'X-RstrBot-Request': '1' } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  }); } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new TransportError(cause);
  }
  if (response.ok && options.method === 'POST' && ['/auth/login', '/auth/passkeys/login/finish', '/auth/logout', '/setup'].includes(path) && typeof window !== 'undefined') notifySessionChange();
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error;
    const code = detail?.code ?? payload.code ?? `HTTP_${response.status}`;
    // Credential proof failures do not revoke an otherwise valid session.
    if (response.status === 401 && code === 'unauthorized' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('rstrbot:session-expired'));
    }
    throw new ApiError(response.status, code,
      typeof detail === 'string' ? detail : detail?.message ?? payload.message ?? response.statusText);
  }
  return payload as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = (path: string, version?: number) => api<void>(`${path}${version === undefined ? '' : `?version=${version}`}`, { method: 'DELETE' });
export const items = <T>(response: { items: T[] } | T[]): T[] => Array.isArray(response) ? response : response.items ?? [];
export const value = (data: Json, key: string, fallback = ''): string => typeof data[key] === 'string' ? data[key] as string : fallback;
export const number = (data: Json, key: string, fallback = 0): number => typeof data[key] === 'number' ? data[key] as number : fallback;
export const unwrap = <T>(data: T | { resource: T }): T => data && typeof data === 'object' && 'resource' in data ? data.resource : data as T;

export function friendlyError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function formatTime(time: string | number | undefined, language: string): string {
  if (time === undefined) return '—';
  const date = new Date(typeof time === 'number' && time < 1e12 ? time * 1000 : time);
  return Number.isNaN(date.getTime()) ? String(time) : date.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function downloadJson(name: string, payload: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
