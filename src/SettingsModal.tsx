import { CheckCircle2, ExternalLink, KeyRound, LoaderCircle, LogOut, X } from 'lucide-react';
import { useState } from 'react';
import type { LlmProvider, LlmStatus, PublicState } from '../shared/types';
import { api } from './lib';

function ProviderConnection({ provider, label, status, value, busy, onValue, onSave, onTest, onRemove }: {
  provider: LlmProvider;
  label: string;
  status: LlmStatus[LlmProvider];
  value: string;
  busy: boolean;
  onValue: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const managedByEnvironment = status.source === 'environment';
  return <div className="provider-card" data-provider={provider}>
    <div className="provider-head"><div><strong>{label}</strong><span>{status.configured ? `Connected · ${managedByEnvironment ? '.env.local' : 'saved locally'}` : 'Not connected'}</span></div>{status.configured ? <CheckCircle2 className="provider-ok" size={18} /> : <KeyRound size={18} />}</div>
    <label className="field"><span>{label} API key</span><input type="password" value={value} onChange={(event) => onValue(event.target.value)} placeholder={status.configured ? 'Enter a new key to replace it' : 'Paste key'} autoComplete="new-password" /></label>
    <div className="provider-actions"><button className="secondary" onClick={value.trim() ? onSave : onTest} disabled={busy || (!value.trim() && !status.configured)}>{busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} {value.trim() ? 'Test and save' : 'Test connection'}</button>{status.source === 'saved' && <button className="text-button danger" onClick={onRemove} disabled={busy}><LogOut size={14} /> Remove saved key</button>}</div>
    {managedByEnvironment && <small className="provider-note">Managed by the local environment file and never returned to the browser.</small>}
  </div>;
}

export function SettingsModal({ state, onClose, onUpdated }: {
  state: PublicState;
  onClose: () => void;
  onUpdated: (update: { connection?: PublicState['connection']; llm?: LlmStatus }) => void;
}) {
  const [url, setUrl] = useState(state.connection.serverUrl);
  const [llm, setLlm] = useState(state.llm);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const connectHiggsfield = async () => {
    setBusy('higgsfield'); setError(''); setMessage('');
    try {
      const result = await api<{ connected: boolean; authorizationUrl?: string }>('/api/oauth/higgsfield/start', { method: 'POST', body: JSON.stringify({ url }) });
      if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
      else onUpdated({ connection: { configured: true, connected: true, serverUrl: url, error: '' } });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  const disconnectHiggsfield = async () => {
    setBusy('higgsfield'); setError(''); setMessage('');
    try { onUpdated({ connection: await api<PublicState['connection']>('/api/oauth/higgsfield/disconnect', { method: 'POST' }) }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  const saveProvider = async (provider: LlmProvider) => {
    setBusy(provider); setError(''); setMessage('');
    try {
      const key = provider === 'openai' ? openaiKey : anthropicKey;
      const next = await api<LlmStatus>(`/api/settings/llm/${provider}`, { method: 'POST', body: JSON.stringify({ key }) });
      setLlm(next); onUpdated({ llm: next });
      if (provider === 'openai') setOpenaiKey(''); else setAnthropicKey('');
      setMessage(`${provider === 'openai' ? 'OpenAI' : 'Claude'} connected.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  const removeProvider = async (provider: LlmProvider) => {
    setBusy(provider); setError(''); setMessage('');
    try {
      const next = await api<LlmStatus>(`/api/settings/llm/${provider}`, { method: 'DELETE' });
      setLlm(next); onUpdated({ llm: next });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  const testProvider = async (provider: LlmProvider) => {
    setBusy(provider); setError(''); setMessage('');
    try { await api<{ connected: true }>(`/api/settings/llm/${provider}/test`, { method: 'POST' }); setMessage(`${provider === 'openai' ? 'OpenAI' : 'Claude'} connection works.`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  const setPreferred = async (provider: LlmProvider) => {
    setBusy('preferred'); setError(''); setMessage('');
    try {
      const next = await api<LlmStatus>('/api/settings/llm/preferred', { method: 'POST', body: JSON.stringify({ provider }) });
      setLlm(next); onUpdated({ llm: next });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  return <div className="modal-backdrop"><div className="modal connections-modal" role="dialog" aria-modal="true" aria-labelledby="connections-title">
    <button className="modal-close" onClick={onClose} aria-label="Close settings"><X /></button>
    <h2 id="connections-title">Connections</h2>
    <p>Connect one writing model—or both—and connect Higgsfield separately for video generation.</p>
    {error && <div className="modal-error">{error}</div>}
    {message && <div className="notice success"><CheckCircle2 size={16} /><span>{message}</span></div>}

    <section className="settings-section"><div className="settings-title"><div><h3>AI script writer</h3><p>Creates or improves the four-shot draft. It never starts a video render.</p></div>{(llm.openai.configured || llm.anthropic.configured) && <label><span>Default</span><select value={llm.preferred} onChange={(event) => void setPreferred(event.target.value as LlmProvider)} disabled={busy === 'preferred'}><option value="openai" disabled={!llm.openai.configured}>OpenAI</option><option value="anthropic" disabled={!llm.anthropic.configured}>Claude</option></select></label>}</div>
      <div className="provider-grid">
        <ProviderConnection provider="openai" label="OpenAI" status={llm.openai} value={openaiKey} busy={busy === 'openai'} onValue={setOpenaiKey} onSave={() => void saveProvider('openai')} onTest={() => void testProvider('openai')} onRemove={() => void removeProvider('openai')} />
        <ProviderConnection provider="anthropic" label="Claude" status={llm.anthropic} value={anthropicKey} busy={busy === 'anthropic'} onValue={setAnthropicKey} onSave={() => void saveProvider('anthropic')} onTest={() => void testProvider('anthropic')} onRemove={() => void removeProvider('anthropic')} />
      </div>
    </section>

    <section className="settings-section higgsfield-settings"><div className="settings-title"><div><h3>Higgsfield video</h3><p>Uses official MCP OAuth. No Higgsfield API key is needed.</p></div>{state.connection.connected && <span className="connected-pill"><CheckCircle2 size={14} /> Connected</span>}</div>
      <label className="field"><span>Official MCP server</span><input value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <div className="provider-actions"><button className="primary" onClick={() => void connectHiggsfield()} disabled={Boolean(busy)}>{busy === 'higgsfield' ? <LoaderCircle className="spin" /> : <ExternalLink size={17} />} {state.connection.connected ? 'Reconnect OAuth' : 'Connect with OAuth'}</button>{state.connection.connected && <button className="text-button danger" onClick={() => void disconnectHiggsfield()} disabled={Boolean(busy)}><LogOut size={14} /> Disconnect</button>}</div>
    </section>
    <p className="modal-foot">Provider keys and OAuth credentials stay on this computer with owner-only file permissions. Keys are never returned to the browser after saving.</p>
  </div></div>;
}
