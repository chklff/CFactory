export type Resolution = '480p' | '720p' | '1080p';
export type LlmProvider = 'openai' | 'anthropic';

export const MIN_VIDEO_DURATION_SECONDS = 4;
export const MAX_VIDEO_DURATION_SECONDS = 30;
export const DEFAULT_VIDEO_DURATION_SECONDS = 8;
export const MIN_SHOTS = 2;
export const MAX_SHOTS = 15;
export const VIDEO_DURATION_OPTIONS = Array.from(
  { length: MAX_VIDEO_DURATION_SECONDS - MIN_VIDEO_DURATION_SECONDS + 1 },
  (_, index) => MIN_VIDEO_DURATION_SECONDS + index
);

export const DEFAULT_CARD_TITLE = 'Untitled video idea';
export function isDefaultCardTitle(value: string): boolean {
  return value.trim() === '' || value.trim() === DEFAULT_CARD_TITLE;
}

export interface LlmProviderStatus {
  configured: boolean;
  source: 'environment' | 'saved' | null;
}

export interface LlmStatus {
  openai: LlmProviderStatus;
  anthropic: LlmProviderStatus;
  preferred: LlmProvider;
}

export const CARD_STATUSES = [
  'Idea', 'Scripting', 'Script review', 'Producing',
  'Video review', 'Ready', 'Rejected'
] as const;

export type CardStatus = typeof CARD_STATUSES[number];

export type RenderPhase =
  | 'Idle'
  | 'Checking price'
  | 'Ready'
  | 'Submitting'
  | 'Generating'
  | 'Completed'
  | 'Blocked'
  | 'Failed'
  | 'Unknown';

export interface Shot {
  id: number;
  duration: number;
  description: string;
}

export function isVideoDuration(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_VIDEO_DURATION_SECONDS && Number(value) <= MAX_VIDEO_DURATION_SECONDS;
}

export function dialogueWordLimit(durationSeconds: number): number {
  return durationSeconds * 3;
}

export function rebalanceShots(shots: Shot[], durationSeconds: number, requestedCount = shots.length): Shot[] {
  const safeDuration = isVideoDuration(durationSeconds) ? durationSeconds : DEFAULT_VIDEO_DURATION_SECONDS;
  const count = Math.max(MIN_SHOTS, Math.min(MAX_SHOTS, safeDuration, Math.trunc(requestedCount || MIN_SHOTS)));
  const baseDuration = Math.floor(safeDuration / count);
  const extraSeconds = safeDuration % count;
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    duration: baseDuration + (index < extraSeconds ? 1 : 0),
    description: shots[index]?.description ?? ''
  }));
}

export interface ProductPhoto {
  id: string;
  filename: string;
  mime: 'image/jpeg' | 'image/png';
  sha256: string;
  thumbnail: string;
  mediaId: string;
}

export interface Quote {
  credits: number;
  sourceHash: string;
  quotedAt: string;
}

export interface RenderState {
  sequence: number;
  requestId: string;
  phase: RenderPhase;
  sourceHash: string;
  prompt: string;
  credits: number | null;
  jobId: string;
  error: string;
  at: string;
}

export interface VideoOutput {
  url: string;
  jobId: string;
  requestedResolution: Resolution;
  requestedDurationSeconds: number;
  requestedAspectRatio: '9:16';
  model: 'seedance_2_5';
  credits: number;
  recordedAt: string;
}

export interface Project {
  id: string;
  status: CardStatus;
  title: string;
  notes: string;
  feedback: string;
  dialogue: string;
  durationSeconds: number;
  shots: Shot[];
  resolution: Resolution;
  referenceRevision: number;
  primaryPhotoId: string;
  photos: ProductPhoto[];
  quote: Quote | null;
  render: RenderState;
  outputs: VideoOutput[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicState {
  cards: Project[];
  project: Project;
  connection: {
    configured: boolean;
    connected: boolean;
    serverUrl: string;
    error: string;
  };
  llm: LlmStatus;
}
