import React, { useState } from 'react';
import {
  getFileBrowserSettings,
  saveFileBrowserSettings,
  type FileBrowserSettings,
} from '../../utils/fileBrowser';
import { ToggleSwitch } from './shared';

export const FilesTab: React.FC = () => {
  const [settings, setSettings] = useState<FileBrowserSettings>(() => getFileBrowserSettings());
  const [newDirPath, setNewDirPath] = useState('');

  const handleChange = (updates: Partial<FileBrowserSettings>) => {
    const next = { ...settings, ...updates };
    setSettings(next);
    saveFileBrowserSettings(next);
  };

  const addDirectory = () => {
    const trimmed = newDirPath.trim();
    if (!trimmed || settings.directories.includes(trimmed)) return;
    handleChange({ directories: [...settings.directories, trimmed] });
    setNewDirPath('');
  };

  return (
    <div className="space-y-5">
      <ToggleSwitch
        checked={settings.enabled}
        onChange={(v) => handleChange({ enabled: v })}
        label="File Browser"
        description="Your project files are shown automatically. Add extra directories below."
      />

      {settings.enabled && (
        <>
          <div className="border-t border-border" />

          {settings.directories.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Directories</label>
              {settings.directories.map((dir) => (
                <div key={dir} className="flex items-center gap-2 group">
                  <div className="flex-1 px-3 py-2 bg-muted rounded-lg text-xs font-mono truncate" title={dir}>
                    {dir}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleChange({ directories: settings.directories.filter((d) => d !== dir) })}
                    className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    title="Remove directory"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Add Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newDirPath}
                onChange={(e) => setNewDirPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addDirectory(); }}
                placeholder="/path/to/directory"
                className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              <button
                type="button"
                onClick={addDirectory}
                disabled={!newDirPath.trim()}
                className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-50"
              >
                Add
              </button>
            </div>
            <div className="text-[10px] text-muted-foreground">
              Add directories outside your project that contain markdown files.
            </div>
          </div>
        </>
      )}
    </div>
  );
};
