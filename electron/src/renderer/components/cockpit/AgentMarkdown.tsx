/**
 * AgentMarkdown - agent words (summaries, digest claims) rendered as compact
 * markdown in the Cockpit and Copilot panels. Same renderer as
 * MarkdownPreview (react-markdown + remark-gfm), but safe and small:
 * raw HTML is dropped (skipHtml, no rehype-raw), links render as their text
 * (the URL in a tooltip, nothing navigates), images as their alt text,
 * headings as bold lines, fenced code as monospace blocks.
 */

import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './agent-markdown.css';

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <span className="agent-md-link" title={typeof href === 'string' && href ? href : undefined}>
      {children}
    </span>
  ),
  img: ({ alt }) => (alt ? <span className="agent-md-img">[{alt}]</span> : null),
  h1: ({ children }) => <div className="agent-md-h">{children}</div>,
  h2: ({ children }) => <div className="agent-md-h">{children}</div>,
  h3: ({ children }) => <div className="agent-md-h">{children}</div>,
  h4: ({ children }) => <div className="agent-md-h">{children}</div>,
  h5: ({ children }) => <div className="agent-md-h">{children}</div>,
  h6: ({ children }) => <div className="agent-md-h">{children}</div>,
  pre: ({ children }) => <pre className="agent-md-pre">{children}</pre>,
};

interface AgentMarkdownProps {
  text: string;
  /** Inline: paragraphs render as spans so the text can follow a label on one line. */
  inline?: boolean;
  className?: string;
}

const INLINE_COMPONENTS: Components = {
  ...COMPONENTS,
  p: ({ children }) => <span className="agent-md-p">{children}</span>,
};

export const AgentMarkdown: React.FC<AgentMarkdownProps> = ({ text, inline, className }) => {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={`agent-md${inline ? ' is-inline' : ''}${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={inline ? INLINE_COMPONENTS : COMPONENTS}>
        {text}
      </ReactMarkdown>
    </Tag>
  );
};

export default AgentMarkdown;
