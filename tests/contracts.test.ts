import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../shared/types.js';
import {
  buildPrompt, buildProviderParams, dialogue, parseAuthorizedPrice,
  referenceHash, renderSourceHash, validateCreative
} from '../server/contracts.js';
import { newProject } from '../server/store.js';
import { CARD_STATUSES, DEFAULT_CARD_TITLE, isDefaultCardTitle } from '../shared/types.js';

function fixture(): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'Idea',
    title: 'Everyday tote demo',
    notes: 'Show how the tote fits a normal weekday.',
    feedback: 'Keep it natural.',
    dialogue: '1. This tote keeps my day simple.\n2. Everything fits, and it is easy to grab.\n3. See it in action.\n4. Take yours anywhere.',
    durationSeconds: 8,
    shots: [
      { id: 1, duration: 2, description: 'New live-action UGC scene; reference photos identify product design only, not the background, mannequin or pose. No still-photo animation. Creator lifts the beige tote from a hall bench.' },
      { id: 2, duration: 2, description: 'Same creator places a notebook and bottle into the open beige tote.' },
      { id: 3, duration: 2, description: 'Close view of the creator reaching into the tote while walking.' },
      { id: 4, duration: 2, description: 'Creator wears the tote and turns to camera for the CTA.' }
    ],
    resolution: '720p',
    referenceRevision: 1,
    primaryPhotoId: '22222222-2222-4222-8222-222222222222',
    photos: [{ id: '22222222-2222-4222-8222-222222222222', filename: 'tote.jpg', mime: 'image/jpeg', sha256: 'a'.repeat(64), thumbnail: 'data:image/jpeg;base64,/9j/', mediaId: '' }],
    quote: null,
    render: { sequence: 0, requestId: '', phase: 'Idle', sourceHash: '', prompt: '', credits: null, jobId: '', error: '', at: '2026-10-22T00:00:00.000Z' },
    outputs: [],
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z'
  };
}

test('dialogue strips numbering without changing words', () => {
  assert.equal(dialogue('1. Hello there\n2) Buy now'), 'Hello there Buy now');
});

test('prompt preserves all authored shots, dialogue and selected delivery', () => {
  const project = fixture();
  const prompt = buildPrompt(project);
  assert.match(prompt, /1\. \(2s\) New live-action UGC scene/);
  assert.match(prompt, /DIALOGUE \(verbatim/);
  assert.match(prompt, /Delivery: 720p, 9:16\./);
  assert.match(prompt, /PRODUCT REFERENCES: Use the supplied photos/);
  assert.match(prompt, /PRESERVE every permanent brand mark/);
  assert.match(prompt, /REMOVE every detachable retail or packaging artifact/);
  assert.match(prompt, /hang tags, price tags, product cards/);
});

test('reference and render hashes are stable and bind ordering and resolution', () => {
  const project = fixture();
  assert.equal(referenceHash(project), '23c26982eff0e489593fe1578c497023e4c096c4326e54541c74876d71d5c711');
  assert.equal(renderSourceHash(project), '6fef81e6bb2e557dd8d30d40c1c5c2a292797b6646893388198bc2c53ef57849');
  const changed = fixture(); changed.resolution = '1080p';
  assert.notEqual(renderSourceHash(changed), renderSourceHash(project));
});

test('creative validation enforces the structural 8-second contract', () => {
  const project = fixture();
  assert.deepEqual(validateCreative(project), []);
  project.dialogue += ' too many unnecessary words added to force this dialogue beyond the strict maximum word count';
  assert.match(validateCreative(project).join(' '), /limit is 24/);
});

test('variable video plans preserve the selected duration and support more shots', () => {
  const project = fixture();
  project.durationSeconds = 12;
  project.shots = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, duration: 2, description: `Shot ${index + 1} product action.` }));
  project.dialogue = Array(30).fill('word').join(' ');
  assert.deepEqual(validateCreative(project), []);
  assert.match(buildPrompt(project), /Create a 12-second vertical 9:16 video/);
  assert.match(buildPrompt(project), /retain all 6 listed shots/);
  assert.equal(buildProviderParams(buildPrompt(project), project.resolution, project.durationSeconds, []).duration, 12);

  project.shots[0].duration = 1;
  assert.match(validateCreative(project).join(' '), /must total exactly 12 seconds/);
});

test('product video validation requires a reference photo', () => {
  const project = fixture();
  project.photos = [];
  project.primaryPhotoId = '';
  assert.match(validateCreative(project).join(' '), /at least one product photo/i);
});

test('price parser accepts the inclusive ceiling and rejects unsafe responses', () => {
  for (const price of [24, 31, 56, 150]) assert.equal(parseAuthorizedPrice(`Cost preflight for seedance_2_5: ${price} credits`), price);
  for (const value of [
    'Cost preflight for seedance_2_5: 150.01 credits',
    'Cost preflight for seedance_2_5: 151 credits',
    'Cost preflight for seedance_2_5: -1 credits',
    'A preset might cost 24 credits',
    'Cost preflight for seedance_2_5: 56 credits; resolution adjusted'
  ]) assert.throws(() => parseAuthorizedPrice(value));
});

test('cost and paid payloads can differ only by get_cost', () => {
  const project = fixture();
  const prompt = buildPrompt(project);
  const base = buildProviderParams(prompt, project.resolution, project.durationSeconds, ['33333333-3333-4333-8333-333333333333']);
  const preflight = { ...base, get_cost: true };
  const { get_cost, ...withoutFlag } = preflight;
  assert.equal(get_cost, true);
  assert.deepEqual(withoutFlag, base);
});

test('new video ideas start as cards in the Idea column', () => {
  const project = newProject();
  assert.equal(project.status, 'Idea');
  assert.equal(project.durationSeconds, 8);
  assert.equal(project.title, DEFAULT_CARD_TITLE);
  assert.equal(isDefaultCardTitle(project.title), true);
  assert.equal(isDefaultCardTitle('Customer testimonial'), false);
  assert.equal(CARD_STATUSES.length, 7);
  assert.deepEqual(CARD_STATUSES, ['Idea', 'Scripting', 'Script review', 'Producing', 'Video review', 'Ready', 'Rejected']);
});
