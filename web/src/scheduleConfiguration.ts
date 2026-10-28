import type { Json } from './api';
import type { ConfigurationIssue } from './resourceConfiguration';

type PreparedSchedule = { ok: true; data: Json } | { ok: false; issues: [ConfigurationIssue, ...ConfigurationIssue[]] };
export function prepareSchedule({ draft, models, conversations }: { draft: Json; models: readonly string[]; conversations: readonly string[] }): PreparedSchedule {
  const issues: ConfigurationIssue[] = [];
  const data: Json = { enabled: draft.enabled === true, missed_policy: 'skip' };
  const issue = (field: string, zh: string, en: string) => issues.push({ field, message: [zh, en] });
  for (const [key, limit, zh, en] of [['title', 200, '任务名称', 'Schedule name'], ['prompt', 16384, '要做的事', 'Instructions']] satisfies [string, number, string, string][]) {
    const text = typeof draft[key] === 'string' ? draft[key] : '';
    if (!text.trim() || new TextEncoder().encode(text).length > limit) issue(key, `${zh}不能为空，且不能超过 ${limit} 个 UTF-8 字节。`, `${en} is required and must be at most ${limit} UTF-8 bytes.`);
    data[key] = text;
  }
  if (typeof draft.model_id !== 'string' || !models.includes(draft.model_id)) issue('model_id', '请选择当前可用的模型。', 'Choose an available model.');
  if (typeof draft.conversation_id !== 'string' || !conversations.includes(draft.conversation_id)) issue('conversation_id', '请选择有权访问的结果会话。', 'Choose an accessible conversation for results.');
  data.model_id = draft.model_id; data.conversation_id = draft.conversation_id;
  if (typeof draft.agent_id === 'string' && draft.agent_id) data.agent_id = draft.agent_id;
  switch (draft.schedule_type) {
    case 'once': {
      const at = typeof draft.at === 'number' ? draft.at : typeof draft.at === 'string' && draft.at ? Math.floor(Date.parse(draft.at) / 1000) : NaN;
      if (!Number.isInteger(at) || at < 0 || at > 4102444800) issue('at', '请输入1970—2100年内有效的设备本地时间。', 'Enter a valid device-local time within 1970–2100.');
      data.schedule_type = 'once'; data.at = at; break;
    }
    case 'interval':
      if (typeof draft.interval_seconds !== 'number' || !Number.isInteger(draft.interval_seconds) || draft.interval_seconds < 60 || draft.interval_seconds > 31536000) issue('interval_seconds', '间隔须为60—31536000秒的整数。', 'Interval must be an integer from 60 to 31536000 seconds.');
      data.schedule_type = 'interval'; data.interval_seconds = draft.interval_seconds;
      if (typeof draft.start_at === 'number') data.start_at = draft.start_at;
      break;
    case 'cron': {
      const cron = typeof draft.cron === 'string' ? draft.cron.trim() : '';
      const fields = cron.split(/\s+/);
      if (cron.length > 128 || ![6, 7].includes(fields.length) || !/^\d+$/.test(fields[0]) || Number(fields[0]) > 59) issue('cron', '请输入六或七段表达式，秒须为0—59的固定值；也可选择常用频率。', 'Use six or seven fields with a fixed second from 0 to 59, or choose a frequency preset.');
      const timezone = typeof draft.timezone === 'string' ? draft.timezone.trim() : '';
      if (!timezone || new TextEncoder().encode(timezone).length > 100) issue('timezone', '请选择时区，或填写IANA ID，如Asia/Tokyo。', 'Choose a time zone or enter an IANA ID such as Asia/Tokyo.');
      data.schedule_type = 'cron'; data.cron = cron; data.timezone = timezone; break;
    }
    default: issue('schedule_type', '请选择一次、固定间隔或日历计划。', 'Choose once, fixed interval, or calendar schedule.');
  }
  return issues[0] ? { ok: false, issues: [issues[0], ...issues.slice(1)] } : { ok: true, data };
}

export function timeZoneSuggestions(): string[] {
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set(['UTC', current, ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [])])].sort();
}

export function zonedTime(seconds: number, timezone: string, language: string): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return `${new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', options).format(new Date(seconds * 1000))} (${timezone})`; }
  catch { return `${new Date(seconds * 1000).toISOString()} (UTC)`; }
}
