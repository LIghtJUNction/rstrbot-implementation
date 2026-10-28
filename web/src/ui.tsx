import { cloneElement, isValidElement, createContext, useContext, useEffect, useId, useRef } from 'react';
import type { AriaAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { AlertCircle, ArrowRight, LoaderCircle, X } from 'lucide-react';
import { ApiError, friendlyError, TransportError } from './api';

export type Language = 'zh' | 'en';
export const LanguageContext = createContext<Language>('zh');
export function useText() {
  const language = useContext(LanguageContext);
  return { language, t: (zh: string, en: string) => language === 'zh' ? zh : en };
}

export function Button({ children, className = '', busy, variant = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: string }) {
  return <button {...rest} disabled={rest.disabled || busy} className={`button ${variant} ${className}`}>
    {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{children}
  </button>;
}

export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'small' : ''}`}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 26V6h14l5 7-11 6 11 7h-8L7 18l14-6h-8v14" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" /></svg><span>RstrBot<span className="brand-dot">.</span></span></span>;
}

export function ErrorNotice({ error, onRetry, draftPreserved, onReview, onConfigureModels }: { error: unknown; onRetry?: () => void; draftPreserved?: boolean; onReview?: () => void; onConfigureModels?: () => void }) {
  const { t } = useText();
  if (!error) return null;
  if (error instanceof ApiError) {
    const guidance = new Map([
      ['provider_authentication_failed', t('模型服务未接受凭据。请检查模型配置中的密钥；如果没有编辑权限，请联系工作区管理员。', 'The model provider rejected the credentials. Check the key in model settings, or contact a workspace administrator if you cannot edit it.')],
      ['provider_access_denied', t('模型服务拒绝访问。请检查模型和服务商授权；如果没有编辑权限，请联系工作区管理员。', 'The model provider denied access. Check the model and provider permissions, or contact a workspace administrator if you cannot edit them.')],
      ['provider_rate_limited', t('模型服务请求过于频繁。请稍等，核对运行记录后再手动尝试。', 'The model provider is rate limiting requests. Wait, review the run record, and try again manually.')],
    ]);
    const message = guidance.get(error.code);
    if (message) return <div className="notice error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>{t('模型服务拒绝了请求', 'The model provider rejected the request')}</strong><p>{message}</p></div>{onConfigureModels && error.code !== 'provider_rate_limited' && <Button type="button" onClick={onConfigureModels}>{t('查看模型配置', 'View model settings')}</Button>}</div>;
  }
  if (error instanceof TransportError) return <div className="notice error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>{t('连接中断，结果尚未确认', 'Connection interrupted; result unconfirmed')}</strong><p>{draftPreserved ? t('草稿仍在。请检查网络，并先核对会话与运行记录，再决定是否手动发送。请求可能已送达；恢复连接不会自动重发。', 'Your draft is still here. Check your connection, then review conversation and run records before sending manually. The request may have arrived; reconnecting will not resend it automatically.') : t('请检查网络或服务连接。请求可能已送达；先核对最新记录，再决定是否重试。', 'Check your network or service connection. The request may have arrived; review the latest records before retrying.')}</p><details><summary>{t('技术详情', 'Technical details')}</summary><p>{friendlyError(error)}</p></details></div>{onReview && <Button type="button" onClick={onReview}>{t('核对会话记录', 'Review conversation records')}</Button>}{onRetry && <Button type="button" onClick={onRetry}>{t('重新读取', 'Reload records')}</Button>}</div>;
  return <div className="notice error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>{t('未能完成操作', 'The operation could not be completed')}</strong><p>{friendlyError(error)}</p></div>{onRetry && <Button type="button" onClick={onRetry}>{t('重试', 'Retry')}</Button>}</div>;
}

export function Loading({ text }: { text?: string }) {
  const { t } = useText();
  return <div className="loading" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" />{text ?? t('正在读取…', 'Loading…')}</div>;
}

export function Empty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-mark" aria-hidden="true">↗</div><h2>{title}</h2>{description && <p>{description}</p>}{action}</div>;
}

export function LoadMore({ query, label }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => Promise<unknown> }; label?: string }) {
  const { t } = useText();
  if (!query.hasNextPage) return null;
  return <div className="load-more"><Button type="button" busy={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{label ?? t('加载更多', 'Load more')}</Button></div>;
}

export function Modal({ title, children, close, wide = false, closeDisabled = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useText();
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); if (!closeDisabled) close(); }} onClick={e => { if (e.target === ref.current && !closeDisabled) close(); }} aria-labelledby={titleId}>
    <div className="dialog-inner"><header><h2 id={titleId}>{title}</h2><Button variant="ghost icon" disabled={closeDisabled} onClick={close} aria-label={t('关闭', 'Close')}><X size={20} /></Button></header>{children}</div>
  </dialog>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  const generated = useId();
  const control = isValidElement<{ id?: string } & AriaAttributes>(children) ? children : null;
  const id = control?.props.id ?? generated;
  const description = [control?.props['aria-describedby'], hint ? `${generated}-hint` : null, error ? `${generated}-error` : null].filter(Boolean).join(' ') || undefined;
  return <div className="field"><label htmlFor={id}>{label}</label>{control ? cloneElement(control, { id, 'aria-describedby': description, 'aria-invalid': error ? true : control.props['aria-invalid'] }) : children}{hint && <small id={`${generated}-hint`}>{hint}</small>}{error && <small className="field-error" id={`${generated}-error`} role="alert">{error}</small>}</div>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}

export function Status({ state }: { state?: string }) {
  const { t } = useText();
  const labels: Record<string, [string, string]> = {
    completed: ['已完成', 'Completed'], succeeded: ['已完成', 'Completed'], running: ['运行中', 'Running'], queued: ['已排队', 'Queued'], cancelled: ['已停止', 'Stopped'], failed: ['失败', 'Failed'], unknown: ['待核对', 'Needs review'], interrupted: ['已中断', 'Interrupted'],
    enabled: ['已启用', 'Enabled'], disabled: ['已停用', 'Disabled'], installed: ['已安装', 'Installed'], ready: ['可用', 'Ready'], indexed: ['可检索', 'Indexed'], indexing: ['建立索引', 'Indexing'], uploaded: ['已上传', 'Uploaded'], active: ['使用中', 'Active'], archived: ['已归档', 'Archived'], paused: ['已暂停', 'Paused'], pending: ['待执行', 'Pending'], degraded: ['已降级', 'Degraded'], accepted: ['已接受', 'Accepted'], rejected: ['已拒绝', 'Rejected'], prepared: ['待发送', 'Prepared'], sending: ['发送中', 'Sending'], not_sent: ['未发送', 'Not sent'], saved: ['已保存', 'Saved'], not_configured: ['未配置', 'Not configured'],
  };
  const pair = labels[state ?? ''];
  return <span className={`status state-${state ?? 'unknown'}`}><span aria-hidden="true" />{pair ? t(...pair) : state ?? t('未知', 'Unknown')}</span>;
}

export function LinkAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <Button variant="text" onClick={onClick}>{children}<ArrowRight size={16} aria-hidden="true" /></Button>;
}
