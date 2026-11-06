import type { CSSProperties } from 'react';

// The Recall mark, the same drawing as the web app's apps/web/src/brand/Logo.tsx (keep the two in
// step): an R inside a Swarm-orange hexagon; the R's bowl is an elephant's head (white eye) and
// its leg is the trunk, drawn at 74% for clear space. Colours are fixed in both themes.
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const a11y = title ? { role: 'img' } : { 'aria-hidden': true as const, focusable: 'false' as const };
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" style={{ display: 'block', flex: 'none' }} {...a11y}>
      {title ? <title>{title}</title> : null}
      <path d="M32 3 L57.1 17.5 L57.1 46.5 L32 61 L6.9 46.5 L6.9 17.5 Z" fill="#f47a20" />
      <g transform="translate(32 32.5) scale(.74) translate(-35 -34)">
        <path
          d="M22 48 V16 H33 C40.5 16 44.5 20.5 44.5 26.5 C44.5 32.5 40.5 37 33 37 H22"
          stroke="#101411"
          strokeWidth="9"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M32 37 C39 38.5 42.5 44 42.5 49 C42.5 53 46 54 48.5 51"
          stroke="#101411"
          strokeWidth="9"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="33" cy="26.5" r="3.6" fill="#fff" />
        <circle cx="33.9" cy="26.5" r="1.8" fill="#101411" />
      </g>
    </svg>
  );
}

const WORDMARK: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 };
const WORDMARK_TEXT: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  lineHeight: 1,
  letterSpacing: '-0.01em',
  color: 'var(--text)',
};

// Logo + "Recall" in the display face (styled inline: the popup has no brand stylesheet).
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark" style={WORDMARK}>
      <Logo size={size} />
      <span className="wordmark-text" style={{ ...WORDMARK_TEXT, fontSize: Math.round(size * 0.78) }}>
        Recall
      </span>
    </span>
  );
}
