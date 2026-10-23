import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecentGenerations, parseSubmittedJobId, selectRecoveryCandidate, type RemoteGeneration } from '../server/higgsfield.js';

const jobId = '84997220-2bf8-489f-991d-f57e067eaad9';

test('paid submission accepts one job id returned as a JSON array', () => {
  assert.equal(parseSubmittedJobId({ content: [{ type: 'text', text: `[\"${jobId}\"]` }] }, `[\"${jobId}\"]`), jobId);
});

test('paid submission accepts structured job_id and rejects ambiguity', () => {
  assert.equal(parseSubmittedJobId({ structuredContent: { jobs: [{ job_id: jobId }] } }, ''), jobId);
  assert.equal(parseSubmittedJobId({ structuredContent: { jobs: [{ job_id: jobId }], unrelated_id: '922605fa-a936-4df9-b701-6f9d35092dc0' } }, ''), jobId);
  assert.throws(() => parseSubmittedJobId({}, '[]'), /no unambiguous job ID/);
  assert.throws(() => parseSubmittedJobId({}, `[\"${jobId}\",\"922605fa-a936-4df9-b701-6f9d35092dc0\"]`), /no unambiguous job ID/);
});

test('generation history keeps exact recovery fields and raw result URL', () => {
  const raw = {
    structuredContent: {
      items: [{
        id: jobId,
        status: 'completed',
        params: { prompt: 'exact prompt' },
        results: { rawUrl: `https://example.cloudfront.net/video-${jobId}.mp4` },
        createdAt: 1_792_777_709.5
      }]
    }
  };
  assert.deepEqual(parseRecentGenerations(raw, ''), [{
    id: jobId,
    status: 'completed',
    prompt: 'exact prompt',
    url: `https://example.cloudfront.net/video-${jobId}.mp4`,
    createdAt: 1_792_777_709.5
  }]);
});

test('recovery selects one exact recent prompt and rejects duplicates', () => {
  const original: RemoteGeneration = {
    id: jobId,
    status: 'in_progress',
    prompt: 'exact prompt',
    createdAt: Date.parse('2026-10-23T17:48:29.000Z') / 1000
  };
  assert.equal(selectRecoveryCandidate([original], 'exact prompt', '2026-10-23T17:48:30.000Z').id, jobId);
  assert.throws(() => selectRecoveryCandidate([], 'exact prompt', '2026-10-23T17:48:30.000Z'), /No matching/);
  assert.throws(() => selectRecoveryCandidate([
    original,
    { ...original, id: '922605fa-a936-4df9-b701-6f9d35092dc0' }
  ], 'exact prompt', '2026-10-23T17:48:30.000Z'), /More than one/);
  assert.throws(() => selectRecoveryCandidate([original], 'exact prompt', '2026-10-23T17:48:30.000Z', [jobId]), /No matching/);
});
