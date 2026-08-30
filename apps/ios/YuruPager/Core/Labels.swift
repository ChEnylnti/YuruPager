import Foundation

public enum Labels {
    public static func requestStatus(_ value: RequestStatus) -> String {
        switch value {
        case .pending: "待处理"
        case .approved: "已批准"
        case .denied: "已拒绝"
        case .expired: "已过期"
        case .cancelled: "已取消"
        case .interrupted: "已中断"
        }
    }

    public static func risk(_ value: RiskLevel) -> String {
        switch value { case .low: "低风险"; case .medium: "中风险"; case .high: "高风险" }
    }

    public static func role(_ value: WorkspaceRole) -> String {
        switch value { case .owner: "所有者"; case .admin: "管理员"; case .member: "成员" }
    }

    public static func delivery(_ value: DeliveryStatus) -> String {
        switch value {
        case .notQueued: "未排队"
        case .queued: "已排队"
        case .sent: "已发送"
        case .delivered: "已送达"
        case .failed: "失败"
        case .sentUnknown: "发送结果未知"
        }
    }

    public static func command(_ value: SessionCommandStatus) -> String {
        switch value {
        case .queued: "等待工作站"
        case .delivered: "已交付"
        case .failed: "投递前失败"
        case .sentUnknown: "发送结果未知"
        }
    }

    public static func relativeDate(_ rawValue: String) -> String {
        guard let date = ISO8601DateFormatter.yuru.date(from: rawValue) else { return rawValue }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    public static func date(_ rawValue: String) -> String {
        guard let date = ISO8601DateFormatter.yuru.date(from: rawValue) else { return rawValue }
        return DateFormatter.yuru.string(from: date)
    }

    public static func error(_ error: Error, fallback: String = "请求失败，请稍后重试") -> String {
        guard let apiError = error as? APIError else { return fallback }
        switch apiError.code {
        case "unauthenticated": return "登录已失效，请重新登录"
        case "invalid_credentials": return "邮箱或密码不正确"
        case "permission_denied": return "你无权执行此操作"
        case "decision_conflict": return "另一位协作者已处理此请求"
        case "high_risk_confirmation_required": return "高风险批准需要再次确认"
        case "invalid_message": return "消息必须为 1 至 8,000 个字符"
        default: return apiError.message.isEmpty ? fallback : apiError.message
        }
    }
}

private extension ISO8601DateFormatter {
    static let yuru: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

private extension DateFormatter {
    static let yuru: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}
