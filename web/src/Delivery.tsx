import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { api, formatTime, post, value } from './api';
import type { Resource } from './api';
import { resourcePath, useResources, workspacePath } from './data';
import { Button, ErrorNotice, Field, Loading, LoadMore, Modal, Status, useText } from './ui';
import { loadDeliveryIntent, writeDeliveryIntent } from './deliveryIntent';
import type { DeliveryIntent as Intent } from './deliveryIntent';

export function SendDialog({ workspace, user, route, close, saved }: {
  workspace: string; user: string; route: Resource; close: () => void; saved: () => void;
}) {
  const { t } = useText();
  const storageKey = `rstrbot:delivery:${user}:${workspace}:${route.id}`;
  const fresh = (): Intent => ({ key: crypto.randomUUID(), text: '', started: false, routeVersion: route.version });
  const [intent, setIntent] = useState<Intent>(fresh);
  const [ready, setReady] = useState(false);
  const currentIntent = useRef(intent); currentIntent.current = intent;
  const [receipt, setReceipt] = useState<Resource | null>(null); const [receiptLoading, setReceiptLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [externalChecked, setExternalChecked] = useState(false);
  const storageError = () => new Error(t('无法安全保存或协调投递记录。请检查浏览器存储及其他标签页，核对目标后再操作。', 'Cannot safely save or coordinate this delivery. Check browser storage and other tabs, then review the receiver.'));
  useEffect(() => {
    let active = true;
    const refresh = () => { void loadDeliveryIntent(storageKey).then(result => {
      if (!active) return;
      if (result.kind !== 'ready') { setReady(false); setError(storageError()); return; }
      setReady(true); setIntent(previous => result.intent ?? (previous.started ? fresh() : previous));
      setExternalChecked(false);
    }); };
    refresh();
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      if (!currentIntent.current.started && currentIntent.current.text.trim()) { setReady(false); setError(storageError()); return; }
      refresh();
    };
    window.addEventListener('storage', changed);
    return () => { active = false; window.removeEventListener('storage', changed); };
  }, [storageKey]);
  useEffect(() => {
    if (!intent.receiptId) { setReceipt(null); return; }
    const controller = new AbortController(); setReceiptLoading(true); setError(null);
    void api<Resource>(resourcePath(workspace, intent.receiptId), { signal: controller.signal }).then(current => {
      if (!controller.signal.aborted) setReceipt(current);
    }).catch(cause => { if (!controller.signal.aborted) { setReceipt(null); setError(cause); } }).finally(() => { if (!controller.signal.aborted) setReceiptLoading(false); });
    return () => controller.abort();
  }, [workspace, intent.receiptId]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const currentRoute = await api<Resource>(resourcePath(workspace, route.id));
      if (currentRoute.version !== intent.routeVersion) throw new Error(t('渠道配置已变化。请核对最新地址后，再决定是否创建新投递。', 'The route configuration changed. Review the current destination before deciding whether to create a new delivery.'));
      if (currentRoute.data.enabled !== true) throw new Error(t('此渠道当前已停用，消息没有提交。', 'This route is disabled; the message was not submitted.'));
      const next = { ...intent, started: true };
      const prepared = await writeDeliveryIntent(storageKey, intent.started ? intent : null, next);
      if (prepared.kind !== 'ready') throw storageError();
      setIntent(next);
      const response = await post<Resource>(`${workspacePath(workspace)}/routes/${encodeURIComponent(route.id)}/send`, {
        text: next.text, idempotency_key: next.key,
      });
      const finished = await writeDeliveryIntent(storageKey, next, { ...next, receiptId: response.id });
      if (finished.kind !== 'ready') throw storageError();
      setIntent({ ...next, receiptId: response.id }); setReceipt(null); saved();
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  async function newMessage() {
    setBusy(true); setError(null);
    const result = await writeDeliveryIntent(storageKey, intent, null);
    if (result.kind !== 'ready') setError(storageError());
    else { setIntent(fresh()); setReceipt(null); setExternalChecked(false); }
    setBusy(false);
  }
  const textBytes = new TextEncoder().encode(intent.text).length;
  const status = receipt ? value(receipt.data, 'status', 'unknown') : '';
  const needsReview = ['unknown', 'prepared', 'sending', 'rejected'].includes(status) || (intent.started && !intent.receiptId);
  const canCreateNew = intent.receiptId ? !!receipt && (!needsReview || externalChecked) : intent.started && externalChecked;
  return <Modal title={t('发送到渠道', 'Send to channel')} close={() => { if (!busy) close(); }} closeDisabled={busy}>
    <form className="stack" onSubmit={submit}>
      <p><strong>{value(route.data, 'name', route.id)}</strong></p>
      <p className="muted small">{value(route.data, 'url')}</p>
      <Field label={t('消息内容', 'Message')} hint={t('只发送到此渠道保存的地址。接收端可能记录这条消息。', 'This sends to the saved destination. The receiver may store your message.')}>
        <textarea value={intent.text} rows={6} required disabled={intent.started || !!intent.receiptId}
          onChange={e => setIntent({ ...intent, text: e.target.value })} />
      </Field>
      <p className={`small ${textBytes > 32768 ? 'field-error' : 'muted'}`}>{textBytes.toLocaleString()} / 32,768 {t('UTF-8 字节', 'UTF-8 bytes')}</p>
      <ErrorNotice error={error} />
      {intent.started && !intent.receiptId && !busy && <div className="stack"><p className="info-line">{t('结果尚未确认。继续原请求会沿用相同编号；如果服务器还没收到第一次请求，这次会成为首次发送。', 'The result is unconfirmed. Continuing uses the same request ID; if the server never received the first request, this will send it for the first time.')}</p><p className="small muted">{t('先刷新投递记录并核对目标端。接口不能把读取到的渠道版本原子绑定到后续发送。', 'Refresh the delivery list and check the receiver first. The API cannot atomically bind the route version you read to a later send.')}</p></div>}
      {intent.receiptId && receiptLoading && <Loading text={t('正在读取投递回执…', 'Reading delivery receipt…')} />}
      {receipt && <div className="stack" role="status"><Status state={status} />
        <p className="small muted">{t('投递编号：', 'Delivery ID: ')}{receipt.id}</p>
        <p>{status === 'accepted' ? t('接收端已接受请求。此回执不表示最终收件人已经阅读。', 'The receiver accepted the request. This receipt does not confirm that the final recipient read it.') : needsReview ? t('结果需要在目标端核对。未知或拒绝回执不代表对方一定没有收到消息。', 'Check the receiver. An unknown or rejected receipt does not prove that the message was not received.') : status === 'not_sent' ? t('服务端确认这次没有发送。修复问题后，可明确创建新的投递。', 'The server confirmed that this attempt was not sent. Fix the issue before explicitly creating a new delivery.') : t('投递未被接收端接受。对方仍可能已产生副作用；核对后再决定下一步。', 'The receiver did not accept the delivery. It may still have caused side effects; check before deciding what to do next.')}</p>
      </div>}
      {intent.started && needsReview && <label className="check-field"><input type="checkbox" checked={externalChecked} onChange={event => setExternalChecked(event.target.checked)} /><span>{t('我已在目标端核对，仍要创建一条新的投递', 'I checked the receiver and still want to create a new delivery')}</span></label>}
      <div className="dialog-actions"><Button type="button" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button>
        {intent.started && <Button type="button" disabled={busy} onClick={saved}>{t('刷新我的投递记录', 'Refresh my delivery records')}</Button>}
        {!intent.receiptId && <Button type="submit" variant="primary" busy={busy} disabled={!ready || !intent.text.trim() || textBytes > 32768}><Send size={16} />{intent.started ? t('继续原发送请求', 'Continue original send request') : t('发送消息', 'Send message')}</Button>}
        {canCreateNew && <Button type="button" disabled={busy || !ready} onClick={() => { void newMessage(); }}>{t('创建另一条消息', 'Create another message')}</Button>}
        {receipt && <Button type="button" disabled={receiptLoading} onClick={() => { setReceipt(null); setError(null); const id = intent.receiptId; if (id) void api<Resource>(resourcePath(workspace, id)).then(setReceipt).catch(setError); }}>{t('刷新回执', 'Refresh receipt')}</Button>}
      </div>
    </form>
  </Modal>;
}

export function DeliveryHistory({ workspace }: { workspace: string }) {
  const { t, language } = useText();
  const query = useResources(workspace, 'deliveries', 5000);
  return <section className="stack" aria-label={t('我的投递记录', 'My deliveries')}>
    <h2>{t('我的投递记录', 'My deliveries')}</h2>
    <p className="muted small">{t('回执仅本人可见。需要核对的记录不会自动重发。', 'Receipts are private to you. Deliveries requiring review are never automatically replayed.')}</p>
    <ErrorNotice error={query.error} onRetry={() => { void query.refetch(); }} />
    {query.isPending ? <Loading /> : <div className="resource-list">{query.data?.map(receipt => <article className="resource-row" key={receipt.id}>
      <div className="resource-main"><p className="resource-description">{value(receipt.data, 'text')}</p>
        <p className="small muted">{receipt.id} · {formatTime(receipt.updated_at, language)}</p></div>
      <Status state={value(receipt.data, 'status', 'unknown')} />
    </article>)}{!query.data?.length && <p className="muted">{t('还没有投递记录。', 'No deliveries yet.')}</p>}</div>}
    <LoadMore query={query} label={t('加载更早的投递', 'Load older deliveries')} />
  </section>;
}
