import { useMemo, type ReactNode } from "react";

import { qrSvgShape } from "../../lib/qrCode";

/**
 * A QR code drawn as inline SVG. Dark modules use the ink token on the surface token, which is
 * about 14:1 and the light quiet zone scanners need around the code.
 */
export function QrCodeSvg({
  value,
  label,
  className,
  fallback = null,
}: {
  value: string;
  /** What a screen reader says about the code. */
  label: string;
  className?: string;
  /** Shown when the value cannot be encoded. */
  fallback?: ReactNode;
}) {
  const shape = useMemo(() => qrSvgShape(value), [value]);
  if (!shape) return <>{fallback}</>;

  return (
    <svg
      viewBox={`0 0 ${shape.size} ${shape.size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={shape.size} height={shape.size} style={{ fill: "var(--color-surface)" }} />
      <path d={shape.path} style={{ fill: "var(--color-text)" }} />
    </svg>
  );
}
