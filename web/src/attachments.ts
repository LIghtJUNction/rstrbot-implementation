export type TextAttachment = { name: string; text: string };

export function parseAttachments(value: unknown): TextAttachment[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const result: TextAttachment[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || !('name' in item) || !('text' in item) || typeof item.name !== 'string' || typeof item.text !== 'string') return null;
    if (!/\.(txt|md)$/i.test(item.name) || /[\x00-\x1f\x7f-\x9f/\\]/.test(item.name) || new TextEncoder().encode(item.name).length > 255 || item.text.includes('\0') || new TextEncoder().encode(item.text).length > 16384) return null;
    result.push({ name: item.name, text: item.text });
  }
  if (result.reduce((sum, item) => sum + new TextEncoder().encode(item.text).length, 0) > 32768) return null;
  return result;
}

export function readDraftAttachments(raw: string): TextAttachment[] {
  try { return parseAttachments(JSON.parse(raw)) ?? []; } catch { return []; }
}

export async function decodeFiles(files: File[], previous: TextAttachment[]): Promise<TextAttachment[]> {
  if (files.length + previous.length > 3) throw new Error('attachment_limit');
  const next = [...previous];
  for (const file of files) {
    if (file.size > 16384) throw new Error('attachment_invalid');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('attachment_invalid'); }
    next.push({ name: file.name, text });
  }
  const parsed = parseAttachments(next);
  if (!parsed) throw new Error('attachment_invalid');
  return parsed;
}
