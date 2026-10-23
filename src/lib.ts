import type { Project } from '../shared/types';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload as T;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url;
  });
}

async function makeJpeg(source: string, maxSide: number, quality: number): Promise<string> {
  const image = await loadImage(source);
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser could not prepare the image.');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export async function preparePhoto(file: File) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Choose JPEG or PNG photos. HEIC is not supported.');
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MiB.`);
  const originalDataUrl = await readAsDataUrl(file);
  let preparedDataUrl = await makeJpeg(originalDataUrl, 1600, 0.84);
  if (preparedDataUrl.length > 2_800_000) preparedDataUrl = await makeJpeg(originalDataUrl, 1280, 0.70);
  if (preparedDataUrl.length > 2_800_000) throw new Error(`${file.name} could not be reduced below the transfer limit.`);
  const thumbnailDataUrl = await makeJpeg(originalDataUrl, 128, 0.65);
  return { filename: file.name, originalDataUrl, preparedDataUrl, thumbnailDataUrl };
}

export function wordCount(value: string): number {
  const normalized = value.replace(/^\s*\d+[.)]\s*/gm, '').trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

export function writerPrompt(project: Project): string {
  return `Create an 8-second, vertical 9:16 UGC product-in-use script for this project.

Title: ${project.title}
Owner brief: ${project.notes || '(not supplied)'}
Feedback: ${project.feedback || '(none)'}
Product photo filenames: ${project.photos.map((photo) => photo.filename).join(', ') || '(none)'}

Inspect every attached product photo. Treat photos as product identity/design references, not scenes to animate. Preserve permanent logos, embroidery, patches, printed graphics, monograms, and integral branded hardware exactly where visible; never redesign, mirror, blur, misspell, replace, remove, or invent them. Remove every detachable retail or packaging artifact from every shot, including hang tags, price tags, product cards, barcode labels, stickers, security tags, plastic wrap, tissue, boxes, bags, hangers, clips, pins, and shipping materials. Create a new live-action scene with a real adult wearing or physically using the product. Use four distinct 2-second hard-cut shots. At least three shots must show a person, wearer, or hands interacting with the product, and at least four seconds must show actual use. Keep the same creator, product, setting, and light across shots. Use one achievable action per shot. Do not invent claims, prices, testimonials, hidden features, or readable labels. Dialogue must be conversational, include a complete CTA, target 18–20 words, and never exceed 24 words.

Return only valid JSON in this exact shape:
{"title":"Concise 3–7 word card title","dialogue":"1. ...\\n2. ...\\n3. ...\\n4. ...","shots":[{"description":"New live-action UGC scene; reference photos identify product design only, not the background, mannequin or pose. No still-photo animation. ..."},{"description":"..."},{"description":"..."},{"description":"..."}]}`;
}

export function cardHint(project: Project): string {
  if (project.render.phase === 'Generating' || project.render.phase === 'Submitting') return 'Generating';
  if (project.render.phase === 'Unknown') return 'Needs inspection';
  if (project.status === 'Ready') return 'Ready';
  if (project.status === 'Video review') return project.outputs.length ? `${project.outputs.at(-1)?.credits ?? 0} credits` : 'Awaiting review';
  if (project.status === 'Script review') return project.feedback ? 'Changes requested' : 'Awaiting review';
  if (project.status === 'Scripting') return `${wordCount(project.dialogue)}/24 words`;
  if (project.status === 'Rejected') return 'Rejected';
  return project.notes ? 'Brief ready' : 'Add a brief';
}
