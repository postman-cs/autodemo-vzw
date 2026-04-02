import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RegisterTeamModal } from "../../frontend/src/components/RegisterTeamModal";
import { installDialogMocks, restoreDialogMocks } from "./helpers/dialog-mock";
import { waitForElement } from "./helpers/render";

// Mock DataTransfer for file upload tests
class MockDataTransfer {
  items = {
    add: (file: File) => {
      (this as unknown as { files: FileList }).files = [file] as unknown as FileList;
    }
  };
  files: FileList = [] as unknown as FileList;
}

async function waitForInputValue(
  selector: string,
  expectedValue: string,
  container: HTMLElement,
  timeoutMs = 2000,
): Promise<HTMLInputElement> {
  const input = await waitForElement(selector, container, timeoutMs) as HTMLInputElement;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const check = () => {
      if (input.value === expectedValue) {
        resolve(input);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitForInputValue: ${selector} did not match expected value within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 16);
    };
    check();
  });
}

describe("RegisterTeamModal", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalDataTransfer: unknown;

  beforeEach(() => {
    originalDataTransfer = (global as { DataTransfer?: unknown }).DataTransfer;
    Object.defineProperty(global, "DataTransfer", {
      value: MockDataTransfer,
      writable: true,
      configurable: true,
    });
    installDialogMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(global, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ teams: [] }), { status: 200 }))
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (typeof originalDataTransfer === "undefined") {
      delete (global as { DataTransfer?: unknown }).DataTransfer;
    } else {
      Object.defineProperty(global, "DataTransfer", {
        value: originalDataTransfer,
        writable: true,
        configurable: true,
      });
    }
    restoreDialogMocks();
    vi.restoreAllMocks();
  });

  describe("simplified registration - default state", () => {
    it("shows only access-token-first registration controls by default", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('input#access-token')).toBeTruthy();
      expect(document.querySelector('input[type="file"]')).toBeTruthy();
      expect(document.querySelector('button[type="submit"]')).toBeTruthy();
    });

    it("renders subtitle in Modal.Header explaining auto-detection", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      const subtitle = document.querySelector('.modal-subtitle');
      expect(subtitle).toBeTruthy();
      expect(subtitle?.textContent).toContain("automatically detected from your credentials");
      expect(subtitle?.textContent).toContain("No additional configuration needed");
    });

    it("does NOT show derived identity hint in modal body", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('.register-derived-identity-section')).toBeFalsy();
      expect(document.querySelector('.register-derived-hint')).toBeFalsy();
    });

    it("does NOT show team slug input by default", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('input#team-slug')).toBeFalsy();
    });

    it("does NOT show team name input by default", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('input#team-name')).toBeFalsy();
    });

    it("does NOT show team ID input by default", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('input#team-id')).toBeFalsy();
    });

    it("does NOT show org mode checkbox by default", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('input#org-mode')).toBeFalsy();
    });

    it("does NOT show API key input by default", () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      expect(document.querySelector('input#api-key')).toBeFalsy();
    });
  });

  describe("postmanrc import", () => {
    it("successfully imports access token from postmanrc file", async () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const postmanrcContent = JSON.stringify({
        session: {
          accessToken: "test-access-token-12345",
          teamId: "12345"
        }
      });

      const mockFile = new File([postmanrcContent], "postmanrc", { type: "application/json" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(mockFile);

      await act(async () => {
        Object.defineProperty(fileInput, 'files', {
          value: dataTransfer.files,
          writable: false
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const accessTokenInput = await waitForInputValue(
        "input#access-token",
        "test-access-token-12345",
        container,
      );
      expect(accessTokenInput.value).toBe("test-access-token-12345");
    });

    it("shows error for invalid JSON in postmanrc file", async () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const invalidContent = "not valid json";
      const mockFile = new File([invalidContent], "postmanrc", { type: "application/json" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(mockFile);

      await act(async () => {
        Object.defineProperty(fileInput, 'files', {
          value: dataTransfer.files,
          writable: false
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const errorBanner = await waitForElement('[role="alert"]', container);
      expect(errorBanner.textContent).toContain("Failed to parse file");
    });

    it("shows error when postmanrc has no token or team ID", async () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const emptyContent = JSON.stringify({ someOtherField: "value" });
      const mockFile = new File([emptyContent], "postmanrc", { type: "application/json" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(mockFile);

      await act(async () => {
        Object.defineProperty(fileInput, 'files', {
          value: dataTransfer.files,
          writable: false
        });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const errorBanner = await waitForElement('[role="alert"]', container);
      expect(errorBanner.textContent).toContain("Could not find access token");
    });
  });

  describe("form submission", () => {
    it("shows error when access token is empty", async () => {
      act(() => {
        root.render(
          <RegisterTeamModal
            onClose={() => {}}
            onSuccess={() => {}}
          />
        );
      });

      const form = document.querySelector('form#register-team-form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true }));
      });

      const errorBanner = await waitForElement('[role="alert"]', container);
      expect(errorBanner.textContent).toContain("Access Token is required");
    });
  });
});
