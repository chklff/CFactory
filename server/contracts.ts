import { createHash } from 'node:crypto';
import {
  MAX_SHOTS, MIN_SHOTS, dialogueWordLimit, isVideoDuration,
  type ProductPhoto, type Project, type Resolution, type Shot
} from '../shared/types.js';

export const MAX_CREDITS = 150;
export const MODEL = 'seedance_2_5' as const;
export const ASPECT_RATIO = '9:16' as const;
export const DECLINED_PRESET_ID = '24bae836-2c4a-48e0-89b6-49fcc0b21612';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compact(value: unknown): string {
  return JSON.stringify(value);
}

export function referenceHash(project: Pick<Project, 'referenceRevision' | 'primaryPhotoId' | 'photos'>): string {
  return sha256(compact([
    project.referenceRevision,
    project.primaryPhotoId,
    project.photos.map((photo) => [photo.id, photo.sha256, photo.filename])
  ]));
}

export function dialogue(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
}

export function shotList(shots: Shot[]): string {
  return shots.map((shot) => `${shot.id}. (${shot.duration}s) ${shot.description.trim()}`).join('\n');
}

const REFERENCE_GUIDE =
  'PRODUCT REFERENCES: Use the supplied photos as PRODUCT IDENTITY AND DESIGN REFERENCES ONLY: preserve product shape, colour, proportions, cut and visible distinguishing details. The first image is the main product reference; others are supporting views of that same product. NON-NEGOTIABLE BRAND FIDELITY: PRESERVE every permanent brand mark that is physically part of the product, including authentic logos, embroidery, patches, printed graphics, monograms and integral branded hardware. Match their visible placement, colour, scale and design; do not remove, replace, redesign, mirror, blur, misspell or invent permanent branding. NON-NEGOTIABLE RETAIL CLEANUP: REMOVE every detachable retail or packaging artifact from every generated frame, including hang tags, price tags, product cards, barcode labels, stickers, security tags, plastic wrap, tissue, boxes, bags, hangers, clips, pins and shipping materials. These artifacts are not part of the product even when attached in a reference photo, and this cleanup rule overrides any conflicting shot direction. These references are NOT mandatory starting/end frames or scenes to animate. Build NEW live-action scenes exactly as the shot directions describe, including the person WEARING or physically USING this product. Do not copy a reference mannequin, flat lay, studio background, camera angle or pose. Product fidelity is not photo-composition fidelity. Do not substitute a slow pan, zoom, parallax or lightly animated catalogue still for the requested human action. Do not replace the product with a generic substitute or invent illegible labels, hidden features or unseen specifications.';

export function buildPrompt(project: Pick<Project, 'durationSeconds' | 'shots' | 'dialogue' | 'resolution' | 'photos'>): string {
  const shots = shotList(project.shots);
  const spoken = dialogue(project.dialogue);
  let prompt =
    `Create a ${project.durationSeconds}-second vertical 9:16 video. Follow EVERY shot below in order, preserving its duration and action. Retain all ${project.shots.length} listed shots. Explicit shot directions override general style defaults. Do not merge shots into a continuous take.\n\n` +
    'SHOT DIRECTIONS (authoritative; retain every listed shot):\n' + shots +
    '\n\nDIALOGUE (verbatim; do not truncate, paraphrase or omit the CTA):\n' + spoken +
    '\n\nDelivery: ' + project.resolution + ", 9:16. Follow the owner's specified camera, clothing, setting and audio directions. Do not invent a real app interface. A missing required asset must block production, not be silently removed.";
  if (project.photos.length > 0) prompt += '\n\n' + REFERENCE_GUIDE;
  return prompt;
}

export function renderSourceHash(project: Pick<Project, 'title' | 'notes' | 'dialogue' | 'durationSeconds' | 'shots' | 'feedback' | 'resolution' | 'photos' | 'referenceRevision' | 'primaryPhotoId'>): string {
  const prompt = buildPrompt(project);
  let source = compact([
    project.title ?? '',
    project.notes ?? '',
    project.dialogue ?? '',
    shotList(project.shots),
    project.feedback ?? '',
    prompt
  ]);
  if (project.referenceRevision > 0 || project.photos.length > 0) {
    source += '\n' + compact([
      project.referenceRevision,
      project.primaryPhotoId,
      project.photos.map((photo: ProductPhoto) => [photo.id, photo.sha256, photo.filename])
    ]);
  }
  if (project.resolution !== '480p') source += '\nresolution:' + project.resolution;
  return sha256(source);
}

export function validateCreative(project: Pick<Project, 'dialogue' | 'durationSeconds' | 'shots' | 'photos'>): string[] {
  const errors: string[] = [];
  if (project.photos.length === 0) errors.push('Add at least one product photo before rendering.');
  const spoken = dialogue(project.dialogue);
  const words = spoken ? spoken.split(/\s+/).length : 0;
  if (!spoken) errors.push('Add spoken dialogue.');
  const wordLimit = dialogueWordLimit(project.durationSeconds);
  if (words > wordLimit) errors.push(`Dialogue has ${words} words; the limit is ${wordLimit} for a ${project.durationSeconds}-second video.`);
  if (!isVideoDuration(project.durationSeconds)) errors.push('Choose a whole video length from 4 to 30 seconds.');
  if (project.shots.length < MIN_SHOTS || project.shots.length > MAX_SHOTS) errors.push(`Use ${MIN_SHOTS} to ${MAX_SHOTS} shots.`);
  if (project.shots.some((shot) => !shot.description.trim())) errors.push('Describe every shot.');
  if (project.shots.some((shot) => !Number.isInteger(shot.duration) || shot.duration < 1)) errors.push('Every shot must be at least 1 whole second.');
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (total !== project.durationSeconds) errors.push(`Shot durations must total exactly ${project.durationSeconds} seconds.`);
  const text = `${spoken}\n${shotList(project.shots)}`;
  if (/\[PRODUCT NAME\]|OWNER TO SUPPLY|\[your link\]|TODO|TBD/i.test(text)) errors.push('Remove placeholders before rendering.');
  if (/APP SCREEN INSERT|real[^\n]*screenshot|screenshot[^\n]*app/i.test(text)) errors.push('Exact app-screen compositing is not supported.');
  if (project.photos.length > 4) errors.push('Use no more than four product photos.');
  return errors;
}

export function parseAuthorizedPrice(text: string): number {
  const match = text.match(/^Cost preflight for seedance_2_5:\s*(\d+(?:\.\d+)?)\s*credits\b/i);
  if (match === null) throw new Error('The provider did not return a valid video price. No video submitted.');
  if (/adjust(?:ment|ed)|coerc|dropp?ed|unsupported|ignored|clamp|truncat/i.test(text)) {
    throw new Error('Provider proposed changing the selected resolution or inputs. No paid submission; choose another setting explicitly.');
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > MAX_CREDITS) {
    throw new Error(`The selected resolution exceeds the ${MAX_CREDITS}-credit limit. Choose a lower resolution explicitly. No video submitted.`);
  }
  return value;
}

export function buildProviderParams(prompt: string, resolution: Resolution, durationSeconds: number, mediaIds: string[]) {
  const base = {
    model: MODEL,
    duration: durationSeconds,
    resolution,
    aspect_ratio: ASPECT_RATIO,
    prompt,
    count: 1,
    use_unlim: false,
    declined_preset_id: DECLINED_PRESET_ID
  };
  return mediaIds.length
    ? {
        ...base,
        mode: 'omni_reference',
        medias: mediaIds.map((value) => ({ value, role: 'image_references' as const })),
        generate_audio: true
      }
    : base;
}
