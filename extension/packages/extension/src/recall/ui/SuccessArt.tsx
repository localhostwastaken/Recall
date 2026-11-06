import './popupExtras.css';

// The success moment of a verified capture (spec 5.2 and 12.5): the duo's elephant head, trunk
// raised, holding a receipt with a green check. Static, decorative (the notice beside it says
// what happened), CSS fade-in only. Drawn from apps/web/src/brand/Duo.tsx with the same
// proportions; skin tones come from --art-* in popupExtras.css (they follow the theme), the
// check uses --pass on --pass-bg so it reads on the green notice in both themes.

const ORANGE = '#f47a20';
const INK = '#101411';
const PAPER = '#fff';

export function SuccessArt() {
  return (
    <svg
      className="popup-success-art"
      data-testid="popup-success-art"
      viewBox="-42 8 254 200"
      width="80"
      height="63"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="112" cy="138" r="64" fill="var(--art-skin)" />
      <path d="M138 90 C198 76 220 150 184 188 C168 204 146 198 140 182 C152 150 152 118 138 90Z" fill="var(--art-skin-2)" />
      <path d="M146 104 C186 98 198 146 176 172 C166 182 156 178 152 170 C160 146 158 124 146 104Z" fill="var(--art-ear-in)" opacity=".45" />
      <ellipse cx="90" cy="126" rx="7.5" ry="9.5" fill={INK} />
      <circle cx="93" cy="122" r="2.8" fill={PAPER} />
      <path d="M78 112 q10 -7 20 -2" stroke="var(--art-skin-3)" strokeWidth="3" fill="none" strokeLinecap="round" />
      <ellipse cx="102" cy="150" rx="10" ry="6" fill={ORANGE} opacity=".28" />
      <path d="M66 172 q-14 9 -24 0" stroke={PAPER} strokeWidth="7" fill="none" strokeLinecap="round" />
      <path d="M84 170 q9 7 18 0" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M70 154 C40 160 26 140 30 112" stroke="var(--art-skin)" strokeWidth="28" fill="none" strokeLinecap="round" />
      <path d="M30 114 C33 92 26 76 12 70" stroke="var(--art-skin)" strokeWidth="19" fill="none" strokeLinecap="round" />
      <g stroke="var(--art-skin-2)" strokeWidth="2.2" strokeLinecap="round">
        <path d="M22 128 h17" />
        <path d="M21 116 h16" />
        <path d="M22 104 h13" />
      </g>
      <g transform="translate(-36 28) rotate(-12)">
        <rect y="3" width="68" height="50" rx="8" fill="var(--art-receipt-shadow)" />
        <rect width="68" height="50" rx="8" fill={PAPER} />
        <rect x="9" y="10" width="20" height="5" rx="2.5" fill={INK} opacity=".75" />
        <rect x="9" y="21" width="22" height="3.5" rx="1.75" fill={INK} opacity=".28" />
        <rect x="9" y="29" width="15" height="3.5" rx="1.75" fill={INK} opacity=".28" />
        <circle cx="49" cy="27" r="15" fill="var(--pass)" />
        <path
          d="M42 27.5 l4.6 4.8 l9 -9.6"
          stroke="var(--pass-bg)"
          strokeWidth="4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
