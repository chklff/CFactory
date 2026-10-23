#!/usr/bin/env node
import './env.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CARD_STATUSES, DEFAULT_CARD_TITLE, MAX_SHOTS, MIN_SHOTS, isVideoDuration, rebalanceShots,
  type LlmProvider, type LlmStatus, type ProductPhoto, type Project, type Resolution
} from '../shared/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { buildPrompt, parseAuthorizedPrice, renderSourceHash, sha256, validateCreative } from './contracts.js';
import { HiggsfieldClient, selectRecoveryCandidate } from './higgsfield.js';
import { HiggsfieldOAuthProvider, newOAuthState } from './oauth.js';
import { generateScript, testLlmKey, type LlmImage } from './llm.js';
import { clearHiggsfieldOAuth, clearLlmKey, createProject, deleteProject, loadProject, loadProjects, loadSettings, saveLlmKey, savePreferredLlm, saveProject, saveUpload, updateSettings, uploadPath, type Settings } from './store.js';

const app = express();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = basename(dirname(moduleDirectory)) === 'dist-server'
  ? dirname(dirname(moduleDirectory))
  : dirname(moduleDirectory);
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4312);
const defaultMcpUrl = process.env.HIGGSFIELD_MCP_URL ?? 'https://mcp.higgsfield.ai/mcp';
const publicUrl = (process.env.CFACTORY_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
const oauthCallbackUrl = `${publicUrl}/api/oauth/higgsfield/callback`;
const activePhases = new Set(['Checking price', 'Submitting', 'Generating', 'Unknown']);
const activeLlmCards = new Set<string>();
const recoveringCards = new Set<string>();
const pollingJobs = new Set<string>();
let writeQueue = Promise.resolve();

app.disable('x-powered-by');
const allowedOrigins = new Set([publicUrl, `http://127.0.0.1:4311`, `http://localhost:${port}`, 'http://localhost:4311']);
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  }
  next();
});
app.use(express.json({ limit: '26mb' }));

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(work, work);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function provider(): Promise<HiggsfieldClient> {
  const settings = await loadSettings();
  const url = settings.higgsfieldUrl || defaultMcpUrl;
  if (!settings.higgsfieldOAuth?.tokens?.access_token) throw new Error('Higgsfield is not connected. Use Connect Higgsfield in Settings.');
  return new HiggsfieldClient({ url, authProvider: new HiggsfieldOAuthProvider(oauthCallbackUrl) });
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function extension(mime: string): string { return mime === 'image/png' ? 'png' : 'jpg'; }
function decodeDataUrl(value: unknown, allowed: string[]): { mime: string; bytes: Buffer } {
  if (typeof value !== 'string') throw new Error('Missing image data.');
  const match = value.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !allowed.includes(match[1])) throw new Error('Only JPEG and PNG images are supported.');
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
}
function assertMagic(mime: string, bytes: Uint8Array): void {
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png)) throw new Error('Image bytes do not match the declared MIME type.');
}

function isLlmProvider(value: unknown): value is LlmProvider { return value === 'openai' || value === 'anthropic'; }

function keyFor(provider: LlmProvider, settings: Settings): { key: string; source: 'environment' | 'saved' | null } {
  const saved = provider === 'openai' ? settings.llm?.openaiKey : settings.llm?.anthropicKey;
  if (saved) return { key: saved, source: 'saved' };
  const environment = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  return environment ? { key: environment, source: 'environment' } : { key: '', source: null };
}

function llmStatus(settings: Settings): LlmStatus {
  const openai = keyFor('openai', settings);
  const anthropic = keyFor('anthropic', settings);
  const requested = settings.llm?.preferred === 'anthropic' ? 'anthropic' : 'openai';
  const preferred = keyFor(requested, settings).key
    ? requested
    : (openai.key ? 'openai' : anthropic.key ? 'anthropic' : requested);
  return {
    openai: { configured: Boolean(openai.key), source: openai.source },
    anthropic: { configured: Boolean(anthropic.key), source: anthropic.source },
    preferred
  };
}

async function publicState(cardId?: string) {
  const [cards, settings] = await Promise.all([loadProjects(), loadSettings()]);
  const project = cardId ? cards.find((card) => card.id === cardId) : cards[0];
  if (!project) throw new Error('Card not found.');
  const configured = Boolean(settings.higgsfieldOAuth?.tokens?.access_token);
  return { cards, project, connection: { configured, connected: configured, serverUrl: settings.higgsfieldUrl || defaultMcpUrl, error: '' }, llm: llmStatus(settings) };
}

app.get('/api/state', async (req, res, next) => {
  try { res.json(await publicState(typeof req.query.cardId === 'string' ? req.query.cardId : undefined)); } catch (error) { next(error); }
});

app.get('/api/health', async (_req, res, next) => {
  try {
    const [projects, settings] = await Promise.all([loadProjects(), loadSettings()]);
    res.json({
      ok: true,
      cards: projects.length,
      higgsfieldConnected: Boolean(settings.higgsfieldOAuth?.tokens?.access_token),
      activeRenders: projects.filter((project) => ['Submitting', 'Generating', 'Unknown'].includes(project.render.phase)).length
    });
  } catch (error) { next(error); }
});

app.post('/api/cards', async (_req, res, next) => {
  try { res.status(201).json(await enqueue(() => createProject())); } catch (error) { next(error); }
});

app.delete('/api/cards/:cardId', async (req, res, next) => {
  try { await enqueue(() => deleteProject(req.params.cardId)); res.status(204).end(); } catch (error) { next(error); }
});

app.get('/api/cards/:cardId/photos/:id/preview', async (req, res, next) => {
  try {
    const project = await loadProject(req.params.cardId);
    const photo = project.photos.find((candidate) => candidate.id === req.params.id);
    if (!photo) return res.status(404).json({ error: 'Photo not found.' });
    const bytes = await readFile(uploadPath(photo.id, 'prepared', extension(photo.mime)));
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  } catch (error) { next(error); }
});

app.patch('/api/cards/:cardId', async (req, res, next) => {
  try {
    const project = await enqueue(async () => {
      const current = await loadProject(req.params.cardId);
      const input = req.body as Partial<Project>;
      const contentChanged = ['title', 'notes', 'feedback', 'dialogue', 'durationSeconds', 'shots', 'resolution'].some((key) => key in input);
      const statusChanged = typeof input.status === 'string' && input.status !== current.status;
      if ((contentChanged || statusChanged) && activePhases.has(current.render.phase)) throw new Error(`Editing is locked while the render is ${current.render.phase}.`);
      if (typeof input.status === 'string' && CARD_STATUSES.includes(input.status)) current.status = input.status;
      if (typeof input.title === 'string') current.title = input.title.trim().slice(0, 120) || DEFAULT_CARD_TITLE;
      if (typeof input.notes === 'string') current.notes = input.notes.slice(0, 4000);
      if (typeof input.feedback === 'string') current.feedback = input.feedback.slice(0, 4000);
      if (typeof input.dialogue === 'string') current.dialogue = input.dialogue.slice(0, 3000);
      const nextDuration = input.durationSeconds === undefined ? current.durationSeconds : input.durationSeconds;
      if (!isVideoDuration(nextDuration)) throw new Error('Choose a whole video length from 4 to 30 seconds.');
      if (Array.isArray(input.shots)) {
        if (input.shots.length < MIN_SHOTS || input.shots.length > MAX_SHOTS || input.shots.length > nextDuration) {
          throw new Error(`Use ${MIN_SHOTS} to ${Math.min(MAX_SHOTS, nextDuration)} shots for a ${nextDuration}-second video.`);
        }
        const shots = input.shots.map((shot, index) => ({
          id: index + 1,
          duration: Number(shot.duration),
          description: String(shot.description ?? '').slice(0, 1500)
        }));
        if (shots.some((shot) => !Number.isInteger(shot.duration) || shot.duration < 1)) throw new Error('Every shot must be at least 1 whole second.');
        if (shots.reduce((sum, shot) => sum + shot.duration, 0) !== nextDuration) throw new Error(`Shot durations must total exactly ${nextDuration} seconds.`);
        current.shots = shots;
      } else if (nextDuration !== current.durationSeconds) {
        if (current.shots.length > nextDuration) throw new Error('Remove shots before choosing a shorter video length.');
        current.shots = rebalanceShots(current.shots, nextDuration);
      }
      current.durationSeconds = nextDuration;
      if (['480p', '720p', '1080p'].includes(String(input.resolution))) current.resolution = input.resolution as Resolution;
      current.quote = null;
      if (!['Submitting', 'Generating', 'Unknown'].includes(current.render.phase)) current.render.phase = 'Idle';
      await saveProject(current);
      return current;
    });
    res.json(project);
  } catch (error) { next(error); }
});

app.post('/api/cards/:cardId/photos', async (req, res, next) => {
  try {
    const project = await enqueue(async () => {
      const current = await loadProject(req.params.cardId);
      if (activePhases.has(current.render.phase)) throw new Error('Photos are locked during active render work.');
      if (current.photos.length >= 4) throw new Error('A project can contain at most four photos.');
      const original = decodeDataUrl(req.body.originalDataUrl, ['image/jpeg', 'image/png']);
      const prepared = decodeDataUrl(req.body.preparedDataUrl, ['image/jpeg', 'image/png']);
      const thumbnail = decodeDataUrl(req.body.thumbnailDataUrl, ['image/jpeg', 'image/png']);
      if (original.bytes.byteLength > 10 * 1024 * 1024) throw new Error('Original images must be 10 MiB or smaller.');
      if (prepared.bytes.byteLength > 2 * 1024 * 1024) throw new Error('Prepared images must be 2 MiB or smaller.');
      if (String(req.body.thumbnailDataUrl).length > 50_000 || thumbnail.bytes.byteLength === 0) throw new Error('Thumbnail is invalid or too large.');
      assertMagic(original.mime, original.bytes); assertMagic(prepared.mime, prepared.bytes); assertMagic(thumbnail.mime, thumbnail.bytes);
      const id = randomUUID();
      await saveUpload(uploadPath(id, 'original', extension(original.mime)), original.bytes);
      await saveUpload(uploadPath(id, 'prepared', extension(prepared.mime)), prepared.bytes);
      const photo: ProductPhoto = {
        id,
        filename: String(req.body.filename || 'product-photo').slice(0, 180),
        mime: prepared.mime as ProductPhoto['mime'],
        sha256: sha256(prepared.bytes),
        thumbnail: String(req.body.thumbnailDataUrl),
        mediaId: ''
      };
      current.photos.push(photo);
      current.referenceRevision += 1;
      if (!current.primaryPhotoId) current.primaryPhotoId = id;
      current.quote = null;
      await saveProject(current);
      return current;
    });
    res.json(project);
  } catch (error) { next(error); }
});

app.delete('/api/cards/:cardId/photos/:id', async (req, res, next) => {
  try {
    const project = await enqueue(async () => {
      const current = await loadProject(req.params.cardId);
      if (activePhases.has(current.render.phase)) throw new Error('Photos are locked during active render work.');
      const before = current.photos.length;
      current.photos = current.photos.filter((photo) => photo.id !== req.params.id);
      if (current.photos.length === before) throw new Error('Photo not found.');
      if (current.primaryPhotoId === req.params.id) current.primaryPhotoId = current.photos[0]?.id ?? '';
      current.referenceRevision += 1;
      current.quote = null;
      await saveProject(current);
      return current;
    });
    res.json(project);
  } catch (error) { next(error); }
});

app.post('/api/cards/:cardId/photos/:id/primary', async (req, res, next) => {
  try {
    const project = await enqueue(async () => {
      const current = await loadProject(req.params.cardId);
      if (!current.photos.some((photo) => photo.id === req.params.id)) throw new Error('Photo not found.');
      if (current.primaryPhotoId !== req.params.id) { current.primaryPhotoId = req.params.id; current.referenceRevision += 1; current.quote = null; }
      await saveProject(current);
      return current;
    });
    res.json(project);
  } catch (error) { next(error); }
});

app.post('/api/oauth/higgsfield/start', async (req, res, next) => {
  try {
    const url = String(req.body.url ?? defaultMcpUrl).trim();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('The MCP server URL must use HTTPS.');
    const state = newOAuthState();
    await updateSettings((settings) => ({ ...settings, higgsfieldUrl: url, higgsfieldOAuth: { ...(settings.higgsfieldOAuth ?? {}), state, stateCreatedAt: new Date().toISOString() } }));
    const authProvider = new HiggsfieldOAuthProvider(oauthCallbackUrl, state);
    const client = new Client({ name: 'cfactory-ugc', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(parsed, { authProvider });
    try {
      await client.connect(transport);
      res.json({ connected: true });
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !authProvider.authorizationUrl) throw error;
      res.json({ connected: false, authorizationUrl: authProvider.authorizationUrl.toString() });
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) { next(error); }
});

app.get('/api/oauth/higgsfield/callback', async (req, res) => {
  try {
    if (typeof req.query.error === 'string') throw new Error(`Higgsfield authorization was declined: ${req.query.error}`);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
    const settings = await loadSettings();
    const expectedState = settings.higgsfieldOAuth?.state ?? '';
    const stateAge = Date.now() - Date.parse(settings.higgsfieldOAuth?.stateCreatedAt ?? '');
    if (!code) throw new Error('Higgsfield did not return an authorization code.');
    if (!expectedState || returnedState !== expectedState || !Number.isFinite(stateAge) || stateAge > 10 * 60_000) throw new Error('OAuth state is invalid or expired. Start the connection again.');
    const url = settings.higgsfieldUrl || defaultMcpUrl;
    const authProvider = new HiggsfieldOAuthProvider(oauthCallbackUrl);
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
    await transport.finishAuth(code);
    await updateSettings((current) => ({ ...current, higgsfieldOAuth: { ...(current.higgsfieldOAuth ?? {}), state: undefined, stateCreatedAt: undefined, codeVerifier: undefined } }));
    await new HiggsfieldClient({ url, authProvider }).health();
    res.redirect('/?oauth=connected');
  } catch (error) {
    res.redirect(`/?oauthError=${encodeURIComponent(asError(error).message)}`);
  }
});

app.post('/api/oauth/higgsfield/disconnect', async (_req, res, next) => {
  try { await clearHiggsfieldOAuth(); res.json({ configured: false, connected: false, serverUrl: defaultMcpUrl, error: '' }); }
  catch (error) { next(error); }
});

app.post('/api/settings/llm/:provider', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!isLlmProvider(provider)) throw new Error('Unknown AI provider.');
    const key = String(req.body.key ?? '').trim();
    if (key.length < 20 || key.length > 500) throw new Error(`Enter a valid ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key.`);
    await testLlmKey(provider, key);
    await enqueue(() => saveLlmKey(provider, key));
    res.json(llmStatus(await loadSettings()));
  } catch (error) { next(error); }
});

app.post('/api/settings/llm/:provider/test', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!isLlmProvider(provider)) throw new Error('Unknown AI provider.');
    const credential = keyFor(provider, await loadSettings());
    if (!credential.key) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Claude'} is not connected.`);
    await testLlmKey(provider, credential.key);
    res.json({ connected: true });
  } catch (error) { next(error); }
});

app.delete('/api/settings/llm/:provider', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!isLlmProvider(provider)) throw new Error('Unknown AI provider.');
    await enqueue(() => clearLlmKey(provider));
    res.json(llmStatus(await loadSettings()));
  } catch (error) { next(error); }
});

app.post('/api/settings/llm/preferred', async (req, res, next) => {
  try {
    const provider = req.body.provider;
    if (!isLlmProvider(provider)) throw new Error('Choose OpenAI or Claude.');
    const settings = await loadSettings();
    if (!keyFor(provider, settings).key) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Claude'} is not connected.`);
    await enqueue(() => savePreferredLlm(provider));
    res.json(llmStatus(await loadSettings()));
  } catch (error) { next(error); }
});

app.post('/api/cards/:cardId/script/generate', async (req, res, next) => {
  const cardId = req.params.cardId;
  if (activeLlmCards.has(cardId)) return res.status(409).json({ error: 'An AI draft is already being created for this card.' });
  activeLlmCards.add(cardId);
  try {
    const project = await loadProject(cardId);
    if (activePhases.has(project.render.phase)) throw new Error(`Script changes are locked while the render is ${project.render.phase}.`);
    const settings = await loadSettings();
    const provider = isLlmProvider(req.body.provider) ? req.body.provider : llmStatus(settings).preferred;
    const credential = keyFor(provider, settings);
    if (!credential.key) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Claude'} is not connected. Add its API key in Settings.`);
    const images: LlmImage[] = [];
    for (const photo of project.photos) {
      const bytes = await readFile(uploadPath(photo.id, 'prepared', extension(photo.mime)));
      images.push({ mime: photo.mime, base64: bytes.toString('base64') });
    }
    res.json(await generateScript(provider, credential.key, project, images));
  } catch (error) { next(error); }
  finally { activeLlmCards.delete(cardId); }
});

app.post('/api/settings/test', async (_req, res, next) => {
  try { const client = await provider(); await client.health(); res.json({ connected: true }); } catch (error) { next(error); }
});

async function registerReferences(project: Project, client: HiggsfieldClient): Promise<string[]> {
  const ordered = [...project.photos].sort((a, b) => Number(b.id === project.primaryPhotoId) - Number(a.id === project.primaryPhotoId));
  for (const photo of ordered) {
    if (!photo.mediaId) {
      photo.mediaId = await client.registerPhoto(photo, uploadPath(photo.id, 'prepared', extension(photo.mime)));
      await saveProject(project);
    }
  }
  return ordered.map((photo) => photo.mediaId);
}

app.post('/api/cards/:cardId/render/quote', async (req, res, next) => {
  try {
    const result = await enqueue(async () => {
      const project = await loadProject(req.params.cardId);
      const blockers = validateCreative(project);
      if (blockers.length) throw new Error(blockers.join(' '));
      project.render = { ...project.render, phase: 'Checking price', error: '', at: new Date().toISOString() };
      await saveProject(project);
      try {
        const client = await provider();
        const mediaIds = await registerReferences(project, client);
        const prompt = buildPrompt(project);
        const sourceHash = renderSourceHash(project);
        const credits = parseAuthorizedPrice(await client.quote(prompt, project.resolution, project.durationSeconds, mediaIds));
        project.quote = { credits, sourceHash, quotedAt: new Date().toISOString() };
        project.render = { ...project.render, phase: 'Ready', sourceHash, prompt, credits, error: '', at: new Date().toISOString() };
        await saveProject(project);
        return project;
      } catch (error) {
        project.render = { ...project.render, phase: 'Blocked', error: asError(error).message, at: new Date().toISOString() };
        await saveProject(project);
        throw error;
      }
    });
    res.json(result);
  } catch (error) { next(error); }
});

app.post('/api/cards/:cardId/render/start', async (req, res, next) => {
  try {
    const project = await enqueue(async () => {
      const current = await loadProject(req.params.cardId);
      if (activePhases.has(current.render.phase)) throw new Error(`A render is already ${current.render.phase}.`);
      const blockers = validateCreative(current);
      if (blockers.length) throw new Error(blockers.join(' '));
      const prompt = buildPrompt(current);
      const sourceHash = renderSourceHash(current);
      const requestId = `${current.id}_${current.render.sequence + 1}`;
      const client = await provider();
      const mediaIds = await registerReferences(current, client);
      const credits = parseAuthorizedPrice(await client.quote(prompt, current.resolution, current.durationSeconds, mediaIds));
      if (renderSourceHash(current) !== sourceHash) throw new Error('Project changed during cost checking. No video submitted.');
      current.render = { sequence: current.render.sequence + 1, requestId, phase: 'Submitting', sourceHash, prompt, credits, jobId: '', error: '', at: new Date().toISOString() };
      current.status = 'Producing';
      current.quote = { credits, sourceHash, quotedAt: new Date().toISOString() };
      await saveProject(current);
      try {
        const jobId = await client.submit(prompt, current.resolution, current.durationSeconds, mediaIds);
        current.render = { ...current.render, phase: 'Generating', jobId, at: new Date().toISOString() };
        await saveProject(current);
        startPolling(jobId);
      } catch (error) {
        current.render = { ...current.render, phase: 'Unknown', error: `Submission outcome needs inspection: ${asError(error).message}`, at: new Date().toISOString() };
        await saveProject(current);
      }
      return current;
    });
    res.status(202).json(project);
  } catch (error) { next(error); }
});

async function recoverRender(cardId: string): Promise<Project> {
  if (recoveringCards.has(cardId)) throw new Error('Render recovery is already running for this card.');
  recoveringCards.add(cardId);
  try {
    return await enqueue(async () => {
      const current = await loadProject(cardId);
      if (!['Unknown', 'Submitting', 'Generating'].includes(current.render.phase)) throw new Error('This render does not need recovery.');
      if (!current.render.prompt) throw new Error('The original paid prompt is missing, so automatic recovery cannot safely identify the job.');

      let jobId = current.render.jobId;
      if (!jobId) {
        const client = await provider();
        const projects = await loadProjects();
        const usedJobIds = projects.flatMap((project) => [project.render.jobId, ...project.outputs.map((output) => output.jobId)]).filter(Boolean);
        const candidate = selectRecoveryCandidate(await client.recentGenerations(), current.render.prompt, current.render.at, usedJobIds);
        jobId = candidate.id;
      }

      current.render = {
        ...current.render,
        phase: 'Generating',
        jobId,
        error: 'Recovered the existing Higgsfield job. Waiting for its result.',
        at: new Date().toISOString()
      };
      current.status = 'Producing';
      await saveProject(current);
      startPolling(jobId);
      return current;
    });
  } finally {
    recoveringCards.delete(cardId);
  }
}

app.post('/api/cards/:cardId/render/recover', async (req, res, next) => {
  try { res.status(202).json(await recoverRender(req.params.cardId)); }
  catch (error) { next(error); }
});

function startPolling(jobId: string): void {
  if (pollingJobs.has(jobId)) return;
  void pollJob(jobId);
}

async function pollJob(jobId: string): Promise<void> {
  if (pollingJobs.has(jobId)) return;
  pollingJobs.add(jobId);
  try {
    const started = Date.now();
    while (Date.now() - started < 24 * 60 * 60 * 1000) {
      const project = (await loadProjects()).find((candidate) => candidate.render.jobId === jobId);
      if (!project) return;
      if (project.render.phase !== 'Generating' || project.render.jobId !== jobId) return;
      try {
        const client = await provider();
        const status = await client.wait(jobId);
        if (status.terminal && status.failed) {
          project.render = { ...project.render, phase: 'Failed', error: status.error || 'Higgsfield reported a failed job.', at: new Date().toISOString() };
          project.status = 'Script review';
          await saveProject(project); return;
        }
        if (status.terminal && status.url) {
          const url = new URL(status.url);
          if (url.protocol !== 'https:' || !url.hostname.endsWith('.cloudfront.net') || !url.pathname.includes(jobId)) {
            project.render = { ...project.render, phase: 'Unknown', error: 'Completed result URL failed provenance validation.', at: new Date().toISOString() };
            await saveProject(project); return;
          }
          if (!project.outputs.some((output) => output.url === status.url)) {
            project.outputs.push({ url: status.url, jobId, requestedResolution: project.resolution, requestedDurationSeconds: project.durationSeconds, requestedAspectRatio: '9:16', model: 'seedance_2_5', credits: project.render.credits ?? 0, recordedAt: new Date().toISOString() });
          }
          project.render = { ...project.render, phase: 'Completed', error: '', at: new Date().toISOString() };
          project.status = 'Video review';
          await saveProject(project); return;
        }
        await new Promise((resolve) => setTimeout(resolve, status.pollAfterSeconds * 1000));
      } catch (error) {
        const current = (await loadProjects()).find((candidate) => candidate.render.jobId === jobId);
        if (!current) return;
        current.render.error = `Polling will continue: ${asError(error).message}`;
        await saveProject(current);
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    }
  } finally {
    pollingJobs.delete(jobId);
  }
}

app.get('/api/cards/:cardId/export', async (req, res, next) => {
  try {
    const project = await loadProject(req.params.cardId);
    const blockers = validateCreative(project);
    res.json({ title: project.title, prompt: buildPrompt(project), resolution: project.resolution, durationSeconds: project.durationSeconds, shotCount: project.shots.length, maxCredits: 150, references: project.photos.map((photo) => photo.filename), blockers });
  } catch (error) { next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = asError(error).message;
  res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
});

const clientRoot = join(packageRoot, 'dist');
app.use(express.static(clientRoot));
app.get('/{*splat}', async (_req, res) => {
  try { res.type('html').send(await readFile(join(clientRoot, 'index.html'), 'utf8')); }
  catch { res.status(404).send('Run npm run build first.'); }
});

app.listen(port, host, async () => {
  const projects = await loadProjects();
  for (const project of projects) {
    if (project.render.phase === 'Generating' && project.render.jobId) startPolling(project.render.jobId);
    else if (['Unknown', 'Submitting'].includes(project.render.phase)) void recoverRender(project.id).catch(() => undefined);
    else if (project.render.phase === 'Checking price') {
      project.render = { ...project.render, phase: 'Blocked', error: 'The previous price check was interrupted. Check cost again.', at: new Date().toISOString() };
      await saveProject(project);
    }
  }
  console.log(`CFactory is running at http://${host}:${port}`);
});
