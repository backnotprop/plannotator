import React, { useState, useRef, useEffect } from 'react';
import { useTheme } from './ThemeProvider';

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Toggle theme"
      >
        {/* Sun */}
        <svg
          className="w-4 h-4 hidden light:block"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        {/* Moon */}
        <svg
          className="w-4 h-4 light:hidden"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-32 rounded-lg border border-border bg-popover shadow-xl z-50 overflow-hidden py-1">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTheme(t); setIsOpen(false); }}
              className={`w-full px-3 py-1.5 text-left text-xs capitalize transition-colors ${
                theme === t
                  ? 'text-primary bg-primary/10 font-medium'
                  : 'text-popover-foreground hover:bg-muted'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
