import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tokensCss = readFileSync(resolve(process.cwd(), "frontend/src/styles/tokens.css"), "utf8");
const provisionCss = readFileSync(resolve(process.cwd(), "frontend/src/styles/provision.css"), "utf8");

function getBlock(source: string, startPattern: RegExp): string {
  const startMatch = source.match(startPattern);
  expect(startMatch).not.toBeNull();

  const startIndex = startMatch!.index! + startMatch![0].length;
  let depth = 1;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(startIndex, index);
    }
  }

  throw new Error(`Could not find block for pattern: ${startPattern}`);
}

describe("provision dark mode semantic tokens", () => {
  it("defines semantic dark-mode background overrides in the explicit dark theme block", () => {
    const darkThemeBlock = getBlock(tokensCss, /\[data-theme="dark"\]\s*\{/);

    expect(darkThemeBlock).toMatch(/--accent-bg\s*:/);
    expect(darkThemeBlock).toMatch(/--accent-bg-warm\s*:/);
    expect(darkThemeBlock).toMatch(/--success-bg\s*:/);
    expect(darkThemeBlock).toMatch(/--warning-bg\s*:/);
    expect(darkThemeBlock).toMatch(/--danger-bg\s*:/);
    expect(darkThemeBlock).toMatch(/--info-bg\s*:/);
  });

  it("defines semantic dark-mode background overrides in the system preference fallback block", () => {
    const mediaDarkBlock = getBlock(tokensCss, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);

    expect(mediaDarkBlock).toMatch(/--accent-bg\s*:/);
    expect(mediaDarkBlock).toMatch(/--accent-bg-warm\s*:/);
    expect(mediaDarkBlock).toMatch(/--success-bg\s*:/);
    expect(mediaDarkBlock).toMatch(/--warning-bg\s*:/);
    expect(mediaDarkBlock).toMatch(/--danger-bg\s*:/);
    expect(mediaDarkBlock).toMatch(/--info-bg\s*:/);
  });

  it("routes the known provision active and badge surfaces through semantic tokens", () => {
    expect(provisionCss).toMatch(/\.provision-mode-option-active\s*\{[^}]*background:\s*var\(--accent-bg\)/s);
    expect(provisionCss).toMatch(/\.provision-runtime-option-active\s*\{[^}]*background:\s*var\(--accent-bg\)/s);
    expect(provisionCss).toMatch(/\.provision-config-pill-emphasis\s*\{[^}]*background:\s*var\(--accent-bg-warm\)/s);
    expect(provisionCss).toMatch(/\.provision-disclosure-badge--complete\s*\{[^}]*background:\s*var\(--success-bg\)/s);
    expect(provisionCss).toMatch(/\.provision-env-card-selected\s*\{[^}]*background:\s*var\(--accent-bg\)/s);
    expect(provisionCss).toMatch(/\.provision-env-card-badge\s*\{[^}]*background:\s*var\(--accent-bg\)/s);
  });
});
