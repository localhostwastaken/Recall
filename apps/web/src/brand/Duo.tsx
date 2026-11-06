import { useId } from 'react';
import './brand.css';

// The duo (spec 5.2): an owl (the witness: watches and signs) riding an elephant (the memory:
// keeps the receipt). Flat SVG, no outlines. Skin tones come from the --duo-* variables in
// brand.css (they follow the theme); the sponsor colours below are fixed.
//
// Stable hooks for the motion code (do not rename): .duo-owl-pupil (x2), .duo-owl-lid (x2, rects
// that start at height 0), #duo-seal-arm, .duo-cloth-hex, #duo-receipt-check, #duo-trunk,
// #duo-ear, #duo-eye, #duo-tail, #duo-owl. The duo renders at most once per page, so the hook ids
// are plain; only the clip path id is per instance.

const ORANGE = '#f47a20';
const CLOTH_HEX = '#b8480f';
const LIME = '#def4b6';
const TASSEL = '#f7c873';
const INK = '#101411';
const PAPER = '#fff';

const CLOTH = 'M148 126 Q196 108 252 128 L256 198 Q202 218 146 198 Z';
const HEX = 'M0 -6 L5.2 -3 L5.2 3 L0 6 L-5.2 3 L-5.2 -3Z';

// Swarm chunks on the saddle cloth: a staggered grid (17 across, 15 down), clipped to the cloth
// (edge cells that would show only as slivers are left out). Written out once; [x, y, lime].
const CLOTH_HEXES: ReadonlyArray<readonly [number, number, 0 | 1]> = [
  [154, 126, 0], [171, 126, 0], [188, 126, 0], [205, 126, 0], [222, 126, 0], [239, 126, 0],
  [162.5, 141, 0], [179.5, 141, 0], [196.5, 141, 1], [213.5, 141, 0], [230.5, 141, 0], [247.5, 141, 0],
  [154, 156, 0], [171, 156, 0], [188, 156, 0], [205, 156, 0], [222, 156, 0], [239, 156, 1],
  [162.5, 171, 0], [179.5, 171, 1], [196.5, 171, 0], [213.5, 171, 0], [230.5, 171, 0], [247.5, 171, 0],
  [154, 186, 0], [171, 186, 0], [188, 186, 0], [205, 186, 1], [222, 186, 0], [239, 186, 0],
  [162.5, 201, 0], [179.5, 201, 0], [196.5, 201, 0], [213.5, 201, 0], [230.5, 201, 0], [247.5, 201, 0],
];

// Tassels hanging along the cloth's gold fringe.
const TASSELS: ReadonlyArray<readonly [number, number]> = [
  [146, 204], [164.3, 209], [182.7, 212.7], [201, 214], [219.3, 212.7], [237.7, 209], [256, 204],
];

export const DUO_LABEL =
  'A small owl riding an elephant. The owl stamps a seal; the elephant holds up a verified receipt.';

export function Duo({ className }: { className?: string }) {
  const clipId = `duo-cloth-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      className={className ? `duo ${className}` : 'duo'}
      viewBox="-60 -20 400 300"
      role="img"
      aria-label={DUO_LABEL}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={CLOTH} />
        </clipPath>
      </defs>
      <ellipse cx="170" cy="262" rx="118" ry="11" fill="var(--duo-shadow)" />

      <g id="duo-tail">
        <path d="M266 168 C282 178 286 196 280 212" stroke="var(--duo-skin-2)" strokeWidth="6" fill="none" strokeLinecap="round" />
        <path d="M280 210 l-6 12 l10 -4 l2 10 l4 -14z" fill="var(--duo-skin-3)" />
      </g>

      {/* far legs */}
      <rect x="214" y="200" width="36" height="58" rx="15" fill="var(--duo-skin-2)" />
      <rect x="146" y="204" width="36" height="54" rx="15" fill="var(--duo-skin-2)" />

      <g id="duo-body">
        <ellipse cx="198" cy="178" rx="82" ry="62" fill="var(--duo-skin)" />
        <ellipse cx="208" cy="214" rx="60" ry="22" fill="var(--duo-skin-2)" opacity=".35" />
        {/* saddle cloth of Swarm hexagons */}
        <path d={CLOTH} fill={ORANGE} />
        <g clipPath={`url(#${clipId})`}>
          {CLOTH_HEXES.map(([x, y, lime]) => (
            <g key={`${x},${y}`} transform={`translate(${x} ${y})`}>
              <path className="duo-cloth-hex" d={HEX} fill={lime ? LIME : CLOTH_HEX} />
            </g>
          ))}
        </g>
        <path d="M146 198 Q202 218 256 198" stroke={TASSEL} strokeWidth="5" fill="none" strokeLinecap="round" />
        <g id="duo-tassels" fill={TASSEL}>
          {TASSELS.map(([cx, cy]) => (
            <ellipse key={cx} className="duo-tassel" cx={cx} cy={cy} rx="3.4" ry="5" />
          ))}
        </g>
      </g>

      {/* near legs and toenails */}
      <rect x="234" y="206" width="36" height="54" rx="15" fill="var(--duo-skin)" />
      <rect x="168" y="208" width="38" height="52" rx="15" fill="var(--duo-skin)" />
      <g fill={PAPER} opacity=".75">
        <ellipse cx="180" cy="256" rx="5" ry="3" />
        <ellipse cx="194" cy="256" rx="5" ry="3" />
        <ellipse cx="246" cy="256" rx="5" ry="3" />
        <ellipse cx="259" cy="256" rx="5" ry="3" />
      </g>

      <g id="duo-head">
        <circle cx="112" cy="138" r="64" fill="var(--duo-skin)" />
        <g id="duo-ear">
          <path d="M138 90 C198 76 220 150 184 188 C168 204 146 198 140 182 C152 150 152 118 138 90Z" fill="var(--duo-skin-2)" />
          <path d="M146 104 C186 98 198 146 176 172 C166 182 156 178 152 170 C160 146 158 124 146 104Z" fill="var(--duo-ear-in)" opacity=".45" />
        </g>
        <g id="duo-eye">
          <ellipse cx="90" cy="126" rx="7.5" ry="9.5" fill={INK} />
          <circle cx="93" cy="122" r="2.8" fill={PAPER} />
        </g>
        <path d="M78 112 q10 -7 20 -2" stroke="var(--duo-skin-3)" strokeWidth="3" fill="none" strokeLinecap="round" />
        <ellipse cx="102" cy="150" rx="10" ry="6" fill={ORANGE} opacity=".28" />
        {/* tusk and smile */}
        <path d="M66 172 q-14 9 -24 0" stroke={PAPER} strokeWidth="7" fill="none" strokeLinecap="round" />
        <path d="M84 170 q9 7 18 0" stroke={INK} strokeWidth="2.6" fill="none" strokeLinecap="round" />

        <g id="duo-trunk">
          <path d="M70 154 C40 160 26 140 30 112" stroke="var(--duo-skin)" strokeWidth="28" fill="none" strokeLinecap="round" />
          <path d="M30 114 C33 92 26 76 12 70" stroke="var(--duo-skin)" strokeWidth="19" fill="none" strokeLinecap="round" />
          <g stroke="var(--duo-skin-2)" strokeWidth="2.2" strokeLinecap="round">
            <path d="M22 128 h17" />
            <path d="M21 116 h16" />
            <path d="M22 104 h13" />
            <path d="M19 92 h12" />
          </g>
          <g id="duo-receipt" transform="translate(-36 28) rotate(-12)">
            {/* a flat offset shadow, so the white card still reads on the light page */}
            <rect y="3" width="68" height="50" rx="8" fill="var(--duo-receipt-shadow)" />
            <rect width="68" height="50" rx="8" fill={PAPER} />
            <rect x="9" y="10" width="30" height="5" rx="2.5" fill={INK} opacity=".75" />
            <rect x="9" y="20" width="40" height="3.5" rx="1.75" fill={INK} opacity=".28" />
            <rect x="9" y="28" width="26" height="3.5" rx="1.75" fill={INK} opacity=".28" />
            <g id="duo-receipt-check" transform="translate(52 36)">
              {/* Grey until a check really passed: the page sets --duo-check (spec 4.2). */}
              <circle r="10" fill="var(--duo-check, var(--na))" />
              <path d="M-4.5 0 l3 3.2 l6 -6.5" stroke={PAPER} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
        </g>
      </g>

      {/* the owl, perched on the elephant's head */}
      <g id="duo-owl" transform="translate(122 80)">
        <g id="duo-owl-in">
          <path d="M-26 -64 L-31 -90 L-11 -72Z M26 -64 L31 -90 L11 -72Z" fill="var(--duo-owl)" />
          <ellipse cx="0" cy="-38" rx="34" ry="40" fill="var(--duo-owl)" />
          <ellipse cx="0" cy="-22" rx="21" ry="22" fill="var(--duo-owl-belly)" />
          <g stroke="var(--duo-owl)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".55">
            <path d="M-9 -24 l3 3 l3 -3" />
            <path d="M3 -24 l3 3 l3 -3" />
            <path d="M-3 -13 l3 3 l3 -3" />
          </g>
          <path d="M-33 -44 C-46 -28 -42 -10 -26 -5 C-31 -20 -30 -32 -33 -44Z" fill="var(--duo-owl-2)" />
          <circle cx="-13" cy="-52" r="16" fill="var(--duo-owl-face)" />
          <circle cx="13" cy="-52" r="16" fill="var(--duo-owl-face)" />
          <circle cx="-13" cy="-52" r="11.5" fill={PAPER} stroke={ORANGE} strokeWidth="3.5" />
          <circle cx="13" cy="-52" r="11.5" fill={PAPER} stroke={ORANGE} strokeWidth="3.5" />
          <circle className="duo-owl-pupil" cx="-13" cy="-52" r="5.2" fill={INK} />
          <circle className="duo-owl-pupil" cx="13" cy="-52" r="5.2" fill={INK} />
          <g fill="var(--duo-owl)">
            <rect className="duo-owl-lid" x="-25" y="-64" width="24" height="0" />
            <rect className="duo-owl-lid" x="1" y="-64" width="24" height="0" />
          </g>
          <path d="M-4.5 -42 L4.5 -42 L0 -32Z" fill={ORANGE} />
          <g fill={ORANGE}>
            <ellipse cx="-11" cy="-1" rx="6" ry="3" />
            <ellipse cx="11" cy="-1" rx="6" ry="3" />
          </g>
        </g>
        {/* raised wing holding the hexagon seal */}
        <g id="duo-seal-arm">
          <path d="M24 -52 C38 -64 50 -74 54 -78 C60 -66 52 -48 34 -34 C28 -32 24 -40 24 -52Z" fill="var(--duo-owl-2)" />
          <g id="duo-seal" transform="translate(56 -88)">
            <path d="M0 -14 L12 -7 L12 7 L0 14 L-12 7 L-12 -7Z" fill={ORANGE} />
            <path d="M-5 0 l3.5 3.5 l7 -7.5" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </g>
      </g>
    </svg>
  );
}
