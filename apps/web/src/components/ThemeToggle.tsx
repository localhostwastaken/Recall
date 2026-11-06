import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme';

/**
 * A round icon button in the header: shows the icon of the theme you would switch to (moon in
 * the light theme, sun in the dark one). The choice is remembered by `setTheme`.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button type="button" className="round-btn" aria-label={label} title={label} onClick={() => setTheme(next)}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
