/**
 * @file Local barcode decoding primitives.
 *
 * The decoder and its WebAssembly binary are both shipped by Keel. This module
 * has no network path: its only fetch is the same-origin, service-worker-cached
 * `/wasm/reader/zxing_reader.wasm` asset.
 */

export interface LocalBarcodeDetector {
  detect(image: HTMLCanvasElement | Blob): Promise<readonly { rawValue: string }[]>;
}

/** Pure guard shared by every async scanner continuation. */
export function isCurrentScannerOperation(
  mounted: boolean,
  currentGeneration: number,
  operationGeneration: number,
  aborted: boolean,
): boolean {
  return mounted && currentGeneration === operationGeneration && !aborted;
}

let detectorPromise: Promise<LocalBarcodeDetector> | null = null;

/** Load the self-hosted ZXing reader after an explicit scan/photo action. */
export function getLocalBarcodeDetector(): Promise<LocalBarcodeDetector> {
  if (!detectorPromise) {
    detectorPromise = import('barcode-detector/ponyfill').then(async ({
      BarcodeDetector,
      prepareZXingModule,
    }) => {
      await prepareZXingModule({
        fireImmediately: true,
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? '/wasm/reader/zxing_reader.wasm' : `${prefix}${path}`,
        },
      });
      return new BarcodeDetector({ formats: ['ean_8', 'ean_13', 'upc_a', 'itf_14'] });
    });
    void detectorPromise.catch(() => {
      detectorPromise = null;
    });
  }
  return detectorPromise;
}

/**
 * Validate the GS1 check digit used by EAN-8, UPC-A, EAN-13 and GTIN-14.
 * Decoder agreement catches image noise; this catches a consistently wrong
 * or manually mistyped number before any vendor request is possible.
 */
export function hasValidBarcodeCheckDigit(raw: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(raw)) return false;
  const digits = [...raw].map(Number);
  const expected = digits.pop() as number;
  let sum = 0;
  let weight = 3;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += digits[index] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === expected;
}

/** Two identical, consecutive valid reads are required before acceptance. */
export function nextBarcodeAgreement(
  prior: { code: string; count: number } | null,
  candidate: string,
): { state: { code: string; count: number }; accepted: string | null } {
  const state = prior?.code === candidate
    ? { code: candidate, count: prior.count + 1 }
    : { code: candidate, count: 1 };
  return { state, accepted: state.count >= 2 ? candidate : null };
}
