import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { help, type HelpTopic } from './help';

export function InfoIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5h.01" />
  </svg>;
}

function InfoDialog({ topic, onClose }: Readonly<{ topic: HelpTopic; onClose(): void }>) {
  const ref = useRef<HTMLDialogElement>(null);
  const entry = help[topic];
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  // O portal tira o modal de formulários e fieldsets desabilitados, que bloqueariam o botão de fechar. Fecha pelo botão ou por Escape.
  return createPortal(<dialog ref={ref} className="info-dialog" aria-labelledby={`help-${topic}`} onClose={onClose}>
    <div className="info-dialog-body">
      <header className="info-dialog-head">
        <div><p className="eyebrow">Entenda</p><h2 id={`help-${topic}`}>{entry.title}</h2></div>
        <button type="button" className="icon-button" aria-label="Fechar explicação" onClick={() => ref.current?.close()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <p className="info-summary">{entry.summary}</p>
      {entry.sections.map((section) => <section key={section.heading} className="info-section">
        <h3>{section.heading}</h3>{section.body}
      </section>)}
    </div>
  </dialog>, document.body);
}

export function InfoButton({ topic }: Readonly<{ topic: HelpTopic }>) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="info-button" aria-label={`Entenda: ${help[topic].title}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <InfoIcon />
    </button>
    {open && <InfoDialog topic={topic} onClose={() => setOpen(false)} />}
  </>;
}

/** Rótulo, botão de explicação e controle. O botão fica fora do label para não entrar no nome acessível do campo. */
export function Field({ id, label, topic, error, className = '', children }: Readonly<{
  id: string; label: string; topic: HelpTopic; error?: string | undefined; className?: string; children: ReactNode;
}>) {
  return <div className={`field ${className}`}>
    <div className="field-head"><label htmlFor={id}>{label}</label><InfoButton topic={topic} /></div>
    {children}
    {error && <span role="alert" className="error">{error}</span>}
  </div>;
}

export function Heading({ eyebrow, title, topic, children }: Readonly<{ eyebrow?: string; title: string; topic: HelpTopic; children?: ReactNode }>) {
  return <div className="section-heading">
    <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<div className="title-row"><h2>{title}</h2><InfoButton topic={topic} /></div></div>
    {children && <div className="section-actions">{children}</div>}
  </div>;
}

const copyLabels = { idle: 'Copiar', copied: 'Copiado', failed: 'Copie manualmente' } as const;
const arrowSteps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

export function CopyButton({ value, label }: Readonly<{ value: string; label: string }>) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return <button type="button" className="copy-button" aria-label={`Copiar ${label}`} onClick={() => {
    navigator.clipboard.writeText(value).then(() => setState('copied'), () => setState('failed'));
  }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {state === 'copied' ? <path d="M5 12l5 5 9-10" /> : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>}
    </svg>
    <span aria-live="polite">{copyLabels[state]}</span>
  </button>;
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Pisca suavemente até a aba ser aberta. */
  attention?: boolean | undefined;
  /** Balão que sai da aba; a chave nova reinicia a animação. */
  bubble?: { key: number; text: string } | undefined;
}

export function Tabs<T extends string>({ items, active, onChange, label }: Readonly<{
  items: readonly TabItem<T>[]; active: T; onChange(id: T): void; label: string;
}>) {
  // Setas trocam de aba, no padrão WAI-ARIA de tabs com ativação automática.
  function move(event: KeyboardEvent<HTMLButtonElement>) {
    const step = arrowSteps[event.key];
    if (!step) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.id === active);
    const next = items[(index + step + items.length) % items.length];
    if (!next) return;
    onChange(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }
  return <div role="tablist" aria-label={label} className="tabs">
    {items.map((item) => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} aria-controls={`panel-${item.id}`}
      aria-selected={item.id === active} tabIndex={item.id === active ? 0 : -1} onClick={() => onChange(item.id)} onKeyDown={move}
      className={item.attention ? 'tab-attention' : undefined}>
      {item.label}
      {item.bubble && <span key={item.bubble.key} className="tab-bubble" aria-hidden="true">
        <span className="tab-bubble-dot" /><span className="tab-bubble-text">{item.bubble.text}</span>
      </span>}
    </button>)}
  </div>;
}

export function TabPanel({ id, active, children }: Readonly<{ id: string; active: boolean; children: ReactNode }>) {
  // Painéis inativos continuam montados para não perder o formulário em edição ao trocar de aba.
  return <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={!active}>{children}</div>;
}
