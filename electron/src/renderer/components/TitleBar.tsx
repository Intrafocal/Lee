/**
 * TitleBar Component - Custom title bar for frameless window
 */

import React from 'react';

// Get the Lee API from preload
const lee = (window as any).lee;

export const TitleBar: React.FC = () => {
  const isMac = navigator.platform.toLowerCase().includes('mac');

  return (
    <div className="title-bar">
      {/* macOS traffic lights space */}
      {isMac && <div className="traffic-light-space" />}

      <div className="title">Lee</div>

      {/* Windows/Linux window controls */}
      {!isMac && (
        <div className="window-controls">
          <button
            className="window-btn minimize"
            onClick={() => lee.window.minimize()}
            title="Minimize"
          >
            −
          </button>
          <button
            className="window-btn maximize"
            onClick={() => lee.window.maximize()}
            title="Maximize"
          >
            □
          </button>
          <button
            className="window-btn close"
            onClick={() => lee.window.close()}
            title="Close"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};
