import test from 'node:test';
import assert from 'node:assert/strict';
import { HiggsfieldOAuthProvider, newOAuthState } from '../server/oauth.js';

test('OAuth state is random and suitable for a URL', () => {
  const first = newOAuthState();
  const second = newOAuthState();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
});

test('Higgsfield OAuth metadata uses authorization code with PKCE-compatible public client auth', () => {
  const callback = 'http://127.0.0.1:4312/api/oauth/higgsfield/callback';
  const provider = new HiggsfieldOAuthProvider(callback, 'state');
  assert.deepEqual(provider.clientMetadata.redirect_uris, [callback]);
  assert.deepEqual(provider.clientMetadata.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, 'none');
});
