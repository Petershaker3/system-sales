// The pairing QR, as an actual QR code (`ADR-042`).
//
// What was here before drew three finder squares and filled the rest from a hash
// of the payload. It looked like a QR code and was not one: no encoder, no error
// correction, no format information. A phone camera could not read it — which is
// why «ربط الموبايل بالكمبيوتر» never worked, no matter how the rest of the link
// was wired.
//
// This module encodes the real thing with the encoder that already ships for the
// camera reader (`@zxing/library`, Apache-2.0, same dependency tree as
// `@zxing/browser`). The proof is not "it looks right": `pair-qr.test.ts` decodes
// what this produces back to the payload the computer printed.
//
// Everything is pure — the QR is a value here, not a DOM node — so the screen can
// be a thin renderer and the rule can be tested without a browser.

// The encoder is loaded on demand, not at startup.
//
// `@zxing/library` is most of a megabyte and only the pairing panel needs it, so
// importing it statically would make every launch of the till (and the phone's
// companion app) unpack it before the first screen appears. The reader in
// `src/ui/scan.ts` is deferred for the same reason.
type EncoderModule = typeof import('@zxing/library');

/** The library's hint keys, as a type: the module also exports them as a value. */
type EncodeHint = import('@zxing/library').EncodeHintType;

let encoderModule: Promise<EncoderModule> | null = null;

function loadEncoder(): Promise<EncoderModule> {
  encoderModule ??= import('@zxing/library');
  return encoderModule;
}

/** What a pairing line looks like, before any of it is believed. */
export const PAIR_PREFIX = 'MSHOP-PAIR';

/**
 * The quiet zone, in modules.
 *
 * The standard asks for four light modules around the code; a camera focusing on
 * a code that touches the edge of its frame is the difference between "scanned"
 * and "hunt for the angle". Kept here rather than in the CSS, because it is part
 * of the code, not part of the layout.
 */
export const QUIET_ZONE = 4;

export interface PairQrCode {
  /** Exactly what will be read back, byte for byte. */
  readonly payload: string;
  /** Modules per side, quiet zone included. */
  readonly size: number;
  /** `true` is a dark module. Row-major: `modules[row][column]`. */
  readonly modules: readonly (readonly boolean[])[];
  /** One SVG path drawing every dark module, so the DOM holds one node. */
  readonly path: string;
}

/**
 * Encode a pairing line as a QR code.
 *
 * `'M'` error correction: a shop's QR is printed on a screen behind a counter and
 * photographed at an angle, so a code that survives a smudge matters more than
 * the handful of modules `'L'` would save.
 *
 * UTF-8 is declared in the code itself, not only assumed: the payload carries the
 * shop's Arabic name, and a decoder that guesses ISO-8859-1 would hand the phone a
 * name made of question marks.
 */
export async function buildPairQr(payload: string, ecc: 'L' | 'M' = 'M'): Promise<PairQrCode> {
  const trimmed = payload.trim();
  if (trimmed === '') {
    throw new Error('a QR code of nothing is not a pairing code');
  }

  const { BarcodeFormat, EncodeHintType, QRCodeWriter } = await loadEncoder();
  const hints = new Map<EncodeHint, unknown>();
  hints.set(EncodeHintType.CHARACTER_SET, 'UTF-8');
  hints.set(EncodeHintType.MARGIN, QUIET_ZONE);
  hints.set(EncodeHintType.ERROR_CORRECTION, ecc);

  // Zero width/height: the encoder picks the smallest version that fits, so a
  // short shop name does not force the same size as a long one.
  const matrix = new QRCodeWriter().encode(
    trimmed,
    BarcodeFormat.QR_CODE,
    0,
    0,
    hints as Map<EncodeHint, never>,
  );

  const size = matrix.getWidth();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let column = 0; column < size; column += 1) {
      // `BitMatrix#get` answers a boolean in this version, not the `1`/`0` the
      // Java original returns; both are accepted so a patch release cannot turn
      // every module light and silently blank the code.
      line.push(matrix.get(column, row) === true);
    }
    modules.push(line);
  }

  return { payload: trimmed, size, modules, path: modulesToPath(modules) };
}

/**
 * Draw the dark modules as one path: horizontal runs, one subpath each.
 *
 * A 45×45 code is roughly a thousand dark modules; a thousand `<rect>`s is a
 * thousand DOM nodes on a screen that is already busy. Runs keep it at a few
 * hundred characters and stay crisp with `shape-rendering="crispEdges"`.
 */
export function modulesToPath(modules: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  for (let row = 0; row < modules.length; row += 1) {
    const line = modules[row] ?? [];
    let column = 0;
    while (column < line.length) {
      if (line[column] !== true) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < line.length && line[column] === true) column += 1;
      parts.push(`M${start} ${row}h${column - start}v1h-${column - start}z`);
    }
  }
  return parts.join('');
}

/**
 * Is this a pairing line at all?
 *
 * Only the prefix is checked here: the full parse (host, port, code) is
 * `parsePairPayload` in `companion.ts`, which is what actually decides. Split so
 * the screen can say «الكود ده مش كود ربط» before showing something that cannot
 * work.
 */
export function looksLikePairPayload(payload: string): boolean {
  return payload.trim().startsWith(`${PAIR_PREFIX}|`);
}

/**
 * Where the three finder patterns sit, as `[row, column]` of their top-left cell.
 *
 * Inside the quiet zone: the encoder counts the margin as part of the matrix, so
 * the first dark module of the top-left square is at `(quietZone, quietZone)`.
 */
export function finderOrigins(
  size: number,
  quietZone = QUIET_ZONE,
): readonly (readonly [number, number])[] {
  const far = size - 7 - quietZone;
  return [
    [quietZone, quietZone],
    [quietZone, far],
    [far, quietZone],
  ];
}

/**
 * Does this matrix carry the marks every QR code has?
 *
 * Not a decoder — `pair-qr.test.ts` decodes for real. This is the cheap shape
 * check the screen and the smoke test use to notice a matrix that was never
 * encoded at all, which is precisely the bug this file replaced.
 */
export function hasQrShape(modules: readonly (readonly boolean[])[], quietZone = QUIET_ZONE): boolean {
  const size = modules.length;
  if (size < 21 || size % 4 !== 1) return false;

  // The quiet zone: a light frame around everything.
  for (let i = 0; i < quietZone; i += 1) {
    const line = modules[i] ?? [];
    const opposite = modules[size - 1 - i] ?? [];
    for (let j = 0; j < size; j += 1) {
      if (line[j] === true || opposite[j] === true) return false;
      if (modules[j]?.[i] === true || modules[j]?.[size - 1 - i] === true) return false;
    }
  }

  // Each finder pattern is a dark 7×7 ring with a dark 3×3 core.
  for (const [row, column] of finderOrigins(size, quietZone)) {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (modules[row + r]?.[column + c] !== (border || core)) return false;
      }
    }
  }

  return true;
}
