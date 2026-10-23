import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Settings, X } from 'lucide-react';
import type { CardStatus, Project, PublicState } from '../shared/types';
import { Board } from './Board';
import { Editor } from './Editor';
import { SettingsModal } from './SettingsModal';
import { api } from './lib';

function StatusDot({ connected }: { connected: boolean }) {
  return <span className={`status-dot ${connected ? 'online' : ''}`} aria-hidden="true" />;
}

export function App() {
  const [state, setState] = useState<PublicState | null>(null);
  const [view, setView] = useState<'board' | 'editor'>('board');
  const [selectedId, setSelectedId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cardId?: string) => {
    const next = await api<PublicState>(`/api/state${cardId ? `?cardId=${encodeURIComponent(cardId)}` : ''}`);
    setState(next); setSelectedId(next.project.id);
  }, []);

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); }, [load]);

  const openCard = async (id: string) => {
    setBusy(true); setError('');
    try { await load(id); setView('editor'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const newCard = async () => {
    setBusy(true); setError('');
    try {
      const card = await api<Project>('/api/cards', { method: 'POST', body: '{}' });
      await load(card.id); setView('editor');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const moveCard = async (id: string, status: CardStatus) => {
    setError('');
    try {
      const card = await api<Project>(`/api/cards/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setState((current) => current ? { ...current, cards: current.cards.map((item) => item.id === id ? card : item), project: current.project.id === id ? card : current.project } : current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const updateCard = useCallback((card: Project) => {
    setState((current) => current ? { ...current, project: card, cards: current.cards.map((item) => item.id === card.id ? card : item) } : current);
  }, []);

  const afterDelete = async () => { await load(); setView('board'); };

  if (!state) return <div className="loading"><LoaderCircle className="spin" /> Opening CFactory…</div>;

  return <div className="app">
    <header className="app-header">
      <button className="brand-button" onClick={() => setView('board')}>CFactory</button>
      <div className="connection"><StatusDot connected={state.connection.connected} /><span>{state.connection.configured ? (state.connection.connected ? 'Connected to Higgsfield' : 'Higgsfield configured') : 'Higgsfield not connected'}</span><button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Higgsfield settings"><Settings size={18} /></button></div>
    </header>

    {error && <div className="global-error"><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
    {busy && <div className="global-busy"><LoaderCircle className="spin" size={18} /></div>}

    {view === 'board' ? <Board cards={state.cards} onOpen={(id) => void openCard(id)} onNew={() => void newCard()} onMove={moveCard} /> : <Editor key={selectedId} project={state.project} llm={state.llm} onBack={() => setView('board')} onChanged={updateCard} onDeleted={() => void afterDelete()} />}

    {settingsOpen && <SettingsModal state={state} onClose={() => setSettingsOpen(false)} onUpdated={(update) => setState((current) => current ? { ...current, ...update } : current)} />}
  </div>;
}
