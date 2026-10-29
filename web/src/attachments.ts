export type TextAttachment = { name: string; text: string };
export type ImageAttachment = { name: string; mime: 'image/png' | 'image/jpeg'; data: string };

export function parseImages(value: unknown): ImageAttachment[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const images: ImageAttachment[] = []; let total = 0;
  for (const item of value) {
    if (typeof item !== 'object' || item === null || !('name' in item) || !('mime' in item) || !('data' in item) || typeof item.name !== 'string' || typeof item.data !== 'string') return null;
    if (!((item.mime === 'image/png' && /\.png$/i.test(item.name)) || (item.mime === 'image/jpeg' && /\.jpe?g$/i.test(item.name))) || /[\x00-\x1f\x7f-\x9f/\\]/.test(item.name) || new TextEncoder().encode(item.name).length > 255 || item.data.length > 349528) return null;
    let bytes: string;
    try { bytes = atob(item.data); } catch { return null; }
    if (!bytes.length || btoa(bytes) !== item.data) return null;
    total += bytes.length;
    images.push({ name: item.name, mime: item.mime, data: item.data });
  }
  return total <= 262144 ? images : null;
}

export function readDraftImages(raw: string): ImageAttachment[] {
  try { return parseImages(JSON.parse(raw)) ?? []; } catch { return []; }
}

export async function decodeImages(files: File[], previous: ImageAttachment[]): Promise<ImageAttachment[]> {
  if (files.length + previous.length > 3 || files.some(file => file.size > 262144)) throw new Error('image_limit');
  const images = [...previous];
  for (const file of files) {
    const mime = /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : null;
    if (!mime) throw new Error('image_format');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    images.push({ name: file.name, mime, data: btoa(binary) });
  }
  const parsed = parseImages(images);
  if (!parsed) throw new Error('image_invalid');
  return parsed;
}

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
