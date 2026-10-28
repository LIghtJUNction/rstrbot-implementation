import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { Json } from './api';
import type { ConfigurationIssue } from './resourceConfiguration';
import { prepareSchedule, timeZoneSuggestions, zonedTime } from './scheduleConfiguration';
import { Button, ErrorNotice, Field, Loading, useText } from './ui';

export function CalendarFields({ draft, set, issues, busy }: { draft: Json; set: (key: string, value: unknown) => void; issues: ConfigurationIssue[]; busy: boolean }) {
  const { t } = useText();
  const [search, setSearch] = useState('');
  const zones = useMemo(timeZoneSuggestions, []);
  const zone = typeof draft.timezone === 'string' ? draft.timezone : '';
  const cron = typeof draft.cron === 'string' ? draft.cron : '';
  const daily = /^0 (\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  const frequency = daily ? 'daily' : cron === '0 0 * * * *' ? 'hourly' : 'custom';
  const time = daily ? `${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}` : '09:00';
  const error = (key: string) => { const issue = issues.find(item => item.field === key); return issue ? t(...issue.message) : undefined; };
  return <>
    <Field label={t('常用频率', 'Frequency preset')}><select disabled={busy} value={frequency} onChange={event => set('cron', event.target.value === 'daily' ? '0 0 9 * * *' : event.target.value === 'hourly' ? '0 0 * * * *' : '')}><option value="daily">{t('每天', 'Daily')}</option><option value="hourly">{t('每小时整点', 'Hourly')}</option><option value="custom">{t('自定义表达式', 'Custom expression')}</option></select></Field>
    {frequency === 'daily' && <Field label={t('每天执行时间', 'Daily run time')}><input type="time" value={time} disabled={busy} onChange={event => { const [hour, minute] = event.target.value.split(':'); set('cron', hour && minute ? `0 ${Number(minute)} ${Number(hour)} * * *` : ''); }} /></Field>}
    <Field label={t('日历表达式', 'Calendar expression')} error={error('cron')} hint={t('支持六或七段；秒须固定，最快每分钟一次。预设也可继续编辑。', 'Six or seven fields, with a fixed second; at most once a minute. Presets remain editable.')}><input name="cron" value={cron} disabled={busy} placeholder="0 0 9 * * *" onChange={event => set('cron', event.target.value)} /></Field>
    <Field label={t('查找时区', 'Search time zones')} hint={t('建议来自当前浏览器的IANA目录，最终由核心验证；可按城市或ID搜索。', 'Suggestions come from this browser’s IANA directory; the core validates the final ID. Search by city or ID.')}><input value={search} disabled={busy} placeholder="Tokyo" onChange={event => setSearch(event.target.value)} /></Field>
    <Field label={t('时区建议', 'Time zone suggestions')}><select value="" disabled={busy} onChange={event => { if (event.target.value) set('timezone', event.target.value); }}><option value="">{t('选择时区以填入下方…', 'Choose a time zone to fill below…')}</option>{zones.filter(id => id.toLowerCase().replaceAll('_', ' ').includes(search.toLowerCase().replaceAll('_', ' '))).map(id => <option key={id} value={id}>{id.replaceAll('_', ' ')}</option>)}</select></Field>
    <Field label={t('时区（IANA ID）', 'Time zone (IANA ID)')} error={error('timezone')} hint={t('可手动填写目录以外的有效ID；请先预览确认。', 'Other valid IDs can be entered manually; preview to confirm.')}><input name="timezone" value={zone} disabled={busy} placeholder="Asia/Tokyo" onChange={event => set('timezone', event.target.value)} /></Field>
  </>;
}

type Preview = { next_runs: number[]; timezone: string };
function parsePreview(value: unknown): Preview {
  if (!value || typeof value !== 'object' || !('timezone' in value) || typeof value.timezone !== 'string' || !('next_runs' in value) || !Array.isArray(value.next_runs) || value.next_runs.length > 5 || !value.next_runs.every(at => typeof at === 'number' && Number.isInteger(at) && at >= 0 && at <= 4102444800)) throw new Error('Invalid schedule preview response');
  return { timezone: value.timezone, next_runs: value.next_runs };
}
export function scheduleIssue(error: unknown): ConfigurationIssue | null {
  if (!(error instanceof ApiError) || ![400, 422].includes(error.status)) return null;
  if (/time zone|timezone/i.test(error.message)) return { field: 'timezone', message: ['核心不接受此时区，请从建议中选择或填写有效IANA ID。', 'The core rejected this time zone. Choose a suggestion or enter a valid IANA ID.'] };
  if (/calendar|cron/i.test(error.message)) return { field: 'cron', message: ['核心不接受此表达式，请调整格式或使用常用频率。', 'The core rejected this expression. Correct it or use a frequency preset.'] };
  return null;
}

export function SchedulePreview({ draft, workspace, models, conversations, showIssues }: { draft: Json; workspace: string; models: string[]; conversations: string[]; showIssues: (issues: ConfigurationIssue[]) => void }) {
  const { t, language } = useText();
  const titleId = useId();
  const key = JSON.stringify([workspace, draft]);
  const currentKey = useRef(key); currentKey.current = key;
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ key: string; status: 'loading' } | { key: string; status: 'success'; result: Preview } | { key: string; status: 'error'; error: unknown } | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [key]);
  async function preview() {
    const prepared = prepareSchedule({ draft, models, conversations });
    if (!prepared.ok) { showIssues(prepared.issues); return; }
    showIssues([]); request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setState({ key, status: 'loading' });
    try {
      const result = parsePreview(await api<unknown>(`/workspaces/${encodeURIComponent(workspace)}/schedules/preview`, { method: 'POST', body: JSON.stringify(prepared.data), signal: controller.signal }));
      if (!controller.signal.aborted && currentKey.current === key) setState({ key, status: 'success', result });
    } catch (error) {
      if (!controller.signal.aborted && currentKey.current === key) { const issue = scheduleIssue(error); if (issue) { showIssues([issue]); setState(null); } else setState({ key, status: 'error', error }); }
    } finally { if (request.current === controller) request.current = null; }
  }
  const visible = state?.key === key ? state : null;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <section className="schedule-preview resource-guidance" aria-labelledby={titleId}>
    <h3 id={titleId}>{t('执行时间预览', 'Execution time preview')}</h3>
    <p className="muted small">{t('只计算时间，不保存、不调用模型，也不运行任务。', 'Calculates times only: no saving, model calls, or task dispatch.')}</p>
    <Button type="button" busy={visible?.status === 'loading'} onClick={() => void preview()}>{t('预览执行时间', 'Preview execution times')}</Button>
    {visible?.status === 'loading' && <Loading />}
    {visible?.status === 'error' && <ErrorNotice error={visible.error} />}
    {visible?.status === 'success' && <div role="status"><p>{draft.enabled === true ? t('候选时间；实际运行仍受权限和任务状态约束。', 'Candidate times; actual execution remains subject to permissions and task state.') : t('任务已暂停。以下仅为候选时间，不会自动运行。', 'Schedule paused. These are candidate times only; no automatic run will occur.')}</p><ol>{visible.result.next_runs.map(at => <li key={at}><time dateTime={new Date(at * 1000).toISOString()}>{zonedTime(at, visible.result.timezone, language)}</time><br /><small>{t('设备时间：', 'Device time: ')}{zonedTime(at, localZone, language)}</small></li>)}</ol>{visible.result.next_runs.length === 0 && <p>{t('没有未来执行时间。', 'No future execution time.')}</p>}<p className="muted small">{t('错过的时刻跳过；夏令时空缺跳过，重复时刻只取第一次。', 'Missed times and DST gaps are skipped; repeated local times use the first occurrence.')}</p></div>}
  </section>;
}
