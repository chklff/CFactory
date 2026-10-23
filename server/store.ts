import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CARD_TITLE, DEFAULT_VIDEO_DURATION_SECONDS, MAX_SHOTS, MIN_SHOTS, isVideoDuration, rebalanceShots,
  type Project, type Shot
} from '../shared/types.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { LlmProvider } from '../shared/types.js';

const dataRoot = process.env.CFACTORY_DATA_DIR ?? join(process.cwd(), '.data');
const statePath = join(dataRoot, 'state.json');
const settingsPath = join(dataRoot, 'settings.json');

function now(): string { return new Date().toISOString(); }

export function newProject(title = DEFAULT_CARD_TITLE): Project {
  const at = now();
  return {
    id: randomUUID(),
    status: 'Idea',
    title,
    notes: '',
    feedback: '',
    dialogue: '',
    durationSeconds: DEFAULT_VIDEO_DURATION_SECONDS,
    shots: [1, 2, 3, 4].map((id) => ({ id, duration: 2, description: '' })),
    resolution: '480p',
    referenceRevision: 0,
    primaryPhotoId: '',
    photos: [],
    quote: null,
    render: { sequence: 0, requestId: '', phase: 'Idle', sourceHash: '', prompt: '', credits: null, jobId: '', error: '', at },
    outputs: [],
    createdAt: at,
    updatedAt: at
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}

interface Workspace { cards: Project[]; }

function normalizeProject(project: Project): Project {
  const legacy = project as Project & { durationSeconds?: number; shots?: Shot[] };
  const legacyTotal = Array.isArray(legacy.shots)
    ? legacy.shots.reduce((sum, shot) => sum + (Number.isFinite(shot.duration) ? shot.duration : 0), 0)
    : 0;
  const durationSeconds = isVideoDuration(legacy.durationSeconds)
    ? legacy.durationSeconds
    : isVideoDuration(legacyTotal)
      ? legacyTotal
      : DEFAULT_VIDEO_DURATION_SECONDS;
  const sourceShots = Array.isArray(legacy.shots) ? legacy.shots : [];
  const hasValidPlan = sourceShots.length >= MIN_SHOTS && sourceShots.length <= MAX_SHOTS &&
    sourceShots.every((shot) => Number.isInteger(shot.duration) && shot.duration >= 1) &&
    sourceShots.reduce((sum, shot) => sum + shot.duration, 0) === durationSeconds;
  const shots = hasValidPlan
    ? sourceShots.map((shot, index) => ({ id: index + 1, duration: shot.duration, description: String(shot.description ?? '') }))
    : rebalanceShots(sourceShots, durationSeconds, sourceShots.length || 4);
  return { ...project, status: project.status ?? 'Idea', durationSeconds, shots };
}

async function loadWorkspace(): Promise<Workspace> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Workspace | Project;
    if ('cards' in parsed && Array.isArray(parsed.cards)) {
      const cards = parsed.cards.map(normalizeProject);
      return { cards: cards.length ? cards : [newProject()] };
    }
    return { cards: [normalizeProject(parsed as Project)] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const workspace = { cards: [newProject()] };
    await atomicJson(statePath, workspace);
    return workspace;
  }
}

export async function loadProjects(): Promise<Project[]> {
  return (await loadWorkspace()).cards;
}

export async function loadProject(id?: string): Promise<Project> {
  const projects = await loadProjects();
  const project = id ? projects.find((candidate) => candidate.id === id) : projects[0];
  if (!project) throw new Error('Card not found.');
  return project;
}

export async function saveProject(project: Project): Promise<void> {
  project.updatedAt = now();
  const workspace = await loadWorkspace();
  const index = workspace.cards.findIndex((candidate) => candidate.id === project.id);
  if (index === -1) workspace.cards.unshift(project);
  else workspace.cards[index] = project;
  await atomicJson(statePath, workspace);
}

export async function createProject(): Promise<Project> {
  const project = newProject();
  await saveProject(project);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  const workspace = await loadWorkspace();
  const project = workspace.cards.find((candidate) => candidate.id === id);
  if (!project) throw new Error('Card not found.');
  if (['Submitting', 'Generating', 'Unknown'].includes(project.render.phase)) throw new Error('Cannot delete a card with unresolved paid work.');
  workspace.cards = workspace.cards.filter((candidate) => candidate.id !== id);
  if (!workspace.cards.length) workspace.cards.push(newProject());
  await atomicJson(statePath, workspace);
}

export function uploadPath(id: string, kind: 'original' | 'prepared', extension: string): string {
  return join(dataRoot, 'uploads', `${id}-${kind}.${extension}`);
}

export async function saveUpload(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
}

export interface Settings {
  higgsfieldUrl?: string;
  higgsfieldOAuth?: {
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    state?: string;
    stateCreatedAt?: string;
    discoveryState?: OAuthDiscoveryState;
  };
  llm?: {
    openaiKey?: string;
    anthropicKey?: string;
    preferred?: LlmProvider;
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Settings & { higgsfieldToken?: unknown };
    if ('higgsfieldToken' in parsed) {
      delete parsed.higgsfieldToken;
      await atomicJson(settingsPath, parsed);
    }
    return parsed;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function updateSettings(update: (settings: Settings) => Settings): Promise<Settings> {
  const next = update(await loadSettings());
  await atomicJson(settingsPath, next);
  return next;
}

export async function clearHiggsfieldOAuth(): Promise<void> {
  await updateSettings((settings) => ({ ...settings, higgsfieldOAuth: undefined }));
}

export async function saveLlmKey(provider: LlmProvider, key: string): Promise<void> {
  await updateSettings((settings) => ({
    ...settings,
    llm: {
      ...(settings.llm ?? {}),
      [provider === 'openai' ? 'openaiKey' : 'anthropicKey']: key
    }
  }));
}

export async function clearLlmKey(provider: LlmProvider): Promise<void> {
  await updateSettings((settings) => {
    const llm = { ...(settings.llm ?? {}) };
    if (provider === 'openai') delete llm.openaiKey;
    else delete llm.anthropicKey;
    return { ...settings, llm };
  });
}

export async function savePreferredLlm(preferred: LlmProvider): Promise<void> {
  await updateSettings((settings) => ({ ...settings, llm: { ...(settings.llm ?? {}), preferred } }));
}
