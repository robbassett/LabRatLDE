import { useId } from 'react';

// The LabRat mark (SPEC-025-R31), redrawn from docs/logo.jpg on a 100-unit grid:
// circles, quarter-circles and a square frame in the mark's four colours. The
// navy shapes use currentColor, so they lighten in the dark theme (.mark sets
// color: var(--mark-ink)). web/src/assets/favicon.svg holds the same geometry.
export const MARK_TEAL = '#3A7B7D';
export const MARK_BLUE = '#A7C2D3';
export const MARK_AQUA = '#ACCECD';

export default function LabRatMark({ size = 24, title }: { size?: number; title?: string }) {
  const clip = useId();
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <clipPath id={clip}>
        <rect width="100" height="100" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <circle cx="92" cy="28" r="42" fill={MARK_BLUE} />
        <rect x="0" y="71.5" width="44" height="28.5" fill={MARK_TEAL} />
        <path d="M51.5 13C60 9 80 8 95 28L98 50L70 72L19.5 72C20 68 24 66.5 27 64C31.5 61 33 53 28 49L30 45Z" fill={MARK_TEAL} />
        <circle cx="24.8" cy="12.1" r="9.4" fill="currentColor" />
        <circle cx="39.5" cy="33" r="15.5" fill="currentColor" />
        <ellipse cx="21" cy="31" rx="21" ry="12.5" transform="rotate(-22 21 31)" fill={MARK_TEAL} />
        <circle cx="39.2" cy="15.1" r="12" fill={MARK_BLUE} />
        <path d="M27.3 27.5V15.2A12.3 12.3 0 0 1 39.6 27.5Z" fill="currentColor" />
        <circle cx="72.2" cy="46.4" r="21.2" fill={MARK_BLUE} />
        <path d="M75.2 21.4A25 25 0 1 1 53.55 58.9L59.6 55.4A18 18 0 1 0 75.2 28.4Z" fill="currentColor" />
        <circle cx="44.4" cy="73.2" r="26" fill={MARK_AQUA} />
      </g>
    </svg>
  );
}
