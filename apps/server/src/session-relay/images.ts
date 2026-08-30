import { createHash, type Hash } from "node:crypto";

import type { SessionImageMimeType, SessionStreamFrame } from "@yurupager/shared";
import { sessionImageLimits } from "@yurupager/shared";

export interface IncomingImage {
  mimeType: SessionImageMimeType;
  byteLength: number;
  receivedBytes: number;
  nextSequence: number;
  hash: Hash;
  prefix: Buffer;
}

export function decodeBase64Chunk(value: string): Buffer {
  if (
    value.length < 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error("Invalid Base64 image chunk");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > sessionImageLimits.maxChunkBytes ||
    bytes.toString("base64") !== value
  ) throw new Error("Invalid Base64 image chunk");
  return bytes;
}

function appendPrefix(prefix: Buffer, bytes: Buffer): Buffer {
  if (prefix.length >= 12) return prefix;
  return Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
}

export function matchesImageSignature(mimeType: SessionImageMimeType, prefix: Buffer): boolean {
  if (mimeType === "image/png") {
    return prefix.length >= 8 && prefix.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (mimeType === "image/jpeg") {
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  }
  return prefix.length >= 12 &&
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP";
}

export function applyIncomingImageFrame(images: Map<string, IncomingImage>, frame: SessionStreamFrame): void {
  if (frame.kind === "image.start") {
    if (images.has(frame.imageId)) throw new Error("Duplicate Connector image start");
    images.set(frame.imageId, {
      mimeType: frame.mimeType,
      byteLength: frame.byteLength,
      receivedBytes: 0,
      nextSequence: 0,
      hash: createHash("sha256"),
      prefix: Buffer.alloc(0),
    });
    return;
  }
  if (frame.kind === "image.chunk") {
    const image = images.get(frame.imageId);
    if (image === undefined || frame.sequence !== image.nextSequence) {
      throw new Error("Connector image chunk is out of order");
    }
    const bytes = decodeBase64Chunk(frame.data);
    if (image.receivedBytes + bytes.length > image.byteLength) {
      throw new Error("Connector image exceeded its declared size");
    }
    image.hash.update(bytes);
    image.prefix = appendPrefix(image.prefix, bytes);
    image.receivedBytes += bytes.length;
    image.nextSequence += 1;
    return;
  }
  if (frame.kind === "image.complete") {
    const image = images.get(frame.imageId);
    if (
      image === undefined ||
      image.receivedBytes !== image.byteLength ||
      !matchesImageSignature(image.mimeType, image.prefix) ||
      image.hash.digest("hex") !== frame.sha256
    ) throw new Error("Connector image verification failed");
    images.delete(frame.imageId);
    return;
  }
  if (frame.kind === "image.error") images.delete(frame.imageId);
}
