import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sdkPkg = JSON.parse(readFileSync(require.resolve("@typesafe-ai/sdk/package.json"), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function nodeMajorFloor(range: string): number {
  const match = /^>=\s*(\d+)/.exec(range.trim());
  if (!match) throw new Error(`Unsupported engines.node range "${range}"`);
  return Number(match[1]);
}

describe("Node version floor", () => {
  it("matches between package.json engines, the TypeSafe SDK's engines and CI", () => {
    const floor = nodeMajorFloor(pkg.engines.node);
    expect(floor).toBe(nodeMajorFloor(sdkPkg.engines.node));
    const ciVersions = [...ci.matchAll(/node-version:\s*["']?(\d+)/g)].map((m) => Number(m[1]));
    expect(ciVersions.length).toBeGreaterThan(0);
    for (const version of ciVersions) expect(version).toBe(floor);
  });
});
