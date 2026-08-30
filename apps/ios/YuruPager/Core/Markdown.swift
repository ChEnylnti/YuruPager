import Foundation

public enum MarkdownTableAlignment: Equatable, Sendable {
    case left
    case center
    case right
}

public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(AttributedString)
    case heading(level: Int, text: AttributedString)
    case listItem(ordered: Bool, ordinal: Int, level: Int, text: AttributedString)
    case quote(level: Int, text: AttributedString)
    case code(language: String?, text: String)
    case table(header: [AttributedString], rows: [[AttributedString]], alignments: [MarkdownTableAlignment?])
    case thematicBreak
}

public struct MarkdownDocument: Equatable, Sendable {
    public let blocks: [MarkdownBlock]

    public init(source: String) {
        guard let parsed = try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .full)
        ) else {
            blocks = source.isEmpty ? [] : [.paragraph(AttributedString(source))]
            return
        }
        blocks = MarkdownDocument.parse(parsed)
    }

    private init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    private static func parse(_ value: AttributedString) -> [MarkdownBlock] {
        var drafts: [DraftKey: Draft] = [:]
        var order: [TopLevel] = []

        for run in value.runs {
            let slice = sanitized(AttributedString(value[run.range]))
            let key = draftKey(for: run.presentationIntent)
            guard let key else { continue }
            if drafts[key] == nil {
                drafts[key] = Draft(key: key, text: slice)
                order.append(key.topLevel)
            } else {
                drafts[key]?.text.append(slice)
            }
        }

        var result: [MarkdownBlock] = []
        var emittedTables = Set<Int>()
        for topLevel in order {
            switch topLevel {
            case .table(let tableId):
                guard emittedTables.insert(tableId).inserted else { continue }
                result.append(tableBlock(tableId: tableId, drafts: drafts))
            case .draft(let key):
                guard let draft = drafts[key] else { continue }
                if let block = draft.block { result.append(block) }
            }
        }
        return result
    }

    private static func draftKey(for intent: PresentationIntent?) -> DraftKey? {
        guard let intent else { return .paragraph(identity: 0) }
        let components = intent.components
        for component in components {
            if case .codeBlock(let language) = component.kind {
                return .code(identity: component.identity, language: language)
            }
        }
        for component in components {
            if case .header(let level) = component.kind {
                return .heading(identity: component.identity, level: level)
            }
        }
        if let table = components.first(where: { component in
            if case .table = component.kind { return true }
            return false
        }), let cell = components.first(where: { component in
            if case .tableCell = component.kind { return true }
            return false
        }) {
            let tableId = table.identity
            let columns: [PresentationIntent.TableColumn]
            if case .table(let values) = table.kind { columns = values } else { columns = [] }
            let column: Int
            if case .tableCell(let index) = cell.kind { column = index } else { column = 0 }
            let headerRow = components.contains { component in
                if case .tableHeaderRow = component.kind { return true }
                return false
            }
            let rowId = components.first(where: { component in
                if case .tableHeaderRow = component.kind { return true }
                if case .tableRow = component.kind { return true }
                return false
            })?.identity ?? tableId
            let alignment = column < columns.count ? tableAlignment(columns[column].alignment) : nil
            return .tableCell(tableId: tableId, rowId: rowId, column: column, header: headerRow, alignment: alignment)
        }
        if let paragraph = components.first(where: { component in
            if case .paragraph = component.kind { return true }
            return false
        }) {
            if let item = components.first(where: { component in
                if case .listItem = component.kind { return true }
                return false
            }) {
                let ordinal: Int
                if case .listItem(let value) = item.kind { ordinal = value } else { ordinal = 1 }
                let ordered = components.contains { component in
                    if case .orderedList = component.kind { return true }
                    return false
                }
                let level = max(0, intent.indentationLevel)
                return .listItem(identity: paragraph.identity, ordered: ordered, ordinal: ordinal, level: level)
            }
            let quoteLevel = components.reduce(into: 0) { count, component in
                if case .blockQuote = component.kind { count += 1 }
            }
            if quoteLevel > 0 {
                return .quote(identity: paragraph.identity, level: quoteLevel)
            }
            return .paragraph(identity: paragraph.identity)
        }
        if components.contains(where: { component in
            if case .thematicBreak = component.kind { return true }
            return false
        }) {
            return .thematicBreak(identity: components.first?.identity ?? 0)
        }
        return nil
    }

    private static func tableBlock(tableId: Int, drafts: [DraftKey: Draft]) -> MarkdownBlock {
        let cells = drafts.compactMap { key, draft -> TableCell? in
            guard case .tableCell(let id, let rowId, let column, let header, let alignment) = key, id == tableId else { return nil }
            return TableCell(rowId: rowId, column: column, header: header, alignment: alignment, text: draft.text)
        }
        let headerCells = cells.filter(\.header).sorted { $0.column < $1.column }
        let rowIds = Array(Set(cells.filter { !$0.header }.map(\.rowId))).sorted()
        let columnCount = max(cells.map(\.column).max().map { $0 + 1 } ?? 0, headerCells.count)
        let header = fill(cells: headerCells, columnCount: columnCount)
        let rows = rowIds.map { rowId in
            fill(cells: cells.filter { !$0.header && $0.rowId == rowId }.sorted { $0.column < $1.column }, columnCount: columnCount)
        }
        let alignments = (0..<columnCount).map { column in
            cells.first(where: { $0.column == column })?.alignment
        }
        return .table(header: header, rows: rows, alignments: alignments)
    }

    private static func fill(cells: [TableCell], columnCount: Int) -> [AttributedString] {
        guard columnCount > 0 else { return [] }
        var result = Array(repeating: AttributedString(""), count: columnCount)
        for cell in cells where cell.column < columnCount { result[cell.column] = cell.text }
        return result
    }

    private static func tableAlignment(_ alignment: PresentationIntent.TableColumn.Alignment) -> MarkdownTableAlignment {
        switch alignment {
        case .left: return .left
        case .center: return .center
        case .right: return .right
        @unknown default: return .left
        }
    }

    private static func sanitized(_ value: AttributedString) -> AttributedString {
        var value = value
        for run in value.runs {
            guard let link = run.link else { continue }
            if link.scheme?.lowercased() == "http" || link.scheme?.lowercased() == "https" { continue }
            value[run.range].link = nil
        }
        return value
    }

    private struct TableCell {
        let rowId: Int
        let column: Int
        let header: Bool
        let alignment: MarkdownTableAlignment?
        let text: AttributedString
    }

    private struct Draft {
        let key: DraftKey
        var text: AttributedString

        var block: MarkdownBlock? {
            switch key {
            case .paragraph: return .paragraph(text)
            case .heading(_, let level): return .heading(level: level, text: text)
            case .listItem(_, let ordered, let ordinal, let level): return .listItem(ordered: ordered, ordinal: ordinal, level: level, text: text)
            case .quote(_, let level): return .quote(level: level, text: text)
            case .code(_, let language):
                var code = String(text.characters)
                if code.last == "\n" { code.removeLast() }
                return .code(language: language, text: code)
            case .thematicBreak: return .thematicBreak
            case .tableCell: return nil
            }
        }
    }

    private enum TopLevel: Hashable {
        case draft(DraftKey)
        case table(Int)
    }

    private enum DraftKey: Hashable {
        case paragraph(identity: Int)
        case heading(identity: Int, level: Int)
        case listItem(identity: Int, ordered: Bool, ordinal: Int, level: Int)
        case quote(identity: Int, level: Int)
        case code(identity: Int, language: String?)
        case tableCell(tableId: Int, rowId: Int, column: Int, header: Bool, alignment: MarkdownTableAlignment?)
        case thematicBreak(identity: Int)

        var topLevel: TopLevel {
            if case .tableCell(let tableId, _, _, _, _) = self { return .table(tableId) }
            return .draft(self)
        }
    }
}
