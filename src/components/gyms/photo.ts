"use client";

/**
 * @file Turning a camera roll picture into something small enough to keep.
 *
 * ## What happens to the photo
 *
 * It is decoded in this tab, drawn onto a canvas, re-encoded as a JPEG data
 * URL, and handed to the vault. That is the whole journey. It is never
 * uploaded, never sent to a model, never read for content. There is nowhere
 * for it to go: the app has no backend, and `npm run audit:privacy` fails the
 * build on a same-origin request carrying user data.
 *
 * ## Why it is downscaled
 *
 * A modern iPhone photo is 3–5 MB. The profile list lives inside the encrypted
 * `settings` row, which is decrypted in full on every read, so a few full-size
 * photos would turn a settings read into a visible pause. A 1024px long edge at
 * quality 0.72 lands around 80–150 kB and is far more than enough to remind
 * someone which corner the cable column is in — which is the entire job.
 */

/** Long edge, in CSS pixels, of the stored image. */
export const MAX_PHOTO_EDGE_PX = 1024;
/** JPEG quality. Memory aid, not a photograph. */
export const PHOTO_QUALITY = 0.72;
/** Refuse anything that still exceeds this after encoding, in bytes. */
export const MAX_PHOTO_BYTES = 600_000;

/** What went wrong, in words the UI can show. */
export class PhotoError extends Error {
  override readonly name = 'PhotoError';
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new PhotoError('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

/**
 * Downscale an image file to a data URL.
 *
 * @param file the picked file
 * @returns a JPEG data URL
 * @throws {PhotoError} when the file is not an image, or is still too large
 *   after encoding — better an honest refusal than a settings row that takes
 *   two seconds to decrypt.
 */
export async function toStoredPhoto(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new PhotoError('That is not an image.');
  }
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_PHOTO_EDGE_PX / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new PhotoError('This browser would not give us a canvas.');
  ctx.drawImage(img, 0, 0, width, height);

  const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
  // A data URL is ~4/3 the size of the bytes it encodes.
  if ((dataUrl.length * 3) / 4 > MAX_PHOTO_BYTES) {
    throw new PhotoError('That photo is too large to store. Try a smaller one.');
  }
  return dataUrl;
}
