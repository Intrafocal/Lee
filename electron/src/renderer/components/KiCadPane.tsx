/**
 * KiCadPane - KiCad schematic and PCB layout viewer tab
 *
 * Renders .kicad_sch and .kicad_pcb files with KiCanvas (vendored MIT
 * bundle, https://kicanvas.org), which registers the <kicanvas-embed> and
 * <kicanvas-source> custom elements. File content is read over IPC and
 * inlined into <kicanvas-source>, so rendering is fully local and works
 * in both dev (http) and packaged (file://) builds.
 */

import React, { useEffect, useRef, useState } from 'react';

const lee = (window as any).lee;

// Side-effect module that registers the custom elements — load once, on demand
let kicanvasModule: Promise<unknown> | null = null;
function loadKiCanvas(): Promise<unknown> {
  if (!kicanvasModule) {
    kicanvasModule = import('../vendor/kicanvas/kicanvas.js');
  }
  return kicanvasModule;
}

interface KiCadPaneProps {
  active: boolean;
  filePath?: string;
  onOpenAsText?: (filePath: string) => void;
}

export const KiCadPane: React.FC<KiCadPaneProps> = ({ active, filePath, onOpenAsText }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (!filePath || !lee) return;
    let cancelled = false;
    const container = containerRef.current;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        await loadKiCanvas();
        const content: string = await lee.fs.readFile(filePath);
        if (cancelled || !container) return;

        // KiCanvas sniffs the content prefix to pick schematic vs board
        const trimmed = content.trimStart();
        if (!trimmed.startsWith('(kicad_sch') && !trimmed.startsWith('(kicad_pcb')) {
          setError(
            'This file does not look like a KiCad 6+ schematic or board. ' +
            'Legacy formats are not supported — re-save the file with a recent KiCad.'
          );
          return;
        }

        container.innerHTML = '';
        const embed = document.createElement('kicanvas-embed');
        embed.setAttribute('controls', 'full');
        embed.style.width = '100%';
        embed.style.height = '100%';

        const source = document.createElement('kicanvas-source');
        // KiCanvas uses the name attribute verbatim as the virtual filename and
        // routes by its extension — it must keep .kicad_sch/.kicad_pcb
        const fileName = filePath.split('/').pop() || 'file.kicad_sch';
        source.setAttribute('name', fileName);
        source.textContent = content;
        embed.appendChild(source);
        container.appendChild(embed);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (container) container.innerHTML = '';
    };
  }, [filePath, reloadCount]);

  const fileName = filePath?.split('/').pop();

  return (
    <div className={`kicad-pane ${active ? 'active' : ''}`}>
      <div className="viewer-toolbar">
        <span className="viewer-toolbar-title">🔌 {fileName ?? 'KiCad Viewer'}</span>
        <div className="viewer-toolbar-actions">
          <button
            className="viewer-btn"
            onClick={() => setReloadCount((c) => c + 1)}
            title="Reload from disk"
          >
            ↻ Reload
          </button>
          {filePath && onOpenAsText && (
            <button
              className="viewer-btn"
              onClick={() => onOpenAsText(filePath)}
              title="Open the raw S-expression source in the text editor"
            >
              Open as text
            </button>
          )}
        </div>
      </div>
      <div className="viewer-body">
        {!filePath && (
          <div className="viewer-message">
            No file associated with this tab — reopen the file from the file tree.
          </div>
        )}
        {loading && <div className="viewer-message">Loading…</div>}
        {error && <div className="viewer-message viewer-error">{error}</div>}
        <div className="kicanvas-container" ref={containerRef} />
      </div>
    </div>
  );
};
