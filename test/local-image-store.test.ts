import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ImageMediaError, decodeStrictBase64, validateImageBytes } from "../src/codex/image-media.js";
import { SqliteLocalImageStore } from "../src/codex/local-image-store.js";

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("yurupager-image-fixture"),
]);

test("stages an ordered upload atomically with private directory and file permissions", async () => {
  await withStore(async (store, directory, mediaDirectory) => {
    const descriptor = imageDescriptor("upload-private", PNG);
    assert.deepEqual(store.beginUpload(descriptor), { state: "accepted", nextOffset: 0 });
    assert.deepEqual(store.beginUpload(descriptor), { state: "accepted", nextOffset: 0 });
    assert.deepEqual(store.appendChunk(descriptor.uploadId, 0, PNG.toString("base64")), {
      state: "progress",
      nextOffset: PNG.length,
    });
    assert.deepEqual(store.beginUpload(descriptor), { state: "accepted", nextOffset: PNG.length });
    const completed = store.completeUpload(descriptor.uploadId);
    assert.equal(completed.state, "ready");
    if (completed.state !== "ready") return;
    const local = store.resolveAttachment(completed.attachment, descriptor.threadId);
    assert.equal(local.path.startsWith(mediaDirectory), true);
    assert.equal(local.path.includes(descriptor.uploadId), false);
    assert.equal((await stat(mediaDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(local.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "media.sqlite"))).mode & 0o777, 0o600);
  });
});

test("rejects malformed base64, disguised media, duplicate chunks, and metadata rebinding", async () => {
  await withStore(async (store) => {
    const malformed = imageDescriptor("upload-malformed", PNG);
    store.beginUpload(malformed);
    assert.throws(
      () => store.appendChunk(malformed.uploadId, 0, `${PNG.toString("base64").slice(0, -1)}!`),
      (error) => error instanceof ImageMediaError && error.code === "invalid_image",
    );
    assert.throws(
      () => store.appendChunk(malformed.uploadId, 0, PNG.toString("base64")),
      (error) => error instanceof ImageMediaError && error.code === "upload_not_found",
    );

    const duplicate = imageDescriptor("upload-duplicate", PNG);
    store.beginUpload(duplicate);
    store.appendChunk(duplicate.uploadId, 0, PNG.subarray(0, 8).toString("base64"));
    assert.throws(
      () => store.appendChunk(duplicate.uploadId, 0, PNG.subarray(0, 8).toString("base64")),
      (error) => error instanceof ImageMediaError && error.code === "invalid_upload_offset",
    );

    const disguised = imageDescriptor("upload-disguised", PNG, "image/jpeg");
    store.beginUpload(disguised);
    store.appendChunk(disguised.uploadId, 0, PNG.toString("base64"));
    assert.throws(
      () => store.completeUpload(disguised.uploadId),
      (error) => error instanceof ImageMediaError && error.code === "invalid_image",
    );

    const wrongHash = { ...imageDescriptor("upload-wrong-hash", PNG), sha256: "b".repeat(64) };
    store.beginUpload(wrongHash);
    store.appendChunk(wrongHash.uploadId, 0, PNG.toString("base64"));
    assert.throws(
      () => store.completeUpload(wrongHash.uploadId),
      (error) => error instanceof ImageMediaError && error.code === "hash_mismatch",
    );

    const cancelled = imageDescriptor("upload-cancelled", PNG);
    store.beginUpload(cancelled);
    assert.deepEqual(store.cancelUpload(cancelled.uploadId), { state: "cancelled", nextOffset: 0 });
    assert.throws(
      () => store.appendChunk(cancelled.uploadId, 0, PNG.toString("base64")),
      (error) => error instanceof ImageMediaError && error.code === "upload_not_found",
    );

    const rebound = imageDescriptor("upload-rebound", PNG);
    store.beginUpload(rebound);
    assert.throws(
      () => store.beginUpload({ ...rebound, threadId: "another-thread" }),
      (error) => error instanceof ImageMediaError && error.code === "upload_conflict",
    );
  });
});

test("keeps completed attachments across restart while discarding incomplete fragments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-media-restart-"));
  const mediaDirectory = join(directory, "images");
  const databasePath = join(directory, "media.sqlite");
  const complete = imageDescriptor("upload-complete", PNG);
  const incomplete = imageDescriptor("upload-incomplete", Buffer.concat([PNG, Buffer.from("more")]));
  let reference;
  const first = new SqliteLocalImageStore(databasePath, mediaDirectory);
  try {
    first.beginUpload(complete);
    first.appendChunk(complete.uploadId, 0, PNG.toString("base64"));
    const result = first.completeUpload(complete.uploadId);
    assert.equal(result.state, "ready");
    if (result.state !== "ready") throw new Error("Fixture did not complete");
    reference = result.attachment;
    first.beginUpload(incomplete);
    first.appendChunk(incomplete.uploadId, 0, incompleteBytes(incomplete).subarray(0, 8).toString("base64"));
  } finally {
    first.close();
  }

  const reopened = new SqliteLocalImageStore(databasePath, mediaDirectory);
  try {
    assert.equal(reopened.resolveAttachment(reference, complete.threadId).sha256, complete.sha256);
    assert.throws(
      () => reopened.appendChunk(incomplete.uploadId, 8, Buffer.from("x").toString("base64")),
      (error) => error instanceof ImageMediaError && error.code === "upload_not_found",
    );
    assert.equal((await readdir(mediaDirectory)).some((name) => name.endsWith(".part")), false);
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces strict canonical base64 and all three allowed magic signatures", () => {
  assert.throws(() => decodeStrictBase64("YQ", 10), /base64 length/u);
  assert.throws(() => decodeStrictBase64("YQ==\n", 10), /base64 length/u);
  assert.equal(validateImageBytes(PNG).mimeType, "image/png");
  assert.equal(validateImageBytes(Buffer.from("ffd8ff01", "hex")).mimeType, "image/jpeg");
  assert.equal(validateImageBytes(Buffer.from("524946460000000057454250", "hex")).mimeType, "image/webp");
});

function imageDescriptor(uploadId: string, bytes: Buffer, mimeType = "image/png") {
  return {
    uploadId,
    threadId: "thread-media",
    mimeType,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function incompleteBytes(descriptor: ReturnType<typeof imageDescriptor>): Buffer {
  assert.equal(descriptor.byteLength > PNG.length, true);
  return Buffer.concat([PNG, Buffer.alloc(descriptor.byteLength - PNG.length)]);
}

async function withStore(
  run: (store: SqliteLocalImageStore, directory: string, mediaDirectory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "yurupager-media-"));
  const mediaDirectory = join(directory, "images");
  const store = new SqliteLocalImageStore(join(directory, "media.sqlite"), mediaDirectory);
  try {
    await run(store, directory, mediaDirectory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
