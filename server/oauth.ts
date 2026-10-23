import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadSettings, updateSettings, type Settings } from './store.js';

type OAuthSettings = NonNullable<Settings['higgsfieldOAuth']>;

export class HiggsfieldOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;

  constructor(readonly redirectUrl: string, private readonly flowState?: string) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'CFactory UGC',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }

  state(): string {
    if (!this.flowState) throw new Error('OAuth flow state is unavailable. Start the connection again.');
    return this.flowState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await loadSettings()).higgsfieldOAuth?.clientInformation;
  }
  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> { await this.patch({ clientInformation }); }
  async tokens(): Promise<OAuthTokens | undefined> { return (await loadSettings()).higgsfieldOAuth?.tokens; }
  async saveTokens(tokens: OAuthTokens): Promise<void> { await this.patch({ tokens }); }
  redirectToAuthorization(authorizationUrl: URL): void { this.authorizationUrl = authorizationUrl; }
  async saveCodeVerifier(codeVerifier: string): Promise<void> { await this.patch({ codeVerifier }); }
  async codeVerifier(): Promise<string> {
    const verifier = (await loadSettings()).higgsfieldOAuth?.codeVerifier;
    if (!verifier) throw new Error('OAuth verifier is missing. Start the connection again.');
    return verifier;
  }
  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> { await this.patch({ discoveryState }); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return (await loadSettings()).higgsfieldOAuth?.discoveryState; }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await updateSettings((settings) => {
      const oauth = { ...(settings.higgsfieldOAuth ?? {}) };
      if (scope === 'all' || scope === 'client') delete oauth.clientInformation;
      if (scope === 'all' || scope === 'tokens') delete oauth.tokens;
      if (scope === 'all' || scope === 'verifier') delete oauth.codeVerifier;
      if (scope === 'all' || scope === 'discovery') delete oauth.discoveryState;
      return { ...settings, higgsfieldOAuth: oauth };
    });
  }

  private async patch(values: OAuthSettings): Promise<void> {
    await updateSettings((settings) => ({ ...settings, higgsfieldOAuth: { ...(settings.higgsfieldOAuth ?? {}), ...values } }));
  }
}

export function newOAuthState(): string { return randomBytes(32).toString('base64url'); }
