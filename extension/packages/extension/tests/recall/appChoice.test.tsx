import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The stylesheets go through the build's PostCSS pipeline, which a unit test does not need.
vi.mock('../../src/recall/ui/settings.css', () => ({}));
vi.mock('../../src/entries/Popup/settingsAdvanced.css', () => ({}));
// lucide-react resolves its own copy of React from the workspace root; the icon is decoration here.
vi.mock('lucide-react', () => ({ ChevronDown: () => null }));

import { SettingsPanel } from '../../src/entries/Popup/SettingsPanel';
import { SETTINGS_KEY, defaultSettings } from '../../src/recall/settings';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGES = 'https://localhostwastaken.github.io/Recall/app/';
const SWARM = 'https://recallapp.eth.limo/';

let stored: Record<string, unknown>;
let host: HTMLDivElement;
let root: Root;

const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

async function renderPanel(appUrl: string) {
  stored = { [SETTINGS_KEY]: { ...defaultSettings('live'), appUrl } };
  const local = chrome.storage.local as unknown as Record<string, ReturnType<typeof vi.fn>>;
  local.get.mockImplementation(async (key: string) =>
    key in stored ? { [key]: stored[key] } : {},
  );
  local.set.mockImplementation(async (items: Record<string, unknown>) => {
    Object.assign(stored, items);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsPanel />));
  await flush();
}

const radio = (name: RegExp) =>
  [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) =>
    name.test(r.closest('label')?.textContent ?? ''),
  )!;
const appUrlInput = () => {
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent === 'App URL')!;
  return host.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
};
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('the popup settings: Recall app choice', () => {
  beforeEach(() => {
    (globalThis.chrome as unknown as { permissions: unknown }).permissions = {
      request: vi.fn(async () => true),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows GitHub Pages checked for the default app, Swarm unchecked', async () => {
    await renderPanel(PAGES);
    expect(host.textContent).toContain('Recall app');
    expect(radio(/^GitHub Pages \(default\)/).checked).toBe(true);
    expect(radio(/^Swarm \(recallapp\.eth\.limo\)/).checked).toBe(false);
    expect(appUrlInput().value).toBe(PAGES);
  });

  it('picking Swarm fills in App URL and saves it; picking GitHub Pages goes back', async () => {
    await renderPanel(PAGES);
    await act(async () => radio(/^Swarm/).click());
    expect(appUrlInput().value).toBe(SWARM);
    expect(radio(/^Swarm/).checked).toBe(true);
    await act(async () => button('Save settings').click());
    await flush();
    expect((stored[SETTINGS_KEY] as { appUrl: string }).appUrl).toBe(SWARM);

    await act(async () => radio(/^GitHub Pages/).click());
    expect(appUrlInput().value).toBe(PAGES);
    await act(async () => button('Save settings').click());
    await flush();
    expect((stored[SETTINGS_KEY] as { appUrl: string }).appUrl).toBe(PAGES);
  });

  it('a custom App URL leaves neither choice checked and says so', async () => {
    await renderPanel('https://my-recall.example/');
    expect(radio(/^GitHub Pages/).checked).toBe(false);
    expect(radio(/^Swarm/).checked).toBe(false);
    expect(host.textContent).toContain('A custom address is set in App URL below.');
  });
});
