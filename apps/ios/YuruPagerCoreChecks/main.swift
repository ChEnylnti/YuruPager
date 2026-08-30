import Foundation
import YuruPagerCore

private struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}

private var passed = 0

private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw CheckFailure(description: message) }
    passed += 1
}

private func unwrap<T>(_ value: T?, _ message: String) throws -> T {
    guard let value else { throw CheckFailure(description: message) }
    return value
}

private func expectImageError(
    _ expected: SessionImageValidationError,
    _ message: String,
    operation: () throws -> Void
) throws {
    do {
        try operation()
        throw CheckFailure(description: "\(message): expected \(expected.rawValue)")
    } catch let error as SessionImageValidationError {
        try check(error == expected, message)
    }
}

private func imageData(header: [UInt8], byteLength: Int) -> Data {
    var data = Data(header)
    if data.count < byteLength { data.append(Data(repeating: 0, count: byteLength - data.count)) }
    return data
}

do {
    let secure = try unwrap(ServerConfiguration(address: "https://example.com/yurupager"), "HTTPS URL should parse")
    try check(secure.baseURL.absoluteString == "https://example.com/yurupager/", "base path normalization")
    try check(secure.url(for: "api/snapshot?workspaceId=team%201").absoluteString == "https://example.com/yurupager/api/snapshot?workspaceId=team%201", "API URL preserves base path")
    try check(secure.liveURL.absoluteString == "wss://example.com/yurupager/api/live", "WSS URL preserves base path")
    let local = try unwrap(ServerConfiguration(address: "http://127.0.0.1:4300/"), "local URL should parse")
    try check(local.liveURL.absoluteString == "ws://127.0.0.1:4300/api/live", "local WebSocket scheme")
    try check(local.isTransportAllowed, "local HTTP should be allowed")
    let insecure = try unwrap(ServerConfiguration(address: "http://example.com"), "remote HTTP URL should parse for validation")
    try check(!insecure.isTransportAllowed, "remote HTTP must be rejected")

    var gate = SubmissionGate()
    try check(gate.prepare(key: "decision-1") == "decision-1", "prepared key")
    try check(gate.begin() == "decision-1", "begin uses prepared key")
    try check(gate.begin() == nil, "duplicate begin is blocked")
    gate.fail()
    try check(gate.begin() == "decision-1", "retry keeps the same idempotency key")
    gate.complete()
    try check(gate.idempotencyKey == nil && !gate.isSubmitting, "completion releases gate")

    var conversation = ConversationState()
    conversation.apply(.historyStart)
    conversation.apply(.messageStart(messageId: "m1", turnId: "t1", role: .assistant, phase: .commentary))
    conversation.apply(.messageDelta(messageId: "m1", delta: "你"))
    conversation.apply(.messageDelta(messageId: "m1", delta: "好"))
    conversation.apply(.messageComplete(messageId: "m1"))
    conversation.apply(.activityUpsert(activityId: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .inProgress))
    conversation.apply(.activityUpsert(activityId: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .completed))
    conversation.apply(.historyComplete)
    try check(conversation.messages.count == 1, "message identity is stable")
    try check(conversation.messages[0].text == "你好", "stream deltas merge in order")
    try check(conversation.messages[0].isComplete && conversation.isHistoryComplete, "completion states")
    try check(conversation.entries.count == 2 && conversation.activities[0].status == .completed, "activity upsert keeps stable identity")
    conversation.apply(.messageReset(messageId: "m1"))
    conversation.apply(.messageDelta(messageId: "m1", delta: "校准文本"))
    try check(conversation.messages[0].text == "校准文本", "reset calibrates streamed text")
    conversation.clear()
    try check(conversation.messages.isEmpty && conversation.turnStatuses.isEmpty, "privacy clear removes conversation")

    let liveData = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"message.delta","messageId":"m1","delta":"hello"}}"#.utf8)
    let live = try JSONDecoder().decode(LiveServerMessage.self, from: liveData)
    try check(live.sessionId == "session-1", "live session routing")
    try check(live.frame == .messageDelta(messageId: "m1", delta: "hello"), "live frame schema")
    let activityData = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"activity.upsert","activityId":"a1","turnId":"t1","activity":"command","label":"读取 main.mjs","status":"in_progress"}}"#.utf8)
    let activityMessage = try JSONDecoder().decode(LiveServerMessage.self, from: activityData)
    try check(activityMessage.frame == .activityUpsert(activityId: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .inProgress), "live activity frame schema")
    let titleData = Data(#"{"type":"session.titles.snapshot","titles":[{"sessionId":"session-1","title":"创建私人仓库并提交项目"}]}"#.utf8)
    let titleMessage = try JSONDecoder().decode(LiveServerMessage.self, from: titleData)
    try check(titleMessage.titles?.first?.sessionId == "session-1", "live title session routing")
    try check(titleMessage.titles?.first?.title == "创建私人仓库并提交项目", "live official title schema")

    let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
    let jpeg = imageData(header: [0xff, 0xd8, 0xff, 0xe0], byteLength: 16)
    let webp = imageData(
        header: [0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
        byteLength: 16
    )
    try check(SessionImageSignature.mimeType(for: png) == "image/png", "PNG signature detection")
    try check(SessionImageSignature.mimeType(for: jpeg) == "image/jpeg", "JPEG signature detection")
    try check(SessionImageSignature.mimeType(for: webp) == "image/webp", "WebP signature detection")
    try expectImageError(.invalidImage, "declared MIME must match bytes") {
        try SessionImageSignature.validate(png, mimeType: "image/jpeg")
    }
    let exactFiveMiB = imageData(
        header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        byteLength: SessionImageLimits.maximumImageBytes
    )
    try SessionImageSignature.validate(exactFiveMiB, mimeType: "image/png")
    try check(exactFiveMiB.count == SessionImageLimits.maximumImageBytes, "exact 5 MiB image is accepted")
    let overFiveMiB = exactFiveMiB + Data([0])
    try expectImageError(.imageTooLarge, "5 MiB plus one byte is rejected") {
        try SessionImageSignature.validate(overFiveMiB, mimeType: "image/png")
    }
    try SessionImageSourceValidator.validateFileSize(SessionImageLimits.maximumSourceBytes)
    try check(SessionImageLimits.maximumSourceBytes == 25 * 1024 * 1024, "exact 25 MiB source file is accepted before reading")
    try expectImageError(.sourceImageTooLarge, "25 MiB plus one byte source file is rejected before reading") {
        try SessionImageSourceValidator.validateFileSize(SessionImageLimits.maximumSourceBytes + 1)
    }
    try SessionImageSourceValidator.validateFileSize(nil)
    try check(true, "unknown source size falls back to post-read validation")

    let threeMiB = imageData(
        header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        byteLength: 3 * 1024 * 1024
    )
    let exactFour = (0..<4).map { DraftImageAttachment(id: "a\($0)", mimeType: "image/png", data: threeMiB) }
    try SessionImageDraftValidator.validate(exactFour)
    try check(exactFour.reduce(0, { $0 + $1.data.count }) == SessionImageLimits.maximumTotalBytes, "exact 4 images and 12 MiB are accepted")
    try expectImageError(.tooManyImages, "fifth image is rejected") {
        try SessionImageDraftValidator.validate(exactFour + [DraftImageAttachment(id: "a4", mimeType: "image/png", data: png)])
    }
    let fourMiB = imageData(
        header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        byteLength: 4 * 1024 * 1024
    )
    let fourMiBPlusOne = fourMiB + Data([0])
    try expectImageError(.imagesTooLarge, "12 MiB plus one byte total is rejected") {
        try SessionImageDraftValidator.validate([
            DraftImageAttachment(id: "b1", mimeType: "image/png", data: fourMiB),
            DraftImageAttachment(id: "b2", mimeType: "image/png", data: fourMiB),
            DraftImageAttachment(id: "b3", mimeType: "image/png", data: fourMiBPlusOne),
        ])
    }

    var draftState = SessionImageDraftState()
    draftState.bind(to: "session-a")
    try draftState.add(data: png, mimeType: "image/png", sessionId: "session-a", id: "draft-a")
    try expectImageError(.invalidImage, "failed selection retains the valid draft") {
        _ = try draftState.add(data: png, mimeType: "image/jpeg", sessionId: "session-a", id: "invalid")
    }
    try check(draftState.attachments.map(\.id) == ["draft-a"], "validation failure retains draft")
    try check(draftState.attachments.count == 1, "cancel path retains draft until explicit completion")
    draftState.bind(to: "session-b")
    try check(draftState.attachments.isEmpty && draftState.sessionId == "session-b", "switching sessions clears image draft")
    try draftState.add(data: png, mimeType: "image/png", sessionId: "session-b", id: "draft-b")
    draftState.completeSubmission(attachmentIds: ["different"])
    try check(draftState.attachments.count == 1, "mismatched completion cannot clear draft")
    draftState.completeSubmission(attachmentIds: ["draft-b"])
    try check(draftState.attachments.isEmpty, "confirmed matching submission clears draft")

    let midpoint = png.count / 2
    let firstChunk = png.subdata(in: 0..<midpoint).base64EncodedString()
    let secondChunk = png.subdata(in: midpoint..<png.count).base64EncodedString()
    var assembler = SessionImageAssembler()
    try assembler.begin(imageId: "image-1", mimeType: "image/png", byteLength: png.count)
    let firstOffset = try assembler.append(imageId: "image-1", sequence: 0, encodedData: firstChunk)
    try check(firstOffset == midpoint, "first image chunk advances bytes")
    let duplicateOffset = try assembler.append(imageId: "image-1", sequence: 0, encodedData: firstChunk)
    try check(duplicateOffset == midpoint, "identical duplicate chunk is idempotent")
    let completedOffset = try assembler.append(imageId: "image-1", sequence: 1, encodedData: secondChunk)
    try check(completedOffset == png.count, "ordered image chunks assemble")
    let completedImage = try assembler.complete(imageId: "image-1", sha256: SessionImageAssembler.sha256Hex(png))
    try check(completedImage.data == png && completedImage.mimeType == "image/png", "completed image validates SHA and bytes")

    var gapAssembler = SessionImageAssembler()
    try gapAssembler.begin(imageId: "gap", mimeType: "image/png", byteLength: png.count)
    try expectImageError(.missingImageChunk, "out-of-order chunk is rejected") {
        _ = try gapAssembler.append(imageId: "gap", sequence: 1, encodedData: firstChunk)
    }
    var conflictAssembler = SessionImageAssembler()
    try conflictAssembler.begin(imageId: "conflict", mimeType: "image/png", byteLength: png.count)
    _ = try conflictAssembler.append(imageId: "conflict", sequence: 0, encodedData: firstChunk)
    try expectImageError(.conflictingImageChunk, "conflicting duplicate chunk is rejected") {
        _ = try conflictAssembler.append(imageId: "conflict", sequence: 0, encodedData: secondChunk)
    }
    var base64Assembler = SessionImageAssembler()
    try base64Assembler.begin(imageId: "base64", mimeType: "image/png", byteLength: png.count)
    try expectImageError(.invalidImageBase64, "non-canonical Base64 is rejected") {
        _ = try base64Assembler.append(imageId: "base64", sequence: 0, encodedData: "not base64")
    }
    let exactChunk = imageData(
        header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        byteLength: SessionImageLimits.chunkBytes
    )
    var exactChunkAssembler = SessionImageAssembler()
    try exactChunkAssembler.begin(imageId: "exact-chunk", mimeType: "image/png", byteLength: exactChunk.count)
    let exactChunkOffset = try exactChunkAssembler.append(
        imageId: "exact-chunk",
        sequence: 0,
        encodedData: exactChunk.base64EncodedString()
    )
    try check(exactChunkOffset == SessionImageLimits.chunkBytes, "exact 48 KiB chunk is accepted")
    let oversizedChunk = exactChunk + Data([0])
    var oversizedChunkAssembler = SessionImageAssembler()
    try oversizedChunkAssembler.begin(imageId: "oversized-chunk", mimeType: "image/png", byteLength: oversizedChunk.count)
    try expectImageError(.invalidImageChunk, "48 KiB plus one byte chunk is rejected") {
        _ = try oversizedChunkAssembler.append(
            imageId: "oversized-chunk",
            sequence: 0,
            encodedData: oversizedChunk.base64EncodedString()
        )
    }
    exactChunkAssembler.clear()
    try expectImageError(.missingImageStart, "assembler clear releases pending image bytes") {
        _ = try exactChunkAssembler.append(imageId: "exact-chunk", sequence: 1, encodedData: firstChunk)
    }
    var hashAssembler = SessionImageAssembler()
    try hashAssembler.begin(imageId: "hash", mimeType: "image/png", byteLength: png.count)
    _ = try hashAssembler.append(imageId: "hash", sequence: 0, encodedData: png.base64EncodedString())
    try expectImageError(.imageHashMismatch, "SHA mismatch is rejected") {
        _ = try hashAssembler.complete(imageId: "hash", sha256: String(repeating: "0", count: 64))
    }

    let imageStartData = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"image.start","imageId":"image-1","turnId":"turn-1","role":"assistant","mimeType":"image/png","byteLength":68}}"#.utf8)
    let imageStartMessage = try JSONDecoder().decode(LiveServerMessage.self, from: imageStartData)
    try check(imageStartMessage.frame == .imageStart(imageId: "image-1", turnId: "turn-1", role: .assistant, mimeType: "image/png", byteLength: 68), "image start frame schema")
    let imageChunkData = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"image.chunk","imageId":"image-1","sequence":0,"data":"aGVsbG8="}}"#.utf8)
    let imageChunkMessage = try JSONDecoder().decode(LiveServerMessage.self, from: imageChunkData)
    try check(imageChunkMessage.frame == .imageChunk(imageId: "image-1", sequence: 0, data: "aGVsbG8="), "image chunk frame schema")
    let imageCompleteData = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"image.complete","imageId":"image-1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#.utf8)
    let imageCompleteMessage = try JSONDecoder().decode(LiveServerMessage.self, from: imageCompleteData)
    try check(imageCompleteMessage.frame == .imageComplete(imageId: "image-1", sha256: String(repeating: "a", count: 64)), "image complete frame schema")
    let imageErrorData = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"image.error","imageId":"image-1","turnId":"turn-1","role":"assistant","code":"image_hash_mismatch"}}"#.utf8)
    let imageErrorMessage = try JSONDecoder().decode(LiveServerMessage.self, from: imageErrorData)
    try check(imageErrorMessage.frame == .imageError(imageId: "image-1", turnId: "turn-1", role: .assistant, code: "image_hash_mismatch"), "image error frame schema")

    let uploadStatusData = Data(#"{"type":"session.attachment.status","sessionId":"session-1","uploadId":"upload-1","state":"progress","nextOffset":49152}"#.utf8)
    let uploadStatusMessage = try JSONDecoder().decode(LiveServerMessage.self, from: uploadStatusData)
    try check(uploadStatusMessage.attachmentStatus == AttachmentUploadStatus(sessionId: "session-1", uploadId: "upload-1", state: .progress, nextOffset: 49_152), "attachment status uses shared state field")
    let beginObject = try unwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(LiveClientMessage.attachmentBegin(sessionId: "session-1", uploadId: "upload-1", mimeType: "image/png", byteLength: png.count, sha256: SessionImageAssembler.sha256Hex(png)))) as? [String: Any], "attachment begin JSON")
    try check(beginObject["type"] as? String == "session.attachment.begin", "attachment begin type")
    try check(beginObject["byteLength"] as? Int == png.count && beginObject["data"] == nil, "attachment begin contains metadata only")
    try check(beginObject["path"] == nil && beginObject["fileName"] == nil, "attachment frames omit path and filename")

    var imageConversation = ConversationState()
    imageConversation.apply(.imageStart(imageId: "image-1", turnId: "turn-1", role: .assistant, mimeType: "image/png", byteLength: png.count))
    imageConversation.updateImageProgress("image-1", receivedBytes: midpoint)
    imageConversation.completeImage("image-1", data: png)
    try check(imageConversation.images.first?.status == .ready && imageConversation.images.first?.data == png, "conversation image keeps stable row through completion")
    imageConversation.clear()
    try check(imageConversation.images.isEmpty, "privacy clear releases conversation image data")
    imageConversation.apply(.imageError(imageId: "orphan-image", turnId: "turn-2", role: .user, code: "image_unavailable"))
    try check(
        imageConversation.images.first?.status == .failed(code: "image_unavailable")
            && imageConversation.images.first?.turnId == "turn-2"
            && imageConversation.images.first?.role == .user,
        "image error without start keeps turn and role in its failed media slot"
    )

    let decision = DecisionInput(decision: .approve, highRiskConfirmed: true)
    let decisionObject = try unwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(decision)) as? [String: Any], "decision JSON object")
    try check(decisionObject["decision"] as? String == "approve", "decision enum encoding")
    try check(decisionObject["highRiskConfirmed"] as? Bool == true, "high risk confirmation encoding")
    try check(decisionObject["answers"] == nil, "nil decision fields are omitted")

    print("YuruPagerCoreChecks: \(passed) checks passed")
} catch {
    fputs("YuruPagerCoreChecks failed: \(error)\n", stderr)
    exit(1)
}
