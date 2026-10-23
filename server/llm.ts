import { dialogueWordLimit, type LlmProvider, type Project, type Shot } from '../shared/types.js';

type Fetch = typeof fetch;

export interface LlmImage {
  mime: 'image/jpeg' | 'image/png';
  base64: string;
}

export interface GeneratedScript {
  title: string;
  dialogue: string;
  shots: Shot[];
  provider: LlmProvider;
  model: string;
}

function scriptSchema(shotCount: number) { return {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Concise descriptive card title, 3–7 words, maximum 60 characters.' },
    dialogue: { type: 'string', description: 'Complete spoken dialogue, maximum 24 words.' },
    shots: {
      type: 'array', minItems: shotCount, maxItems: shotCount,
      items: {
        type: 'object', additionalProperties: false,
        properties: { description: { type: 'string' } },
        required: ['description']
      }
    }
  },
  required: ['title', 'dialogue', 'shots']
} as const; }

function systemInstruction(durationSeconds: number, shotCount: number): string {
  return `You are a senior direct-response UGC creative director. Produce a truthful, filmable ${durationSeconds}-second vertical product video script with exactly ${shotCount} shots. Never invent product claims, prices, materials, hidden features, testimonials, guarantees, readable labels, or app screens. Preserve permanent branding that is physically part of the product. The product must already be clean and free of detachable retail tags and packaging before the first frame; never make removing, showing, or handling those artifacts part of a shot, and do not mention them in the returned script. The output is a draft for human review and must never authorize a paid generation.`;
}

const retailArtifactSource = String.raw`(?:hang\s*tags?|price\s*tags?|product\s*cards?|barcode\s*labels?|security\s*tags?|plastic\s*wrap|tissue\s*paper|packaging|shipping\s*materials?)`;
const retailArtifact = new RegExp(String.raw`\b${retailArtifactSource}\b`, 'i');
const retailArtifactAction = new RegExp(
  String.raw`\b(?:creator|person|model|wearer|customer|actor|talent|hands?|she|he|they)\b[^.\n]{0,120}\b(?:remov(?:e|es|ed|ing)|detach(?:es|ed|ing)?|cut(?:s|ting)?(?:\s+off)?|pull(?:s|ed|ing)?\s+off|open(?:s|ed|ing)?|unbox(?:es|ed|ing)?|unwrap(?:s|ped|ping)?|show(?:s|ed|ing)?|display(?:s|ed|ing)?|hold(?:s|held|ing)?)\b[^.\n]{0,120}\b${retailArtifactSource}\b`,
  'i'
);

export const OPENAI_SCRIPT_MODELS = [
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol'
] as const;

export function llmBrief(project: Pick<Project, 'title' | 'notes' | 'feedback' | 'dialogue' | 'durationSeconds' | 'shots' | 'photos'>): string {
  const wordLimit = dialogueWordLimit(project.durationSeconds);
  const targetLow = Math.max(8, Math.round(project.durationSeconds * 2));
  const targetHigh = Math.max(targetLow, Math.round(project.durationSeconds * 2.5));
  const interactionShots = Math.max(2, Math.ceil(project.shots.length * 0.75));
  const current = project.dialogue.trim() || project.shots.some((shot) => shot.description.trim())
    ? `\nCurrent draft to improve:\nDialogue: ${project.dialogue || '(empty)'}\nShots:\n${project.shots.map((shot) => `${shot.id}. (${shot.duration}s) ${shot.description || '(empty)'}`).join('\n')}`
    : '';
  return `Create or improve a UGC product-in-use script.

Title: ${project.title}
Owner brief: ${project.notes || '(not supplied)'}
Revision notes: ${project.feedback || '(none)'}
Reference images supplied: ${project.photos.length}
Total video length: ${project.durationSeconds} seconds
Shot timing: ${project.shots.map((shot) => `${shot.id}:${shot.duration}s`).join(', ')}
${current}

Requirements:
- A concise descriptive card title of 3–7 words and at most 60 characters.
- Exactly ${project.shots.length} distinct hard-cut shots. Follow the supplied per-shot durations exactly; together they total ${project.durationSeconds} seconds.
- A consistent adult creator, product, setting, wardrobe, and lighting across all shots.
- At least ${interactionShots} shots show the creator or hands physically using the product.
- At least ${Math.max(2, Math.ceil(project.durationSeconds / 2))} seconds show actual product use.
- Each shot contains one achievable action and useful camera direction.
- Reference images identify the product design only; do not animate their original background, mannequin, hanger, flat lay, or pose.
- Preserve permanent logos, embroidery, patches, prints, monograms, and integral branded hardware exactly where visible on the product; never redesign, mirror, blur, misspell, replace, remove, or invent them.
- Remove all detachable retail and packaging artifacts before filming: hang tags, price tags, product cards, barcode labels, stickers, security tags, plastic wrap, tissue, boxes, bags, hangers, clips, pins, and shipping materials. The product must be already clean before the first frame. Never make removing, showing, or handling these artifacts an action. Do not mention retail cleanup in the returned title, dialogue, or shot descriptions.
- Conversational dialogue with a hook, visible benefit, and complete CTA; ${targetLow}–${targetHigh} words preferred and ${wordLimit} words maximum for ${project.durationSeconds} seconds.
- Preserve factual limits from the owner brief. Do not fill missing facts with guesses.
- Return the final structured script only.`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The AI provider returned an invalid response.');
  return value as Record<string, unknown>;
}

function messageFromError(payload: unknown): string {
  try {
    const root = asRecord(payload);
    const error = asRecord(root.error);
    return typeof error.message === 'string' ? error.message.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]') : '';
  } catch { return ''; }
}

async function jsonResponse(response: Response, providerName: string): Promise<unknown> {
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = messageFromError(payload);
    throw new Error(`${providerName} request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  return payload;
}

export function selectOpenAiScriptModel(payload: unknown, configuredModel?: string): string {
  const root = asRecord(payload);
  if (!Array.isArray(root.data)) throw new Error('OpenAI returned an invalid model list.');
  const available = new Set<string>();
  for (const item of root.data) {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === 'string') {
      available.add((item as Record<string, string>).id);
    }
  }

  const requested = configuredModel?.trim();
  if (requested) {
    if (!available.has(requested)) throw new Error(`Configured OPENAI_MODEL "${requested}" is not available to this OpenAI project. Remove the override to select an available model automatically.`);
    return requested;
  }

  const selected = OPENAI_SCRIPT_MODELS.find((model) => available.has(model));
  if (!selected) throw new Error('This OpenAI project has no supported CFactory script model. Grant access to GPT-6 Luna or choose Claude in Settings.');
  return selected;
}

async function openAiScriptModel(key: string, fetchFn: Fetch): Promise<string> {
  const response = await fetchFn('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await jsonResponse(response, 'OpenAI');
  return selectOpenAiScriptModel(payload, process.env.OPENAI_MODEL);
}

export function validateGeneratedScript(
  value: unknown,
  provider: LlmProvider,
  model: string,
  plan: Pick<Project, 'durationSeconds' | 'shots'>
): GeneratedScript {
  const root = asRecord(value);
  const expectedShots = plan.shots.length;
  if (typeof root.dialogue !== 'string' || !Array.isArray(root.shots) || root.shots.length !== expectedShots) throw new Error(`The AI draft did not contain dialogue and exactly ${expectedShots} shots.`);
  const title = typeof root.title === 'string' ? root.title.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > 60) throw new Error('The AI draft did not contain a valid card title of 60 characters or fewer.');
  const dialogue = root.dialogue.trim().slice(0, 3000);
  const words = dialogue.replace(/^\s*\d+[.)]\s*/gm, '').trim().split(/\s+/).filter(Boolean).length;
  const wordLimit = dialogueWordLimit(plan.durationSeconds);
  if (!dialogue || words > wordLimit) throw new Error(`The AI draft has ${words} dialogue words; the limit is ${wordLimit} for ${plan.durationSeconds} seconds. No draft was applied.`);
  if (/\[PRODUCT NAME\]|OWNER TO SUPPLY|\[your link\]|TODO|TBD/i.test(dialogue)) throw new Error('The AI draft contains unresolved placeholders. No draft was applied.');
  const shots = root.shots.map((item, index) => {
    const shot = asRecord(item);
    const description = typeof shot.description === 'string' ? shot.description.trim().slice(0, 1500) : '';
    if (!description) throw new Error(`The AI draft is missing shot ${index + 1}. No draft was applied.`);
    return { id: index + 1, duration: plan.shots[index].duration, description };
  });
  const combined = `${dialogue}\n${shots.map((shot) => shot.description).join('\n')}`;
  if (/\[PRODUCT NAME\]|OWNER TO SUPPLY|\[your link\]|TODO|TBD/i.test(combined)) throw new Error('The AI draft contains unresolved placeholders. No draft was applied.');
  if (/APP SCREEN INSERT|real[^\n]*screenshot|screenshot[^\n]*app/i.test(combined)) throw new Error('The AI draft requests unsupported app-screen compositing. No draft was applied.');
  if (retailArtifact.test(dialogue) || retailArtifactAction.test(combined)) throw new Error('The AI draft asks the creator to show or handle retail or packaging artifacts. No draft was applied.');
  return { title, dialogue, shots, provider, model };
}

export async function testLlmKey(provider: LlmProvider, key: string, fetchFn: Fetch = fetch): Promise<void> {
  if (provider === 'openai') {
    await openAiScriptModel(key, fetchFn);
    return;
  }
  const response = await fetchFn('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(20_000)
  });
  await jsonResponse(response, 'Claude');
}

export async function generateScript(
  provider: LlmProvider,
  key: string,
  project: Pick<Project, 'title' | 'notes' | 'feedback' | 'dialogue' | 'durationSeconds' | 'shots' | 'photos'>,
  images: LlmImage[],
  fetchFn: Fetch = fetch
): Promise<GeneratedScript> {
  const prompt = llmBrief(project);
  const schema = scriptSchema(project.shots.length);
  const instructions = systemInstruction(project.durationSeconds, project.shots.length);
  if (provider === 'openai') {
    const model = await openAiScriptModel(key, fetchFn);
    const content: Record<string, unknown>[] = [{ type: 'input_text', text: prompt }];
    for (const image of images) content.push({ type: 'input_image', image_url: `data:${image.mime};base64,${image.base64}`, detail: 'high' });
    const response = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, instructions, input: [{ role: 'user', content }], store: false, max_output_tokens: 2400,
        text: { format: { type: 'json_schema', name: 'ugc_script', strict: true, schema } }
      }),
      signal: AbortSignal.timeout(90_000)
    });
    const payload = asRecord(await jsonResponse(response, 'OpenAI'));
    let text = typeof payload.output_text === 'string' ? payload.output_text : '';
    if (!text && Array.isArray(payload.output)) {
      for (const item of payload.output) {
        const output = asRecord(item);
        if (!Array.isArray(output.content)) continue;
        for (const part of output.content) {
          const candidate = asRecord(part);
          if (candidate.type === 'output_text' && typeof candidate.text === 'string') text += candidate.text;
        }
      }
    }
    if (!text) throw new Error('OpenAI returned no script text.');
    return validateGeneratedScript(JSON.parse(text), provider, model, project);
  }

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
  for (const image of images) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
  const response = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, max_tokens: 2400, system: instructions, messages: [{ role: 'user', content }],
      tools: [{ name: 'save_ugc_script', description: 'Return the completed UGC script.', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'save_ugc_script' }
    }),
    signal: AbortSignal.timeout(90_000)
  });
  const payload = asRecord(await jsonResponse(response, 'Claude'));
  if (!Array.isArray(payload.content)) throw new Error('Claude returned no script content.');
  const tool = payload.content.map(asRecord).find((item) => item.type === 'tool_use' && item.name === 'save_ugc_script');
  if (!tool) throw new Error('Claude did not return a structured script.');
  return validateGeneratedScript(tool.input, provider, model, project);
}
