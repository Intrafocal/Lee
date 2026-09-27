/**
 * FilesSection - Library's Files tab (cockpit-design §5; package R2): the
 * workspace's files, filtered by Library's find.
 *
 * Same data sources as Manual's FileTreePane (window.lee.fs.readdir,
 * and the main-process directory watch: watchDir/unwatchDir/onDirChanged),
 * rendered as flat rows so the Cockpit keymap drives it: j/k move, Enter
 * opens a file or expands/collapses a directory. Opening a file goes through
 * Manual's own open-file path (App.handleFileOpen, so viewers such as
 * KiCad/PDF/model tabs route the same way) and switches to Manual.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../Icon';
import { flattenFileTree, type FileEntryLite } from '../../../lib/cockpitModel';
import { QuietLinks } from '../ui';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

function lee() {
  return typeof window !== 'undefined' ? window.lee : undefined;
}

export const FilesSection: React.FC<{ ctx: CockpitCtx; filter: string }> = ({ ctx, filter }) => {
  const workspace = ctx.workspace;
  const [root, setRoot] = useState<FileEntryLite[] | null>(null);
  const [children, setChildren] = useState<Map<string, FileEntryLite[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    const api = lee();
    if (!workspace || !api) return;
    try {
      setRoot(await api.fs.readdir(workspace));
      setError(null);
    } catch {
      setError('Could not read the workspace');
    }
  }, [workspace]);

  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    void loadRoot();
  }, [loadRoot]);

  // Watch the root and each expanded directory while the section is shown.
  const watched = useRef<Set<string>>(new Set());
  useEffect(() => {
    const api = lee();
    if (!api || !workspace) return;
    const want = new Set([workspace, ...expanded]);
    for (const d of want) if (!watched.current.has(d)) {
      api.fs.watchDir(d);
      watched.current.add(d);
    }
    for (const d of [...watched.current]) if (!want.has(d)) {
      api.fs.unwatchDir(d);
      watched.current.delete(d);
    }
  }, [workspace, expanded]);
  useEffect(() => {
    const set = watched.current;
    return () => {
      const api = lee();
      if (api) for (const d of set) api.fs.unwatchDir(d);
      set.clear();
    };
  }, []);
  useEffect(() => {
    const api = lee();
    if (!api) return;
    return api.fs.onDirChanged(({ path }: { path: string }) => {
      if (path === workspace) {
        void loadRoot();
        return;
      }
      api.fs
        .readdir(path)
        .then((list: FileEntryLite[]) => setChildren((prev) => (prev.has(path) ? new Map(prev).set(path, list) : prev)))
        .catch(() => undefined);
    });
  }, [workspace, loadRoot]);

  const toggle = useCallback(
    async (dir: string) => {
      if (expanded.has(dir)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(dir);
          return next;
        });
        return;
      }
      const api = lee();
      if (!children.has(dir) && api) {
        try {
          const list = await api.fs.readdir(dir);
          setChildren((prev) => new Map(prev).set(dir, list));
        } catch {
          ctx.notify('Could not read that folder', 'error');
          return;
        }
      }
      setExpanded((prev) => new Set(prev).add(dir));
    },
    [expanded, children, ctx],
  );

  const rows = useMemo(() => flattenFileTree(root ?? [], children, expanded, filter), [root, children, expanded, filter]);
  const rel = (p: string) => (p.startsWith(`${workspace}/`) ? p.slice(workspace.length + 1) : p);

  const handles: RowHandle[] = rows.map((r) => ({
    id: `file:${r.entry.path}`,
    title: rel(r.entry.path),
    open: () => (r.entry.type === 'directory' ? void toggle(r.entry.path) : ctx.openFile(r.entry.path)),
  }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;

  return (
    <div className="library-tab">
      {error && <div className="library-hint">{error}</div>}
      {!root && !error && <div className="library-hint">Loading…</div>}
      {root && rows.length === 0 && <p className="library-hint">{filter ? `No loaded file matches “${filter}”` : 'Empty workspace'}</p>}
      <div className="library-files">
        {rows.map((r, i) => {
          const isDir = r.entry.type === 'directory';
          const id = handles[i].id;
          return (
            <div
              key={r.entry.path}
              data-cockpit-row={id}
              className={`library-file${sel?.kind === 'row' && sel.id === id ? ' is-selected' : ''}`}
              style={{ paddingLeft: 8 + r.depth * 14 }}
              title={rel(r.entry.path)}
              onClick={() => {
                ctx.selectRow(id);
                if (isDir) void toggle(r.entry.path);
              }}
              onDoubleClick={() => !isDir && ctx.openFile(r.entry.path)}
            >
              <Icon name={isDir ? (r.expanded ? 'folder-open' : 'folder') : 'file-code'} size={12} />
              <span className="library-file-name">{r.entry.name}</span>
              {!isDir && (
                <button
                  type="button"
                  className="library-file-open"
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.openFile(r.entry.path);
                  }}
                >
                  Open in Manual
                </button>
              )}
            </div>
          );
        })}
      </div>
      <QuietLinks items={[{ label: 'Refresh', onClick: () => void loadRoot() }]} />
    </div>
  );
};

export default FilesSection;
