import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Download, History, RotateCcw, Save } from 'lucide-react';
import projectPrompt from '../../docs/RECIPE_BUILD_PROMPT.md?raw';
import { useText } from './ui';
import { maxVersions, promptStorageKey, readPromptState } from './promptStorage';
import type { PromptState, PromptVersion } from './promptStorage';

const baselineVersion = projectPrompt.match(/^# RstrBot 重建提示词 ([0-9]+\.[0-9]+)/m)?.[1] ?? '—';

function lineChanges(content: string) {
  const base = projectPrompt.split('\n');
  const current = content.split('\n');
  let first = 0;
  while (first < base.length && first < current.length && base[first] === current[first]) first++;
  let tail = 0;
  while (tail < base.length - first && tail < current.length - first && base[base.length - 1 - tail] === current[current.length - 1 - tail]) tail++;
  const removedLines = base.slice(first, base.length - tail);
  const addedLines = current.slice(first, current.length - tail);
  return { removed: removedLines.length, added: addedLines.length, removedLines, addedLines, firstLine: first + 1 };
}

function download(content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'BUILD_PROMPT.md';
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function BuildPromptEditor({ userId }: { userId: string }) {
  return <AccountPromptEditor key={userId} userId={userId} />;
}

function AccountPromptEditor({ userId }: { userId: string }) {
  const { t } = useText();
  const key = promptStorageKey({ origin: location.origin, userId });
  const [initial] = useState(() => {
    try { return { ...readPromptState(localStorage, key, projectPrompt), failed: false }; }
    catch { return { draft: projectPrompt, versions: [], failed: true }; }
  });
  const [draft, setDraft] = useState(initial.draft);
  const [versions, setVersions] = useState<PromptVersion[]>(initial.versions);
  const [storageError, setStorageError] = useState(initial.failed);
  const [saved, setSaved] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const savedTimer = useRef(0);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const diff = useMemo(() => lineChanges(draft), [draft]);

  function saveVersion() {
    const version: PromptVersion = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), content: draft };
    const next = [version, ...versions].slice(0, maxVersions);
    try {
      localStorage.setItem(key, JSON.stringify({ draft, versions: next } satisfies PromptState));
      setVersions(next);
      setStorageError(false);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2200);
    } catch {
      setStorageError(true);
    }
  }

  function restore(content: string) {
    setDraft(content);
    setSaved(false);
    try {
      localStorage.setItem(key, JSON.stringify({ draft: content, versions } satisfies PromptState));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }

  function restoreProject() {
    restore(projectPrompt);
  }

  return <section className="developer-section build-prompt-editor" aria-labelledby="build-prompt-title">
    <div className="developer-section-heading"><span className="developer-card-icon"><History size={19} aria-hidden="true" /></span><div><h2 id="build-prompt-title">{t('构建提示词', 'Build prompt')}</h2><p>{t('编辑下一轮需求，保存浏览器版本、比较改动或导出 Markdown。项目基线仍以仓库文件为准。', 'Edit requirements for the next iteration, save a browser version, compare changes, or export Markdown. The repository file remains the project baseline.')}</p></div></div>
    <div className="build-prompt-toolbar">
      <span className="build-prompt-baseline">{t(`仓库基线：RstrBot 重建提示词 ${baselineVersion}`, `Repository baseline: RstrBot build prompt ${baselineVersion}`)}</span>
      <div className="build-prompt-actions">
        <button type="button" className="button subtle" onClick={() => setShowDiff(value => !value)} aria-expanded={showDiff}>{t(showDiff ? '收起差异' : '查看差异', showDiff ? 'Hide changes' : 'View changes')}</button>
        <button type="button" className="button subtle" onClick={() => download(draft)}><Download size={15} aria-hidden="true" />{t('导出 Markdown', 'Export Markdown')}</button>
        <button type="button" className="button primary" onClick={saveVersion}><Save size={15} aria-hidden="true" />{t(saved ? '已保存' : '保存浏览器版本', saved ? 'Saved' : 'Save browser version')}</button>
      </div>
    </div>
    {storageError && <p className="build-prompt-notice" role="status">{t('浏览器未能读取或保存本地版本；当前文字仍在编辑器中，请导出留存。', 'The browser could not read or save a local version. Your text remains in the editor; export it to keep a copy.')}</p>}
    <label className="build-prompt-label" htmlFor="build-prompt-draft">{t('提示词正文', 'Prompt text')}</label>
    <textarea id="build-prompt-draft" className="build-prompt-textarea" spellCheck={false} value={draft} onChange={event => { setDraft(event.target.value); setSaved(false); }} />
    <div className="build-prompt-footnote"><span>{t('点击保存后，草稿与最近 20 版仅保存在此实例、此浏览器的当前账号下。', 'After saving, the draft and latest 20 versions belong to this account on this instance and browser.')}</span><button type="button" className="text-button" onClick={restoreProject}><RotateCcw size={14} aria-hidden="true" />{t('恢复仓库基线', 'Restore repository baseline')}</button></div>
    <p className="muted small">{t('升级前未绑定账号的旧稿不会自动载入，也不会被删除。无法确认归属的内容不会交给下一位登录者。', 'Older drafts without an account binding are neither loaded automatically nor deleted. Unattributed content is not handed to the next person who signs in.')}</p>
    {showDiff && <div className="build-prompt-diff" aria-live="polite">
      <div className="build-prompt-diff-heading"><strong>{t('相对仓库基线的改动', 'Changes from repository baseline')}</strong><span>−{diff.removed} / +{diff.added}</span></div>
      {diff.removed === 0 && diff.added === 0
        ? <p>{t('当前草稿与仓库基线相同。', 'The draft matches the repository baseline.')}</p>
        : <pre>{[...diff.removedLines.map(line => ({ marker: '−', line, kind: 'removed' })), ...diff.addedLines.map(line => ({ marker: '+', line, kind: 'added' }))].slice(0, 120).map((item, index) => <span className={item.kind} key={`${index}-${item.marker}`}><i>{item.marker}</i>{item.line || ' '}{'\n'}</span>)}{diff.removed + diff.added > 120 && <span>{t('差异较长，仅显示前 120 行。', 'Diff is long; only the first 120 lines are shown.')}</span>}</pre>}
      {(diff.removed > 0 || diff.added > 0) && <small>{t(`从第 ${diff.firstLine} 行附近开始显示。`, `Changes begin near line ${diff.firstLine}.`)}</small>}
    </div>}
    <details className="build-prompt-history"><summary>{t(`本机版本历史（${versions.length}）`, `Local version history (${versions.length})`)}</summary>{versions.length === 0 ? <p>{t('保存后，版本会列在这里。', 'Saved versions will appear here.')}</p> : <ul>{versions.map(version => { const changes = lineChanges(version.content); return <li key={version.id}><div className="build-prompt-version-info"><time dateTime={version.savedAt}>{new Date(version.savedAt).toISOString()}</time><small>−{changes.removed} / +{changes.added}</small></div><div><button type="button" className="text-button" onClick={() => restore(version.content)}><RotateCcw size={14} aria-hidden="true" />{t('恢复到编辑器', 'Restore to editor')}</button><button type="button" className="text-button" onClick={() => download(version.content)}><Download size={14} aria-hidden="true" />{t('导出这一版', 'Export this version')}</button></div></li>; })}</ul>}</details>
    <p className="build-prompt-notice">{t('保存只写入当前浏览器，不会改动仓库。要更新项目基线，请导出后将改动合并到 recipes/rstrbot/BUILD_PROMPT.md。', 'Saving changes only this browser; it does not update the repository. To update the project baseline, export the file and merge it into recipes/rstrbot/BUILD_PROMPT.md.')}</p>
    <a className="developer-doc-link" href="https://github.com/LIghtJUNction/RstrBot/blob/main/recipes/rstrbot/BUILD_PROMPT.md" target="_blank" rel="noreferrer">{t('查看仓库里的完整构建提示词', 'View the full repository build prompt')}<ArrowUpRight size={15} aria-hidden="true" /></a>
  </section>;
}
