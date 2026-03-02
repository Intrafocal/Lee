/**
 * WorkspaceModal - Select a workspace/folder on startup
 */

import React, { useState, useEffect } from 'react';

const lee = (window as any).lee;

interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: number;
}

interface WorkspaceModalProps {
  onSelect: (workspace: string) => void;
  onSkip: () => void;
  onOpenInNewWindow?: (workspace: string) => void;
}

export const WorkspaceModal: React.FC<WorkspaceModalProps> = ({ onSelect, onSkip, onOpenInNewWindow }) => {
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);

  useEffect(() => {
    // Load recent workspaces from localStorage
    const stored = localStorage.getItem('lee:recentWorkspaces');
    if (stored) {
      try {
        const workspaces = JSON.parse(stored) as RecentWorkspace[];
        // Sort by lastOpened, most recent first
        workspaces.sort((a, b) => b.lastOpened - a.lastOpened);
        setRecentWorkspaces(workspaces.slice(0, 5)); // Keep top 5
      } catch (e) {
        console.error('Failed to parse recent workspaces:', e);
      }
    }
  }, []);

  const handleBrowse = async () => {
    if (!lee) return;

    try {
      const result = await lee.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Workspace Folder',
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        saveRecentWorkspace(selectedPath);
        onSelect(selectedPath);
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error);
    }
  };

  const handleSelectRecent = (workspace: RecentWorkspace) => {
    saveRecentWorkspace(workspace.path);
    onSelect(workspace.path);
  };

  const saveRecentWorkspace = (path: string) => {
    const name = path.split('/').pop() || path;
    const newWorkspace: RecentWorkspace = {
      path,
      name,
      lastOpened: Date.now(),
    };

    // Update recent workspaces
    const stored = localStorage.getItem('lee:recentWorkspaces');
    let workspaces: RecentWorkspace[] = stored ? JSON.parse(stored) : [];

    // Remove if already exists
    workspaces = workspaces.filter((w) => w.path !== path);

    // Add to front
    workspaces.unshift(newWorkspace);

    // Keep only 10
    workspaces = workspaces.slice(0, 10);

    localStorage.setItem('lee:recentWorkspaces', JSON.stringify(workspaces));
  };

  return (
    <div className="workspace-modal-overlay">
      <div className="workspace-modal">
        <div className="workspace-modal-header">
          <h2>Select Workspace</h2>
          <p>Choose a folder to work in</p>
        </div>

        <div className="workspace-modal-content">
          {recentWorkspaces.length > 0 && (
            <div className="recent-workspaces">
              <h3>Recent</h3>
              <div className="workspace-list">
                {recentWorkspaces.map((workspace) => (
                  <div key={workspace.path} className="workspace-item-row">
                    <button
                      className="workspace-item"
                      onClick={() => handleSelectRecent(workspace)}
                    >
                      <span className="workspace-icon">📁</span>
                      <div className="workspace-info">
                        <span className="workspace-name">{workspace.name}</span>
                        <span className="workspace-path">{workspace.path}</span>
                      </div>
                    </button>
                    {onOpenInNewWindow && (
                      <button
                        className="workspace-new-window-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          saveRecentWorkspace(workspace.path);
                          onOpenInNewWindow(workspace.path);
                        }}
                        title="Open in New Window"
                      >
                        ⧉
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="workspace-actions">
            <button className="workspace-browse-btn" onClick={handleBrowse}>
              <span className="btn-icon">📂</span>
              Browse for Folder...
            </button>
          </div>
        </div>

        <div className="workspace-modal-footer">
          <button className="workspace-skip-btn" onClick={onSkip}>
            Skip (use current directory)
          </button>
        </div>
      </div>
    </div>
  );
};
