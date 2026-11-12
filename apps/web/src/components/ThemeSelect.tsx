import { useId } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { themeModes, useTheme, type ThemeMode } from '../lib/theme';
import { Panel } from './common';

const icons = { light: Sun, dark: Moon, system: Monitor };

export function ThemeSelect({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const { mode, saving, selectMode } = useTheme();
  const Icon = icons[mode];
  return (
    <div
      className={compact ? 'theme-select-compact' : 'block w-full max-w-64'}
      title={compact ? 'Theme' : undefined}
    >
      {compact ? (
        <Icon size={18} aria-hidden="true" />
      ) : (
        <label className="field-label" htmlFor={id}>
          Theme
        </label>
      )}
      <select
        id={id}
        aria-label={compact ? 'Theme' : undefined}
        className={compact ? undefined : 'input'}
        value={mode}
        disabled={saving}
        onChange={(event) => selectMode(event.target.value as ThemeMode)}
      >
        {Object.entries(themeModes).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AppearanceSettings({ className }: { className?: string }) {
  return (
    <Panel title="Appearance" className={className}>
      <div className="settings-body">
        <ThemeSelect />
        <p className="mt-2 text-xs text-stone-600">
          System Default follows this device’s light or dark setting.
        </p>
      </div>
    </Panel>
  );
}
