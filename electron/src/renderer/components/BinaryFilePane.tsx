/**
 * BinaryFilePane - interstitial for binary files
 *
 * Shown when a file with no dedicated viewer contains a NUL byte in its
 * first 8KB (git's binary heuristic), instead of dumping mojibake into the
 * editor. Shows file info and a hex preview of the first 4KB, with an
 * explicit escape hatch to open as text anyway.
 */

import React, { useEffect, useState } from 'react';

const lee = (window as any).lee;

const PREVIEW_BYTES = 4096;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

interface HexRow {
  offset: string;
  hex: string;
  ascii: string;
}

function toHexRows(bytes: Uint8Array): HexRow[] {
  const rows: HexRow[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(slice, (b) =>
      b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'
    ).join('');
    rows.push({ offset: i.toString(16).padStart(8, '0'), hex, ascii });
  }
  return rows;
}

interface BinaryFilePaneProps {
  active: boolean;
  filePath?: string;
  onOpenAsText?: (filePath: string) => void;
}

export const BinaryFilePane: React.FC<BinaryFilePaneProps> = ({ active, filePath, onOpenAsText }) => {
  const [rows, setRows] = useState<HexRow[]>([]);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath || !lee) return;
    let cancelled = false;
    (async () => {
      try {
        const chunk = await lee.fs.readFileChunkBase64(filePath, PREVIEW_BYTES);
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0));
        setRows(toHexRows(bytes));
        setFileSize(chunk.size);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const fileName = filePath?.split('/').pop();
  const truncated = fileSize !== null && fileSize > PREVIEW_BYTES;

  return (
    <div className={`binary-pane ${active ? 'active' : ''}`}>
      <div className="viewer-toolbar">
        <span className="viewer-toolbar-title">📦 {fileName ?? 'Binary file'}</span>
        {fileSize !== null && (
          <span className="viewer-toolbar-info">{formatSize(fileSize)} · binary</span>
        )}
        <div className="viewer-toolbar-actions">
          {filePath && onOpenAsText && (
            <button
              className="viewer-btn"
              onClick={() => onOpenAsText(filePath)}
              title="Open in the text editor anyway (may render garbled)"
            >
              Open as text anyway
            </button>
          )}
        </div>
      </div>
      <div className="viewer-body">
        {error ? (
          <div className="viewer-message viewer-error">{error}</div>
        ) : (
          <div className="binary-hex-view">
            <div className="binary-hex-note">
              This file looks binary (contains NUL bytes), so it isn't shown in the editor.
              {truncated && ` Previewing the first ${formatSize(PREVIEW_BYTES)} of ${formatSize(fileSize!)}.`}
            </div>
            <table className="binary-hex-table">
              <tbody>
                {rows.map((row) => (
                  <tr key={row.offset}>
                    <td className="hex-offset">{row.offset}</td>
                    <td className="hex-bytes">{row.hex}</td>
                    <td className="hex-ascii">{row.ascii}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
