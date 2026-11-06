// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { pageTitle } from '../src/library/title';

const enc = (s: string) => new TextEncoder().encode(s);

describe('pageTitle', () => {
  it('reads the title as plain text, markup and all, without touching the document', () => {
    const before = document.body.innerHTML;
    expect(pageTitle(enc('<html><head><title> Hello <b>x</b> </title></head></html>'), 'text/html')).toBe('Hello <b>x</b>');
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('b')).toBeNull();
  });

  it('collapses whitespace and caps the length at 120 characters plus an ellipsis', () => {
    expect(pageTitle(enc('<title>a\n\n   b\tc</title>'), 'text/html; charset=utf-8')).toBe('a b c');
    const t = pageTitle(enc(`<title>${'x'.repeat(10_000)}</title>`), 'text/html')!;
    expect(t).toHaveLength(121);
    expect(t.endsWith('…')).toBe(true);
  });

  it('drops bidi controls and never cuts a character in half', () => {
    expect(pageTitle(enc('<title>a\u202Eevil\u2066b\u2069</title>'), 'text/html')).toBe('aevilb');
    const t = pageTitle(enc(`<title>${'😀'.repeat(200)}</title>`), 'text/html')!;
    expect(Array.from(t)).toHaveLength(121);
    expect(t.endsWith('😀…')).toBe(true);
  });

  it('is null for an empty title or a body that is not HTML', () => {
    expect(pageTitle(enc('<title>   </title>'), 'text/html')).toBeNull();
    expect(pageTitle(enc('<p>no title</p>'), 'text/html')).toBeNull();
    expect(pageTitle(enc('{"title":"x"}'), 'application/json')).toBeNull();
    expect(pageTitle(enc('%PDF-1.4'), 'application/pdf')).toBeNull();
  });

  it('never runs a script in the captured body', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    pageTitle(enc('<title>t</title><script>alert(1)</script><img src=x onerror="alert(2)">'), 'text/html');
    expect(alert).not.toHaveBeenCalled();
  });
});
