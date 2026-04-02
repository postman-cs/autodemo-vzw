#!/usr/bin/env node

/**
 * Design System Validator
 *
 * Validates that frontend code uses design tokens instead of hardcoded values.
 * Reads tokens from frontend/src/styles/tokens.css and checks for violations.
 *
 * Usage:
 *   node scripts/validate-design-system.mjs [options]
 *
 * Options:
 *   --scope changed|all     Scan changed files only or all files (default: changed)
 *   --staged                Include staged files in changed scope
 *   --files <paths>         Comma-separated list of specific files to check
 *   --json                  Output results as JSON
 *   --report-only           Always exit with code 0, just report findings
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, relative } from "path";

const DEFAULT_GLOB = "frontend/src/**/*.{css,ts,tsx}";
const TOKENS_PATH = "frontend/src/styles/tokens.css";

const BANNED_LEGACY_CLASSES = [
  { pattern: /register-derived-hint/g, replacement: ".modal-hint" },
  { pattern: /register-derived-identity-section/g, replacement: "Modal.Header subtitle" },
  { pattern: /className=["']modal-backdrop["']/g, replacement: "Modal component (no raw .modal-backdrop)" },
  { pattern: /className=["']modal-panel["']/g, replacement: "Modal component (no raw .modal-panel)" },
];

// Legacy modal class names that must not appear as standalone tokens in className attributes.
// These are matched as whole class tokens (space-delimited) to avoid false positives on
// legitimate consumer classes like resource-modal-panel, settings-edit-modal-panel,
// chaos-config-modal-panel, modal-header-modern, modal-footer-modern.
const BANNED_LEGACY_MODAL_TOKENS = [
  { token: "modal-backdrop", replacement: "Modal component (no raw .modal-backdrop)" },
  { token: "modal-panel", replacement: "Modal component (no raw .modal-panel)" },
  { token: "modal-header", replacement: "Modal.Header compound component (no raw .modal-header)" },
  { token: "modal-body", replacement: "Modal.Body compound component (no raw .modal-body)" },
];

/**
 * Returns true if `token` appears as a standalone class token within a className attribute value.
 * Matches `className="... token ..."` where token is surrounded by quote boundaries or spaces.
 * Does NOT match when token appears as a substring of a longer class name (e.g. modal-header-modern).
 */
function classNameContainsToken(line, token) {
  // Match className="..." or className='...' and check if token is a standalone word in the value
  const classNameRegex = /className=["']([^"']*)["']/g;
  let match = classNameRegex.exec(line);
  while (match !== null) {
    const classValue = match[1];
    // Split on whitespace and check for exact token match
    const classes = classValue.split(/\s+/);
    if (classes.includes(token)) {
      return true;
    }
    match = classNameRegex.exec(line);
  }
  return false;
}

function isFrontendSourceFile(filePath) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return normalizedPath.includes("/frontend/src/");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    scope: "changed",
    staged: false,
    files: null,
    json: false,
    reportOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--scope":
        options.scope = args[++i];
        break;
      case "--staged":
        options.staged = true;
        break;
      case "--files":
        options.files = args[++i];
        break;
      case "--json":
        options.json = true;
        break;
      case "--report-only":
        options.reportOnly = true;
        break;
    }
  }

  return options;
}

function normalizeHex(color) {
  if (!color) return null;

  color = color.toLowerCase().trim();

  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length === 6) {
      return `#${hex}`;
    }
  }

  if (color.startsWith("rgba(")) {
    const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (match) {
      const r = parseInt(match[1], 10).toString(16).padStart(2, "0");
      const g = parseInt(match[2], 10).toString(16).padStart(2, "0");
      const b = parseInt(match[3], 10).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }
  }

  return color;
}

function parseTokens(tokensPath) {
  if (!existsSync(tokensPath)) {
    throw new Error(`Tokens file not found: ${tokensPath}`);
  }

  const content = readFileSync(tokensPath, "utf-8");
  const fontSizeTokens = new Map();
  const colorTokens = new Map();

  const varRegex = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match;

  match = varRegex.exec(content);
  while (match !== null) {
    const [, name, value] = match;
    const trimmedValue = value.trim();

    if (trimmedValue.endsWith("px")) {
      const pxValue = parseInt(trimmedValue, 10);
      if (!isNaN(pxValue)) {
        fontSizeTokens.set(pxValue, name);
      }
    }

    if (trimmedValue.startsWith("#") || trimmedValue.startsWith("rgba(")) {
      const normalized = normalizeHex(trimmedValue);
      if (normalized) {
        if (!colorTokens.has(normalized)) {
          colorTokens.set(normalized, []);
        }
        colorTokens.get(normalized).push(name);
      }
    }
    match = varRegex.exec(content);
  }

  return { fontSizeTokens, colorTokens };
}

function findNearestToken(value, tokenMap) {
  if (tokenMap.has(value)) {
    return tokenMap.get(value);
  }
  return null;
}

function findClosestColorToken(colorValue, colorTokens) {
  const normalized = normalizeHex(colorValue);
  if (!normalized) return null;

  if (colorTokens.has(normalized)) {
    const tokens = colorTokens.get(normalized);
    return tokens[0];
  }

  return null;
}

function getChangedFiles(includeStaged = false) {
  try {
    const stagedCmd = includeStaged ? " --cached" : "";
    const diffOutput = execSync(
      `git diff${stagedCmd} --name-only --diff-filter=ACMRT`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );

    const files = diffOutput
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .filter((f) => f.match(/\.(css|ts|tsx)$/));

    return files;
  } catch {
    return [];
  }
}

function hasExceptionComment(lines, lineIndex) {
  const currentLine = lines[lineIndex] || "";

  const currentLineMatch = currentLine.match(/design-system-exception:\s*([^*]+)/);
  if (currentLineMatch) {
    const reason = currentLineMatch[1].trim();
    return reason.length > 0 && !reason.match(/^\s*$/);
  }

  if (lineIndex > 0) {
    const prevLine = lines[lineIndex - 1] || "";
    const prevLineMatch = prevLine.match(/design-system-exception:\s*([^*]+)/);
    if (prevLineMatch) {
      const reason = prevLineMatch[1].trim();
      return reason.length > 0 && !reason.match(/^\s*$/);
    }
  }

  return false;
}

function isButtonLikeSelector(selector) {
  return /(\bbutton\b|\[type\s*=\s*["']?(button|submit|reset)["']?\]|\[role\s*=\s*["']button["']\]|\.btn\b|-button\b|-trigger\b)/i.test(selector);
}

function validateCssFile(filePath, tokens) {
  const violations = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const fontSizeRegex = /font-size:\s*(\d+)px/i;
  const colorPropRegex = /(color|background-color|border-color|outline-color)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/i;
  const boxShadowRegex = /box-shadow\s*:\s*[^;]*?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/i;
  const buttonSquareRadiusRegex = /border(?:-(?:top|bottom))?(?:-(?:left|right))?-radius\s*:\s*0(?:px)?\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (hasExceptionComment(lines, i)) {
      continue;
    }

    const fontSizeMatch = line.match(fontSizeRegex);
    if (fontSizeMatch) {
      const pxValue = parseInt(fontSizeMatch[1], 10);
      const token = findNearestToken(pxValue, tokens.fontSizeTokens);

      if (token) {
        violations.push({
          file: filePath,
          line: lineNum,
          rule: "css-hardcoded-font-size",
          message: `Hardcoded font-size: ${pxValue}px when design token exists`,
          snippet: line.trim(),
          suggestion: `use var(${token})`,
        });
      }
    }

    const colorMatch = line.match(colorPropRegex);
    if (colorMatch) {
      const colorValue = colorMatch[2];
      const token = findClosestColorToken(colorValue, tokens.colorTokens);

      if (token) {
        violations.push({
          file: filePath,
          line: lineNum,
          rule: "css-hardcoded-color",
          message: `Hardcoded color value ${colorValue} when design token exists`,
          snippet: line.trim(),
          suggestion: `use var(${token})`,
        });
      }
    }

    const boxShadowMatch = line.match(boxShadowRegex);
    if (boxShadowMatch) {
      const colorValue = boxShadowMatch[1];
      const token = findClosestColorToken(colorValue, tokens.colorTokens);

      if (token) {
        violations.push({
          file: filePath,
          line: lineNum,
          rule: "css-hardcoded-box-shadow",
          message: `Hardcoded color in box-shadow: ${colorValue} when design token exists`,
          snippet: line.trim(),
          suggestion: `use var(${token})`,
        });
      }
    }

    for (const banned of BANNED_LEGACY_CLASSES) {
      if (banned.pattern.test(line)) {
        violations.push({
          file: filePath,
          line: lineNum,
          rule: "css-banned-legacy-class",
          message: `Banned legacy class pattern detected`,
          snippet: line.trim(),
          suggestion: `use ${banned.replacement}`,
        });
      }
    }
  }

  const blockRegex = /([^{}]+)\{([^{}]*)\}/g;
  let blockMatch = blockRegex.exec(content);
  while (blockMatch !== null) {
    const selector = blockMatch[1].trim();
    const declarations = blockMatch[2];
    const nextBlockMatch = blockRegex.exec(content);

    if (!isButtonLikeSelector(selector) || !buttonSquareRadiusRegex.test(declarations)) {
      blockMatch = nextBlockMatch;
      continue;
    }

    const startLine = content.slice(0, blockMatch.index).split("\n").length;
    const blockLineIndex = Math.max(0, startLine - 1);
    if (hasExceptionComment(lines, blockLineIndex)) {
      blockMatch = nextBlockMatch;
      continue;
    }

    violations.push({
      file: filePath,
      line: startLine,
      rule: "css-button-square-corners",
      message: "Button-like selectors must not define square corners",
      snippet: selector,
      suggestion: "use var(--radius-control) or var(--radius-full)",
    });

    blockMatch = nextBlockMatch;
  }

  return violations;
}

function validateTsxFile(filePath, tokens) {
  const violations = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const inlineStyleRegex = /style\s*=\s*\{\{\s*([^}]+)\s*\}\}/;
  const fontSizeStyleRegex = /fontSize\s*:\s*['"](\d+)px['"]/i;
  const colorStyleRegex = /color\s*:\s*['"](#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))['"]/i;
  const buttonSquareRadiusStyleRegex = /borderRadius\s*:\s*['"]0(?:px)?['"]/i;
  const pxValueRegex = /['"](\d+)px['"]/g;
  const modalWidthRegex = /Modal[^/]*\s+width\s*=\s*['"](\d+)px['"]/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (hasExceptionComment(lines, i)) {
      continue;
    }

    if (filePath.endsWith(".tsx") && isFrontendSourceFile(filePath) && /<select\b/i.test(line)) {
      violations.push({
        file: filePath,
        line: lineNum,
        rule: "tsx-native-select-banned",
        message: "Native <select> elements are banned in frontend source",
        snippet: line.trim(),
        suggestion: "use SelectDropdown instead of a native <select>",
      });
    }

    const styleMatch = line.match(inlineStyleRegex);
    if (styleMatch) {
      const styleContent = styleMatch[1];

      const fontSizeMatch = styleContent.match(fontSizeStyleRegex);
      if (fontSizeMatch) {
        const pxValue = parseInt(fontSizeMatch[1], 10);
        const token = findNearestToken(pxValue, tokens.fontSizeTokens);

        if (token) {
          violations.push({
            file: filePath,
            line: lineNum,
            rule: "tsx-inline-style-font-size",
            message: `Inline style with hardcoded fontSize: ${pxValue}px`,
            snippet: line.trim(),
            suggestion: `use var(${token})`,
          });
        }
      }

      const colorMatch = styleContent.match(colorStyleRegex);
      if (colorMatch) {
        const colorValue = colorMatch[1];
        const token = findClosestColorToken(colorValue, tokens.colorTokens);

        if (token) {
          violations.push({
            file: filePath,
            line: lineNum,
            rule: "tsx-inline-style-color",
            message: `Inline style with hardcoded color: ${colorValue}`,
            snippet: line.trim(),
            suggestion: `use var(${token})`,
          });
        }
      }

      if ((/<button\b/i.test(line) || /role\s*=\s*["']button["']/i.test(line)) && buttonSquareRadiusStyleRegex.test(styleContent)) {
        violations.push({
          file: filePath,
          line: lineNum,
          rule: "tsx-inline-style-square-button",
          message: "Buttons must not use square corner inline styles",
          snippet: line.trim(),
          suggestion: "use borderRadius: 'var(--radius-control)' or remove the inline override",
        });
      }

      let pxMatch = pxValueRegex.exec(styleContent);
      while (pxMatch !== null) {
        const pxValue = parseInt(pxMatch[1], 10);
        const hasPxViolation = violations.some(
          (v) => v.line === lineNum && (v.rule === "tsx-inline-style-font-size" || v.rule === "tsx-inline-style-color")
        );

        if (!hasPxViolation) {
          const spaceToken = findNearestToken(pxValue, tokens.fontSizeTokens);
          if (spaceToken) {
            violations.push({
              file: filePath,
              line: lineNum,
              rule: "tsx-inline-style-px-value",
              message: `Inline style with hardcoded pixel value: ${pxValue}px`,
              snippet: line.trim(),
              suggestion: `use var(${spaceToken}) for spacing or a semantic token`,
            });
          }
          break;
        }
        pxMatch = pxValueRegex.exec(styleContent);
      }
    }

    const modalWidthMatch = line.match(modalWidthRegex);
    if (modalWidthMatch) {
      violations.push({
        file: filePath,
        line: lineNum,
        rule: "tsx-modal-raw-width",
        message: `Modal component with raw width prop`,
        snippet: line.trim(),
        suggestion: `use Modal.Header subtitle or CSS class instead of raw width`,
      });
    }

    for (const banned of BANNED_LEGACY_CLASSES) {
      if (banned.pattern.test(line) && filePath.endsWith(".tsx")) {
        const isClassUsage = line.includes('className=') || line.includes('class=');
        if (isClassUsage) {
          violations.push({
            file: filePath,
            line: lineNum,
            rule: "tsx-banned-legacy-class",
            message: `Banned legacy class pattern in TSX`,
            snippet: line.trim(),
            suggestion: `use ${banned.replacement}`,
          });
        }
      }
    }

    // Token-based legacy modal class ban: catches multi-class strings and exact matches.
    // Only applies to .tsx files in frontend source.
    if (filePath.endsWith(".tsx") && isFrontendSourceFile(filePath)) {
      for (const banned of BANNED_LEGACY_MODAL_TOKENS) {
        if (classNameContainsToken(line, banned.token)) {
          violations.push({
            file: filePath,
            line: lineNum,
            rule: "tsx-banned-legacy-class",
            message: `Banned legacy modal class "${banned.token}" in TSX source`,
            snippet: line.trim(),
            suggestion: `use ${banned.replacement}`,
          });
        }
      }
    }
  }

  return violations;
}

function getFilesToCheck(options) {
  if (options.files) {
    return options.files.split(",").map((f) => resolve(f.trim()));
  }

  if (options.scope === "all") {
    try {
      const glob = DEFAULT_GLOB;
      const output = execSync(`git ls-files "${glob}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return output
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0)
        .map((f) => resolve(f));
    } catch {
      return [];
    }
  }

  return getChangedFiles(options.staged).map((f) => resolve(f));
}

function main() {
  const options = parseArgs();
  const cwd = process.cwd();

  const tokensPath = resolve(cwd, TOKENS_PATH);
  let tokens;
  try {
    tokens = parseTokens(tokensPath);
  } catch (error) {
    const errorMsg = `Error loading tokens: ${error.message}`;
    if (options.json) {
      console.log(JSON.stringify({ error: errorMsg, violations: [] }));
    } else {
      console.error(errorMsg);
    }
    process.exit(1);
  }

  const filesToCheck = getFilesToCheck(options);
  const allViolations = [];
  const filesWithViolations = new Set();

  for (const filePath of filesToCheck) {
    if (!existsSync(filePath)) {
      continue;
    }

    let fileViolations = [];

    if (filePath.endsWith(".css")) {
      fileViolations = validateCssFile(filePath, tokens);
    } else if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
      fileViolations = validateTsxFile(filePath, tokens);
    }

    if (fileViolations.length > 0) {
      filesWithViolations.add(filePath);
      allViolations.push(...fileViolations);
    }
  }

  const report = {
    violations: allViolations,
    summary: {
      totalFiles: filesToCheck.length,
      filesWithViolations: filesWithViolations.size,
      totalViolations: allViolations.length,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (allViolations.length === 0) {
      console.log("No design system violations found.");
    } else {
      console.log(`\nFound ${allViolations.length} design system violation(s):\n`);

      for (const v of allViolations) {
        const relPath = relative(cwd, v.file);
        console.log(`${relPath}:${v.line}`);
        console.log(`  Rule: ${v.rule}`);
        console.log(`  Message: ${v.message}`);
        console.log(`  Suggestion: ${v.suggestion}`);
        console.log(`  Code: ${v.snippet}`);
        console.log("");
      }

      console.log(`Summary: ${filesWithViolations.size} file(s) with violations out of ${filesToCheck.length} checked.`);
    }
  }

  if (!options.reportOnly && allViolations.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main();
