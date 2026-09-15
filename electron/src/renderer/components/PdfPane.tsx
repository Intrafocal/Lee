/**
 * PdfPane - PDF viewer tab
 *
 * Renders .pdf files with Chromium's built-in PDF viewer (pdfium) inside a
 * <webview> pointed at the file:// URL. The webview is what makes this work:
 * the plugin that backs the viewer is enabled per-webContents, and the
 * renderer's own CSP forbids framing file:// directly.
 *
 * Unlike a browser tab this has no URL bar or history — it is a file viewer,
 * so it only offers reload and an escape hatch to the system PDF app.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

const lee = window.lee;

/** file:// URL with each path segment escaped (spaces, #, ? in filenames) */
function toFileUrl(filePath: string): string {
  return `file://${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

interface PdfPaneProps {
  active: boolean;
  filePath?: string;
}

export const PdfPane: React.FC<PdfPaneProps> = ({ active, filePath }) => {
  const webviewRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleStartLoading = () => {
      setLoading(true);
      setError(null);
    };
    const handleStopLoading = () => setLoading(false);
    const handleFailLoad = (e: any) => {
      // -3 is ERR_ABORTED, fired for ordinary in-page navigations
      if (e.errorCode === -3 || !e.isMainFrame) return;
      setError(`Failed to load PDF: ${e.errorDescription || e.errorCode}`);
      setLoading(false);
    };

    webview.addEventListener('did-start-loading', handleStartLoading);
    webview.addEventListener('did-stop-loading', handleStopLoading);
    webview.addEventListener('did-fail-load', handleFailLoad);
    return () => {
      webview.removeEventListener('did-start-loading', handleStartLoading);
      webview.removeEventListener('did-stop-loading', handleStopLoading);
      webview.removeEventListener('did-fail-load', handleFailLoad);
    };
  }, []);

  const handleReload = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const handleOpenExternally = useCallback(async () => {
    if (!filePath || !lee?.shell) return;
    const message = await lee.shell.openPath(filePath);
    if (message) setError(`Could not open externally: ${message}`);
  }, [filePath]);

  const fileName = filePath?.split('/').pop();

  return (
    <div className={`pdf-pane ${active ? 'active' : ''}`}>
      <div className="viewer-toolbar">
        <span className="viewer-toolbar-title">📄 {fileName ?? 'PDF Viewer'}</span>
        {loading && <span className="viewer-toolbar-info">Loading…</span>}
        <div className="viewer-toolbar-actions">
          <button className="viewer-btn" onClick={handleReload} title="Reload from disk">
            ↻ Reload
          </button>
          {filePath && (
            <button
              className="viewer-btn"
              onClick={handleOpenExternally}
              title="Open in the system's default PDF application"
            >
              Open externally
            </button>
          )}
        </div>
      </div>
      <div className="viewer-body">
        {!filePath ? (
          <div className="viewer-message">
            No file associated with this tab — reopen the file from the file tree.
          </div>
        ) : (
          <>
            {error && <div className="viewer-message viewer-error">{error}</div>}
            <webview
              ref={webviewRef}
              src={toFileUrl(filePath)}
              className="pdf-webview"
              // Own partition: the default session has the renderer CSP headers
              // injected into every response, which the PDF viewer's own
              // resources have no reason to be subject to
              partition="persist:pdfviewer"
              webpreferences="contextIsolation=yes, sandbox=yes"
              // Chromium's built-in PDF viewer ships as a "plugin"
              plugins={true}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default PdfPane;
