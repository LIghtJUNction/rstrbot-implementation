import type { Json, Resource } from './api';

export type ConfigurationKind = 'models' | 'routes';
export type ConfigurationIssue = { field: string; message: [string, string] };
type PreparedConfiguration = { ok: true; data: Json } | { ok: false; issues: [ConfigurationIssue, ...ConfigurationIssue[]] };

// Shared by step validation and the final save. Secrets never enter an error message.
export function prepareConfiguration({ kind, draft, saved, providers }: {
  kind: ConfigurationKind; draft: Json; saved?: Resource; providers: readonly string[] | null;
}): PreparedConfiguration {
  const issues: ConfigurationIssue[] = [];
  const issue = (field: string, zh: string, en: string) => issues.push({ field, message: [zh, en] });
  const text = (key: string) => typeof draft[key] === 'string' ? draft[key] : '';
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const name = text('name');
  if (!name.trim() || bytes(name) > 200) issue('name', '名称不能为空，且不能超过 200 个 UTF-8 字节。', 'Name is required and must be at most 200 UTF-8 bytes.');
  const provider = text('provider');
  if (kind === 'models') {
    if (providers === null) issue('provider', '还没有成功读取模型插件，请先重试。', 'Model plugins have not loaded successfully. Retry first.');
    else if (!providers.includes(provider)) issue('provider', '请选择当前已安装的模型插件。', 'Choose a currently installed model plugin.');
  }
  const diagnostic = kind === 'models' && provider === 'diagnostic';
  const urlKey = kind === 'models' ? 'base_url' : 'url';
  const url = text(urlKey);
  if (!diagnostic) {
    if (!url || url.trim() !== url || bytes(url) > 2048) issue(urlKey, '请输入完整地址，最多 2048 个 UTF-8 字节，首尾不能有空白。', 'Enter an absolute URL of at most 2048 UTF-8 bytes, without surrounding whitespace.');
    else {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
      } catch { issue(urlKey, '地址须使用 HTTP(S)，且不能包含账号、密码、查询参数或片段。', 'Use an absolute HTTP(S) URL without embedded credentials, query parameters, or fragments.'); }
    }
  }
  const secretKey = kind === 'models' ? 'api_key' : 'token';
  const clearKey = kind === 'models' ? 'clear_api_key' : 'clear_token';
  const hasSecretKey = kind === 'models' ? 'has_api_key' : 'has_token';
  const secret = diagnostic || draft[clearKey] === true ? '' : text(secretKey);
  if (secret && (bytes(secret) > 8192 || /[\u0000-\u001f\u007f]/.test(secret) || !secret.trim())) issue(secretKey, '凭据最多 8192 个 UTF-8 字节，不能只有空白或包含控制字符。', 'Credentials must be at most 8192 UTF-8 bytes, not whitespace only, and contain no control characters.');
  const targetChanged = saved && (url !== saved.data[urlKey] || (kind === 'models' && provider !== saved.data.provider));
  if (saved?.data[hasSecretKey] === true && targetChanged && !secret && draft[clearKey] !== true) issue(diagnostic ? clearKey : secretKey, '目标已变化。请填写新凭据，或明确清除旧凭据。', 'The destination changed. Enter a new credential or explicitly clear the saved one.');
  const data: Json = { name, allow_private_network: !diagnostic && draft.allow_private_network === true };
  if (draft[clearKey] === true) data[clearKey] = true;
  else if (secret) data[secretKey] = secret;
  if (kind === 'routes') Object.assign(data, { adapter: 'webhook', url, enabled: saved?.data.enabled === true });
  else {
    const model = text('model');
    const maxTokens = Number(draft.max_tokens);
    if (!model.trim() || bytes(model) > 200) issue('model', '模型 ID 不能为空，且不能超过 200 个 UTF-8 字节。', 'Model ID is required and must be at most 200 UTF-8 bytes.');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) issue('max_tokens', '最大输出 token 必须是 1 到 32768 的整数。', 'Maximum output tokens must be an integer from 1 to 32768.');
    Object.assign(data, { provider, model, max_tokens: maxTokens });
    if (!diagnostic) data.base_url = url;
    for (const direction of ['input', 'output']) {
      const key = `${direction}_price_usd`;
      const price = text(key);
      if (!price) continue;
      if (price.length > 64 || !/^\d+(\.\d{1,6})?$/.test(price)) {
        issue(key, '价格必须为非负数，最多六位小数。', 'Prices must be non-negative with up to six decimal places.');
        continue;
      }
      const [whole, fraction = ''] = price.split('.');
      const exact = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
      if (exact > 1000000000000n) issue(key, '价格超过服务端支持上限。', 'Price exceeds the server-supported limit.');
      else data[`${direction}_microusd_per_million`] = Number(exact);
    }
  }
  const [first, ...rest] = issues;
  return first ? { ok: false, issues: [first, ...rest] } : { ok: true, data };
}
