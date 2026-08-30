import { describe, expect, it } from "vitest";

import { resolveBasePath } from "../src/base-path.js";

describe("resolveBasePath", () => {
  it("derives a reverse-proxy subpath from a relative production base", () => {
    expect(resolveBasePath("./", "https://example.com/yurupager/?view=inbox")).toBe("/yurupager/");
  });

  it("preserves explicit root and nested deployment bases", () => {
    expect(resolveBasePath("/", "https://example.com/yurupager/")).toBe("/");
    expect(resolveBasePath("/console", "https://example.com/")).toBe("/console/");
  });
});
