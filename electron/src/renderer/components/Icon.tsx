/**
 * Icon - inline SVG icon renderer for the Phosphor icon set.
 *
 * Renders stroke icons from icons/iconData.generated.ts on a 24x24 grid,
 * and the Hester hare silhouette (filled, with an optional eye cutout).
 */

import React, { useId } from 'react';
import { strokeIcons, hesterGlyph, type IconName } from '../icons/iconData.generated';

export type { IconName };

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  title?: string;
}

export const Icon: React.FC<IconProps> = ({ name, size = 16, strokeWidth, className, title }) => {
  const sw = strokeWidth ?? (size <= 16 ? 2 : 1.75);
  const d = strokeIcons[name];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
};

interface HesterGlyphProps {
  size?: number;
  eye?: boolean;
  className?: string;
  title?: string;
}

const HESTER_WIDTH = 520;
const HESTER_HEIGHT = 710;

export const HesterGlyph: React.FC<HesterGlyphProps> = ({ size = 16, eye, className, title }) => {
  const cutEye = eye ?? size >= 24;
  const width = (size * HESTER_WIDTH) / HESTER_HEIGHT;
  const rawId = useId();
  const maskId = `hester-eye-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { viewBox, paths, eye: eyeRect } = hesterGlyph;
  const [vbX, vbY, vbW, vbH] = viewBox.split(' ').map(Number);

  return (
    <svg
      width={width}
      height={size}
      viewBox={viewBox}
      className={className}
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {title ? <title>{title}</title> : null}
      {cutEye ? (
        <>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={vbX} y={vbY} width={vbW} height={vbH}>
            <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="white" />
            <rect x={eyeRect.x} y={eyeRect.y} width={eyeRect.width} height={eyeRect.height} fill="black" />
          </mask>
          <g mask={`url(#${maskId})`}>
            {paths.map((d, i) => (
              <path key={i} d={d} fill="currentColor" />
            ))}
          </g>
        </>
      ) : (
        paths.map((d, i) => <path key={i} d={d} fill="currentColor" />)
      )}
    </svg>
  );
};
