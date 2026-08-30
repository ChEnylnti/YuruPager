import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 48 * 1024;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface ValidatedImage {
  bytes: Buffer;
  mimeType: ImageMimeType;
  byteLength: number;
  sha256: string;
}

export class ImageMediaError extends Error {
  override readonly name = "ImageMediaError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function readImageMimeType(value: unknown): ImageMimeType {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") return value;
  throw new ImageMediaError("unsupported_image_type", "Unsupported image media type");
}

export function validateImageBytes(
  value: Uint8Array,
  claimedMimeType?: ImageMimeType,
  claimedSha256?: string,
): ValidatedImage {
  const bytes = Buffer.from(value);
  if (bytes.length === 0) throw new ImageMediaError("invalid_image", "Image is empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageMediaError("image_too_large", "Image exceeds the byte limit");
  const mimeType = sniffImageMimeType(bytes);
  if (mimeType === null) throw new ImageMediaError("invalid_image", "Image signature is not supported");
  if (claimedMimeType !== undefined && claimedMimeType !== mimeType) {
    throw new ImageMediaError("invalid_image", "Image signature does not match its media type");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (claimedSha256 !== undefined && !sameSha256(claimedSha256, sha256)) {
    throw new ImageMediaError("hash_mismatch", "Image digest does not match");
  }
  return { bytes, mimeType, byteLength: bytes.length, sha256 };
}

export function readLocalImage(path: string): ValidatedImage {
  if (!isAbsolute(path)) throw new ImageMediaError("invalid_image", "Local image path must be absolute");
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new ImageMediaError("invalid_image", "Local image is not a regular file");
    size = stat.size;
  } catch (error) {
    if (error instanceof ImageMediaError) throw error;
    throw new ImageMediaError("image_unavailable", "Local image is unavailable");
  }
  if (size <= 0) throw new ImageMediaError("invalid_image", "Local image is empty");
  if (size > MAX_IMAGE_BYTES) throw new ImageMediaError("image_too_large", "Local image exceeds the byte limit");
  try {
    return validateImageBytes(readFileSync(path));
  } catch (error) {
    if (error instanceof ImageMediaError) throw error;
    throw new ImageMediaError("image_unavailable", "Local image could not be read");
  }
}

export function decodeImageBase64(
  encoded: string,
  claimedMimeType?: ImageMimeType,
): ValidatedImage {
  const bytes = decodeStrictBase64(encoded, MAX_IMAGE_BYTES);
  return validateImageBytes(bytes, claimedMimeType);
}

export function decodeDataImageUrl(value: string): ValidatedImage {
  const separator = value.indexOf(",");
  if (separator < 0) throw new ImageMediaError("invalid_image", "Image data URL is invalid");
  const header = value.slice(0, separator);
  const match = /^data:(image\/(?:png|jpeg|webp));base64$/u.exec(header);
  if (match === null) throw new ImageMediaError("unsupported_image_type", "Image data URL type is unsupported");
  const mimeType = readImageMimeType(match[1]);
  return decodeImageBase64(value.slice(separator + 1), mimeType);
}

export function decodeStrictBase64(encoded: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ImageMediaError("invalid_image", "Image byte limit is invalid");
  }
  const maximumEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (encoded.length === 0 || encoded.length > maximumEncodedLength || encoded.length % 4 !== 0) {
    throw new ImageMediaError("invalid_image", "Image base64 length is invalid");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new ImageMediaError("invalid_image", "Image base64 is invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== encoded) {
    throw new ImageMediaError("invalid_image", "Image base64 is not canonical");
  }
  return bytes;
}

export function sniffImageMimeType(bytes: Uint8Array): ImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) return "image/webp";
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function sameSha256(expected: string, actual: string): boolean {
  return /^[a-f0-9]{64}$/u.test(expected) && expected === actual;
}
