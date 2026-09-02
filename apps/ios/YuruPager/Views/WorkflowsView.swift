import SwiftUI

/// Run monitoring for planning workflows (ADR-032..036). iOS is
/// intentionally read-only: canvas editing stays on the desktop console.
/// Gate approvals ride the shared request inbox decision sheet.
struct WorkflowsView: View {
    @EnvironmentObject private var store: AppStore

    @State private var workflows: [WorkflowSummary] = []
    @State private var runsByWorkflow: [String: [WorkflowRunSummary]] = [:]
    @State private var loadError: String?

    var body: some View {
        Group {
            if workflows.isEmpty {
                if loadError !== nil {
                    ContentUnavailableView("无法读取工作流", systemImage: "flowchart")
                } else {
                    ContentUnavailableView("没有工作流", systemImage: "flowchart")
                }
            } else {
                List {
                    ForEach(workflows) { workflow in
                        Section(workflow.name) {
                            if let runs = runsByWorkflow[workflow.id], !runs.isEmpty {
                                ForEach(runs.prefix(5)) { run in
                                    NavigationLink {
                                        WorkflowRunDetailView(run: run, workflowName: workflow.name)
                                    } label: {
                                        WorkflowRunRow(run: run)
                                    }
                                }
                            } else {
                                Text("暂无运行").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle("工作流")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let workspaceId = store.selectedWorkspaceId else { return }
        do {
            let fetched = try await store.workflowsAPI.workflows(workspaceId: workspaceId)
            workflows = fetched
            var runs: [String: [WorkflowRunSummary]] = [:]
            for workflow in fetched {
                runs[workflow.id] = try? await store.workflowsAPI.workflowRuns(workflowId: workflow.id, workspaceId: workspaceId)
            }
            runsByWorkflow = runs
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct WorkflowRunRow: View {
    let run: WorkflowRunSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(run.id.suffix(8)).font(.headline.monospaced())
                Spacer()
                Text(run.status).font(.caption).foregroundStyle(runStatusColor)
            }
            if let nodes = run.nodes, !nodes.isEmpty {
                Text(nodes.map { "\($0.nodeId.suffix(6))·\($0.status)" }.joined(separator: "  "))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let reason = run.reasonCode {
                Text(reason).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }

    private var runStatusColor: Color {
        switch run.status {
        case "completed": .green
        case "failed": .red
        case "running": .accentColor
        default: .secondary
        }
    }
}

struct WorkflowRunDetailView: View {
    let run: WorkflowRunSummary
    let workflowName: String

    var body: some View {
        List {
            Section("状态") {
                LabeledContent("Run", value: String(run.id.suffix(8)))
                LabeledContent("状态", value: run.status)
                if let reason = run.reasonCode {
                    LabeledContent("原因", value: reason)
                }
                LabeledContent("更新于") {
                    Text(Labels.relativeDate(run.updatedAt))
                }
            }
            if let nodes = run.nodes, !nodes.isEmpty {
                Section("节点时间线") {
                    ForEach(nodes) { node in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(String(node.nodeId.suffix(10))).font(.headline.monospaced())
                                Spacer()
                                Text(node.status).font(.caption).foregroundStyle(.secondary)
                            }
                            Text("尝试 \(node.attempts) 次").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            Section("审批") {
                Text("人工审批门出现在请求列表，使用既有审批页批准或拒绝。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(workflowName)
        .navigationBarTitleDisplayMode(.inline)
    }
}
