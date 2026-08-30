import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ImageAssemblyError, ImageAssemblyStore } from "../src/image-assembly.js";

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const data = Buffer.from(bytes).toString("base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");

describe("temporary conversation image assembly", () => {
  it("accepts an identical duplicate chunk and verifies the final digest", async () => {
    const store = new ImageAssemblyStore();
    store.begin({ kind: "image.start", imageId: "image-one", turnId: "turn-one", role: "assistant", mimeType: "image/png", byteLength: bytes.byteLength });
    store.append({ kind: "image.chunk", imageId: "image-one", sequence: 0, data });
    store.append({ kind: "image.chunk", imageId: "image-one", sequence: 0, data });

    const result = await store.complete({ kind: "image.complete", imageId: "image-one", sha256 });
    expect(result.blob.size).toBe(bytes.byteLength);
    expect(result.blob.type).toBe("image/png");
  });

  it("fails closed on gaps, conflicting duplicates and digest mismatch", async () => {
    const gap = new ImageAssemblyStore();
    gap.begin({ kind: "image.start", imageId: "gap", turnId: "turn", role: "user", mimeType: "image/png", byteLength: bytes.byteLength });
    expect(() => gap.append({ kind: "image.chunk", imageId: "gap", sequence: 1, data })).toThrowError(ImageAssemblyError);

    const conflict = new ImageAssemblyStore();
    conflict.begin({ kind: "image.start", imageId: "conflict", turnId: "turn", role: "assistant", mimeType: "image/png", byteLength: bytes.byteLength });
    conflict.append({ kind: "image.chunk", imageId: "conflict", sequence: 0, data });
    expect(() => conflict.append({ kind: "image.chunk", imageId: "conflict", sequence: 0, data: Buffer.from(bytes.map((value) => value ^ 1)).toString("base64") })).toThrowError(ImageAssemblyError);

    const digest = new ImageAssemblyStore();
    digest.begin({ kind: "image.start", imageId: "digest", turnId: "turn", role: "assistant", mimeType: "image/png", byteLength: bytes.byteLength });
    digest.append({ kind: "image.chunk", imageId: "digest", sequence: 0, data });
    await expect(digest.complete({ kind: "image.complete", imageId: "digest", sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "image_hash_mismatch" });
  });

  it("rejects oversized declarations and non-canonical base64", () => {
    const store = new ImageAssemblyStore();
    expect(() => store.begin({ kind: "image.start", imageId: "large", turnId: "turn", role: "assistant", mimeType: "image/png", byteLength: 5 * 1024 * 1024 + 1 })).toThrowError(ImageAssemblyError);
    store.begin({ kind: "image.start", imageId: "bad", turnId: "turn", role: "assistant", mimeType: "image/png", byteLength: 1 });
    expect(() => store.append({ kind: "image.chunk", imageId: "bad", sequence: 0, data: "not base64" })).toThrowError(ImageAssemblyError);
  });

  it("rejects content whose signature does not match the declared MIME", async () => {
    const store = new ImageAssemblyStore();
    const forged = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    store.begin({ kind: "image.start", imageId: "forged", turnId: "turn", role: "assistant", mimeType: "image/png", byteLength: forged.byteLength });
    store.append({ kind: "image.chunk", imageId: "forged", sequence: 0, data: Buffer.from(forged).toString("base64") });

    await expect(store.complete({
      kind: "image.complete",
      imageId: "forged",
      sha256: createHash("sha256").update(forged).digest("hex"),
    })).rejects.toMatchObject({ code: "unsupported_image" });
  });
});
