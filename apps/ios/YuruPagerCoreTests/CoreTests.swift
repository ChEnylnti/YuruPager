import XCTest
#if canImport(YuruPager)
@testable import YuruPager
#else
@testable import YuruPagerCore
#endif

final class ServerConfigurationTests: XCTestCase {
    func testNormalizesBasePathAndBuildsAPIURL() throws {
        let configuration = try XCTUnwrap(ServerConfiguration(address: "https://example.com/yurupager"))
        XCTAssertEqual(configuration.baseURL.absoluteString, "https://example.com/yurupager/")
        XCTAssertEqual(
            configuration.url(for: "api/snapshot?workspaceId=team%201").absoluteString,
            "https://example.com/yurupager/api/snapshot?workspaceId=team%201"
        )
    }

    func testBuildsWebSocketURLWithoutDroppingBasePath() throws {
        let secure = try XCTUnwrap(ServerConfiguration(address: "https://example.com/yurupager/"))
        let local = try XCTUnwrap(ServerConfiguration(address: "http://127.0.0.1:4300/"))
        XCTAssertEqual(secure.liveURL.absoluteString, "wss://example.com/yurupager/api/live")
        XCTAssertEqual(local.liveURL.absoluteString, "ws://127.0.0.1:4300/api/live")
        XCTAssertTrue(local.isTransportAllowed)
    }

    func testRejectsInsecureRemoteServer() throws {
        let remote = try XCTUnwrap(ServerConfiguration(address: "http://example.com"))
        XCTAssertFalse(remote.isTransportAllowed)
        XCTAssertNil(ServerConfiguration(address: "example.com"))
    }
}

final class SubmissionGateTests: XCTestCase {
    func testRetryKeepsIdempotencyKeyAndDuplicateBeginIsBlocked() {
        var gate = SubmissionGate()
        XCTAssertEqual(gate.prepare(key: "decision-1"), "decision-1")
        XCTAssertEqual(gate.begin(), "decision-1")
        XCTAssertNil(gate.begin())

        gate.fail()
        XCTAssertEqual(gate.begin(), "decision-1")
        gate.complete()
        XCTAssertNil(gate.idempotencyKey)
        XCTAssertFalse(gate.isSubmitting)
    }

    func testCancelReleasesPreparedKey() {
        var gate = SubmissionGate()
        _ = gate.prepare(key: "cancelled-key")
        gate.cancel()
        XCTAssertNil(gate.idempotencyKey)
    }
}

final class ConversationStateTests: XCTestCase {
    func testHistoryAndStreamingFramesMergeByMessageIdentity() {
        var state = ConversationState()
        state.apply(.historyStart)
        state.apply(.messageStart(messageId: "m1", turnId: "t1", role: .assistant, phase: .commentary))
        state.apply(.messageDelta(messageId: "m1", delta: "你"))
        state.apply(.messageDelta(messageId: "m1", delta: "好"))
        state.apply(.messageComplete(messageId: "m1"))
        state.apply(.historyComplete)

        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(state.messages[0].text, "你好")
        XCTAssertTrue(state.messages[0].isComplete)
        XCTAssertTrue(state.isHistoryComplete)
    }

    func testResetCalibratesMessageAndClearRemovesAllConversationText() {
        var state = ConversationState()
        state.apply(.messageStart(messageId: "m1", turnId: "t1", role: .user, phase: nil))
        state.apply(.messageDelta(messageId: "m1", delta: "stale secret"))
        state.apply(.messageReset(messageId: "m1"))
        state.apply(.messageDelta(messageId: "m1", delta: "校准文本"))
        XCTAssertEqual(state.messages[0].text, "校准文本")

        state.clear()
        XCTAssertTrue(state.messages.isEmpty)
        XCTAssertTrue(state.turnStatuses.isEmpty)
        XCTAssertFalse(state.isHistoryComplete)
    }

    func testDuplicateMessageStartDoesNotDuplicateHistory() {
        var state = ConversationState()
        let start = SessionStreamFrame.messageStart(messageId: "m1", turnId: "t1", role: .assistant, phase: .finalAnswer)
        state.apply(start)
        state.apply(start)
        XCTAssertEqual(state.messages.count, 1)
    }

    func testActivityUpsertKeepsOneOrderedRow() {
        var state = ConversationState()
        state.apply(.messageStart(messageId: "m1", turnId: "t1", role: .assistant, phase: .commentary))
        state.apply(.activityUpsert(activityId: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .inProgress))
        state.apply(.activityUpsert(activityId: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .completed))
        XCTAssertEqual(state.entries.count, 2)
        XCTAssertEqual(state.activities, [ConversationActivity(id: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .completed)])
    }
}

final class MarkdownDocumentTests: XCTestCase {
    func testParsesModelHeadingsListsLinksAndCodeWithoutLeavingMarkup() {
        let document = MarkdownDocument(source: "# 今日简报\n\n1. **重点**\n2. [来源](https://example.com)\n\n```js\nconst ready = true\n```")

        XCTAssertEqual(document.blocks.count, 4)
        guard case .heading(let level, let heading) = document.blocks[0] else { return XCTFail("expected heading") }
        XCTAssertEqual(level, 1)
        XCTAssertEqual(String(heading.characters), "今日简报")
        guard case .listItem(let ordered, let ordinal, _, let item) = document.blocks[1] else { return XCTFail("expected ordered item") }
        XCTAssertTrue(ordered)
        XCTAssertEqual(ordinal, 1)
        XCTAssertEqual(String(item.characters), "重点")
        guard case .code(let language, let code) = document.blocks[3] else { return XCTFail("expected code block") }
        XCTAssertEqual(language, "js")
        XCTAssertEqual(code, "const ready = true")
    }

    func testDropsUnsafeLinksAndPreservesTableStructure() {
        let document = MarkdownDocument(source: "[危险](javascript:alert(1))\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |")

        guard case .paragraph(let paragraph) = document.blocks[0] else { return XCTFail("expected paragraph") }
        XCTAssertNil(paragraph.runs.first?.link)
        guard case .table(let header, let rows, _) = document.blocks[1] else { return XCTFail("expected table") }
        XCTAssertEqual(header.map { String($0.characters) }, ["名称", "值"])
        XCTAssertEqual(rows.map { $0.map { String($0.characters) } }, [["A", "1"]])
    }
}

final class ProtocolContractTests: XCTestCase {
    func testDecodesLiveSessionFrame() throws {
        let data = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"message.delta","messageId":"m1","delta":"hello"}}"#.utf8)
        let message = try JSONDecoder().decode(LiveServerMessage.self, from: data)
        XCTAssertEqual(message.type, "session.stream.frame")
        XCTAssertEqual(message.sessionId, "session-1")
        XCTAssertEqual(message.frame, .messageDelta(messageId: "m1", delta: "hello"))
    }

    func testDecodesSanitizedActivityFrame() throws {
        let data = Data(#"{"type":"session.stream.frame","sessionId":"session-1","frame":{"kind":"activity.upsert","activityId":"a1","turnId":"t1","activity":"command","label":"读取 main.mjs","status":"in_progress"}}"#.utf8)
        let message = try JSONDecoder().decode(LiveServerMessage.self, from: data)
        XCTAssertEqual(message.frame, .activityUpsert(activityId: "a1", turnId: "t1", activity: .command, label: "读取 main.mjs", status: .inProgress))
    }

    func testDecodesLiveSessionTitles() throws {
        let data = Data(#"{"type":"session.titles.snapshot","titles":[{"sessionId":"session-1","title":"创建私人仓库并提交项目"}]}"#.utf8)
        let message = try JSONDecoder().decode(LiveServerMessage.self, from: data)
        XCTAssertEqual(message.type, "session.titles.snapshot")
        XCTAssertEqual(message.titles, [SessionTitle(sessionId: "session-1", title: "创建私人仓库并提交项目")])
    }

    func testHighRiskDecisionPayloadMatchesServerSchema() throws {
        let input = DecisionInput(decision: .approve, highRiskConfirmed: true)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(object["decision"] as? String, "approve")
        XCTAssertEqual(object["highRiskConfirmed"] as? Bool, true)
        XCTAssertNil(object["answers"])
    }
}

final class SessionImageTests: XCTestCase {
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!

    func testSourceFileSizePreflightRejectsOversizedFileBeforeReading() throws {
        XCTAssertNoThrow(try SessionImageSourceValidator.validateFileSize(SessionImageLimits.maximumSourceBytes))
        XCTAssertNoThrow(try SessionImageSourceValidator.validateFileSize(nil))
        XCTAssertThrowsError(
            try SessionImageSourceValidator.validateFileSize(SessionImageLimits.maximumSourceBytes + 1)
        ) {
            XCTAssertEqual($0 as? SessionImageValidationError, .sourceImageTooLarge)
        }
    }

    func testStrictAssemblyAcceptsOrderedChunksAndIdenticalReplay() throws {
        var assembler = SessionImageAssembler()
        let midpoint = png.count / 2
        let first = png.subdata(in: 0..<midpoint).base64EncodedString()
        let second = png.subdata(in: midpoint..<png.count).base64EncodedString()
        try assembler.begin(imageId: "image", mimeType: "image/png", byteLength: png.count)
        XCTAssertEqual(try assembler.append(imageId: "image", sequence: 0, encodedData: first), midpoint)
        XCTAssertEqual(try assembler.append(imageId: "image", sequence: 0, encodedData: first), midpoint)
        XCTAssertEqual(try assembler.append(imageId: "image", sequence: 1, encodedData: second), png.count)
        XCTAssertEqual(
            try assembler.complete(imageId: "image", sha256: SessionImageAssembler.sha256Hex(png)).data,
            png
        )
    }

    func testAssemblyRejectsGapConflictAndHashMismatch() throws {
        var gap = SessionImageAssembler()
        try gap.begin(imageId: "gap", mimeType: "image/png", byteLength: png.count)
        XCTAssertThrowsError(try gap.append(imageId: "gap", sequence: 1, encodedData: png.base64EncodedString())) {
            XCTAssertEqual($0 as? SessionImageValidationError, .missingImageChunk)
        }

        var hash = SessionImageAssembler()
        try hash.begin(imageId: "hash", mimeType: "image/png", byteLength: png.count)
        _ = try hash.append(imageId: "hash", sequence: 0, encodedData: png.base64EncodedString())
        XCTAssertThrowsError(try hash.complete(imageId: "hash", sha256: String(repeating: "0", count: 64))) {
            XCTAssertEqual($0 as? SessionImageValidationError, .imageHashMismatch)
        }
    }

    func testDraftIsBoundToSessionAndOnlyMatchingCompletionClearsIt() throws {
        var draft = SessionImageDraftState()
        draft.bind(to: "session-a")
        try draft.add(data: png, mimeType: "image/png", sessionId: "session-a", id: "attachment-a")
        draft.completeSubmission(attachmentIds: ["stale"])
        XCTAssertEqual(draft.attachments.count, 1)
        draft.bind(to: "session-b")
        XCTAssertTrue(draft.attachments.isEmpty)
        XCTAssertEqual(draft.sessionId, "session-b")
    }

    func testAttachmentStatusUsesStateField() throws {
        let data = Data(#"{"type":"session.attachment.status","sessionId":"session-1","uploadId":"upload-1","state":"ready","ticket":"1234567890abcdef"}"#.utf8)
        let message = try JSONDecoder().decode(LiveServerMessage.self, from: data)
        XCTAssertEqual(
            message.attachmentStatus,
            AttachmentUploadStatus(
                sessionId: "session-1",
                uploadId: "upload-1",
                state: .ready,
                ticket: "1234567890abcdef"
            )
        )
    }

    func testConversationClearReleasesImageBytes() {
        var conversation = ConversationState()
        conversation.apply(.imageStart(
            imageId: "image",
            turnId: "turn",
            role: .assistant,
            mimeType: "image/png",
            byteLength: png.count
        ))
        conversation.completeImage("image", data: png)
        XCTAssertEqual(conversation.images.first?.data, png)
        conversation.clear()
        XCTAssertTrue(conversation.images.isEmpty)
    }

    func testImageErrorWithoutStartCreatesFailureRow() {
        var conversation = ConversationState()
        conversation.apply(.imageError(
            imageId: "orphan",
            turnId: "turn",
            role: .user,
            code: "image_unavailable"
        ))
        XCTAssertEqual(conversation.images.first?.status, .failed(code: "image_unavailable"))
        XCTAssertEqual(conversation.images.first?.turnId, "turn")
        XCTAssertEqual(conversation.images.first?.role, .user)
        XCTAssertNil(conversation.images.first?.data)
    }
}
