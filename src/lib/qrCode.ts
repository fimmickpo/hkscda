import { encode } from "uqr";

export type QrSvgShape = {
  /** Modules per side, quiet zone included: the SVG viewBox is `0 0 size size`. */
  size: number;
  /** Every dark module as one path, so a code is a single element. */
  path: string;
};

// The QR specification asks for four light modules around the code. Scanners often fail without it.
const QUIET_ZONE_MODULES = 4;

/**
 * A QR code for `value`, ready to draw as SVG. Error correction M (15%) keeps the code small enough
 * to scan from a laptop screen. Returns null for a value too long for any QR code, so the caller can
 * show something else instead of crashing the page.
 */
export function qrSvgShape(value: string): QrSvgShape | null {
  try {
    const { data, size } = encode(value, { ecc: "M", border: QUIET_ZONE_MODULES });
    const segments: string[] = [];
    for (let y = 0; y < data.length; y += 1) {
      let x = 0;
      while (x < size) {
        if (!data[y][x]) {
          x += 1;
          continue;
        }
        let end = x;
        while (end < size && data[y][end]) end += 1;
        segments.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
        x = end;
      }
    }
    return { size, path: segments.join("") };
  } catch {
    return null;
  }
}
