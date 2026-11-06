import type { CSSProperties } from 'react';
import './brand.css';

// The Recall mark: an R inside a Swarm-orange hexagon. The R's bowl is an elephant's head (white
// eye) and its leg is the trunk. The R is drawn at 74% so it has clear space at every size.
// Colours are fixed: the same orange, ink and white in both themes (spec 5.1).
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const a11y = title ? { role: 'img' } : { 'aria-hidden': true as const, focusable: 'false' as const };
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" {...a11y}>
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

// Logo + "Recall" in the display face. The text is real text, so the lockup reads as "Recall".
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ '--wordmark-size': `${size}px` } as CSSProperties}>
      <Logo size={size} />
      <span className="wordmark-text">Recall</span>
    </span>
  );
}
