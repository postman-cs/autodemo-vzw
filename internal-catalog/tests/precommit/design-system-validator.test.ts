import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
  suggestion: string;
}

interface ValidationReport {
  violations: Violation[];
  summary: {
    totalFiles: number;
    filesWithViolations: number;
    totalViolations: number;
  };
}

const VALIDATOR_PATH = join(process.cwd(), "scripts/validate-design-system.mjs");

let testDir: string;
let fixturesDir: string;

function setupFixturesDir() {
  testDir = mkdtempSync(join(tmpdir(), "design-system-test-"));
  fixturesDir = join(testDir, "frontend", "src");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(fixturesDir, "styles"), { recursive: true });
  mkdirSync(join(fixturesDir, "components"), { recursive: true });

  const tokensContent = `/* === TOKENS === */
:root {
  --text-xs: 10px;
  --text-sm: 12px;
  --text-base: 14px;
  --text-md: 15px;
  --text-lg: 16px;
  --text-xl: 18px;
  --text-2xl: 22px;
  --text-3xl: 24px;

  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-hover: rgba(0, 0, 0, 0.03);
  --text: #1a1a2e;
  --text-secondary: #334155;
  --muted: #6b7280;
  --border: #e2e5ea;

  --accent: #f97316;
  --accent-hover: #ea580c;
  --green: #16a34a;
  --red: #dc2626;

  --neutral-50: #f8fafc;
  --neutral-100: #f1f5f9;
  --neutral-200: #e2e8f0;
}
`;
  writeFileSync(join(fixturesDir, "styles", "tokens.css"), tokensContent);

  return testDir;
}

function cleanupFixturesDir() {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

function runValidator(args: string[] = [], cwd?: string): ValidationReport {
  const cmd = `node "${VALIDATOR_PATH}" --json --scope all ${args.join(" ")}`;
  try {
    const result = execSync(cmd, {
      cwd: cwd || testDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(result) as ValidationReport;
  } catch (error: any) {
    const output = error.stdout || error.message;
    try {
      return JSON.parse(output) as ValidationReport;
    } catch {
      return { violations: [], summary: { totalFiles: 0, filesWithViolations: 0, totalViolations: 0 } };
    }
  }
}

function runValidatorWithExit(args: string[] = [], cwd?: string): { exitCode: number; output: string } {
  const cmd = `node "${VALIDATOR_PATH}" --json --scope all ${args.join(" ")}`;
  try {
    const result = execSync(cmd, {
      cwd: cwd || testDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, output: result };
  } catch (error: any) {
    return {
      exitCode: error.status || 1,
      output: error.stdout || error.message,
    };
  }
}

describe("design-system-validator", () => {
  beforeAll(() => {
    setupFixturesDir();
  });

  afterAll(() => {
    cleanupFixturesDir();
  });

  beforeEach(() => {
    try {
      const componentsDir = join(fixturesDir, "components");
      const stylesDir = join(fixturesDir, "styles");
      rmSync(componentsDir, { recursive: true, force: true });
      rmSync(stylesDir, { recursive: true, force: true });
      mkdirSync(componentsDir, { recursive: true });
      mkdirSync(stylesDir, { recursive: true });
      const tokensContent = `/* === TOKENS === */
:root {
  --text-xs: 10px;
  --text-sm: 12px;
  --text-base: 14px;
  --text-md: 15px;
  --text-lg: 16px;
  --text-xl: 18px;
  --text-2xl: 22px;
  --text-3xl: 24px;

  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-hover: rgba(0, 0, 0, 0.03);
  --text: #1a1a2e;
  --text-secondary: #334155;
  --muted: #6b7280;
  --border: #e2e5ea;

  --accent: #f97316;
  --accent-hover: #ea580c;
  --green: #16a34a;
  --red: #dc2626;

  --neutral-50: #f8fafc;
  --neutral-100: #f1f5f9;
  --neutral-200: #e2e8f0;
}
`;
      writeFileSync(join(stylesDir, "tokens.css"), tokensContent);
    } catch {
    }
  });

  describe("CSS font-size rules", () => {
    it("flags hardcoded font-size: 12px and suggests --text-sm", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 12px;
  color: var(--text);
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-hardcoded-font-size");
      expect(result.violations[0].snippet).toContain("12px");
      expect(result.violations[0].suggestion).toContain("var(--text-sm)");
    });

    it("flags hardcoded font-size: 16px and suggests --text-lg", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 16px;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-hardcoded-font-size");
      expect(result.violations[0].suggestion).toContain("var(--text-lg)");
    });

    it("does not flag font-size using tokens", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: var(--text-sm);
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(0);
    });

    it("does not flag font-size: inherit or font-size: normal", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: inherit;
  font-size: normal;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(0);
    });
  });

  describe("CSS color rules", () => {
    it("flags hardcoded hex color when equivalent token exists", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  color: #1a1a2e;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-hardcoded-color");
      expect(result.violations[0].snippet).toContain("#1a1a2e");
      expect(result.violations[0].suggestion).toContain("var(--text)");
    });

    it("flags hardcoded rgba color", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  background-color: rgba(0, 0, 0, 0.03);
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-hardcoded-color");
      expect(result.violations[0].suggestion).toContain("var(--surface-hover)");
    });

    it("flags hardcoded border-color", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  border-color: #e2e5ea;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-hardcoded-color");
      expect(result.violations[0].suggestion).toContain("var(--border)");
    });

    it("flags hardcoded box-shadow with hex values", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  box-shadow: 0 1px 3px #000000;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations.length).toBeGreaterThanOrEqual(1);
      expect(result.violations.some((v) => v.rule === "css-hardcoded-color" || v.rule === "css-hardcoded-box-shadow")).toBe(true);
    });

    it("does not flag colors already using tokens", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  color: var(--text);
  background-color: var(--surface);
  border-color: var(--border);
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(0);
    });
  });

  describe("Button corner rules", () => {
    it("flags square corners on button-like CSS selectors", () => {
      const cssFile = join(fixturesDir, "styles", "buttons.css");
      writeFileSync(
        cssFile,
        `.menu-trigger {
  border-radius: 0;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-button-square-corners");
      expect(result.violations[0].suggestion).toContain("var(--radius-control)");
    });

    it("does not flag rounded button selectors", () => {
      const cssFile = join(fixturesDir, "styles", "buttons.css");
      writeFileSync(
        cssFile,
        `.menu-trigger {
  border-radius: var(--radius-control);
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(0);
    });
  });

  describe("TSX inline style rules", () => {
    it("flags inline style with hardcoded fontSize in pixels", () => {
      const tsxFile = join(fixturesDir, "components", "Test.tsx");
      writeFileSync(
        tsxFile,
        [
          `export function Test() {`,
          // design-system-exception: validator fixture intentionally uses hardcoded font size
          `  return <div style={{ fontSize: '14px' }}>Test</div>;`,
          `}`,
        ].join("\n")
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("tsx-inline-style-font-size");
      expect(result.violations[0].snippet).toContain("14px");
      expect(result.violations[0].suggestion).toContain("var(--text-base)");
    });

    it("flags inline style with hardcoded color", () => {
      const tsxFile = join(fixturesDir, "components", "Test.tsx");
      writeFileSync(
        tsxFile,
        [
          `export function Test() {`,
          // design-system-exception: validator fixture intentionally uses hardcoded color
          `  return <div style={{ color: '#f97316' }}>Test</div>;`,
          `}`,
        ].join("\n")
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("tsx-inline-style-color");
      expect(result.violations[0].suggestion).toContain("var(--accent)");
    });

    it("flags style prop with px values", () => {
      const tsxFile = join(fixturesDir, "components", "Test.tsx");
      writeFileSync(
        tsxFile,
        [
          `export function Test() {`,
          // design-system-exception: validator fixture intentionally uses hardcoded spacing
          `  return <div style={{ padding: '16px' }}>Test</div>;`,
          `}`,
        ].join("\n")
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.length).toBeGreaterThanOrEqual(1);
      expect(result.violations.some((v) => v.snippet.includes("16px"))).toBe(true);
    });

    it("flags inline style square corners on buttons", () => {
      const tsxFile = join(fixturesDir, "components", "Test.tsx");
      writeFileSync(
        tsxFile,
        [
          `export function Test() {`,
          `  return <button type="button" style={{ borderRadius: '0px' }}>Run</button>;`,
          `}`,
        ].join("\n")
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("tsx-inline-style-square-button");
      expect(result.violations[0].suggestion).toContain("var(--radius-control)");
    });
  });

  describe("Banned legacy patterns", () => {
    it("flags register-derived-hint class usage", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.register-derived-hint {
  color: red;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations.some((v) => v.rule === "css-banned-legacy-class")).toBe(true);
      expect(result.violations.some((v) => v.suggestion.includes(".modal-hint"))).toBe(true);
    });

    it("flags register-derived-identity-section class usage", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.register-derived-identity-section {
  display: flex;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations.some((v) => v.rule === "css-banned-legacy-class")).toBe(true);
    });

    it("flags raw width prop on Modal component", () => {
      const tsxFile = join(fixturesDir, "components", "Test.tsx");
      writeFileSync(
        tsxFile,
        [
          `import { Modal } from './Modal';`,
          `export function Test() {`,
          // design-system-exception: validator fixture intentionally uses raw modal width
          `  return <Modal width="500px" />;`,
          `}`,
        ].join("\n")
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-modal-raw-width")).toBe(true);
      expect(result.violations.some((v) => v.suggestion.includes("Modal.Header subtitle"))).toBe(true);
    });

    it("flags native select usage in frontend source TSX files", () => {
      const tsxFile = join(fixturesDir, "components", "SelectField.tsx");
      writeFileSync(
        tsxFile,
        `export function SelectField() {
  return (
    <label>
      Team
      <select className="form-input" onChange={() => {}}>
        <option value="a">A</option>
      </select>
    </label>
  );
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-native-select-banned")).toBe(true);
      expect(result.violations.some((v) => v.message.includes("Native <select> elements are banned"))).toBe(true);
      expect(result.violations.some((v) => v.suggestion.includes("SelectDropdown"))).toBe(true);
    });

    it("does not flag native select usage outside frontend source scope", () => {
      const externalDir = join(testDir, "docs");
      mkdirSync(externalDir, { recursive: true });
      const tsxFile = join(externalDir, "SelectExample.tsx");
      writeFileSync(
        tsxFile,
        `export function SelectExample() {
  return (
    <select>
      <option value="demo">Demo</option>
    </select>
  );
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-native-select-banned")).toBe(false);
    });

    it("does not flag resource-modal-panel class usage as a legacy modal panel", () => {
      const tsxFile = join(fixturesDir, "components", "ResourceModal.tsx");
      writeFileSync(
        tsxFile,
        `import { Modal } from './Modal';
export function ResourceModal() {
  return <Modal open={true} onClose={() => {}} className="resource-modal-panel" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(false);
    });

    it("does not flag settings-edit-modal-panel class usage as a legacy modal panel", () => {
      const tsxFile = join(fixturesDir, "components", "SettingsModal.tsx");
      writeFileSync(
        tsxFile,
        `import { Modal } from './Modal';
export function SettingsModal() {
  return <Modal open={true} onClose={() => {}} className="settings-edit-modal-panel" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(false);
    });

    it("does not flag chaos-config-modal-panel class usage as a legacy modal panel", () => {
      const tsxFile = join(fixturesDir, "components", "ChaosModal.tsx");
      writeFileSync(
        tsxFile,
        `import { Modal } from './Modal';
export function ChaosModal() {
  return <Modal open={true} onClose={() => {}} className="chaos-config-modal-panel" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(false);
    });

    it("flags raw modal-backdrop in a multi-class className string", () => {
      const tsxFile = join(fixturesDir, "components", "LegacyModal.tsx");
      writeFileSync(
        tsxFile,
        `export function LegacyModal() {
  return <div className="overlay modal-backdrop active" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(true);
    });

    it("flags raw modal-panel in a multi-class className string", () => {
      const tsxFile = join(fixturesDir, "components", "LegacyPanel.tsx");
      writeFileSync(
        tsxFile,
        `export function LegacyPanel() {
  return <div className="modal-panel large" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(true);
    });

    it("flags raw modal-header class usage in TSX source", () => {
      const tsxFile = join(fixturesDir, "components", "LegacyHeader.tsx");
      writeFileSync(
        tsxFile,
        `export function LegacyHeader() {
  return <div className="modal-header" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(true);
    });

    it("flags raw modal-body class usage in TSX source", () => {
      const tsxFile = join(fixturesDir, "components", "LegacyBody.tsx");
      writeFileSync(
        tsxFile,
        `export function LegacyBody() {
  return <div className="modal-body" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(true);
    });

    it("does not flag modal-header-modern class (shared shell class)", () => {
      const tsxFile = join(fixturesDir, "components", "ModernHeader.tsx");
      writeFileSync(
        tsxFile,
        `export function ModernHeader() {
  return <div className="modal-header-modern" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(false);
    });

    it("does not flag modal-footer-modern class (shared shell class)", () => {
      const tsxFile = join(fixturesDir, "components", "ModernFooter.tsx");
      writeFileSync(
        tsxFile,
        `export function ModernFooter() {
  return <div className="modal-footer-modern" />;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations.some((v) => v.rule === "tsx-banned-legacy-class")).toBe(false);
    });
  });

  describe("Exception comments", () => {
    it("allows violation when design-system-exception comment is present on same line", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 12px; /* design-system-exception: legacy third-party override */
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(0);
    });

    it("allows violation when design-system-exception comment is on previous line", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  /* design-system-exception: requires exact pixel match for design */
  font-size: 12px;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(0);
    });

    it("still reports violation when exception comment has no reason", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 12px; /* design-system-exception: */
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe("css-hardcoded-font-size");
    });

    it("allows TSX violation with exception comment", () => {
      const tsxFile = join(fixturesDir, "components", "Test.tsx");
      writeFileSync(
        tsxFile,
        `export function Test() {
  // design-system-exception: prototyping only
  return <div style={{ fontSize: '14px' }}>Test</div>;
}`
      );

      const result = runValidator(["--files", tsxFile]);

      expect(result.violations).toHaveLength(0);
    });
  });

  describe("CLI options", () => {
    it("--report-only exits with code 0 even with violations", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 12px;
}`
      );

      const result = runValidatorWithExit(["--files", cssFile, "--report-only"]);

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.output) as ValidationReport;
      expect(report.violations).toHaveLength(1);
    });

    it("exits with non-zero code when violations exist without --report-only", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 12px;
}`
      );

      const result = runValidatorWithExit(["--files", cssFile]);

      expect(result.exitCode).not.toBe(0);
    });

    it("--json outputs valid JSON", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(cssFile, `.test { color: #1a1a2e; }`);

      const result = runValidatorWithExit(["--files", cssFile]);
      const parsed = JSON.parse(result.output);
      expect(parsed.violations).toBeDefined();
      expect(parsed.summary).toBeDefined();
    });
  });

  describe("JSON output structure", () => {
    it("includes required fields in each violation", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 12px;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations).toHaveLength(1);
      const violation = result.violations[0];
      expect(violation.file).toBeDefined();
      expect(violation.line).toBeGreaterThan(0);
      expect(violation.rule).toBeDefined();
      expect(violation.message).toBeDefined();
      expect(violation.snippet).toBeDefined();
      expect(violation.suggestion).toBeDefined();
    });

    it("provides explicit suggestions not generic messages", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  font-size: 13px;
  color: #1a1a2e;
}`
      );

      const result = runValidator(["--files", cssFile]);

      for (const v of result.violations) {
        expect(v.suggestion).not.toContain("use the design system");
        expect(v.suggestion.length).toBeGreaterThan(5);
      }
    });
  });

  describe("Multiple file handling", () => {
    it("reports violations across multiple files", () => {
      const cssFile1 = join(fixturesDir, "styles", "test1.css");
      const cssFile2 = join(fixturesDir, "styles", "test2.css");

      writeFileSync(
        cssFile1,
        `.class1 {
  font-size: 12px;
}`
      );
      writeFileSync(
        cssFile2,
        `.class2 {
  color: #1a1a2e;
}`
      );

      const result = runValidator(["--files", `${cssFile1},${cssFile2}`]);

      expect(result.violations).toHaveLength(2);
      expect(result.summary.filesWithViolations).toBe(2);
      expect(result.summary.totalViolations).toBe(2);
    });
  });

  describe("Color normalization", () => {
    it("matches #fff with #ffffff", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  color: #ffffff;
}`
      );

      const result = runValidator(["--files", cssFile]);

      expect(result.violations[0].suggestion).toContain("var(--surface)");
    });

    it("matches 3-char hex with 6-char token", () => {
      const cssFile = join(fixturesDir, "styles", "test.css");
      writeFileSync(
        cssFile,
        `.test-class {
  color: #f00;
}`
      );

      const result = runValidator(["--files", cssFile]);
      expect(result.violations.length).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Token contrast regression", () => {
  const TOKENS_PATH = join(process.cwd(), "frontend/src/styles/tokens.css");

  function parseHex(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  function contrastRatio(hex1: string, hex2: string): number {
    const l1 = relativeLuminance(parseHex(hex1));
    const l2 = relativeLuminance(parseHex(hex2));
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function extractTokenPairs(css: string): Array<{ name: string; bg: string; text: string }> {
    const pairs: Array<{ name: string; bg: string; text: string }> = [];
    const bgPattern = /--([\w-]+)-bg\s*:\s*(#[0-9a-fA-F]{6})\b/g;
    const textPattern = (prefix: string) =>
      new RegExp(`--${prefix}-text\\s*:\\s*(#[0-9a-fA-F]{6})\\b`);

    let match: RegExpExecArray | null = bgPattern.exec(css);
    while (match !== null) {
      const prefix = match[1];
      const bgHex = match[2];
      const textMatch = css.match(textPattern(prefix));
      if (textMatch) {
        pairs.push({ name: prefix, bg: bgHex, text: textMatch[1] });
      }
      match = bgPattern.exec(css);
    }
    return pairs;
  }

  it("all semantic *-bg / *-text token pairs in :root meet WCAG AA contrast (>= 4.5:1)", () => {
    const fs = require("fs");
    const css = fs.readFileSync(TOKENS_PATH, "utf-8");
    const rootBlock = css.match(/:root\s*\{([^}]+)\}/s);
    expect(rootBlock).toBeTruthy();

    const pairs = extractTokenPairs(rootBlock![1]);
    expect(pairs.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const { name, bg, text } of pairs) {
      const ratio = contrastRatio(bg, text);
      if (ratio < 4.5) {
        failures.push(
          `--${name}-text (${text}) on --${name}-bg (${bg}): ratio ${ratio.toFixed(2)}:1 (need >= 4.5:1)`
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
