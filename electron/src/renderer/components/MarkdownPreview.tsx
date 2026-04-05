/**
 * MarkdownPreview - Renders markdown content with GitHub-flavored styling
 *
 * Uses react-markdown with remark-gfm for tables, task lists, strikethrough, etc.
 * Supports Mermaid diagram rendering and base64 image display.
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

/**
 * MermaidBlock - Renders a Mermaid diagram from DSL text.
 * Uses mermaid.js to render SVG inline.
 */
const MermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    const renderMermaid = async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            primaryColor: '#3a3f4b',
            primaryTextColor: '#e0e0e0',
            primaryBorderColor: '#555',
            lineColor: '#888',
            secondaryColor: '#2a2e38',
            tertiaryColor: '#1a1e28',
          },
        });

        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setError('');
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || 'Failed to render diagram');
          setSvg('');
        }
      }
    };

    renderMermaid();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="code-block-language">mermaid (error)</div>
        <pre className="code-block">{code}</pre>
        <div className="mermaid-error-msg">{error}</div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-loading">
        <div className="code-block-language">mermaid</div>
        <div className="mermaid-spinner">Rendering diagram...</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }}
    />
  );
};

export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
  content,
  className = '',
}) => {
  return (
    <div className={`markdown-preview ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          // Allow data:image URIs (for generated images) alongside default protocols
          if (url.startsWith('data:image/')) return url;
          // Default: allow http, https, mailto, tel
          if (/^https?:\/\/|^mailto:|^tel:|^#|^\//.test(url)) return url;
          return '';
        }}
        components={{
          // Custom rendering for code blocks — intercept mermaid blocks
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';

            if (inline) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }

            // Render Mermaid diagrams
            if (language === 'mermaid') {
              const code = String(children).replace(/\n$/, '');
              return <MermaidBlock code={code} />;
            }

            return (
              <div className="code-block-wrapper">
                {language && (
                  <div className="code-block-language">{language}</div>
                )}
                <pre className={`code-block ${className || ''}`}>
                  <code {...props}>{children}</code>
                </pre>
              </div>
            );
          },

          // Custom rendering for links
          a({ href, children, ...props }: any) {
            const isExternal = href?.startsWith('http');
            return (
              <a
                href={href}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                {...props}
              >
                {children}
                {isExternal && <span className="external-link-icon">↗</span>}
              </a>
            );
          },

          // Custom rendering for images — supports base64 data URIs
          img({ src, alt, ...props }: any) {
            return (
              <span className="image-wrapper">
                <img src={src} alt={alt || ''} loading="lazy" {...props} />
                {alt && <span className="image-caption">{alt}</span>}
              </span>
            );
          },

          // Custom rendering for tables
          table({ children, ...props }: any) {
            return (
              <div className="table-wrapper">
                <table {...props}>{children}</table>
              </div>
            );
          },

          // Custom rendering for task lists
          input({ type, checked, ...props }: any) {
            if (type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  disabled
                  className="task-checkbox"
                  {...props}
                />
              );
            }
            return <input type={type} {...props} />;
          },

          // Custom rendering for blockquotes
          blockquote({ children, ...props }: any) {
            return (
              <blockquote className="blockquote" {...props}>
                {children}
              </blockquote>
            );
          },

          // Custom rendering for horizontal rules
          hr({ ...props }: any) {
            return <hr className="horizontal-rule" {...props} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownPreview;
