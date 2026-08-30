import { describe, expect, it, vi } from "vitest";

import { createIdempotencyKey } from "../src/idempotency.js";

describe("idempotency keys", () => {
  it("uses the native UUID implementation in a secure context", () => {
    const getRandomValues = vi.fn();
    expect(createIdempotencyKey({
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      getRandomValues,
    })).toBe("00000000-0000-4000-8000-000000000001");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("generates a UUID when randomUUID is unavailable over LAN HTTP", () => {
    const key = createIdempotencyKey({
      getRandomValues(values) {
        values.fill(0xab);
        return values;
      },
    });

    expect(key).toBe("abababab-abab-4bab-abab-abababababab");
  });
});
