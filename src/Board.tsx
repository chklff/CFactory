import { CircleAlert, FileText, Film, Inbox, Plus, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { CARD_STATUSES, type CardStatus, type Project } from '../shared/types';
import { cardHint } from './lib';

function CardIcon({ project }: { project: Project }) {
  if (project.render.phase === 'Generating' || project.render.phase === 'Submitting') return <RotateCw size={14} className="spin" />;
  if (project.render.phase === 'Unknown') return <CircleAlert size={14} />;
  if (project.status === 'Ready') return <span className="ready-check">✓</span>;
  if (project.status === 'Video review') return <Film size={14} />;
  return <FileText size={14} />;
}

function BoardCard({ project, onOpen, onDragStart }: { project: Project; onOpen: () => void; onDragStart: () => void }) {
  const image = project.photos.find((photo) => photo.id === project.primaryPhotoId) ?? project.photos[0];
  return <button className="kanban-card" onClick={onOpen} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; onDragStart(); }}>
    <div className={`card-media ${image ? '' : 'empty'}`}>{image ? <img src={image.thumbnail} alt="" /> : <Film size={25} />}</div>
    <strong>{project.title || 'Untitled video idea'}</strong>
    <div className="card-meta"><span>Short · 9:16</span><span>{project.resolution}</span></div>
    <div className={`card-hint hint-${project.status.toLowerCase().replaceAll(' ', '-')}`}><CardIcon project={project} /><span>{cardHint(project)}</span></div>
  </button>;
}

export function Board({ cards, onOpen, onNew, onMove }: {
  cards: Project[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onMove: (id: string, status: CardStatus) => Promise<void>;
}) {
  const [draggedId, setDraggedId] = useState('');
  const [dropStatus, setDropStatus] = useState<CardStatus | ''>('');
  return <main className="board-view">
    <div className="board-heading"><div><h1>Content board</h1><p>Each card is one video idea. Move it through the workflow as you create.</p></div><button className="primary new-card" onClick={onNew}><Plus size={18} /> New card</button></div>
    <div className="kanban-board">
      {CARD_STATUSES.map((status) => {
        const columnCards = cards.filter((card) => card.status === status);
        return <section className={`kanban-column ${dropStatus === status ? 'drop-target' : ''}`} key={status}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropStatus(status); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropStatus(''); }}
          onDrop={(event) => { event.preventDefault(); const id = draggedId; setDraggedId(''); setDropStatus(''); if (id) void onMove(id, status); }}>
          <div className="column-head"><h2>{status}</h2><span>{columnCards.length}</span></div>
          <div className="column-cards">
            {columnCards.map((card) => <BoardCard key={card.id} project={card} onOpen={() => onOpen(card.id)} onDragStart={() => setDraggedId(card.id)} />)}
            {!columnCards.length && <div className="empty-column"><Inbox size={19} /><span>No cards</span><small>Drop an idea here.</small></div>}
          </div>
        </section>;
      })}
    </div>
  </main>;
}
