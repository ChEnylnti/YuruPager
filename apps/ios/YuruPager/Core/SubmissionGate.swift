import Foundation

public struct SubmissionGate: Equatable, Sendable {
    public private(set) var idempotencyKey: String?
    public private(set) var isSubmitting = false

    public init() {}

    @discardableResult
    public mutating func prepare(key: String = UUID().uuidString.lowercased()) -> String {
        if let idempotencyKey { return idempotencyKey }
        idempotencyKey = key
        return key
    }

    public mutating func begin() -> String? {
        guard !isSubmitting else { return nil }
        isSubmitting = true
        return prepare()
    }

    public mutating func fail() {
        isSubmitting = false
    }

    public mutating func complete() {
        isSubmitting = false
        idempotencyKey = nil
    }

    public mutating func cancel() {
        complete()
    }
}
