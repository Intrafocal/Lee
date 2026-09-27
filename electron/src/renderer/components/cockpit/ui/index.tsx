/**
 * Cockpit UI primitives (cockpit-design §1.3): small presentational pieces
 * every Cockpit view builds from, instead of ad-hoc markup. Owned by the
 * scaffold (S) and read-only for R1-R3: report a needed change as a question.
 *
 * The rules they carry (§0): phosphor only on `Btn kind="next"` (one per view,
 * checked by nextGuard in development) and the working Dot; ember only as a
 * Dot or the needs Eyebrow, never a number, button or border; your words in
 * Newsreader through WritingQuote. Focus rings are the global rule (§1.4).
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { nextGuard, viewRootOf } from './nextGuard';
import './ui.css';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** A click on a control inside a clickable card belongs to the control, not the card. */
function fromInnerControl(e: React.SyntheticEvent): boolean {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  const control = t.closest('button, a[href], input, textarea, select, summary, [role="button"], [contenteditable="true"]');
  return !!control && control !== e.currentTarget;
}

// ---------------------------------------------------------------------------
// SectionHead, Eyebrow
// ---------------------------------------------------------------------------

export interface SectionHeadProps {
  title: string;
  summary?: string;
  right?: React.ReactNode;
  className?: string;
}

/** A view's title (20px/500) with its one-line summary on the same baseline. */
export const SectionHead: React.FC<SectionHeadProps> = ({ title, summary, right, className }) => (
  <header className={cx('ui-section-head', className)}>
    <h2 className="ui-section-title">{title}</h2>
    {summary && <span className="ui-section-summary">{summary}</span>}
    {right != null && <div className="ui-section-right">{right}</div>}
  </header>
);

export interface EyebrowProps {
  /** 'needs' for "Waiting on you": the one ember text. */
  tone?: 'default' | 'needs';
  /** Quiet text at the right (a relative time). */
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/** A small uppercase label over a group. */
export const Eyebrow: React.FC<EyebrowProps> = ({ tone = 'default', right, className, children }) => (
  <div className={cx('ui-eyebrow', tone === 'needs' && 'is-needs', className)}>
    <span className="ui-eyebrow-text">{children}</span>
    {right != null && <span className="ui-eyebrow-right">{right}</span>}
  </div>
);

// ---------------------------------------------------------------------------
// Card, Row, Dot
// ---------------------------------------------------------------------------

export type DotKind = 'needs' | 'working' | 'done' | 'idle';

const DOT_LABELS: Record<DotKind, string> = {
  needs: 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
};

export interface DotProps {
  kind: DotKind;
  /** Overrides the default accessible label ("Needs you", "Working", ...). */
  label?: string;
  className?: string;
}

/** 7px state dot: ember (needs you), phosphor (working), a ring (done), muted (idle). */
export const Dot: React.FC<DotProps> = ({ kind, label, className }) => (
  <span className={cx('ui-dot', `is-${kind}`, className)} role="img" aria-label={label ?? DOT_LABELS[kind]} />
);

export interface CardProps {
  /** 'raised' marks the one item that needs you most; 'needs' looks plain (the Dot says it, never a border). */
  tone?: 'plain' | 'raised' | 'needs';
  /** Makes the whole card open its detail; clicks on controls inside stay theirs. */
  onOpen?: () => void;
  /** The list's keyboard selection (the 1px focus ring, §4.3). */
  selected?: boolean;
  /** Accessible name when the card opens something. */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { tone = 'plain', onOpen, selected, label, className, style, children },
  ref,
) {
  const open = onOpen
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': label,
        onClick: (e: React.MouseEvent) => {
          if (!fromInnerControl(e)) onOpen();
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          if ((e.key === 'Enter' || e.key === ' ') && !fromInnerControl(e)) {
            e.preventDefault();
            onOpen();
          }
        },
      }
    : {};
  return (
    <div
      ref={ref}
      className={cx('ui-card', `is-${tone}`, onOpen && 'is-openable', selected && 'is-selected', className)}
      style={style}
      aria-selected={selected || undefined}
      {...open}
    >
      {children}
    </div>
  );
});

export interface RowProps {
  dot?: DotKind;
  title: React.ReactNode;
  sub?: React.ReactNode;
  meta?: React.ReactNode;
  onOpen?: () => void;
  selected?: boolean;
  className?: string;
}

/** One line in a list: dot, 14px title, 13px sub, 12px meta at the right with › when it opens. */
export const Row = React.forwardRef<HTMLElement, RowProps>(function Row(
  { dot, title, sub, meta, onOpen, selected, className },
  ref,
) {
  const body = (
    <>
      {dot && <Dot kind={dot} className="ui-row-dot" />}
      <span className="ui-row-main">
        <span className="ui-row-title">{title}</span>
        {sub != null && <span className="ui-row-sub">{sub}</span>}
      </span>
      {(meta != null || onOpen) && (
        <span className="ui-row-meta">
          {meta}
          {onOpen && <span className="ui-row-chevron" aria-hidden="true">›</span>}
        </span>
      )}
    </>
  );
  const cls = cx('ui-row', onOpen && 'is-openable', selected && 'is-selected', className);
  return onOpen ? (
    <button ref={ref as React.Ref<HTMLButtonElement>} type="button" className={cls} onClick={onOpen} aria-selected={selected || undefined}>
      {body}
    </button>
  ) : (
    <div ref={ref as React.Ref<HTMLDivElement>} className={cls}>
      {body}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Chip, Btn, QuietLinks
// ---------------------------------------------------------------------------

export interface ChipProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/** A pill that acts at once (a quick reply, a question's option). Shows its exact text (C3). */
export const Chip: React.FC<ChipProps> = ({ label, onClick, disabled, title, className }) => (
  <button type="button" className={cx('ui-chip', className)} onClick={onClick} disabled={disabled} title={title}>
    {label}
  </button>
);

export type BtnKind = 'next' | 'plain' | 'quiet';

export interface BtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** 'next': the view's one phosphor step (nextGuard warns on a second). 'plain': filled. 'quiet': text only. */
  kind: BtnKind;
  /** Key hint shown after the label ("⇧⌘0"). */
  kbd?: string;
  className?: string;
}

export const Btn = React.forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { kind, kbd, className, children, type = 'button', ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const label = typeof children === 'string' ? children : '';
  useEffect(() => {
    if (kind !== 'next' || !nextGuard.enabled || !own.current) return undefined;
    return nextGuard.register(viewRootOf(own.current), label);
  }, [kind, label]);
  return (
    <button ref={setRef} type={type} className={cx('ui-btn', `is-${kind}`, className)} {...rest}>
      {children}
      {kbd && <span className="ui-kbd">{kbd}</span>}
    </button>
  );
});

export interface QuietLink {
  label: string;
  onClick: () => void;
  kbd?: string;
}

/** A row of quiet text links under a rule: the view's secondary ways on. */
export const QuietLinks: React.FC<{ items: QuietLink[]; className?: string }> = ({ items, className }) => (
  <nav className={cx('ui-quiet-links', className)}>
    {items.map((it) => (
      <button key={it.label} type="button" className="ui-quiet-link" onClick={it.onClick}>
        {it.label}
        {it.kbd && <span className="ui-kbd">{it.kbd}</span>}
      </button>
    ))}
  </nav>
);

// ---------------------------------------------------------------------------
// WritingQuote
// ---------------------------------------------------------------------------

export interface WritingQuoteProps {
  /** Your words, exactly as written (curly quotes are added here). */
  text: string;
  /** 17-19px; 18 by default (Home's Pick up uses 19). */
  size?: 17 | 18 | 19;
  className?: string;
}

/** Something you wrote, quoted back in Newsreader italic. */
export const WritingQuote: React.FC<WritingQuoteProps> = ({ text, size = 18, className }) => (
  <blockquote className={cx('ui-writing-quote', className)} style={{ fontSize: size }}>
    {`“${text.trim()}”`}
  </blockquote>
);

export { nextGuard, createNextGuard, viewRootOf, VIEW_ROOT_ATTR } from './nextGuard';
