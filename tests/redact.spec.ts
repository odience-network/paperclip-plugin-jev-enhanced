import { describe, expect, it } from "vitest";
import { redactText, truncateHeadTail } from "../src/jev/redact.js";

describe("redactText", () => {
  it("replaces every pattern match, case-insensitively", () => {
    expect(redactText("Email me at FOO@bar.com", ["foo@bar\\.com"])).toBe("Email me at [REDACTED]");
  });

  it("skips an invalid pattern instead of throwing", () => {
    expect(() => redactText("hello", ["(unclosed"])).not.toThrow();
    expect(redactText("hello", ["(unclosed"])).toBe("hello");
  });
});

describe("truncateHeadTail", () => {
  it("leaves short text untouched", () => {
    expect(truncateHeadTail("short", 100)).toBe("short");
  });

  it("keeps the head and tail and marks what was omitted", () => {
    const text = "A".repeat(20) + "B".repeat(20) + "C".repeat(20);
    const truncated = truncateHeadTail(text, 30, 10, 10);
    expect(truncated.startsWith("A".repeat(10))).toBe(true);
    expect(truncated.endsWith("C".repeat(10))).toBe(true);
    expect(truncated).toContain("characters truncated");
  });
});
