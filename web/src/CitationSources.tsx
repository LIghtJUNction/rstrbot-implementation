import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { api, isResourceUnavailable, value } from './api';
import type { Resource } from './api';
import { resourcePath } from './data';
import { Button, Loading, Modal, useText } from './ui';

type Source = { documentId: string; chunkId: string; title: string; hash: string; indexVersion: number; start: number; end: number };

type Excerpt = { before: string; match: string; after: string };

function readSource(input: unknown): Source | null {
  if (!input || typeof input !== 'object') return null;
  const fields = Object.fromEntries(Object.entries(input));
  const { document_id, chunk_id, source_hash, index_version, source_start, source_end } = fields;
  if (typeof document_id !== 'string' || !document_id || typeof chunk_id !== 'string' || !chunk_id ||
      typeof source_hash !== 'string' || !/^[a-f0-9]{64}$/.test(source_hash) ||
      typeof index_version !== 'number' || !Number.isSafeInteger(index_version) || index_version < 1 ||
      typeof source_start !== 'number' || !Number.isSafeInteger(source_start) || source_start < 0 ||
      typeof source_end !== 'number' || !Number.isSafeInteger(source_end) || source_end <= source_start) return null;
  return { documentId: document_id, chunkId: chunk_id, title: typeof fields.title === 'string' ? fields.title.slice(0, 512) : '', hash: source_hash, indexVersion: index_version, start: source_start, end: source_end };
}

function findExcerpt(resource: Resource, source: Source): Excerpt | null {
  const data = resource.data;
  if (resource.kind !== 'knowledge' || resource.id !== source.documentId || data.source_hash !== source.hash ||
      data.index_version !== source.indexVersion || data.state !== 'ready' || data.enabled === false || data.archived === true ||
      typeof data.text !== 'string' || !Array.isArray(data.chunks)) return null;
  const chunk = data.chunks.find(item => item && typeof item === 'object' && item.id === source.chunkId &&
    item.start_byte === source.start && item.end_byte === source.end && typeof item.text === 'string');
  if (!chunk) return null;
  const bytes = new TextEncoder().encode(data.text);
  if (source.end > bytes.length) return null;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const before = decoder.decode(bytes.slice(0, source.start));
    const match = decoder.decode(bytes.slice(source.start, source.end));
    const after = decoder.decode(bytes.slice(source.end));
    return match === chunk.text ? { before, match, after } : null;
  } catch { return null; }
}

function SourceDialog({ workspace, user, source, close }: { workspace: string; user: string; source: Source; close: () => void }) {
  const { t } = useText();
  const documentRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const query = useQuery({
    queryKey: [workspace, 'citation-source', user, source.documentId, source.hash, source.chunkId],
    queryFn: ({ signal }) => api<Resource>(resourcePath(workspace, source.documentId), { signal }),
    staleTime: 0, gcTime: 0, retry: false, refetchOnMount: 'always', refetchInterval: 3000,
  });
  const excerpt = !query.error && query.data ? findExcerpt(query.data, source) : null;
  const checking = query.isFetching && (!query.data || !!query.error);
  const unavailable = isResourceUnavailable(query.error) || (!query.isFetching && !query.error && !excerpt);
  useLayoutEffect(() => {
    const document = documentRef.current; const mark = markRef.current;
    if (document && mark) document.scrollTop += mark.getBoundingClientRect().top - document.getBoundingClientRect().top - 12;
  }, [source.documentId, source.hash, source.chunkId, !!excerpt]);
  return <Modal title={t('核对资料', 'Check source')} close={close} wide>
    {checking ? <Loading /> : unavailable ? <div className="stack"><p role="status">{t('资料已更改、停用、删除或你已无法访问，无法核对当时的原文。', 'The source changed, was disabled or deleted, or is no longer accessible. The original passage cannot be verified.')}</p><Button onClick={() => void query.refetch()}>{t('重新检查', 'Check again')}</Button></div> : query.error ? <div className="stack"><p role="alert">{t('暂时无法检查资料，请检查连接后重试。', 'Could not check the source. Check your connection and try again.')}</p><Button onClick={() => void query.refetch()}>{t('重试', 'Retry')}</Button></div> : excerpt && query.data && <div className="stack"><h3>{value(query.data.data, 'title', t('资料', 'Source'))}</h3><p className="muted small">{t('突出显示的是当时检索到的片段。', 'The highlighted passage is what was retrieved.')} {t('内容版本', 'Content version')} {source.hash.slice(0, 12)} · {t('原文位置', 'Source position')} {source.start}–{source.end} {t('字节', 'bytes')}</p><div ref={documentRef} className="document-text source-document">{excerpt.before}<mark ref={markRef}>{excerpt.match}</mark>{excerpt.after}</div><Button onClick={close}>{t('关闭', 'Close')}</Button></div>}
  </Modal>;
}

export function CitationSources({ citations, workspace, user }: { citations: unknown; workspace: string; user: string }) {
  const { t } = useText();
  const [selected, setSelected] = useState<Source | null>(null);
  if (!Array.isArray(citations) || citations.length === 0) return null;
  const sources = citations.map(readSource);
  return <div className="message-sources"><p className="muted small">{t('检索到的资料（不一定被回答使用）', 'Retrieved sources (not necessarily used in the answer)')}</p><div className="source-buttons">{sources.map((source, index) => source ? <Button key={`${source.documentId}:${source.chunkId}:${index}`} variant="ghost" onClick={() => setSelected(source)}><BookOpen size={14} />{t(`资料 ${index + 1}`, `Source ${index + 1}`)}{source.title && `: ${source.title}`}</Button> : <span key={index} className="muted small">{t(`资料 ${index + 1} 无法核对`, `Source ${index + 1} cannot be checked`)}</span>)}</div>{selected && <SourceDialog workspace={workspace} user={user} source={selected} close={() => setSelected(null)} />}</div>;
}
