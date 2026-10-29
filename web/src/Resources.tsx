import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, BookOpen, Brain, CalendarClock, Check, ChevronRight, Cpu, FileText, FlaskConical, LockKeyhole, MoreHorizontal, Pencil, Plug, Plus, RefreshCw, Search, Send, Trash2, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, formatTime, items, number, patch, post, remove, value } from './api';
import type { Json, Resource, User, Workspace } from './api';
import { collectionPath, resourcePath, useResources, workspacePath } from './data';
import { DeliveryHistory, SendDialog } from './Delivery';
import { prepareConfiguration } from './resourceConfiguration';
import { prepareSchedule, zonedTime } from './scheduleConfiguration';
import { CalendarFields, SchedulePreview, scheduleIssue } from './ScheduleFields';
import type { ConfigurationIssue } from './resourceConfiguration';
import { canCreateResource, canWriteResource, roleAllows } from './permissions';
import { Button, Empty, ErrorNotice, Field, Loading, LoadMore, Modal, PageHeader, Status, useText } from './ui';

type ResourceKind = 'models' | 'plugins' | 'knowledge' | 'memories' | 'schedules' | 'routes' | 'agents';
type FieldDefinition = { key: string; label: [string, string]; type?: string; required?: boolean; placeholder?: string | [string, string]; options?: [string, string, string][]; hint?: [string, string]; default?: unknown };
const icons: Record<ResourceKind, LucideIcon> = { models: Cpu, plugins: Plug, knowledge: BookOpen, memories: Brain, schedules: CalendarClock, routes: Send, agents: Users };
const pageTitles: Record<ResourceKind, [string, string]> = { models: ['模型', 'Models'], plugins: ['插件', 'Plugins'], knowledge: ['知识库', 'Knowledge'], memories: ['长期记忆', 'Memory'], schedules: ['计划任务', 'Schedules'], routes: ['机器人与渠道', 'Channels'], agents: ['代理', 'Agents'] };
const descriptions: Record<ResourceKind, [string, string]> = {
  models: ['把合适的模型，放在合适的事情上。', 'The right model for the work at hand.'],
  plugins: ['独立的能力，清楚的授权。每个工作区各自配置。', 'Independent capabilities, explicit permissions. Configured per workspace.'],
  knowledge: ['保留原文，让回答有据可查。', 'Keep the source. Give every answer a reference.'],
  memories: ['记住什么，由你决定。', 'What stays with your assistant is up to you.'],
  schedules: ['安排好下一件事，回来看结果。', 'Make a plan. Come back to the result.'],
  routes: ['把结果送到经过授权的地方。', 'Deliver results to destinations you authorize.'],
  agents: ['为常做的事，设定一套做法。', 'Give recurring work its own instructions.'],
};

function definitions(kind: ResourceKind): FieldDefinition[] {
  switch (kind) {
    case 'models': return [
      { key: 'name', label: ['显示名称', 'Display name'], required: true },
      { key: 'provider', label: ['模型提供方', 'Model provider'], type: 'provider', required: true },
      { key: 'base_url', label: ['API 地址', 'API base URL'], placeholder: 'https://api.example.com/v1', hint: ['本地模型需要实例管理员明确允许私有网络。', 'Local models require explicit private-network authorization by the instance administrator.'] },
      { key: 'api_key', label: ['API 密钥', 'API key'], type: 'password', hint: ['只写入，不回显。留空保留密钥；更换 API 地址或供应商时，需填写新密钥或勾选清除。', 'Write-only. Blank keeps the key. Changing the API endpoint or provider requires a new key or explicit clearing.'] },
      { key: 'clear_api_key', label: ['清除已有 API 密钥', 'Clear the saved API key'], type: 'checkbox', default: false },
      { key: 'allow_private_network', label: ['允许本地 / 私有网络（仅实例管理员）', 'Allow local / private network (instance administrator only)'], type: 'checkbox', default: false },
      { key: 'model', label: ['模型 ID', 'Model ID'], required: true, placeholder: 'model-name' },
      { key: 'supports_images', label: ['此模型支持图片输入', 'This model supports image input'], type: 'checkbox', default: false, hint: ['请先查阅模型提供方文档确认；图片和元数据会发送给该提供方。启用工作区预算时暂不可发送图片。', 'Confirm this with the provider first. Images and metadata are sent to the provider. Images are unavailable while a workspace budget is enabled.'] },
      { key: 'max_tokens', label: ['最大输出 token', 'Maximum output tokens'], type: 'number', default: 2048 },
      { key: 'input_price_usd', label: ['输入单价（USD / 百万 token）', 'Input price (USD / million tokens)'], placeholder: '0.00', hint: ['可留空。没有价格时费用保持未知。', 'Optional. Costs remain unknown without pricing.'] },
      { key: 'output_price_usd', label: ['输出单价（USD / 百万 token）', 'Output price (USD / million tokens)'], placeholder: '0.00' },
    ];
    case 'plugins': return [{ key: 'name', label: ['实例名称', 'Instance name'], required: true }, { key: 'package_id', label: ['已安装的插件包', 'Installed package'], type: 'package', required: true }, { key: 'enabled', label: ['启用此实例', 'Enable this instance'], type: 'checkbox', default: false }];
    case 'knowledge': return [{ key: 'title', label: ['文档标题', 'Document title'], required: true }, { key: 'text', label: ['原文', 'Source text'], type: 'textarea', required: true, hint: ['支持 UTF-8 文本与 Markdown。上传后由服务端建立可检索分块。', 'UTF-8 text and Markdown are supported. The server builds searchable chunks after upload.'] }];
    case 'memories': return [{ key: 'title', label: ['标题', 'Title'], required: true }, { key: 'content', label: ['记忆内容', 'Memory'], type: 'textarea', required: true }, { key: 'source', label: ['来源', 'Source'], placeholder: ['由用户明确保存', 'Explicitly saved by the user'] }, { key: 'enabled', label: ['参与后续对话', 'Use in future conversations'], type: 'checkbox', default: true }, { key: 'pinned', label: ['固定重要记忆', 'Pin important memory'], type: 'checkbox', default: false }];
    case 'schedules': return [{ key: 'title', label: ['任务名称', 'Schedule name'], required: true }, { key: 'prompt', label: ['要做的事', 'Instructions'], type: 'textarea', required: true }, { key: 'model_id', label: ['使用模型', 'Model'], type: 'model', required: true }, { key: 'conversation_id', label: ['结果会话', 'Conversation for results'], type: 'conversation', required: true }, { key: 'schedule_type', label: ['时间安排', 'Schedule'], type: 'select', default: 'once', options: [['once', '指定时间，一次', 'Once, at a specific time'], ['interval', '固定间隔', 'Fixed interval'], ['cron', '日历计划', 'Calendar schedule']] }, { key: 'at', label: ['执行时间（当前设备时区）', 'Run at (device time zone)'], type: 'datetime-local', required: true }, { key: 'interval_seconds', label: ['间隔（秒）', 'Interval (seconds)'], type: 'number', default: 3600 }, { key: 'cron', label: ['日历表达式', 'Calendar expression'], placeholder: '0 0 9 * * *', hint: ['六段：秒 分 时 日 月 星期。示例为每日 09:00。', 'Six fields: second minute hour day month weekday. The example runs daily at 09:00.'] }, { key: 'timezone', label: ['时区', 'Time zone'], default: Intl.DateTimeFormat().resolvedOptions().timeZone, placeholder: 'Asia/Taipei', required: true }, { key: 'enabled', label: ['启用任务', 'Enable schedule'], type: 'checkbox', default: true }];
    case 'routes': return [{ key: 'name', label: ['渠道名称', 'Channel name'], required: true }, { key: 'adapter', label: ['渠道类型', 'Channel type'], type: 'readonly', default: 'webhook' }, { key: 'url', label: ['完整接收地址', 'Full receiver URL'], type: 'url', required: true, hint: ['仅接受 HTTP(S) 地址；保存不等于允许投递。实际发送要求 HTTPS，或已获批的私有网络 HTTP。', 'Only HTTP(S) URLs can be saved. Saving does not authorize delivery. Sending requires HTTPS or approved private-network HTTP.'] }, { key: 'token', label: ['Bearer 令牌（可选）', 'Bearer token (optional)'], type: 'password', hint: ['仅写入。留空保留令牌；更换完整目标地址时，需替换或清除旧令牌。', 'Write-only. Blank keeps the token. Changing the full destination requires replacing or clearing the saved token.'] }, { key: 'clear_token', label: ['清除已有授权令牌', 'Clear the saved authorization token'], type: 'checkbox', default: false }, { key: 'allow_private_network', label: ['允许此目标访问私有网络（需实例管理员审批）', 'Allow this destination to access private networks (instance admin approval required)'], type: 'checkbox', default: false }];
    case 'agents': return [{ key: 'name', label: ['代理名称', 'Agent name'], required: true }, { key: 'system_prompt', label: ['工作方式', 'Instructions'], type: 'textarea', required: true }, { key: 'model_id', label: ['默认模型', 'Default model'], type: 'model', required: true }, { key: 'max_steps', label: ['最多执行轮次', 'Maximum execution steps'], type: 'number', default: 6 }, { key: 'knowledge', label: ['检索获准知识库', 'Search authorized knowledge'], type: 'checkbox', default: true }, { key: 'memory', label: ['使用获准记忆', 'Use authorized memory'], type: 'checkbox', default: true }];
  }
}

type DiscoveredModel = { id: string; name: string };
type ModelDiscoveryResult = { items: DiscoveredModel[]; truncated: boolean; fixture: boolean };
type ModelDiscoveryState = { status: 'idle' | 'loading' | 'cancelled' } | { status: 'success'; result: ModelDiscoveryResult } | { status: 'error'; error: unknown };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseModelDiscovery(value: unknown): ModelDiscoveryResult {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('Invalid model discovery response');
  const items: DiscoveredModel[] = [];
  for (const row of value.items) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim() || row.id.trim() !== row.id || row.id.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(row.id)) continue;
    const name = typeof row.name === 'string' && row.name.trim().length > 0 && row.name.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(row.name) ? row.name : row.id;
    items.push({ id: row.id, name });
  }
  return { items: items.slice(0, 500), truncated: value.truncated === true || items.length > 500, fixture: value.fixture === true };
}

type ModelTestResult = { success?: boolean; usage?: unknown; cost_microusd?: number | null; fixture?: boolean };

function ModelTestDialog({ workspace, model, close, completed }: { workspace: string; model: Resource; close: () => void; completed: () => void }) {
  const { t } = useText();
  const [started, setStarted] = useState(false); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModelTestResult | null>(null); const [error, setError] = useState<unknown>(null);
  async function run() {
    setStarted(true); setBusy(true); setError(null);
    try {
      const response = await post<ModelTestResult>(`${workspacePath(workspace)}/models/${encodeURIComponent(model.id)}/test`);
      setResult(response); completed();
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  const usage = result?.usage && typeof result.usage === 'object' ? JSON.stringify(result.usage) : null;
  const cost = typeof result?.cost_microusd === 'number' ? `${(result.cost_microusd / 1_000_000).toFixed(6)} USD` : t('未知', 'Unknown');
  return <Modal title={t('发起模型调用测试', 'Run model call test')} close={close} closeDisabled={busy}>
    {!started && <div className="stack"><p><strong>{value(model.data, 'name', model.id)}</strong></p><p>{t('测试会调用已保存的配置，并请求最多 8 个输出 token。供应商可能计费；这里没有只检查地址、不产生调用的测试。', 'The test calls the saved configuration and requests up to 8 output tokens. The provider may charge; there is no address-only test.')}</p><p className="muted small">{t('模型配置 v', 'Saved model version ')}{model.version}</p><div className="dialog-actions"><Button type="button" disabled={busy} onClick={close}>{t('取消', 'Cancel')}</Button><Button type="button" variant="primary" onClick={() => void run()}><FlaskConical size={16} />{t('确认并发起实际调用', 'Confirm and send actual test call')}</Button></div></div>}
    {started && <div className="stack">{busy ? <Loading text={t('正在调用已保存配置…', 'Calling the saved configuration…')} /> : result ? <div role="status" className="stack"><Status state={result.success === true ? 'completed' : 'failed'} /><p>{result.success === true ? t('服务端确认测试调用成功。', 'The server confirmed the test call succeeded.') : t('测试未通过。通用插件错误不能确定是密钥、模型 ID 或供应商余额的问题。', 'The test did not pass. A generic plugin error cannot identify whether the key, model ID, or provider balance caused it.')}</p><p className="small">{t('供应商用量：', 'Provider usage: ')}{usage ?? t('未知', 'Unknown')}</p><p className="small">{t('服务端报告费用：', 'Server-reported cost: ')}{cost}</p>{result.fixture === true && <p className="muted small">{t('本次结果来自本地诊断夹具，不是 AI 调用。', 'This result came from the local diagnostic fixture, not an AI call.')}</p>}<Button type="button" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button></div> : error ? <div className="stack" role="alert"><ErrorNotice error={error} /><p>{t('结果未确认：请求可能已到达供应商。先检查运行记录和费用；再次测试会是一次新的实际调用。', 'The result is unconfirmed: the request may have reached the provider. Check run records and charges first; testing again would be a new actual call.')}</p><Button type="button" disabled={busy} onClick={close}>{t('关闭', 'Close')}</Button></div> : null}</div>}
  </Modal>;
}

export function ResourceEditor({ workspace, kind, resource, user, close, saved }: { workspace: string; kind: ResourceKind; resource?: Resource; user: User; close: () => void; saved: () => void }) {
  const { t } = useText(); const fields = definitions(kind);
  const [draft, setDraft] = useState<Json>(() => ({ ...Object.fromEntries(fields.map(f => [f.key, f.default ?? ''])), ...(resource?.data ?? {}), api_key: '', token: '', ...(kind === 'models' ? { input_price_usd: typeof resource?.data.input_microusd_per_million === 'number' ? String(resource.data.input_microusd_per_million / 1000000) : '', output_price_usd: typeof resource?.data.output_microusd_per_million === 'number' ? String(resource.data.output_microusd_per_million / 1000000) : '' } : {}) }));
  const [step, setStep] = useState(0); const formRef = useRef<HTMLFormElement>(null);
  const [modelDiscovery, setModelDiscovery] = useState<ModelDiscoveryState>({ status: 'idle' });
  const modelListId = useId();
  const modelDiscoveryRequest = useRef<AbortController | null>(null);
  const [fieldIssues, setFieldIssues] = useState<ConfigurationIssue[]>([]);
  const focusIssue = useRef<string | null>(null);
  const [visibility, setVisibility] = useState<'private' | 'workspace'>(resource?.visibility ?? (['models', 'plugins', 'knowledge', 'agents', 'routes'].includes(kind) ? 'workspace' : 'private'));
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const modelQuery = useResources(workspace, 'models'); const conversationQuery = useResources(workspace, 'conversations');
  const packageQuery = useQuery({ queryKey: ['plugin-packages'], enabled: kind === 'plugins' || kind === 'models', queryFn: ({ signal }) => api<{ items: Json[] }>('/plugin-packages', { signal }).then(items) });
  const modelPackages = (packageQuery.data ?? []).filter(pkg => Array.isArray(pkg.capabilities) && pkg.capabilities.includes('model'));
  const wizard = kind === 'models' || kind === 'routes';
  const wizardLabels: [string, string][] = kind === 'models' ? [['连接与凭据', 'Connection & credentials'], ['模型参数', 'Model settings'], ['范围与核对', 'Scope & review']] : [['投递目标', 'Destination'], ['授权与网络', 'Authorization & network'], ['范围与核对', 'Scope & review']];
  const wizardFields = kind === 'models' ? [['name', 'provider', 'base_url', 'api_key', 'clear_api_key', 'allow_private_network', 'model'], ['supports_images', 'max_tokens', 'input_price_usd', 'output_price_usd'], []] : [['name', 'adapter', 'url'], ['token', 'clear_token', 'allow_private_network'], []];
  const currentFields = wizard ? fields.filter(field => wizardFields[step]?.includes(field.key)) : fields;
  const prepare = () => prepareConfiguration({ kind: kind === 'routes' ? 'routes' : 'models', draft, saved: resource, providers: packageQuery.isSuccess ? modelPackages.map(pkg => value(pkg, 'id')) : null });
  function showIssues(issues: ConfigurationIssue[]) {
    focusIssue.current = issues[0]?.field ?? null;
    setFieldIssues(issues);
  }
  useEffect(() => {
    if (!focusIssue.current) return;
    const control = formRef.current?.elements.namedItem(focusIssue.current);
    if (control instanceof HTMLElement) { control.focus(); focusIssue.current = null; }
  }, [fieldIssues, step]);
  useEffect(() => () => {
    modelDiscoveryRequest.current?.abort();
    modelDiscoveryRequest.current = null;
  }, [workspace, user.id, resource?.id, kind]);
  function cancelDiscovery() {
    if (!modelDiscoveryRequest.current) return;
    modelDiscoveryRequest.current.abort();
    modelDiscoveryRequest.current = null;
    setModelDiscovery({ status: 'cancelled' });
  }
  function nextStep() {
    const result = prepare();
    const issues = result.ok ? [] : result.issues.filter(issue => wizardFields[step]?.includes(issue.field));
    showIssues(issues);
    if (issues.length) return;
    cancelDiscovery();
    setError(null); setStep(current => Math.min(current + 1, 2));
  }
  useEffect(() => {
    if (!resource && kind === 'models' && draft.provider === '' && packageQuery.isSuccess && modelPackages.some(pkg => value(pkg, 'id') === 'openai')) {
      setDraft(current => current.provider === '' ? { ...current, provider: 'openai' } : current);
    }
  }, [resource, kind, draft.provider, packageQuery.isSuccess, packageQuery.data]);
  const set = (key: string, val: unknown) => {
    setFieldIssues(current => current.filter(issue => issue.field !== key));
    if (kind === 'models' && ['provider', 'base_url', 'api_key', 'clear_api_key', 'allow_private_network'].includes(key)) {
      cancelDiscovery();
      setModelDiscovery({ status: 'idle' });
    }
    setDraft(prev => ({ ...prev, [key]: val, ...(kind === 'schedules' && key === 'schedule_type' && val === 'cron' && !prev.cron ? { cron: '0 0 9 * * *' } : {}), ...(['provider', 'base_url'].includes(key) ? { api_key: '' } : {}), ...(key === 'clear_api_key' && val ? { api_key: '' } : {}), ...(key === 'clear_token' && val ? { token: '' } : {}) }));
  };
  async function discoverModels() {
    if (modelDiscoveryRequest.current) return;
    const prepared = prepareConfiguration({ kind: 'models', draft, providers: packageQuery.isSuccess ? modelPackages.map(pkg => value(pkg, 'id')) : null });
    const issues = prepared.ok ? [] : prepared.issues.filter(issue => ['provider', 'base_url', 'api_key'].includes(issue.field));
    showIssues(issues);
    if (issues.length) return;
    const controller = new AbortController();
    modelDiscoveryRequest.current = controller;
    const provider = String(draft.provider ?? '');
    const baseUrl = provider === 'diagnostic' ? '' : String(draft.base_url ?? '');
    const allowPrivateNetwork = provider !== 'diagnostic' && draft.allow_private_network === true;
    const apiKey = provider === 'diagnostic' ? '' : String(draft.api_key ?? '');
    const canReuseSavedKey = !!resource
      && resource.data.has_api_key === true
      && draft.clear_api_key !== true
      && provider === resource.data.provider
      && baseUrl === value(resource.data, 'base_url')
      && allowPrivateNetwork === (resource.data.allow_private_network === true)
      && !apiKey;
    setModelDiscovery({ status: 'loading' });
    try {
      const response = await api<unknown>(`${workspacePath(workspace)}/models/discover`, { method: 'POST', signal: controller.signal, body: JSON.stringify({
        provider,
        base_url: baseUrl,
        allow_private_network: allowPrivateNetwork,
        ...(apiKey ? { api_key: apiKey } : canReuseSavedKey && resource ? { saved_model_id: resource.id } : {}),
      }) });
      if (modelDiscoveryRequest.current === controller && !controller.signal.aborted) setModelDiscovery({ status: 'success', result: parseModelDiscovery(response) });
    } catch (cause) {
      if (modelDiscoveryRequest.current === controller && !controller.signal.aborted) setModelDiscovery({ status: 'error', error: cause });
    } finally {
      if (modelDiscoveryRequest.current === controller) modelDiscoveryRequest.current = null;
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (wizard && step < 2) { nextStep(); return; }
    const prepared = kind === 'schedules' ? prepareSchedule({ draft, models: (modelQuery.data ?? []).map(row => row.id), conversations: (conversationQuery.data ?? []).map(row => row.id) }) : wizard ? prepare() : null;
    if (prepared && !prepared.ok) {
      showIssues(prepared.issues);
      if (wizard) { const first = wizardFields.findIndex(group => group.includes(prepared.issues[0].field)); setStep(first < 0 ? 0 : first); }
      return;
    }
    setBusy(true); setError(null);
    try {
      if (prepared?.ok) {
        if (resource) await patch(resourcePath(workspace, resource.id), { version: resource.version, data: prepared.data });
        else await post(collectionPath(workspace, kind), { visibility, data: prepared.data });
        saved(); close(); return;
      }

      const data: Json = { ...draft };
      if (!data.api_key) delete data.api_key;
      if (!data.token) delete data.token;
      if (kind === 'memories') data.archived = resource?.data.archived ?? false;
      if (kind === 'plugins') data.config = resource?.data.config ?? {};
      if (resource) await patch(resourcePath(workspace, resource.id), { version: resource.version, data });
      else await post(collectionPath(workspace, kind), { visibility, data });
      saved(); close();
    } catch (err) { const issue = kind === 'schedules' ? scheduleIssue(err) : null; if (issue) showIssues([issue]); else setError(err); } finally { setBusy(false); }
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 512 * 1024) { setError(new Error(t('文本文件上限为 512 KiB。', 'Text files must be 512 KiB or smaller.'))); return; }
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setError(new Error(t('此版本支持 .txt 和 .md 文档。', 'This version supports .txt and .md documents.'))); return; }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      setDraft(prev => ({ ...prev, text, title: prev.title || file.name })); setError(null);
    } catch { setError(new Error(t('文件不是有效的 UTF-8 文本。', 'The file is not valid UTF-8 text.'))); }
  }
  const credentialTargetChanged = kind === 'models'
    ? !!resource && (draft.provider !== resource.data.provider || (draft.provider !== 'diagnostic' && String(draft.base_url ?? '') !== value(resource.data, 'base_url')))
    : !!resource && String(draft.url ?? '') !== value(resource.data, 'url');
  const credentialConfigured = kind === 'models' ? resource?.data.has_api_key === true : resource?.data.has_token === true;
  const credentialCleared = kind === 'models' ? draft.clear_api_key === true : draft.clear_token === true;
  const credentialReplacement = !!String(kind === 'models' ? draft.api_key ?? '' : draft.token ?? '');
  const credentialSummary = credentialCleared ? t('明确清除已保存凭据', 'Explicitly clear the saved credential') : credentialReplacement ? t('使用新凭据替换', 'Replace with a new credential') : credentialConfigured && credentialTargetChanged ? t('目标已变化：必须替换或清除', 'Destination changed: replace or clear it') : credentialConfigured ? t('保留已保存凭据', 'Keep the saved credential') : t('不发送凭据', 'No credential will be sent');
  return <Modal title={`${resource ? t('编辑', 'Edit') : t('添加', 'Add')} ${t(...pageTitles[kind])}`} close={close} wide={kind === 'knowledge'} closeDisabled={busy}><form ref={formRef} className="stack" onSubmit={submit} noValidate={wizard || kind === 'schedules'}>
    <ErrorNotice error={error || (['plugins', 'models'].includes(kind) ? packageQuery.error : null) || (fields.some(f => f.type === 'model') ? modelQuery.error : null) || (fields.some(f => f.type === 'conversation') ? conversationQuery.error : null)} onRetry={['plugins', 'models'].includes(kind) ? () => { void packageQuery.refetch(); } : undefined} />
    {wizard && <ol className="resource-steps" aria-label={t('配置步骤', 'Configuration steps')}>{wizardLabels.map((label, index) => <li key={index} className={index === step ? 'current' : index < step ? 'complete' : ''}><button type="button" disabled={busy || index > step} aria-current={index === step ? 'step' : undefined} onClick={() => setStep(index)}><span>{index + 1}</span>{t(...label)}</button></li>)}</ol>}
    {kind === 'models' && <div className="resource-guidance"><strong>{t('模型连接类型', 'Model connection types')}</strong><p>{draft.provider === 'diagnostic' ? t('诊断夹具只用于验证本机调用流程，不会生成 AI 内容，也不会请求外部模型。', 'The diagnostic fixture checks the local call path. It does not generate AI content or contact an external model.') : draft.provider === 'openai' ? t('OpenAI 兼容 API 可连接符合该协议的服务。单独发起测试会调用已保存配置，可能产生费用。', 'The OpenAI-compatible API connects to services implementing that protocol. A separate test calls the saved configuration and may incur a charge.') : t('提供方来自当前已安装并声明 model 能力的插件包。请按所选插件文档填写连接参数。', 'Providers come from installed packages that declare model capability. Follow the selected plugin documentation for connection parameters.')}</p>{packageQuery.isPending ? <p>{t('正在读取已安装的模型插件…', 'Loading installed model plugins…')}</p> : packageQuery.isSuccess && modelPackages.length === 0 ? <p>{t('当前没有已安装的模型插件。请让实例管理员先安装模型插件。', 'No model plugin is installed. Ask an instance administrator to install one first.')}</p> : null}<a href="https://github.com/LIghtJUNction/RstrBot/blob/main/recipes/rstrbot-core/HTTP_CONTRACT.md" target="_blank" rel="noreferrer">{t('查看模型字段与行为说明', 'Read model fields and behavior')}<ArrowUpRight size={14} aria-hidden="true" /></a></div>}
    {kind === 'routes' && <div className="resource-guidance"><strong>{t('当前支持 Webhook 投递', 'Webhook delivery is currently supported')}</strong><p>{t('目标地址需要实例管理员授权。发送消息会产生真实外部投递；这里没有无副作用的连接测试。', 'The destination requires instance administrator approval. Sending creates a real external delivery; there is no side-effect-free connection test.')}</p><a href="https://github.com/LIghtJUNction/RstrBot/blob/main/recipes/rstrbot-core/HTTP_CONTRACT.md" target="_blank" rel="noreferrer">{t('查看路由与投递说明', 'Read route and delivery behavior')}<ArrowUpRight size={14} aria-hidden="true" /></a></div>}
    {kind === 'knowledge' && <label className="file-drop"><FileText size={24} /><span>{t('选择文本文件，或在下面粘贴内容', 'Choose a text file, or paste content below')}</span><input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={e => void readFile(e.target.files?.[0])} /></label>}
    {currentFields.filter(f => !((f.key === 'clear_api_key' && resource?.data.has_api_key !== true) || (f.key === 'clear_token' && resource?.data.has_token !== true)) && !(kind === 'models' && draft.provider === 'diagnostic' && ['base_url', 'api_key', 'allow_private_network'].includes(f.key)) && !(kind === 'schedules' && ((f.key === 'at' && draft.schedule_type !== 'once') || (f.key === 'interval_seconds' && draft.schedule_type !== 'interval') || (f.key === 'cron' && draft.schedule_type !== 'cron') || f.key === 'timezone'))).map(f => {
      if (kind === 'schedules' && f.key === 'cron') return <CalendarFields key={f.key} draft={draft} set={set} issues={fieldIssues} busy={busy} />;
      const raw = draft[f.key]; const text = raw === undefined || raw === null ? '' : String(raw);
      const fieldIssue = fieldIssues.find(issue => issue.field === f.key);
      const checkboxErrorId = `${modelListId}-${f.key}-error`;
      if (f.type === 'checkbox') return <div key={f.key} className="field"><label className="check-field"><input name={f.key} type="checkbox" checked={!!raw} aria-invalid={fieldIssue ? true : undefined} aria-describedby={fieldIssue ? checkboxErrorId : undefined} disabled={busy || (f.key === 'allow_private_network' && user.instance_admin !== true)} onChange={e => set(f.key, e.target.checked)} /><span>{t(...f.label)}{f.key === 'allow_private_network' && user.instance_admin !== true ? ` · ${t('仅实例管理员可修改', 'instance admin only')}` : ''}</span></label>{f.hint && <small className="muted">{t(...f.hint)}</small>}{fieldIssue && <small className="field-error" id={checkboxErrorId} role="alert">{t(...fieldIssue.message)}</small>}</div>;
      let options: { id: string; name: string; disabled?: boolean }[] = f.options?.map(([id, zh, en]) => ({ id, name: t(zh, en) })) ?? [];
      if (f.type === 'provider') {
        options = modelPackages.map(pkg => {
          const id = value(pkg, 'id'); const version = value(pkg, 'version');
          const label = id === 'openai' ? t('OpenAI 兼容接口', 'OpenAI-compatible API') : id === 'diagnostic' ? t('本地诊断夹具（非 AI）', 'Local diagnostic fixture (not AI)') : value(pkg, 'name', id);
          return { id, name: `${label}${version ? ` · v${version}` : ''}` };
        });
        if (text && !modelPackages.some(pkg => value(pkg, 'id') === text)) options = [{ id: text, name: `${text} · ${t('当前未安装', 'not installed')}`, disabled: true }, ...options];
      }
      if (f.type === 'model') options = modelQuery.data?.map(r => ({ id: r.id, name: value(r.data, 'name', r.id) })) ?? [];
      if (f.type === 'conversation') options = conversationQuery.data?.map(r => ({ id: r.id, name: value(r.data, 'title', r.id) })) ?? [];
      if (f.type === 'package') options = packageQuery.data?.map(r => ({ id: value(r, 'id', value(r, 'package_id')), name: value(r, 'name', value(r, 'id', value(r, 'package_id'))) })) ?? [];
      const select = ['select', 'provider', 'model', 'conversation', 'package'].includes(f.type ?? '');
      const timestamp = f.type === 'datetime-local' && typeof raw === 'number' ? new Date(raw * 1000) : null;
      const date = timestamp && !Number.isNaN(timestamp.getTime()) ? new Date(timestamp.getTime() - timestamp.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : text;
      const placeholder = typeof f.placeholder === 'string' ? f.placeholder : f.placeholder ? t(f.placeholder[0], f.placeholder[1]) : undefined;
      const required = f.required || (kind === 'models' && f.key === 'base_url' && draft.provider !== 'diagnostic');
      const discoveryReady = packageQuery.isSuccess && !!String(draft.provider ?? '') && (draft.provider === 'diagnostic' || !!String(draft.base_url ?? '').trim());
      const issue = fieldIssues.find(issue => issue.field === f.key);
      return <div key={f.key}><Field label={t(...f.label)} hint={f.hint ? t(...f.hint) : undefined} error={issue ? t(...issue.message) : undefined}>
        {f.type === 'readonly' ? <input name={f.key} value={text} readOnly disabled={busy} /> : select ? <select name={f.key} disabled={busy} value={text} required={required} onChange={e => set(f.key, e.target.value)}><option value="">{t('请选择…', 'Choose…')}</option>{options?.map(o => <option key={o.id} value={o.id} disabled={'disabled' in o && o.disabled === true}>{o.name}</option>)}</select> : f.type === 'textarea' ? <textarea name={f.key} disabled={busy} value={text} onChange={e => set(f.key, e.target.value)} required={required} rows={kind === 'knowledge' ? 11 : 5} maxLength={500000} /> : <input name={f.key} type={f.type ?? 'text'} list={kind === 'models' && f.key === 'model' ? modelListId : undefined} disabled={busy || (f.key === 'api_key' && draft.clear_api_key === true) || (f.key === 'token' && draft.clear_token === true)} required={required} placeholder={placeholder} autoComplete={f.type === 'password' ? 'new-password' : 'off'} min={f.type === 'number' ? 1 : undefined} value={f.type === 'datetime-local' ? date : text} onChange={e => set(f.key, f.type === 'number' ? (e.target.value ? Number(e.target.value) : '') : e.target.value)} />}
      </Field>
        {kind === 'models' && f.key === 'model' && <div className="model-discovery">
          <Button type="button" variant="ghost" busy={modelDiscovery.status === 'loading'} disabled={!discoveryReady || modelDiscovery.status === 'loading'} onClick={() => void discoverModels()}>{t('读取可用模型 ID', 'Discover model IDs')}</Button>
          {modelDiscovery.status === 'loading' && <Button type="button" variant="ghost" onClick={cancelDiscovery}>{t('取消读取', 'Cancel discovery')}</Button>}
          {modelDiscovery.status === 'cancelled' && <p className="muted small" role="status">{t('已停止等待。提供方可能仍在处理已经发出的列表请求。', 'Stopped waiting. The provider may still be processing the list request already sent.')}</p>}
          <p className="muted small">{t('只读取提供方模型清单，不发起生成请求，也不占用 RstrBot 预算。供应商仍可能按其政策记录或计费。也可以直接手动填写模型 ID。', 'Reads the provider model list only. It sends no generation request and reserves no RstrBot budget. The provider may still log or charge under its own policy. You can also enter a model ID manually.')}</p>
          {modelDiscovery.status === 'error' && <ErrorNotice error={modelDiscovery.error} />}
          {modelDiscovery.status === 'success' && <div className="model-discovery-result" role="status" aria-live="polite">
            <span>{modelDiscovery.result.items.length ? t(`找到 ${modelDiscovery.result.items.length} 个模型 ID。`, `Found ${modelDiscovery.result.items.length} model IDs.`) : t('服务返回了空列表，仍可手动填写模型 ID。', 'The provider returned an empty list. You can still enter a model ID manually.')}</span>
            {modelDiscovery.result.truncated && <span>{t('结果过多，已显示前 500 项。', 'More than 500 results were returned; showing the first 500.')}</span>}
            {modelDiscovery.result.fixture && <span>{t('这是本地诊断项，不是真实 AI 模型。', 'This is a local diagnostic fixture, not an AI model.')}</span>}
            {modelDiscovery.result.items.length > 0 && <datalist id={modelListId}>{modelDiscovery.result.items.map(item => <option key={item.id} value={item.id} label={item.name} />)}</datalist>}
          </div>}
        </div>}
      </div>;
    })}
    {wizard && step === 2 && <section className="resource-review"><h3>{t('保存前核对', 'Review before saving')}</h3><dl>
      <dt>{t('名称', 'Name')}</dt><dd>{String(draft.name || '—')}</dd>
      {kind === 'models' ? <><dt>{t('提供方', 'Provider')}</dt><dd><code>{String(draft.provider || '—')}</code></dd><dt>{t('模型 ID', 'Model ID')}</dt><dd><code>{String(draft.model || '—')}</code></dd>{draft.provider !== 'diagnostic' && <><dt>{t('API 基础地址', 'API base URL')}</dt><dd className="break-anywhere">{String(draft.base_url || '—')}</dd></>}<dt>{t('图片输入', 'Image input')}</dt><dd>{draft.supports_images === true ? t('由用户确认支持', 'Confirmed by user') : t('未启用', 'Not enabled')}</dd><dt>{t('最大输出 token', 'Maximum output tokens')}</dt><dd>{String(draft.max_tokens || '—')}</dd><dt>{t('价格', 'Pricing')}</dt><dd>{draft.input_price_usd || draft.output_price_usd ? `${draft.input_price_usd || '—'} / ${draft.output_price_usd || '—'} USD` : t('未知', 'Unknown')}</dd></> : <><dt>{t('适配器', 'Adapter')}</dt><dd>Webhook</dd><dt>{t('接收地址', 'Receiver URL')}</dt><dd className="break-anywhere">{String(draft.url || '—')}</dd><dt>{t('保存后状态', 'State after saving')}</dt><dd>{resource?.data.enabled === true ? t('保持启用', 'Remain enabled') : t('停用；不会发送消息', 'Disabled; no message will be sent')}</dd></>}
      <dt>{t('凭据', 'Credential')}</dt><dd>{credentialSummary}</dd>
      {kind === 'models' && <><dt>{t('私有网络', 'Private network')}</dt><dd>{draft.provider === 'diagnostic' ? t('关闭', 'Off') : draft.allow_private_network ? t('请求实例管理员批准', 'Request instance-admin approval') : t('关闭', 'Off')}</dd></>}
      <dt>{t('可见范围', 'Visibility')}</dt><dd>{visibility === 'workspace' ? t('当前工作区', 'This workspace') : t('仅自己', 'Only me')}</dd>
    </dl>{kind === 'routes' && !resource && <p className="muted small">{t('保存只创建停用的 Webhook。启用投递是单独操作，不会在此处发送消息。', 'Saving creates a disabled Webhook. Enabling delivery is a separate action and sends no message here.')}</p>}</section>}
    {fields.some(f => f.type === 'model') && <LoadMore query={modelQuery} label={t('加载更多模型', 'Load more models')} />}
    {fields.some(f => f.type === 'conversation') && <LoadMore query={conversationQuery} label={t('加载更早的会话', 'Load older conversations')} />}
    {kind === 'schedules' && <SchedulePreview workspace={workspace} draft={draft} models={(modelQuery.data ?? []).map(row => row.id)} conversations={(conversationQuery.data ?? []).map(row => row.id)} showIssues={showIssues} />}
    {!resource && (!wizard || step === 2) && <Field label={t('可见范围', 'Visibility')} hint={t('共享给当前工作区的成员；私有资源仅本人可见。', 'Workspace resources are shared with its members; private resources are visible only to you.')}><select disabled={busy} value={visibility} onChange={e => setVisibility(e.target.value as 'private' | 'workspace')}><option value="private">{t('仅自己', 'Only me')}</option><option value="workspace">{t('当前工作区', 'This workspace')}</option></select></Field>}
    {wizard ? <div className="dialog-actions"><Button type="button" disabled={busy} onClick={close}>{t('取消', 'Cancel')}</Button>{step > 0 && <Button type="button" disabled={busy} onClick={() => { setError(null); setStep(current => Math.max(0, current - 1)); }}>{t('上一步', 'Back')}</Button>}{step < 2 ? <Button type="submit" variant="primary">{t('下一步', 'Continue')}<ChevronRight size={16} /></Button> : <Button type="submit" variant="primary" busy={busy}>{t('保存配置', 'Save configuration')}<Check size={16} /></Button>}</div> : <div className="dialog-actions"><Button type="button" disabled={busy} onClick={close}>{t('取消', 'Cancel')}</Button><Button type="submit" variant="primary" busy={busy}>{t('保存', 'Save')}<Check size={16} /></Button></div>}
  </form></Modal>;
}

export default function Resources({ workspace, kind, user, goRun }: { workspace: Workspace; kind: ResourceKind; user: User; goRun: (id: string) => void }) {
  const { t, language } = useText(); const client = useQueryClient(); const query = useResources(workspace.id, kind, kind === 'schedules' ? 5000 : undefined);
  const [search, setSearch] = useState(''); const [editor, setEditor] = useState<Resource | 'new' | null>(null); const [deleting, setDeleting] = useState<Resource | null>(null);
  const [sending, setSending] = useState<Resource | null>(null);
  const [testing, setTesting] = useState<Resource | null>(null);
  const [reviewing, setReviewing] = useState<Resource | null>(null); const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [detail, setDetail] = useState<Resource | null>(null); const [busy, setBusy] = useState(''); const [error, setError] = useState<unknown>(null); const [notice, setNotice] = useState('');
  const Icon = icons[kind];
  const write = roleAllows(workspace.role, 'member');
  const allowedCreate = canCreateResource(workspace.role, kind, user);
  const refresh = () => { void client.invalidateQueries({ queryKey: [workspace.id] }); };
  const records = query.data?.filter(r => `${value(r.data, 'name')} ${value(r.data, 'title')} ${value(r.data, 'content')} ${value(r.data, 'text')} ${value(r.data, 'prompt')} ${value(r.data, 'model')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  async function action(record: Resource, name: string) {
    setBusy(`${record.id}:${name}`); setError(null); setNotice('');
    try {
      if (name === 'delete') { await remove(resourcePath(workspace.id, record.id), record.version); setDeleting(null); }
      else if (kind === 'routes' && (name === 'enable' || name === 'disable')) {
        const data: Json = { name: value(record.data, 'name'), adapter: 'webhook', url: value(record.data, 'url'), enabled: name === 'enable', allow_private_network: record.data.allow_private_network === true };
        await patch(resourcePath(workspace.id, record.id), { version: record.version, data });
        setNotice(name === 'enable' ? t('已启用后续投递；此操作没有发送消息。', 'Delivery is enabled for future requests; this action sent no message.') : t('已停用新投递申请；已经进入外部网络的请求无法由此撤回。', 'New delivery requests are disabled; requests already sent to the network cannot be recalled here.'));
      }
      else if (name === 'toggle' || name === 'archive') await patch(resourcePath(workspace.id, record.id), { version: record.version, data: { ...record.data, [name === 'toggle' ? 'enabled' : 'archived']: !record.data[name === 'toggle' ? 'enabled' : 'archived'] } });
      else { const result = await post<Json>(`${workspacePath(workspace.id)}/${kind}/${record.id}/${name}`); setNotice(name === 'test' ? t('实际调用测试通过。', 'The actual model request succeeded.') : t('操作已接受，请查看最新状态。', 'The operation was accepted. Check the updated status.')); if (result?.error) setNotice(String(result.error)); }
      refresh();
    } catch (e) { setError(e); } finally { setBusy(''); }
  }
  async function reviewSchedule() {
    if (!reviewing || !reviewConfirmed) return;
    setBusy(`${reviewing.id}:review`); setError(null);
    try {
      await post(`${workspacePath(workspace.id)}/schedules/${reviewing.id}/reconcile`, { version: reviewing.version, acknowledge: true });
      setReviewing(null); setReviewConfirmed(false); setDetail(null);
      setNotice(t('已记录核对，任务仍处于暂停。需要时请单独启用。', 'Review recorded. The schedule remains paused; enable it separately when ready.'));
      refresh();
    } catch (e) { setError(e); } finally { setBusy(''); }
  }
  return <section className="page"><PageHeader eyebrow={t('当前工作区', 'WORKSPACE')} title={t(...pageTitles[kind])} description={t(...descriptions[kind])} action={allowedCreate && <Button variant="primary" onClick={() => setEditor('new')}><Plus size={17} />{kind === 'routes' ? t('创建 Webhook', 'Create Webhook') : t('添加', 'Add')}</Button>} />
    {kind === 'knowledge' && <p className="info-line">{t('当前可导入文本与 Markdown，并进行词项检索。此版本尚未提供向量嵌入与 PDF 解析。', 'Import text or Markdown and use lexical retrieval. Vector embeddings and PDF parsing are not available in this version.')}</p>}
    {kind === 'plugins' && <p className="info-line">{t('选择由实例管理员安装的可信插件包。配置保存、启用与实际调用是独立状态。', 'Choose trusted packages installed by the instance administrator. Saved configuration, enabled state and actual invocation are separate.')}</p>}
    {kind === 'routes' && roleAllows(workspace.role, 'admin') && !user.instance_admin && <p className="info-line">{t('创建或更改投递目标需要工作区管理员与实例管理员同时授权。你仍可停用现有渠道。', 'Creating or changing a delivery destination requires both workspace-admin and instance-admin authority. You can still disable an existing route.')}</p>}
    <ErrorNotice error={error || query.error} onRetry={refresh} />{notice && <div className="notice success" role="status"><Check size={18} />{notice}</div>}
    <div className="collection-toolbar"><label className="search"><Search size={17} aria-hidden="true" /><input aria-label={t('搜索已加载的条目', 'Search loaded items')} placeholder={t('搜索已加载的条目…', 'Search loaded items…')} value={search} onChange={e => setSearch(e.target.value)} /></label><span className="muted small">{records.length} {t('项', 'items')}</span><Button variant="ghost icon" aria-label={t('刷新', 'Refresh')} onClick={refresh}><RefreshCw size={17} /></Button></div>
    {query.isPending ? <Loading /> : records.length === 0 ? <Empty title={search ? t('没有找到匹配项', 'No matches') : t('这里还有很多可能', 'Room for something useful')} description={search ? t('试试其他关键词。', 'Try a different search.') : t('添加第一个条目，开始使用。', 'Add your first item to get started.')} action={allowedCreate && !search && <Button onClick={() => setEditor('new')}><Plus size={16} />{t('添加', 'Add')}</Button>} /> : <div className="resource-list">{records.map(record => {
      const title = value(record.data, 'name', value(record.data, 'title', record.id));
      const last = record.data.last_result;
      const lastStatus = last && typeof last === 'object' && !Array.isArray(last) && 'status' in last && typeof last.status === 'string' ? last.status : '';
      const rawState = value(record.data, 'status') || (record.data.archived ? 'archived' : record.data.enabled === false ? 'disabled' : record.data.enabled === true ? 'enabled' : undefined);
      const state = kind === 'schedules' && rawState === 'completed' && ['failed', 'cancelled'].includes(lastStatus) ? lastStatus : rawState;
      const canDelete = canWriteResource(workspace.role, user, record);
      const canEdit = canDelete && (kind !== 'schedules' || record.owner_id === user.id) && (kind !== 'routes' || user.instance_admin === true);
      const description = kind === 'models' ? `${value(record.data, 'provider')} / ${value(record.data, 'model')}` : kind === 'plugins' ? value(record.data, 'package_id') : value(record.data, 'content', value(record.data, 'text', value(record.data, 'prompt', value(record.data, 'system_prompt', value(record.data, 'url')))));
      return <article className="resource-row" key={record.id}><span className="resource-icon"><Icon size={22} /></span><div className="resource-main"><button className="resource-title" onClick={() => setDetail(record)}>{title}<ChevronRight size={15} /></button><p className="resource-description">{description || t('已保存配置', 'Configuration saved')}</p><div className="resource-meta">{record.visibility === 'private' ? <span><LockKeyhole size={12} />{t('私有', 'Private')}</span> : <span><Users size={12} />{t('工作区共享', 'Workspace')}</span>}<span>{formatTime(record.updated_at, language)}</span>{state && <Status state={state} />}{kind === 'schedules' && lastStatus && <span>{t('上次运行：', 'Last run: ')}<Status state={lastStatus} /></span>}{kind === 'models' && record.data.has_api_key === true && <span>{t('密钥已配置', 'Key configured')}</span>}{kind === 'schedules' && !!record.data.next_run && <span>{record.data.enabled === false ? t('暂停 · 候选：', 'Paused · candidate: ') : t('下次候选：', 'Next candidate: ')}{zonedTime(Number(record.data.next_run), value(record.data, 'timezone', 'UTC'), language)}</span>}</div></div><div className="resource-actions">
        {kind === 'models' && canEdit && <Button variant="ghost" title={t('会调用已保存配置，可能产生费用', 'Calls the saved configuration and may incur a charge')} aria-label={`${t('发起模型调用测试', 'Run model call test')}: ${title}`} onClick={() => setTesting(record)}><FlaskConical size={16} /><span>{t('测试', 'Test')}</span></Button>}
        {kind === 'plugins' && canEdit && <Button variant="ghost icon" aria-label={t('重载', 'Reload')} busy={busy === `${record.id}:reload`} onClick={() => action(record, 'reload')}><RefreshCw size={16} /></Button>}
        {kind === 'routes' && write && record.data.enabled === true && <Button variant="ghost" onClick={() => setSending(record)}><Send size={16} />{t('发送消息', 'Send message')}</Button>}
        {kind === 'routes' && canEdit && record.data.enabled !== true && <Button variant="ghost" onClick={() => action(record, 'enable')} busy={busy === `${record.id}:enable`}>{t('启用投递', 'Enable delivery')}</Button>}
        {kind === 'routes' && canDelete && record.data.enabled === true && <Button variant="ghost" onClick={() => action(record, 'disable')} busy={busy === `${record.id}:disable`}>{t('停用', 'Disable')}</Button>}
        {kind === 'schedules' && canEdit && <Button variant="ghost" disabled={['unknown', 'needs_reconciliation'].includes(rawState ?? '')} onClick={() => action(record, 'run')} busy={busy === `${record.id}:run`}>{t('立即运行', 'Run now')}</Button>}
        {['plugins', 'schedules', 'memories'].includes(kind) && canEdit && <Button variant="ghost" disabled={kind === 'schedules' && ['unknown', 'needs_reconciliation'].includes(rawState ?? '')} onClick={() => action(record, 'toggle')} busy={busy === `${record.id}:toggle`}>{record.data.enabled ? t('停用', 'Disable') : t('启用', 'Enable')}</Button>}
        {canEdit && <Button variant="ghost icon" aria-label={`${t('编辑', 'Edit')} ${title}`} onClick={() => setEditor(record)}><Pencil size={16} /></Button>}
        {canDelete && <Button variant="ghost icon" aria-label={`${t('删除', 'Delete')} ${title}`} onClick={() => setDeleting(record)}><Trash2 size={16} /></Button>}
      </div></article>;
    })}</div>}
    <LoadMore query={query} />
    {kind === 'routes' && <DeliveryHistory workspace={workspace.id} />}
    {sending && <SendDialog workspace={workspace.id} user={user.id} route={sending} close={() => setSending(null)} saved={refresh} />}
    {testing && <ModelTestDialog workspace={workspace.id} model={testing} close={() => setTesting(null)} completed={refresh} />}
    {reviewing && <Modal title={t('核对中断的任务', 'Review interrupted schedule')} close={() => { setReviewing(null); setReviewConfirmed(false); setError(null); }}><div className="stack"><p>{t('旧请求可能已经到达模型或接收方。确认只记录你已检查，结果仍可能未知；不会发送请求，也不会启用任务。', 'The previous request may have reached the model or destination. Confirmation records your review, not the outcome; it will not send a request or enable the schedule.')}</p>{typeof reviewing.data.run_id !== 'string' && <p>{t('没有可查看的运行记录，无法从这里核实旧请求是否执行。', 'No run record is available here to verify whether the previous request executed.')}</p>}<label className="check-field"><input type="checkbox" checked={reviewConfirmed} onChange={event => setReviewConfirmed(event.target.checked)} /><span>{t('我已检查现有记录，明白旧结果可能仍未知。', 'I checked the available records and understand the previous outcome may remain unknown.')}</span></label><ErrorNotice error={error} /><div className="dialog-actions"><Button onClick={() => { setReviewing(null); setReviewConfirmed(false); setError(null); }}>{t('取消', 'Cancel')}</Button><Button variant="primary" disabled={!reviewConfirmed} busy={busy === `${reviewing.id}:review`} onClick={reviewSchedule}>{t('记录核对', 'Record review')}</Button></div></div></Modal>}
    {editor && <ResourceEditor key={`${workspace.id}:${user.id}:${kind}:${editor === 'new' ? 'new' : editor.id}`} workspace={workspace.id} kind={kind} resource={editor === 'new' ? undefined : editor} user={user} close={() => setEditor(null)} saved={refresh} />}
    {deleting && <Modal title={t('删除此条目？', 'Delete this item?')} close={() => setDeleting(null)}><p>{value(deleting.data, 'name', value(deleting.data, 'title', deleting.id))}</p><p className="muted">{t('此操作将删除保存的条目。', 'This removes the saved item.')}</p><ErrorNotice error={error} /><div className="dialog-actions"><Button onClick={() => setDeleting(null)}>{t('取消', 'Cancel')}</Button><Button variant="danger" busy={busy === `${deleting.id}:delete`} onClick={() => action(deleting, 'delete')}>{t('删除', 'Delete')}</Button></div></Modal>}
    {detail && <Modal title={value(detail.data, 'name', value(detail.data, 'title', t('详情', 'Details')))} close={() => setDetail(null)} wide><div className="stack"><p className="muted small">{detail.id} · v{detail.version}</p><div className="document-text">{value(detail.data, 'content', value(detail.data, 'text', value(detail.data, 'prompt', value(detail.data, 'system_prompt', value(detail.data, 'base_url'))))) || t('此条目没有正文。', 'This item has no body text.')}</div>{kind === 'schedules' && <div className="resource-guidance"><p>{t('计划时区：', 'Schedule time zone: ')}{value(detail.data, 'timezone', 'UTC')} · {value(detail.data, 'cron', value(detail.data, 'schedule_type'))}</p><p>{detail.data.enabled === false ? t('不会自动运行。', 'No automatic run is scheduled.') : t('实际运行仍须满足权限与任务状态。', 'Execution remains subject to permissions and task state.')}</p>{detail.data.status === 'needs_reconciliation' && <p role="status">{t('上次运行的结果需要核对，不会自动重发。请先查看运行记录和实际接收方。', 'The previous outcome needs review and will not be retried automatically. Check the run and destination first.')}</p>}{typeof detail.data.run_id === 'string' && <Button type="button" onClick={() => goRun(String(detail.data.run_id))}>{t('查看对应运行', 'View related run')}</Button>}{['unknown', 'needs_reconciliation'].includes(value(detail.data, 'status')) && detail.owner_id === user.id && roleAllows(workspace.role, 'member') && <Button type="button" onClick={() => { setReviewing(detail); setReviewConfirmed(false); setDetail(null); setError(null); }}>{t('核对并记录', 'Review and record')}</Button>}{!!detail.data.last_review && <p>{t('已记录核对，旧结果仍可能未知。', 'Review recorded; the previous outcome may still be unknown.')}</p>}{detail.data.schedule_type === 'once' && typeof detail.data.at === 'number' && detail.data.at <= Date.now() / 1000 && detail.data.enabled === false && <p>{t('如需再次安排，请先编辑为未来时间。', 'To schedule another run, first edit the time to a future date.')}</p>}{typeof detail.data.next_run === 'number' && <><p>{zonedTime(detail.data.next_run, value(detail.data, 'timezone', 'UTC'), language)}</p><p>{t('设备时间：', 'Device time: ')}{zonedTime(detail.data.next_run, Intl.DateTimeFormat().resolvedOptions().timeZone, language)}</p></>}</div>}{kind === 'memories' && <><p className="small muted">{t('来源：', 'Source: ')}{value(detail.data, 'source', t('未注明', 'Not specified'))}</p>{canWriteResource(workspace.role, user, detail) && <Button onClick={() => { void action(detail, 'archive'); setDetail(null); }}>{detail.data.archived ? t('恢复使用', 'Restore') : t('归档', 'Archive')}</Button>}</>}{kind === 'knowledge' && <p className="muted small">{t('索引版本：', 'Index version: ')}{number(detail.data, 'index_version', 1)} · {Array.isArray(detail.data.chunks) ? detail.data.chunks.length : '—'} {t('个分块', 'chunks')}</p>}<Button onClick={() => setDetail(null)}>{t('关闭', 'Close')}</Button></div></Modal>}
  </section>;
}
