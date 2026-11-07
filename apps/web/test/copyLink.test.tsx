// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyLinkButton } from '../src/ui/CopyLinkButton';
import { ToastProvider } from '../src/ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function render() {
  act(() =>
    root.render(
      <ToastProvider>
        <CopyLinkButton />
      </ToastProvider>,
    ),
  );
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Copy link');
  expect(button).toBeDefined();
  return button!;
}

const toastText = () => host.querySelector('[role="status"]')?.textContent ?? '';

describe('CopyLinkButton', () => {
  it('is a secondary button named "Copy link" that copies this page address and says so', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const button = render();
    expect(button.type).toBe('button');
    expect(button.className).toBe('btn btn-secondary');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(toastText()).toBe('Copied');
  });

  it('tells the person to select the address bar when the browser blocks copying', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    const button = render();
    await act(async () => button.click());
    expect(toastText()).toBe('Copy is blocked in this browser. Select the address bar instead.');
  });
});
