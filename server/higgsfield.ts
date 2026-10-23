import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { buildProviderParams } from './contracts.js';
import type { ProductPhoto, Resolution } from '../shared/types.js';

type UnknownRecord = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RemoteGeneration {
  id: string;
  status: string;
  prompt: string;
  createdAt: number;
  url?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findKey(value: unknown, names: string[]): string | undefined {
  if (isRecord(value)) {
    for (const name of names) {
      const candidate = value[name];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    for (const child of Object.values(value)) {
      const match = findKey(child, names);
      if (match) return match;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findKey(child, names);
      if (match) return match;
    }
  }
  return undefined;
}

function findNumber(value: unknown, names: string[]): number | undefined {
  if (isRecord(value)) {
    for (const name of names) {
      const candidate = value[name];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
      if (typeof candidate === 'string' && candidate.trim() && Number.isFinite(Number(candidate))) return Number(candidate);
    }
    for (const child of Object.values(value)) {
      const match = findNumber(child, names);
      if (match !== undefined) return match;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findNumber(child, names);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  return result.content
    .filter((item): item is UnknownRecord => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => String(item.text))
    .join('\n');
}

function parseEmbeddedJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function collectUuidStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (UUID.test(candidate)) output.add(candidate);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectUuidStrings(child, output);
  }
}

function collectNamedJobIds(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectNamedJobIds(child, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:job_?ids?|jobIds?)$/i.test(key)) collectUuidStrings(child, output);
    collectNamedJobIds(child, output);
  }
}

export function parseSubmittedJobId(raw: unknown, text: string): string {
  const namedIds = new Set<string>();
  collectNamedJobIds(raw, namedIds);
  const embedded = parseEmbeddedJson(text);
  collectNamedJobIds(embedded, namedIds);
  if (namedIds.size === 1) return [...namedIds][0];
  if (namedIds.size > 1) throw new Error('Paid submission returned no unambiguous job ID.');

  const fallbackIds = new Set<string>();
  collectUuidStrings(embedded, fallbackIds);
  const textMatches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig) ?? [];
  for (const match of textMatches) fallbackIds.add(match);
  if (fallbackIds.size !== 1) throw new Error('Paid submission returned no unambiguous job ID.');
  return [...fallbackIds][0];
}

function generationItems(raw: unknown, text: string): unknown[] {
  const structured = isRecord(raw) ? raw.structuredContent : undefined;
  if (isRecord(structured) && Array.isArray(structured.items)) return structured.items;
  const embedded = parseEmbeddedJson(text);
  if (isRecord(embedded) && Array.isArray(embedded.items)) return embedded.items;
  return [];
}

export function parseRecentGenerations(raw: unknown, text: string): RemoteGeneration[] {
  return generationItems(raw, text).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const params = isRecord(item.params) ? item.params : {};
    const results = isRecord(item.results) ? item.results : {};
    const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
    const prompt = typeof params.prompt === 'string' ? params.prompt : '';
    const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Number(item.createdAt);
    const url = typeof results.rawUrl === 'string'
      ? results.rawUrl
      : typeof results.result_url === 'string'
        ? results.result_url
        : undefined;
    if (!UUID.test(id) || !status || !prompt || !Number.isFinite(createdAt)) return [];
    return [{ id, status, prompt, createdAt, url }];
  });
}

export function selectRecoveryCandidate(
  generations: RemoteGeneration[],
  prompt: string,
  submissionAt: string,
  usedJobIds: Iterable<string> = []
): RemoteGeneration {
  const anchor = Date.parse(submissionAt) / 1000;
  if (!Number.isFinite(anchor)) throw new Error('The original submission time is invalid.');
  const used = new Set(usedJobIds);
  const matches = generations.filter((generation) =>
    generation.prompt === prompt &&
    generation.createdAt >= anchor - 10 * 60 &&
    generation.createdAt <= anchor + 2 * 60 &&
    !used.has(generation.id)
  );
  if (matches.length === 0) throw new Error('No matching Higgsfield job was found. Wait a moment, then try Recover render again. Do not submit a new render.');
  if (matches.length > 1) throw new Error('More than one matching Higgsfield job was found. Recovery is blocked to avoid attaching the wrong paid render.');
  return matches[0];
}

export interface HiggsfieldConfig { url: string; authProvider: OAuthClientProvider; }

export class HiggsfieldClient {
  constructor(private readonly config: HiggsfieldConfig) {}

  private async connected(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: 'cfactory-ugc', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      authProvider: this.config.authProvider
    });
    await client.connect(transport);
    return { client, transport };
  }

  private async call(name: string, args: UnknownRecord): Promise<{ raw: unknown; text: string }> {
    const { client, transport } = await this.connected();
    try {
      const raw = await client.callTool({ name, arguments: args });
      if (isRecord(raw) && raw.isError) throw new Error(resultText(raw) || `${name} failed.`);
      return { raw, text: resultText(raw) };
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  async health(): Promise<void> {
    const { client, transport } = await this.connected();
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((tool) => tool.name));
      for (const required of ['generate_video', 'jobs_wait']) {
        if (!names.has(required)) throw new Error(`Connected MCP server does not expose ${required}.`);
      }
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  async registerPhoto(photo: ProductPhoto, preparedPath: string): Promise<string> {
    const upload = await this.call('media_upload', { filename: `product-${photo.id}.${photo.mime === 'image/png' ? 'png' : 'jpg'}`, content_type: photo.mime });
    const embedded = parseEmbeddedJson(upload.text);
    const mediaId = findKey(upload.raw, ['media_id', 'mediaId']) ?? findKey(embedded, ['media_id', 'mediaId']);
    const uploadUrl = findKey(upload.raw, ['upload_url', 'uploadUrl']) ?? findKey(embedded, ['upload_url', 'uploadUrl']);
    if (!mediaId || !/^[a-f0-9-]{20,}$/i.test(mediaId)) throw new Error('Higgsfield did not return an unambiguous media ID.');
    if (!uploadUrl) throw new Error('Higgsfield did not return a signed upload URL.');

    const parsed = new URL(uploadUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'upload.higgsfield.ai' || parsed.username || parsed.password || !parsed.pathname.includes(mediaId)) {
      throw new Error('Higgsfield returned an unsafe or mismatched upload URL.');
    }
    const bytes = await readFile(preparedPath);
    const response = await fetch(parsed, {
      method: 'PUT',
      headers: { 'Content-Type': photo.mime, 'If-None-Match': '*' },
      body: bytes,
      redirect: 'error'
    });
    if (response.status !== 200) throw new Error(`Reference upload failed with HTTP ${response.status}.`);

    const confirmation = await this.call('media_confirm', { type: 'image', media_id: mediaId });
    const proof = confirmation.text;
    if (!proof.startsWith('Confirmed 1 upload.') || !proof.includes(`- ${mediaId} (uploaded)`)) {
      throw new Error('Higgsfield did not confirm the exact uploaded media ID.');
    }
    return mediaId;
  }

  async quote(prompt: string, resolution: Resolution, durationSeconds: number, mediaIds: string[]): Promise<string> {
    const params = buildProviderParams(prompt, resolution, durationSeconds, mediaIds);
    return (await this.call('generate_video', { params: { ...params, get_cost: true } })).text;
  }

  async submit(prompt: string, resolution: Resolution, durationSeconds: number, mediaIds: string[]): Promise<string> {
    const params = buildProviderParams(prompt, resolution, durationSeconds, mediaIds);
    const result = await this.call('generate_video', { params });
    return parseSubmittedJobId(result.raw, result.text);
  }

  async recentGenerations(): Promise<RemoteGeneration[]> {
    const result = await this.call('show_generations', { type: 'video', only_completed: false, size: 50 });
    return parseRecentGenerations(result.raw, result.text);
  }

  async wait(jobId: string): Promise<{ terminal: boolean; failed: boolean; url?: string; error?: string; pollAfterSeconds: number }> {
    const result = await this.call('jobs_wait', { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 15 });
    const embedded = parseEmbeddedJson(result.text);
    const status = (findKey(result.raw, ['status', 'state']) ?? findKey(embedded, ['status', 'state']) ?? '').toLowerCase();
    const url = findKey(result.raw, ['result_url', 'resultUrl', 'rawUrl', 'url']) ?? findKey(embedded, ['result_url', 'resultUrl', 'rawUrl', 'url']);
    const error = findKey(result.raw, ['error', 'message']) ?? findKey(embedded, ['error', 'message']);
    const pollValue = findNumber(result.raw, ['poll_after_seconds', 'pollAfterSeconds']) ?? findNumber(embedded, ['poll_after_seconds', 'pollAfterSeconds']);
    const pollAfterSeconds = Math.max(2, Math.min(60, pollValue || 10));
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return { terminal: true, failed: true, error: error || `Higgsfield job ${status}.`, pollAfterSeconds };
    if (url || ['completed', 'succeeded', 'success'].includes(status)) return { terminal: true, failed: false, url, pollAfterSeconds };
    return { terminal: false, failed: false, pollAfterSeconds };
  }
}
