/**
 * Product image helpers («صور الأصناف», ADR-018 §5, plan item 1.2 step 5).
 *
 * Matches `shrinkImage` in `docs/ui/mockup-v1/app.js`: centre-crops any picked
 * image to a 192×192 square on a white ground and encodes it as JPEG (`0.82`),
 * typically ~10–18 KB.
 */

export const IMAGE_SIDE = 192;
export const MAX_IMAGE_BYTES = 65_536;

export interface SquareCrop {
  readonly sx: number;
  readonly sy: number;
  readonly sSide: number;
  readonly dSide: number;
}

/** Compute the centre-crop source box for a square thumbnail of `dSide` pixels. */
export function cropSquare192(
  width: number,
  height: number,
  dSide: number = IMAGE_SIDE,
): SquareCrop {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const sSide = Math.min(w, h);
  const sx = (w - sSide) / 2;
  const sy = (h - sSide) / 2;
  return { sx, sy, sSide, dSide };
}

/** Approximate decoded byte length of a `data:image/jpeg;base64,...` URL. */
export function approxBytesFromDataUrl(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = (comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl).trim();
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Rounded kilobyte count (minimum 1 KB) for the «اتحفظت صورة ... (X ك.ب)» toast. */
export function approxKilobytes(dataUrl: string): number {
  return Math.max(1, Math.round(approxBytesFromDataUrl(dataUrl) / 1024));
}

/**
 * Read a `File` picked by the operator, centre-crop it to `192×192` on a white
 * background, and return a `data:image/jpeg;base64,...` string.
 */
export function shrinkImageFile(
  file: File,
  side: number = IMAGE_SIDE,
  quality: number = 0.82,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
      img.onload = () => {
        const { sx, sy, sSide, dSide } = cropSquare192(
          img.naturalWidth || img.width,
          img.naturalHeight || img.height,
          side,
        );
        const canvas = document.createElement('canvas');
        canvas.width = dSide;
        canvas.height = dSide;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('CANVAS_UNAVAILABLE'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, dSide, dSide);
        ctx.drawImage(img, sx, sy, sSide, sSide, 0, 0, dSide, dSide);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result ?? '');
    };
    reader.readAsDataURL(file);
  });
}
