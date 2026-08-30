import Foundation
import SwiftUI

struct UsageView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selectedModel = "全部模型"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ConnectionBanner()
                if let snapshot = store.snapshot {
                    if snapshot.usage.isEmpty {
                        LoadingOrEmpty(isLoading: false, title: "没有用量记录", message: "Codex 上报的累计用量会显示在这里。", systemImage: "chart.bar")
                    } else {
                        List {
                            Section {
                                HStack(alignment: .firstTextBaseline) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(totalTokens, format: .number.notation(.compactName))
                                            .font(.title2.weight(.semibold))
                                        Text("累计 Token").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 3) {
                                        Text(estimatedCost)
                                            .font(.title3.weight(.semibold))
                                        Text("估算成本").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            Section {
                                Picker("模型", selection: $selectedModel) {
                                    Text("全部模型").tag("全部模型")
                                    ForEach(models, id: \.self) { Text($0).tag($0) }
                                }
                            }
                            Section("会话用量") {
                                ForEach(filteredUsage.sorted { $0.updatedAt > $1.updatedAt }) { item in
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack(alignment: .firstTextBaseline) {
                                            Text(item.projectName).font(.headline).lineLimit(2)
                                            Spacer()
                                            Text(item.totalTokens, format: .number.notation(.compactName))
                                                .font(.subheadline.monospacedDigit())
                                        }
                                        Text("\(item.workstationName) · \(item.model)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                        HStack {
                                            qualityLabel(item.quality)
                                            Spacer()
                                            if let micros = item.estimatedCostMicros {
                                                Text("估算 \(formattedCost(micros))")
                                            } else {
                                                Text("暂无价格")
                                            }
                                        }
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                    .padding(.vertical, 4)
                                    .accessibilityElement(children: .combine)
                                }
                            }
                        }
                        .listStyle(.insetGrouped)
                        .refreshable { await store.refresh() }
                    }
                } else {
                    LoadingOrEmpty(isLoading: true, title: "", message: "", systemImage: "chart.bar")
                }
            }
            .navigationTitle("Token 用量")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ScreenToolbar() }
        }
    }

    private var usage: [UsageSummary] { store.snapshot?.usage ?? [] }
    private var models: [String] { Array(Set(usage.map(\.model))).sorted() }
    private var filteredUsage: [UsageSummary] { selectedModel == "全部模型" ? usage : usage.filter { $0.model == selectedModel } }
    private var totalTokens: Int { filteredUsage.reduce(0) { $0 + $1.totalTokens } }
    private var estimatedCost: String {
        let micros = filteredUsage.compactMap(\.estimatedCostMicros).reduce(0, +)
        return formattedCost(micros)
    }

    private func formattedCost(_ micros: Int) -> String {
        String(format: "$%.4f", locale: Locale(identifier: "en_US_POSIX"), Double(micros) / 1_000_000)
    }

    private func qualityLabel(_ quality: String) -> some View {
        Label(
            quality == "final" ? "最终" : quality == "incomplete" ? "不完整" : "进行中",
            systemImage: quality == "final" ? "checkmark.circle" : quality == "incomplete" ? "exclamationmark.triangle" : "clock"
        )
        .foregroundStyle(quality == "incomplete" ? .orange : .secondary)
    }
}
