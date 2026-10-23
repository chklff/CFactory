import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScript, llmBrief, selectOpenAiScriptModel, testLlmKey, validateGeneratedScript } from '../server/llm.js';
import type { Project } from '../shared/types.js';

const project = {
  title: 'Everyday tote demo',
  notes: 'Show the zipper and shoulder fit. Do not claim waterproofing.',
  feedback: 'Make the hook more direct.',
  dialogue: '',
  durationSeconds: 8,
  shots: [1, 2, 3, 4].map((id) => ({ id, duration: 2 as const, description: '' })),
  photos: []
} satisfies Pick<Project, 'title' | 'notes' | 'feedback' | 'dialogue' | 'durationSeconds' | 'shots' | 'photos'>;

const validDraft = {
  title: 'Everyday Tote Commute Demo',
  dialogue: 'This tote keeps my everyday essentials organized. See the zipper and comfortable fit—take yours anywhere today.',
  shots: [
    { description: 'Creator enters frame carrying the tote on one shoulder.' },
    { description: 'Close-up of hands opening the zipper in natural light.' },
    { description: 'Creator places everyday essentials inside the tote.' },
    { description: 'Creator closes the zipper and walks toward the door.' }
  ]
};

test('LLM brief preserves owner facts and prohibits guessing', () => {
  const prompt = llmBrief(project);
  assert.match(prompt, /Do not claim waterproofing/);
  assert.match(prompt, /Do not fill missing facts with guesses/);
  assert.match(prompt, /Exactly four distinct hard-cut shots/);
  assert.match(prompt, /Total video length: 8 seconds/);
  assert.match(prompt, /Preserve permanent logos, embroidery, patches, prints, monograms, and integral branded hardware/);
  assert.match(prompt, /Remove all detachable retail and packaging artifacts/);
  assert.match(prompt, /already clean before the first frame/);
  assert.match(prompt, /Do not mention retail cleanup in the returned title, dialogue, or shot descriptions/);
});

test('generated script validation enforces four shots and the dialogue ceiling', () => {
  const accepted = validateGeneratedScript(validDraft, 'openai', 'test-model', project);
  assert.equal(accepted.title, 'Everyday Tote Commute Demo');
  assert.equal(accepted.shots.length, 4);
  assert.equal(accepted.shots.every((shot) => shot.duration === 2), true);
  assert.throws(() => validateGeneratedScript({ ...validDraft, dialogue: Array(25).fill('word').join(' ') }, 'openai', 'test-model', project), /limit is 24/);
  assert.throws(() => validateGeneratedScript({ ...validDraft, shots: validDraft.shots.slice(0, 3) }, 'anthropic', 'test-model', project), /exactly 4 shots/);
  assert.throws(() => validateGeneratedScript({ ...validDraft, title: '' }, 'openai', 'test-model', project), /card title/);
  assert.throws(() => validateGeneratedScript({ ...validDraft, shots: [{ description: 'Creator removes the price tag.' }, ...validDraft.shots.slice(1)] }, 'openai', 'test-model', project), /retail or packaging artifacts/);
  const cleanConstraint = validateGeneratedScript({ ...validDraft, shots: [{ description: 'Product is already clean; no hang tags or packaging are visible.' }, ...validDraft.shots.slice(1)] }, 'openai', 'test-model', project);
  assert.match(cleanConstraint.shots[0].description, /no hang tags or packaging are visible/);
});

test('LLM plan follows a longer duration and expanded shot list', () => {
  const longer = {
    ...project,
    durationSeconds: 12,
    shots: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, duration: 2 as const, description: '' }))
  };
  const prompt = llmBrief(longer);
  assert.match(prompt, /Total video length: 12 seconds/);
  assert.match(prompt, /Exactly 6 distinct hard-cut shots/);
  const draft = { ...validDraft, dialogue: Array(30).fill('word').join(' '), shots: Array.from({ length: 6 }, (_, index) => ({ description: `Shot ${index + 1}` })) };
  const accepted = validateGeneratedScript(draft, 'openai', 'test-model', longer);
  assert.equal(accepted.shots.length, 6);
  assert.deepEqual(accepted.shots.map((shot) => shot.duration), [2, 2, 2, 2, 2, 2]);
});

test('OpenAI script model selection prefers current efficient models available to the project', () => {
  const models = { data: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] };
  assert.equal(selectOpenAiScriptModel(models), 'gpt-6-luna');
  assert.equal(selectOpenAiScriptModel(models, 'gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.throws(
    () => selectOpenAiScriptModel(models, 'gpt-5-mini'),
    /Configured OPENAI_MODEL "gpt-5-mini" is not available/
  );
});

test('OpenAI generation uses structured output and returns a review draft', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push(String(input));
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-6-luna' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ output_text: JSON.stringify(validDraft) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await generateScript('openai', 'fake-openai-key', project, [], fakeFetch);
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.shots.length, 4);
  assert.deepEqual(calls, ['https://api.openai.com/v1/models', 'https://api.openai.com/v1/responses']);
  assert.equal(requestBody?.model, 'gpt-6-luna');
  assert.equal((requestBody?.text as { format?: { type?: string } }).format?.type, 'json_schema');
  assert.equal(requestBody?.store, false);
});

test('Claude generation forces one structured script tool result', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'save_ugc_script', input: validDraft }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await generateScript('anthropic', 'fake-claude-key', project, [], fakeFetch);
  assert.equal(result.provider, 'anthropic');
  assert.deepEqual(requestBody?.tool_choice, { type: 'tool', name: 'save_ugc_script' });
});

test('provider key checks use non-generation model-list endpoints', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    const data = String(input).includes('openai.com') ? [{ id: 'gpt-6-luna' }] : [];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await testLlmKey('openai', 'fake-openai-key', fakeFetch);
  await testLlmKey('anthropic', 'fake-claude-key', fakeFetch);
  assert.deepEqual(calls, ['https://api.openai.com/v1/models', 'https://api.anthropic.com/v1/models?limit=1']);
});

test('provider failures are readable and redact any key-like text', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid key sk-example-secret-value-123456789' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(
    () => generateScript('openai', 'fake-openai-key', project, [], fakeFetch),
    (error: Error) => error.message.includes('OpenAI request failed (401)') && error.message.includes('[redacted]') && !error.message.includes('sk-example')
  );
});
