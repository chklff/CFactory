import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Check, ChevronRight, CircleAlert, Clipboard, ExternalLink, Film,
  ImagePlus, LoaderCircle, Pencil, Play, ShieldCheck, Sparkles, Star, Trash2, X
} from 'lucide-react';
import { CARD_STATUSES, isDefaultCardTitle, type LlmProvider, type LlmStatus, type ProductPhoto, type Project, type Resolution, type Shot } from '../shared/types';
import { api, preparePhoto, wordCount, writerPrompt } from './lib';

function StepTitle({ number, title, active }: { number: number; title: string; active?: boolean }) {
  return <div className={`step-title ${active ? 'active' : ''}`}><span>{number}</span>{title}</div>;
}

export function Editor({ project, llm, onBack, onChanged, onDeleted }: {
  project: Project;
  llm: LlmStatus;
  onBack: () => void;
  onChanged: (project: Project) => void;
  onDeleted: () => void;
}) {
  const [saved, setSaved] = useState(project);
  const [draft, setDraft] = useState(project);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [writerOpen, setWriterOpen] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<ProductPhoto | null>(null);
  const [writerResult, setWriterResult] = useState('');
  const [writerProvider, setWriterProvider] = useState<LlmProvider>(llm.preferred);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setSaved(project); setDraft(project); setPreviewPhoto(null); }, [project.id]);
  useEffect(() => {
    if (!llm[writerProvider].configured) setWriterProvider(llm.preferred);
  }, [llm, writerProvider]);
  useEffect(() => {
    if (!['Generating', 'Submitting', 'Unknown'].includes(draft.render.phase)) return;
    const timer = window.setInterval(async () => {
      try {
        const state = await api<{ project: Project }>(`/api/state?cardId=${draft.id}`);
        setSaved(state.project); setDraft(state.project); onChanged(state.project);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [draft.id, draft.render.phase, onChanged]);
  useEffect(() => {
    if (!previewPhoto) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewPhoto(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewPhoto]);

  const changed = useMemo(() => JSON.stringify({
    title: saved.title, status: saved.status, notes: saved.notes, feedback: saved.feedback,
    dialogue: saved.dialogue, shots: saved.shots, resolution: saved.resolution
  }) !== JSON.stringify({
    title: draft.title, status: draft.status, notes: draft.notes, feedback: draft.feedback,
    dialogue: draft.dialogue, shots: draft.shots, resolution: draft.resolution
  }), [saved, draft]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError(''); setMessage('');
    try { await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(''); }
  };

  const acceptProject = (next: Project) => { setSaved(next); setDraft(next); onChanged(next); };

  const save = async () => {
    const next = await api<Project>(`/api/cards/${draft.id}`, { method: 'PATCH', body: JSON.stringify({
      title: draft.title, status: draft.status, notes: draft.notes, feedback: draft.feedback,
      dialogue: draft.dialogue, shots: draft.shots, resolution: draft.resolution
    }) });
    acceptProject(next); setMessage('Saved.');
  };

  const saveThen = async (path: string) => {
    if (changed) await save();
    const next = await api<Project>(path, { method: 'POST', body: '{}' });
    acceptProject(next);
  };

  const upload = async (files: FileList | null) => {
    if (!files) return;
    await run('upload', async () => {
      let current = draft;
      for (const file of Array.from(files)) {
        if (current.photos.length >= 4) throw new Error('You can add up to four product photos.');
        const next = await api<Project>(`/api/cards/${draft.id}/photos`, { method: 'POST', body: JSON.stringify(await preparePhoto(file)) });
        current = next; acceptProject(next);
      }
      setMessage('Product photo added.');
    });
    if (fileInput.current) fileInput.current.value = '';
  };

  const removePhoto = (id: string) => run('photo', async () => {
    acceptProject(await api<Project>(`/api/cards/${draft.id}/photos/${id}`, { method: 'DELETE' }));
  });

  const makePrimary = (id: string) => run('photo', async () => {
    acceptProject(await api<Project>(`/api/cards/${draft.id}/photos/${id}/primary`, { method: 'POST', body: '{}' }));
  });

  const copyWriterPrompt = async () => {
    await navigator.clipboard.writeText(writerPrompt(draft));
    setMessage('ChatGPT script prompt copied. Attach the same product photos.');
  };

  const applyWriterResult = () => {
    try {
      const parsed = JSON.parse(writerResult);
      if (typeof parsed.dialogue !== 'string' || !Array.isArray(parsed.shots) || parsed.shots.length !== 4) throw new Error();
      const shots: Shot[] = parsed.shots.map((shot: { description?: unknown }, index: number) => ({ id: index + 1, duration: 2, description: String(shot.description ?? '') }));
      const generatedTitle = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '';
      setDraft({ ...draft, title: isDefaultCardTitle(draft.title) && generatedTitle ? generatedTitle : draft.title, dialogue: parsed.dialogue, shots, status: 'Script review' });
      setWriterOpen(false); setWriterResult(''); setMessage('Draft imported. Review it before saving.');
    } catch { setError('Paste the exact JSON object returned by ChatGPT.'); }
  };

  const generateWriterDraft = async () => {
    await run('writer', async () => {
      if (changed) await save();
      const generated = await api<{ title: string; dialogue: string; shots: Shot[]; provider: LlmProvider; model: string }>(`/api/cards/${draft.id}/script/generate`, { method: 'POST', body: JSON.stringify({ provider: writerProvider }) });
      const namedByAI = isDefaultCardTitle(draft.title);
      setDraft((current) => ({ ...current, title: isDefaultCardTitle(current.title) ? generated.title : current.title, dialogue: generated.dialogue, shots: generated.shots, status: 'Script review', quote: null }));
      setWriterOpen(false);
      setMessage(`${generated.provider === 'openai' ? 'OpenAI' : 'Claude'} draft added with ${generated.model}.${namedByAI ? ` Card named “${generated.title}”.` : ''} Review it, then save.`);
    });
  };

  const copyRenderPacket = async () => {
    if (changed) await save();
    const packet = await api<{ prompt: string; resolution: Resolution; maxCredits: number; references: string[]; blockers: string[] }>(`/api/cards/${draft.id}/export`);
    if (packet.blockers.length) throw new Error(packet.blockers.join(' '));
    const text = `Use the connected Higgsfield MCP to create exactly one video. First upload and confirm every product photo I attach, preserving the listed order. Then cost-check the exact payload below and stop if the quote is above ${packet.maxCredits} credits or if Higgsfield changes any input. Ask for my confirmation after the quote and before the paid call. Do not downgrade, drop references, or retry an ambiguous paid submission.\n\nResolution: ${packet.resolution}\nDuration: 8 seconds\nAspect ratio: 9:16\nModel: seedance_2_5\nReference order: ${packet.references.join(', ') || '(none)'}\n\nPROMPT:\n${packet.prompt}`;
    await navigator.clipboard.writeText(text); setMessage('Higgsfield packet copied. Attach the same photos in ChatGPT.');
  };

  const removeCard = async () => {
    if (!window.confirm(`Delete “${draft.title}”? This removes the card from CFactory.`)) return;
    await api<void>(`/api/cards/${draft.id}`, { method: 'DELETE' }); onDeleted();
  };

  const output = draft.outputs.at(-1);
  const locked = ['Checking price', 'Submitting', 'Generating', 'Unknown'].includes(draft.render.phase);
  const missingProductPhoto = draft.photos.length === 0;

  const recoverRender = async () => {
    const next = await api<Project>(`/api/cards/${draft.id}/render/recover`, { method: 'POST', body: '{}' });
    acceptProject(next);
    setMessage('Existing Higgsfield job recovered. Waiting for the result.');
  };

  return <div className="editor-shell">
    <div className="editor-main">
      <div className="editor-nav"><button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Content board</button><button className="danger-text" onClick={() => void run('delete', removeCard)} disabled={locked}><Trash2 size={15} /> Delete card</button></div>
      <div className="workspace-title">
        <div className="title-editor"><input ref={titleInput} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value.slice(0, 120) })} aria-label="Card title" disabled={locked} /><button type="button" className="rename-title" onClick={() => { titleInput.current?.focus(); titleInput.current?.select(); }} aria-label="Rename card" title="Rename card" disabled={locked}><Pencil size={15} /></button></div>
        <label className="status-select"><span>Status</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as Project['status'] })} disabled={locked}>{CARD_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
        <div className="compact-meta">8 sec · 9:16 <ChevronRight size={14} /> {draft.resolution}</div>
      </div>
      <div className="stepper"><StepTitle number={1} title="Product" active /><i /><StepTitle number={2} title="Script" /><i /><StepTitle number={3} title="Render" /></div>

      {(error || message) && <div className={`notice ${error ? 'error' : 'success'}`}>{error ? <CircleAlert size={17} /> : <Check size={17} />}<span>{error || message}</span><button onClick={() => { setError(''); setMessage(''); }}><X size={15} /></button></div>}

      <section className="editor-section">
        <div className="section-head"><div><h2>Product</h2><p>Add a brief and up to four product photos.</p></div></div>
        <div className="product-grid">
          <label className="field"><span>Product brief</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="What should the creator show, and what must stay true?" disabled={locked} /><small>{draft.notes.length}/4000</small></label>
          <div className="photos-field"><div className="field-label">Product photos <span>({draft.photos.length}/4)</span></div>
            <div className="photo-list">
              {draft.photos.map((photo) => <div className={`photo ${photo.id === draft.primaryPhotoId ? 'primary' : ''}`} key={photo.id}>
                <button type="button" className="photo-preview-trigger" onClick={() => setPreviewPhoto(photo)} aria-label={`Enlarge ${photo.filename}`}><img src={photo.thumbnail} alt={photo.filename} /></button>
                {photo.id === draft.primaryPhotoId && <span className="primary-label">Main</span>}
                <div className="photo-actions"><button onClick={() => void makePrimary(photo.id)} title="Make main" disabled={locked}><Star size={14} /></button><button onClick={() => void removePhoto(photo.id)} title="Remove" disabled={locked}><Trash2 size={14} /></button></div>
              </div>)}
              {draft.photos.length < 4 && <button className="add-photo" onClick={() => fileInput.current?.click()} disabled={locked || busy === 'upload'}>{busy === 'upload' ? <LoaderCircle className="spin" /> : <ImagePlus />}<span>Add photo</span></button>}
            </div>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png" multiple hidden onChange={(event) => void upload(event.target.files)} />
            <small className={missingProductPhoto ? 'required-photo' : ''}>{missingProductPhoto ? 'Required before cost check or generation' : 'JPEG or PNG · 10 MiB max each · first photo is the main reference · click to enlarge'}</small>
          </div>
        </div>
      </section>

      <section className="editor-section">
        <div className="section-head"><div><h2>Script</h2><p>Four 2-second shots with complete dialogue.</p></div><button className="secondary" onClick={() => setWriterOpen(true)} disabled={locked}><Sparkles size={16} /> Write with AI</button></div>
        <label className="field dialogue"><span>Spoken dialogue <em className={wordCount(draft.dialogue) > 24 ? 'over' : ''}>{wordCount(draft.dialogue)}/24 words</em></span><textarea value={draft.dialogue} onChange={(event) => setDraft({ ...draft, dialogue: event.target.value })} placeholder={'1. Hook…\n2. Demonstration…\n3. Benefit the viewer can see…\n4. Complete CTA…'} disabled={locked} /></label>
        <div className="shots">{draft.shots.map((shot, index) => <div className="shot" key={shot.id}><span className="shot-number">{shot.id}</span><span className="duration">2s</span><input value={shot.description} onChange={(event) => setDraft({ ...draft, shots: draft.shots.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) })} placeholder={index === 0 ? 'Person-in-context hook; include the live-action reference instruction.' : 'One clear, achievable product-in-use action.'} disabled={locked} /></div>)}</div>
        <label className="field feedback"><span>Revision notes <em>optional</em></span><input value={draft.feedback} onChange={(event) => setDraft({ ...draft, feedback: event.target.value })} placeholder="What should the next version change?" disabled={locked} /></label>
      </section>

      <section className="editor-section render-section">
        <div className="section-head"><div><h2>Render</h2><p>Choose resolution, verify the exact cost, then submit once.</p></div><div className={`phase phase-${draft.render.phase.toLowerCase().replaceAll(' ', '-')}`}>{draft.render.phase}</div></div>
        <div className="render-grid">
          <div><div className="field-label">Resolution</div><div className="resolution-group">{(['480p', '720p', '1080p'] as Resolution[]).map((resolution) => <button key={resolution} className={draft.resolution === resolution ? 'selected' : ''} onClick={() => setDraft({ ...draft, resolution })} disabled={locked}>{resolution}</button>)}</div><small>Higher resolution may cost more. CFactory never downgrades automatically.</small></div>
          <div className="cost"><span>Cost estimate</span><strong>{draft.quote ? `${draft.quote.credits} credits` : 'Not checked'}</strong><small>150-credit hard limit · one output</small></div>
          <div className="render-actions"><button className="secondary" onClick={() => void run('quote', () => saveThen(`/api/cards/${draft.id}/render/quote`))} disabled={locked || missingProductPhoto || Boolean(busy)}>{busy === 'quote' ? <LoaderCircle className="spin" /> : <ShieldCheck size={17} />} Check cost</button><button className="primary" onClick={() => void run('render', () => saveThen(`/api/cards/${draft.id}/render/start`))} disabled={locked || missingProductPhoto || Boolean(busy)}>{busy === 'render' || draft.render.phase === 'Submitting' ? <LoaderCircle className="spin" /> : <Play size={17} fill="currentColor" />} Generate video</button><button className="text-button" onClick={() => void run('copy', copyRenderPacket)} disabled={locked || missingProductPhoto}>Copy for ChatGPT <ExternalLink size={14} /></button></div>
        </div>
        {missingProductPhoto && !locked && <div className="render-guidance"><CircleAlert size={16} /> Add at least one real product photo before checking cost.</div>}
        {draft.render.error && <div className="render-error"><CircleAlert size={16} /><span>{draft.render.error}</span>{draft.render.phase === 'Unknown' && <button className="secondary recover-button" onClick={() => void run('recover', recoverRender)} disabled={Boolean(busy)}>{busy === 'recover' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />} Recover render</button>}</div>}
      </section>

      <div className="save-bar"><span>{changed ? 'Unsaved changes' : 'All changes saved locally'}</span><button className="secondary" onClick={() => void run('save', save)} disabled={!changed || locked || Boolean(busy)}>{busy === 'save' ? <LoaderCircle className="spin" /> : <Check size={16} />} Save changes</button></div>
    </div>

    <aside className="preview-rail"><h2>Video review</h2><div className="video-frame">{output ? <video src={output.url} controls poster={draft.photos[0]?.thumbnail} /> : <div className="empty-preview">{draft.photos[0] ? <img src={draft.photos[0].thumbnail} alt="Product preview" /> : <Film size={34} />}<span>{draft.render.phase === 'Generating' ? 'Higgsfield is rendering…' : 'Your latest video appears here.'}</span></div>}</div><div className="history-head"><h3>History</h3><span>{draft.outputs.length}</span></div><div className="history-list">{[...draft.outputs].reverse().map((item, index) => <a href={item.url} target="_blank" rel="noreferrer" className="history-row" key={item.url}><div className="history-thumb">{draft.photos[0] ? <img src={draft.photos[0].thumbnail} alt="" /> : <Film size={18} />}</div><div><strong>{index === 0 ? 'Latest render' : `Version ${draft.outputs.length - index}`}</strong><small>8 sec · {item.requestedResolution}</small><small>{item.credits} credits · {new Date(item.recordedAt).toLocaleDateString()}</small></div><ExternalLink size={15} /></a>)}</div>{!draft.outputs.length && <p className="empty-history">No paid generations yet.</p>}</aside>

    {writerOpen && <div className="modal-backdrop"><div className="modal writer-modal" role="dialog" aria-modal="true" aria-labelledby="writer-title"><button className="modal-close" onClick={() => setWriterOpen(false)} aria-label="Close AI writer"><X /></button><h2 id="writer-title">Write with AI</h2><p>The selected model analyzes your brief, current draft, revision notes, and product photos. It creates an unsaved draft for your review and cannot start Higgsfield.</p>
      {(llm.openai.configured || llm.anthropic.configured) ? <div className="ai-writer-box"><label className="field"><span>Writing provider</span><select value={writerProvider} onChange={(event) => setWriterProvider(event.target.value as LlmProvider)}><option value="openai" disabled={!llm.openai.configured}>OpenAI{llm.openai.configured ? '' : ' — not connected'}</option><option value="anthropic" disabled={!llm.anthropic.configured}>Claude{llm.anthropic.configured ? '' : ' — not connected'}</option></select></label><button className="primary wide" onClick={() => void generateWriterDraft()} disabled={busy === 'writer'}>{busy === 'writer' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} {draft.dialogue.trim() ? 'Improve draft' : 'Generate draft'}</button><small>OpenAI selects an available script model automatically. One generation call; no automatic generation retry.</small></div> : <div className="modal-error">Connect OpenAI or Claude in Settings first.</div>}
      <details className="manual-writer"><summary>Use ChatGPT or Claude manually</summary><p>Copy the production-safe request, attach the same product photos in your chat, then paste the JSON response.</p><button className="secondary wide" onClick={() => void copyWriterPrompt()}><Clipboard size={16} /> Copy script request</button><label className="field"><span>JSON response</span><textarea value={writerResult} onChange={(event) => setWriterResult(event.target.value)} placeholder='{"dialogue":"1. …","shots":[…]}' /></label><button className="secondary wide" onClick={applyWriterResult}>Import manual draft</button></details>
    </div></div>}
    {previewPhoto && <div className="modal-backdrop photo-lightbox-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewPhoto(null); }}><div className="photo-lightbox" role="dialog" aria-modal="true" aria-label={`Product photo: ${previewPhoto.filename}`}><button className="modal-close lightbox-close" onClick={() => setPreviewPhoto(null)} aria-label="Close product photo"><X /></button><img src={`/api/cards/${encodeURIComponent(draft.id)}/photos/${encodeURIComponent(previewPhoto.id)}/preview`} alt={previewPhoto.filename} /><div className="photo-lightbox-caption"><strong>{previewPhoto.filename}</strong><span>{previewPhoto.id === draft.primaryPhotoId ? 'Main product reference' : 'Supporting product reference'}</span></div></div></div>}
  </div>;
}
