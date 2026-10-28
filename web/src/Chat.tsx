import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, GitBranch, LockKeyhole, Plus, RotateCcw, Search, Settings2, Sparkles, Square, Trash2, Users, X } from 'lucide-react';
import { api, ApiError, items, post, remove, value, unwrap } from './api';
import type { Event, Message, Resource, User, Workspace } from './api';
import { collectionPath, resourcePath, safePreference, savePreference, useMessages, useResource, useResources, workspacePath } from './data';
import { acknowledgeDraft, applyEventPage, emptyStream, normalizeMessages } from './conversation';
import type { StreamState } from './conversation';
import { canWriteResource, roleAllows } from './permissions';
import { Brand, Button, Empty, ErrorNotice, Field, Loading, LoadMore, Modal, Status, useText } from './ui';

function useEvents(workspace: string, active: boolean) {
  const client = useQueryClient();
  const key = [workspace, 'stream'];
  const [live, setLive] = useState<Record<string, string>>(() => client.getQueryData<StreamState>(key)?.live ?? {});
  const [error, setError] = useState<unknown>(null);
  const activeRef = useRef(active); activeRef.current = active;
  useEffect(() => {
    const controller = new AbortController(); let timer = 0; let running = true;
    const cacheKey = [workspace, 'stream'];
    let state = client.getQueryData<StreamState>(cacheKey) ?? emptyStream();
    async function poll() {
      try {
        const response = await api<{ items: Event[]; cursor: number }>(`${workspacePath(workspace)}/events?after=${state.cursor}&limit=100`, { signal: controller.signal });
        if (!running) return;
        setError(null);
        const { state: next, changed } = applyEventPage(state, response.items ?? [], response.cursor);
        state = next; client.setQueryData(cacheKey, state); setLive(state.live);
        if (changed) void client.invalidateQueries({ queryKey: [workspace] });
        timer = window.setTimeout(poll, response.items.length >= 100 ? 40 : activeRef.current ? 700 : 3000);
      } catch (e) {
        if (running && !controller.signal.aborted) {
          setError(e);
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
            setLive({}); running = false;
            client.removeQueries({ queryKey: [workspace] });
            void client.invalidateQueries({ queryKey: ['workspaces'] });
            if (e.status === 401) void client.invalidateQueries({ queryKey: ['me'] });
            return;
          }
          timer = window.setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => { running = false; controller.abort(); clearTimeout(timer); };
  }, [workspace, client]);
  return { live, error };
}

function MessageView({ message, onBranch }: { message: Message; onBranch?: () => void }) {
  const { t } = useText(); const [copied, setCopied] = useState(false);
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  if (message.role === 'system' || (message.role === 'assistant' && !content.trim())) return null;
  if (message.role === 'tool') return <details className="tool-message"><summary><Settings2 size={14} />{message.name ?? t('工具结果', 'Tool result')}</summary><pre>{content}</pre></details>;
  return <article className={`message ${message.role}`}><div className="message-byline">{message.role === 'user' ? <><span className="message-avatar">U</span>{t('你', 'You')}</> : <><Brand small /> <span className="muted small">{t('助手', 'Assistant')}</span></>}</div><div className="message-body">{content}</div><div className="message-actions"><Button variant="ghost icon" aria-label={t('复制消息', 'Copy message')} onClick={async () => { try { await navigator.clipboard.writeText(content); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}</Button>{onBranch && <Button variant="ghost" onClick={onBranch}><GitBranch size={14} />{t('编辑并分支', 'Edit as branch')}</Button>}</div></article>;
}

export default function Chat({ workspace, user, goModels }: { workspace: Workspace; user: User; goModels: () => void }) {
  const { t } = useText(); const client = useQueryClient(); const wid = workspace.id;
  const conversations = useResources(wid, 'conversations'); const models = useResources(wid, 'models'); const agents = useResources(wid, 'agents'); const runs = useResources(wid, 'runs', 2500);
  const [selected, setSelected] = useState<string | null>(null); const conversation = useResource(wid, selected, undefined, true); const history = useMessages(wid, selected);
  const draftPrefix = `draft:${user.id}:${wid}`;
  const [draft, setDraft] = useState(() => safePreference(`${draftPrefix}:new`)); const [model, setModel] = useState(''); const [agent, setAgent] = useState(''); const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [settings, setSettings] = useState(false); const [title, setTitle] = useState('');
  const [system, setSystem] = useState(''); const [visibility, setVisibility] = useState('private'); const [sidebar, setSidebar] = useState(false); const [conversationCollapsed, setConversationCollapsed] = useState(() => safePreference(`conversation-list-collapsed:${user.id}:${wid}`) === 'true'); const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null);
  const [branch, setBranch] = useState<Message | null>(null); const [branchText, setBranchText] = useState(''); const [hasNew, setHasNew] = useState(false);
  const idempotency = useRef<{ text: string; key: string } | null>(null); const messagesRef = useRef<HTMLDivElement>(null); const follow = useRef(true); const composing = useRef(false); const viewGeneration = useRef(0);
  const modelRestoredFor = useRef<string | null>(null);
  const draftVersion = useRef({ text: draft, revision: 0 });
  const readingPositions = useRef(new Map<string, { top: number; following: boolean }>());
  const restoreReadingPosition = useRef(false);
  const justRestoredReadingPosition = useRef(false);
  const olderPageAnchor = useRef<{ id: string; firstMessage?: string; height: number; top: number } | null>(null);
  useEffect(() => { savePreference(`conversation-list-collapsed:${user.id}:${wid}`, String(conversationCollapsed)); }, [conversationCollapsed, user.id, wid]);
  // Leaving this page is also a view change. Pending mutations cannot start a
  // second operation or overwrite persisted drafts after their view is gone.
  useLayoutEffect(() => () => { viewGeneration.current += 1; }, []);
  const unavailable = conversation.unavailable || history.unavailable;
  const sharedConversation = (selected ? conversation.data?.visibility : visibility) === 'workspace';
  const chosenModel = useResource(wid, model || null);
  const modelAllowed = chosenModel.data?.kind === 'models' && (!sharedConversation || chosenModel.data.visibility === 'workspace');
  const modelAvailable = !!model && !chosenModel.unavailable && !chosenModel.error && modelAllowed && chosenModel.data?.id === model;
  const selectableModels = (models.data ?? []).filter(item => !sharedConversation || item.visibility === 'workspace');
  const modelOptions = modelAllowed && chosenModel.data && !selectableModels.some(item => item.id === model) ? [...selectableModels, chosenModel.data] : selectableModels;
  const activeRunId = value(conversation.data?.data ?? {}, 'active_run');
  const activeRunQuery = useResource(wid, activeRunId || null, activeRunId ? 1500 : undefined);
  const activeRun = unavailable ? undefined : activeRunQuery.data && ['queued', 'running'].includes(value(activeRunQuery.data.data, 'status')) ? activeRunQuery.data : runs.data?.find(run => value(run.data, 'conversation_id') === selected && ['queued', 'running'].includes(value(run.data, 'status')));
  const latestRun = unavailable ? undefined : runs.data?.filter(run => value(run.data, 'conversation_id') === selected).sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
  const runError = latestRun && !activeRun && ['failed', 'unknown', 'interrupted'].includes(value(latestRun.data, 'status')) ? new ApiError(502, value(latestRun.data, 'error_code'), value(latestRun.data, 'error', t('运行未完成，请到运行记录中核对。', 'The run did not complete. Review its execution record.'))) : null;
  const { live, error: eventError } = useEvents(wid, !!activeRun);
  const messages = unavailable ? [] : normalizeMessages(history.data?.pages.slice().reverse().flatMap(page => page.items));
  const stream = activeRun ? live[activeRun.id] ?? value(activeRun.data, 'content') : '';
  const visibleConversations = conversations.data?.filter(c => value(c.data, 'title').toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const writable = !unavailable && (selected ? !!conversation.data && canWriteResource(workspace.role, user, conversation.data) : roleAllows(workspace.role, 'member'));
  const availableAgents = (agents.data ?? []).filter(candidate => !sharedConversation || candidate.visibility === 'workspace');
  useEffect(() => {
    if (sharedConversation && agents.data?.some(candidate => candidate.id === agent && candidate.visibility === 'private')) setAgent('');
  }, [sharedConversation, agents.data, agent]);
  useEffect(() => {
    if (!selected && selectableModels.length && !model) setModel(selectableModels[0].id);
  }, [selectableModels, model, selected]);
  useEffect(() => {
    if (!selected || conversation.data?.id !== selected || modelRestoredFor.current === selected) return;
    modelRestoredFor.current = selected;
    setModel(value(conversation.data.data, 'last_model_id'));
  }, [selected, conversation.data]);
  function selectAgent(id: string) {
    setAgent(id);
    const configuredModel = agents.data?.find(candidate => candidate.id === id)?.data.model_id;
    if (typeof configuredModel === 'string' && configuredModel) { modelRestoredFor.current = selected; setModel(configuredModel); }
  }
  function selectConversation(id: string | null) {
    if (id === selected) { setSidebar(false); return; }
    if (selected && messagesRef.current) readingPositions.current.set(selected, { top: messagesRef.current.scrollTop, following: follow.current });
    restoreReadingPosition.current = true; olderPageAnchor.current = null;
    const text = safePreference(`${draftPrefix}:${id ?? 'new'}`);
    viewGeneration.current += 1; draftVersion.current = { text, revision: draftVersion.current.revision + 1 };
    modelRestoredFor.current = null; setModel(''); setAgent('');
    setBusy(false); setSelected(id); setDraft(text); follow.current = true; setHasNew(false); idempotency.current = null; setSidebar(false); setError(null); setConfirm(null); setBranch(null);
  }
  const lastMessage = messages.at(-1);
  const latestMessageIdentity = `${lastMessage?.id ?? ''}:${lastMessage?.content ?? ''}`;
  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (!element || history.isPending && selected) return;
    if (restoreReadingPosition.current) {
      const position = selected ? readingPositions.current.get(selected) : undefined;
      follow.current = position?.following ?? true;
      element.scrollTop = follow.current ? element.scrollHeight : position?.top ?? 0;
      restoreReadingPosition.current = false;
      justRestoredReadingPosition.current = true;
      return;
    }
    const anchor = olderPageAnchor.current;
    if (anchor && anchor.id === selected && anchor.firstMessage !== messages[0]?.id) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      olderPageAnchor.current = null;
      return;
    }
    if (follow.current) element.scrollTop = element.scrollHeight;
  }, [selected, history.isPending, history.data, stream]);
  useEffect(() => {
    // Loading older pages does not mean that a new reply arrived.
    if (justRestoredReadingPosition.current) { justRestoredReadingPosition.current = false; return; }
    if (!follow.current && !restoreReadingPosition.current) setHasNew(true);
  }, [selected, latestMessageIdentity, stream]);
  async function loadOlderMessages() {
    if (!selected || !messagesRef.current) return;
    const anchor = { id: selected, firstMessage: messages[0]?.id, height: messagesRef.current.scrollHeight, top: messagesRef.current.scrollTop };
    olderPageAnchor.current = anchor;
    const result = await history.fetchNextPage();
    // Clear a failed request's anchor without changing the reader's position.
    if (result.isError && olderPageAnchor.current === anchor) olderPageAnchor.current = null;
  }
  function updateDraft(text: string) { draftVersion.current = { text, revision: draftVersion.current.revision + 1 }; setDraft(text); savePreference(`${draftPrefix}:${selected ?? 'new'}`, text); }
  async function createConversation() {
    return unwrap(await post<Resource>(collectionPath(wid, 'conversations'), { visibility, data: { title: title || draft.slice(0, 48) || t('新对话', 'New conversation'), system_prompt: system } }));
  }
  async function send(e?: React.FormEvent) {
    e?.preventDefault(); const text = draft.trim(); if (!text || busy || activeRun || !modelAvailable || !writable) return;
    setBusy(true); setError(null);
    const generation = viewGeneration.current;
    const submittedRevision = draftVersion.current.revision;
    if (!idempotency.current || idempotency.current.text !== text) idempotency.current = { text, key: crypto.randomUUID() };
    const intent = idempotency.current;
    try {
      let conversationId = selected;
      if (!conversationId) {
        const created = await createConversation(); conversationId = created.id;
        void client.invalidateQueries({ queryKey: [wid, 'resources', 'conversations'] });
        // Creating an empty conversation may have completed, but changing the
        // view before its acknowledgement cancels the not-yet-sent message.
        if (viewGeneration.current !== generation) return;
        modelRestoredFor.current = created.id; setSelected(created.id);
        savePreference(`${draftPrefix}:${created.id}`, draftVersion.current.text);
        savePreference(`${draftPrefix}:new`, '');
        client.setQueryData([wid, 'resource', created.id], created);
      }
      const response = await post<{ run: Resource; conversation: Resource }>(`${workspacePath(wid)}/chat`, { conversation_id: conversationId, content: text, model_id: model, idempotency_key: intent.key, ...(agent ? { agent_id: agent } : {}) });
      if (viewGeneration.current === generation) {
        // A delayed write receipt is not a fresh permission check. Keep a
        // subsequent read denial until the invalidated query succeeds again.
        client.setQueryData<Resource | null>([wid, 'resource', conversationId], cached => cached === null ? null : response.conversation);
        const remaining = acknowledgeDraft(draftVersion.current, submittedRevision);
        draftVersion.current = { text: remaining, revision: draftVersion.current.revision + 1 };
        setDraft(remaining); savePreference(`${draftPrefix}:${conversationId}`, remaining); idempotency.current = null; follow.current = true;
      }
      void client.invalidateQueries({ queryKey: [wid] });
    } catch (e) { if (viewGeneration.current === generation) setError(e); } finally { if (viewGeneration.current === generation) setBusy(false); }
  }
  async function cancel() {
    if (!activeRun) return; setError(null);
    const generation = viewGeneration.current;
    try { await post(`${workspacePath(wid)}/runs/${activeRun.id}/cancel`); void client.invalidateQueries({ queryKey: [wid] }); } catch (e) { if (viewGeneration.current === generation) setError(e); }
  }
  async function alterConversation() {
    if (!selected || !conversation.data) return; setBusy(true); setError(null);
    const generation = viewGeneration.current;
    try {
      if (confirm === 'delete') { await remove(resourcePath(wid, selected), conversation.data.version); if (viewGeneration.current === generation) selectConversation(null); }
      else await post(`${workspacePath(wid)}/conversations/${selected}/reset`);
      if (viewGeneration.current === generation) setConfirm(null);
      void client.invalidateQueries({ queryKey: [wid] });
    } catch (e) { if (viewGeneration.current === generation) setError(e); } finally { if (viewGeneration.current === generation) setBusy(false); }
  }
  async function createBranch(e: React.FormEvent) {
    e.preventDefault(); if (!selected || !branch?.id) return; setBusy(true); setError(null);
    const generation = viewGeneration.current;
    try { const created = unwrap(await post<Resource>(`${workspacePath(wid)}/conversations/${selected}/branch`, { message_id: branch.id, content: branchText })); if (viewGeneration.current === generation) selectConversation(created.id); void client.invalidateQueries({ queryKey: [wid] }); }
    catch (e) { if (viewGeneration.current === generation) setError(e); } finally { if (viewGeneration.current === generation) setBusy(false); }
  }
  return <section className={`chat-layout ${conversationCollapsed ? 'conversation-collapsed' : ''}`}><aside className={`conversation-sidebar ${conversationCollapsed ? 'is-collapsed' : ''} ${sidebar ? 'mobile-open' : ''}`} aria-label={t('对话列表', 'Conversations')}><div className="conversation-heading"><h2>{t('对话', 'Conversations')}</h2><Button variant="ghost icon conversation-collapse-control" aria-label={conversationCollapsed ? t('展开对话列表', 'Expand conversation list') : t('折叠对话列表', 'Collapse conversation list')} aria-expanded={!conversationCollapsed} title={conversationCollapsed ? t('展开对话列表', 'Expand conversation list') : t('折叠对话列表', 'Collapse conversation list')} onClick={() => setConversationCollapsed(value => !value)}>{conversationCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}</Button><Button variant="ghost icon" aria-label={t('新建对话', 'New conversation')} onClick={() => { selectConversation(null); }}><Plus size={19} /></Button><Button variant="ghost icon mobile-only" aria-label={t('关闭列表', 'Close list')} onClick={() => setSidebar(false)}><X size={18} /></Button></div><label className="search compact"><Search size={15} /><input aria-label={t('搜索已加载的会话标题', 'Search loaded conversation titles')} placeholder={t('搜索已加载的对话', 'Search loaded conversations')} value={search} onChange={e => setSearch(e.target.value)} /></label><div className="conversation-items">{conversations.isPending ? <Loading /> : visibleConversations.map(c => <button key={c.id} className={`conversation-link ${selected === c.id ? 'active' : ''}`} onClick={() => { selectConversation(c.id); }}><span>{value(c.data, 'title', t('新对话', 'New conversation'))}</span>{c.visibility === 'private' ? <LockKeyhole size={12} /> : <Users size={12} />}</button>)}{!conversations.isPending && visibleConversations.length === 0 && <p className="muted small conversation-hint">{search ? t('没有匹配的对话。', 'No conversations match.') : t('每个新想法，都可以从这里开始。', 'Every new idea can start here.')}</p>}<LoadMore query={conversations} label={t('加载更早的对话', 'Load older conversations')} /></div><p className="conversation-note"><LockKeyhole size={13} />{t('私有会话只对你开放', 'Private conversations are only yours')}</p></aside>
    <div className="chat-main"><header className="chat-heading"><div className="row"><Button variant="ghost icon mobile-only" aria-label={t('显示对话列表', 'Show conversations')} onClick={() => setSidebar(true)}><ChevronLeft size={18} /></Button><h1>{selected ? value(unavailable ? {} : conversation.data?.data ?? {}, 'title', t('对话', 'Conversation')) : t('新对话', 'New conversation')}</h1></div><div className="row"><span className="privacy-label">{sharedConversation ? <><Users size={14} />{t('共享', 'Shared')}</> : <><LockKeyhole size={14} />{t('私有', 'Private')}</>}</span>{!selected && <Button variant="ghost icon" aria-label={t('对话设置', 'Conversation settings')} onClick={() => setSettings(true)}><Settings2 size={17} /></Button>}{selected && writable && <><Button variant="ghost icon" aria-label={t('重置上下文', 'Reset context')} onClick={() => setConfirm('reset')}><RotateCcw size={16} /></Button><Button variant="ghost icon" aria-label={t('删除会话', 'Delete conversation')} onClick={() => setConfirm('delete')}><Trash2 size={16} /></Button></>}</div></header>
      <div className="messages" ref={messagesRef} onScroll={() => { const el = messagesRef.current; if (el) { follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (follow.current) setHasNew(false); } }}>
        {unavailable ? <Empty title={t('这段对话已不可用', 'This conversation is no longer available')} description={t('对话可能已删除，或你的访问权限已被撤销。请从列表选择其他对话。', 'It may have been deleted or your access was revoked. Choose another conversation from the list.')} /> : selected && (conversation.isPending || history.isPending) ? <Loading /> : !messages.length ? <div className="chat-welcome"><div className="welcome-mark"><Brand small /></div><h2>{t('今天，从哪里开始？', 'What are we working on?')}</h2><p>{t('提出问题，探索资料，或把想法变成下一步。', 'Ask a question, explore your sources, or turn an idea into a plan.')}</p><div className="suggestions">{[[t('理清一个想法', 'Think through an idea'), t('帮我理清这个想法：', 'Help me think through this idea: ')], [t('从资料中找答案', 'Find an answer in my knowledge'), t('请根据我的知识库，回答：', 'Using my knowledge, answer: ')], [t('列出下一步', 'Plan the next step'), t('帮我把目标分成可以执行的步骤：', 'Help me break this goal into actionable steps: ')]].map(([label, text]) => <button key={label} onClick={() => { updateDraft(text); document.getElementById('composer-input')?.focus(); }}>{label}<ArrowUp size={14} /></button>)}</div></div> : <div className="message-column">{history.hasNextPage && <Button variant="ghost" busy={history.isFetchingNextPage} onClick={() => void loadOlderMessages()}>{t('显示更早的消息', 'Show earlier messages')}</Button>}{messages.map((message, index) => <MessageView key={message.id ?? `${message.role}:${index}`} message={message} onBranch={message.role === 'user' && message.id && writable && !activeRun ? () => { setBranch(message); setBranchText(message.content); } : undefined} />)}{activeRun && <article className="message assistant"><div className="message-byline"><Brand small /><Status state={value(activeRun.data, 'status')} /></div><div className="message-body">{stream || t('正在准备…', 'Preparing…')}<span className="stream-caret" aria-hidden="true" /></div></article>}</div>}
      </div>
      {hasNew && <Button className="new-content" onClick={() => { follow.current = true; messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }); setHasNew(false); }}><ArrowDown size={16} />{t('有新内容', 'New content')}</Button>}
      <div className="composer-wrap"><ErrorNotice error={error || runError || history.error || conversation.error || conversations.error || models.error || agents.error || (chosenModel.unavailable ? null : chosenModel.error) || activeRunQuery.error} draftPreserved onConfigureModels={goModels} onReview={() => { void client.invalidateQueries({ queryKey: [wid] }); }} />{!!eventError && <p className="connection-warning" role="status">{t('连接暂时中断，正在按记录游标恢复。', 'Connection interrupted. Resuming from the saved event cursor.')}</p>}{chosenModel.unavailable && <p className="connection-warning" role="status">{t('上次使用的模型已删除或无权访问，请选择其他模型。', 'The last model was removed or is no longer accessible. Choose another model.')}</p>}
        {sharedConversation && <p className="connection-warning">{t('共享会话仅可使用工作区共享的代理。', 'Shared conversations can use workspace-shared agents only.')}</p>}
        {!models.isPending && !models.data?.length && <div className="model-needed"><CpuIcon /><span>{t('接入一个模型，就可以开始对话。', 'Connect a model to start a conversation.')}</span><Button variant="text" onClick={goModels}>{t('配置模型', 'Connect model')}</Button></div>}
        <form className="composer" onSubmit={send}><textarea id="composer-input" aria-label={t('消息', 'Message')} placeholder={!writable ? t('你只能查看这段对话', 'You can view this conversation only') : t('说说你的想法…', 'What’s on your mind?')} value={draft} onChange={e => updateDraft(e.target.value)} rows={3} maxLength={100000} disabled={!writable} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div className="composer-toolbar"><div className="composer-selects"><label><span className="sr-only">{t('选择模型', 'Select model')}</span><select value={model} onChange={e => { modelRestoredFor.current = selected; setModel(e.target.value); }} disabled={!!activeRun}><option value="">{t('选择模型', 'Select model')}</option>{modelOptions.map(m => <option value={m.id} key={m.id}>{value(m.data, 'name', value(m.data, 'model'))}</option>)}</select></label>{!!agents.data?.length && <label><span className="sr-only">{t('选择代理', 'Select agent')}</span><select value={agent} onChange={e => selectAgent(e.target.value)} disabled={!!activeRun}><option value="">{t('默认助手', 'Default assistant')}</option>{availableAgents.map(a => <option key={a.id} value={a.id}>{value(a.data, 'name')}</option>)}</select></label>}</div>{activeRun ? <Button type="button" variant="stop" onClick={cancel}><Square size={15} fill="currentColor" />{t('停止', 'Stop')}</Button> : <Button type="submit" variant="primary send" aria-label={t('发送消息', 'Send message')} disabled={!draft.trim() || !modelAvailable || !writable} busy={busy}><ArrowUp size={20} /></Button>}</div></form><div className="selector-pagination"><LoadMore query={models} label={t('加载更多模型', 'Load more models')} /><LoadMore query={agents} label={t('加载更多代理', 'Load more agents')} /></div><p className="composer-foot">{t('Enter 发送 · Shift + Enter 换行。模型回复可能有误，请核对重要信息。', 'Enter to send · Shift + Enter for a new line. Check important information.')}</p>
      </div>
    </div>
    {settings && <Modal title={t('新对话设置', 'New conversation settings')} close={() => setSettings(false)}><div className="stack"><Field label={t('会话名称', 'Conversation title')}><input value={title} onChange={e => setTitle(e.target.value)} /></Field><Field label={t('对助手的说明', 'Instructions for the assistant')}><textarea rows={5} value={system} onChange={e => setSystem(e.target.value)} /></Field><Field label={t('可见范围', 'Visibility')}><select value={visibility} onChange={e => setVisibility(e.target.value)}><option value="private">{t('仅自己', 'Only me')}</option><option value="workspace">{t('工作区成员', 'Workspace members')}</option></select></Field><Button variant="primary" onClick={() => setSettings(false)}>{t('完成', 'Done')}</Button></div></Modal>}
    {confirm && <Modal title={confirm === 'reset' ? t('重置当前上下文？', 'Reset the current context?') : t('删除此会话？', 'Delete this conversation?')} close={() => setConfirm(null)}><p>{confirm === 'reset' ? t('保留历史记录，后续对话使用新的上下文。当前运行将停止，迟到结果不会写回。', 'History is preserved. Future messages use a new context. The current run will stop and late results cannot write back.') : t('将删除这段会话及其历史。', 'This removes the conversation and its history.')}</p><ErrorNotice error={error} /><div className="dialog-actions"><Button onClick={() => setConfirm(null)}>{t('取消', 'Cancel')}</Button><Button variant={confirm === 'delete' ? 'danger' : 'primary'} busy={busy} onClick={alterConversation}>{t('确认', 'Confirm')}</Button></div></Modal>}
    {branch && <Modal title={t('编辑并建立分支', 'Edit and create a branch')} close={() => setBranch(null)}><form className="stack" onSubmit={createBranch}><p className="muted">{t('原会话保留不变，编辑后的内容进入新的会话分支。', 'The original conversation stays intact. Your edit starts a new branch.')}</p><Field label={t('消息', 'Message')}><textarea rows={7} value={branchText} onChange={e => setBranchText(e.target.value)} required /></Field><ErrorNotice error={error} /><Button variant="primary" busy={busy} type="submit">{t('建立分支', 'Create branch')}</Button></form></Modal>}
  </section>;
}

function CpuIcon() { return <BookOpen size={17} aria-hidden="true" />; }
