import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "../src/markdown-message.js";

describe("MarkdownMessage", () => {
  it("renders common model formatting without exposing the markdown syntax", () => {
    render(
      <MarkdownMessage
        source={'# 每日重点\n\n1. **重要事项**\n2. [查看来源](https://example.com/news)\n\n> 需要注意\n\n```js\nconst ready = true;\n```'}
      />,
    );

    expect(screen.getByRole("heading", { name: "每日重点" })).toBeVisible();
    expect(screen.getByText("重要事项")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看来源" })).toHaveAttribute("href", "https://example.com/news");
    expect(screen.getByText("需要注意")).toBeVisible();
    expect(screen.getByText("const ready = true;")).toBeVisible();
    expect(screen.queryByText("# 每日重点")).not.toBeInTheDocument();
    expect(screen.queryByText("**重要事项**")).not.toBeInTheDocument();
  });

  it("keeps unsafe links and raw HTML inert, and does not fetch markdown images", () => {
    const { container } = render(
      <MarkdownMessage source={'[危险](javascript:alert(1))\n\n![远程图片](https://tracker.example/image.png)\n\n<script>alert(1)</script>'} />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("图片：远程图片")).toBeVisible();
    expect(container.textContent).toContain("alert(1)");
  });

  it("unwraps Codex protocol tags before rendering the assistant Markdown", () => {
    const { container } = render(
      <MarkdownMessage source={"<message><heartbeat>\n## 风险提醒\n\n1. **权限风险**：检查工具边界。\n</message></heartbeat>"} />,
    );

    expect(screen.getByRole("heading", { name: "风险提醒" })).toBeVisible();
    expect(screen.getByText("权限风险", { exact: false })).toBeVisible();
    expect(container.textContent).not.toContain("<message>");
    expect(container.textContent).not.toContain("</heartbeat>");
    expect(screen.queryByText("## 风险提醒")).not.toBeInTheDocument();
  });

  it("leaves user-authored markdown as plain text", () => {
    const { container } = render(<p className="message-plain">{"# 标题 **不是格式**"}</p>);
    expect(container.querySelector("h4")).toBeNull();
    expect(container.textContent).toBe("# 标题 **不是格式**");
  });
});
