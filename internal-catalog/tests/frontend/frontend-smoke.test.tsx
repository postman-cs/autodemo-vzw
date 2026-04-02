import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import { EmptyState } from "../../frontend/src/components/EmptyState";
import { StatusCard } from "../../frontend/src/components/StatusCard";
import { Skeleton } from "../../frontend/src/components/Skeleton";
import { InProgressBar } from "../../frontend/src/components/InProgressBar";
import { WarningBanner } from "../../frontend/src/components/WarningBanner";
import { SuccessBanner } from "../../frontend/src/components/SuccessBanner";
import { ErrorBanner } from "../../frontend/src/components/ErrorBanner";
import { ConfirmDialog } from "../../frontend/src/components/ConfirmDialog";
import { ErrorBoundary } from "../../frontend/src/components/ErrorBoundary";
import { DocsPage } from "../../frontend/src/pages/DocsPage";

function mount(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function Bomb(): React.ReactElement {
  throw new Error("test render error");
}

describe("shared components render without crashing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("EmptyState renders with default props", () => {
    const { container, unmount } = mount(<EmptyState />);
    expect(container.textContent).toContain("Nothing here yet");
    unmount();
  });

  it("StatusCard renders with variant=empty", () => {
    const { container, unmount } = mount(<StatusCard variant="empty" title="No data" />);
    expect(container.textContent).toContain("No data");
    unmount();
  });

  it("StatusCard renders with variant=error and role=alert", () => {
    const { container, unmount } = mount(<StatusCard variant="error" title="Something failed" />);
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Something failed");
    unmount();
  });

  it("Skeleton renders without crashing", () => {
    const { container, unmount } = mount(<Skeleton />);
    const el = container.querySelector(".skeleton");
    expect(el).not.toBeNull();
    unmount();
  });

  it("InProgressBar renders without crashing", () => {
    const { container, unmount } = mount(<InProgressBar />);
    expect(container.textContent).toContain("Operation in progress");
    unmount();
  });

  it("WarningBanner renders with message", () => {
    const { container, unmount } = mount(<WarningBanner message="Watch out" />);
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Watch out");
    unmount();
  });

  it("SuccessBanner renders with message", () => {
    const { container, unmount } = mount(<SuccessBanner message="All good" />);
    const el = container.querySelector('[role="status"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("All good");
    unmount();
  });

  it("ErrorBanner renders with message", () => {
    const { container, unmount } = mount(<ErrorBanner message="Something broke" />);
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Something broke");
    unmount();
  });

  it("ConfirmDialog renders title and description when open", () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    const { container, unmount } = mount(
      <ConfirmDialog
        open={true}
        title="Are you sure?"
        description="This cannot be undone."
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(container.textContent).toContain("Are you sure?");
    expect(container.textContent).toContain("This cannot be undone.");
    unmount();
  });
});

describe("EmptyState renders correct text", () => {
  it("renders custom title prop", () => {
    const { container, unmount } = mount(<EmptyState title="Custom Title" />);
    expect(container.textContent).toContain("Custom Title");
    unmount();
  });

  it("renders description prop when provided", () => {
    const { container, unmount } = mount(
      <EmptyState title="My Title" description="Helpful description text." />
    );
    expect(container.textContent).toContain("My Title");
    expect(container.textContent).toContain("Helpful description text.");
    unmount();
  });
});

describe("Skeleton renders with variants", () => {
  it("renders text variant with correct class", () => {
    const { container, unmount } = mount(<Skeleton variant="text" />);
    expect(container.querySelector(".skeleton--text")).not.toBeNull();
    unmount();
  });

  it("renders rect variant with correct class", () => {
    const { container, unmount } = mount(<Skeleton variant="rect" />);
    expect(container.querySelector(".skeleton--rect")).not.toBeNull();
    unmount();
  });

  it("renders circle variant with correct class", () => {
    const { container, unmount } = mount(<Skeleton variant="circle" />);
    expect(container.querySelector(".skeleton--circle")).not.toBeNull();
    unmount();
  });

  it("renders multiple items when count > 1", () => {
    const { container, unmount } = mount(<Skeleton variant="text" count={3} />);
    const items = container.querySelectorAll(".skeleton--text");
    expect(items.length).toBe(3);
    unmount();
  });
});

describe("ErrorBoundary catches errors", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows default fallback when child throws", () => {
    const { container, unmount } = mount(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(container.textContent).toContain("Something went wrong");
    unmount();
  });

  it("shows custom fallback node when provided and child throws", () => {
    const { container, unmount } = mount(
      <ErrorBoundary fallback={<div>Custom error fallback</div>}>
        <Bomb />
      </ErrorBoundary>
    );
    expect(container.textContent).toContain("Custom error fallback");
    unmount();
  });

  it("renders children normally when no error is thrown", () => {
    const { container, unmount } = mount(
      <ErrorBoundary>
        <span>Safe content</span>
      </ErrorBoundary>
    );
    expect(container.textContent).toContain("Safe content");
    unmount();
  });
});

describe("DocsPage uses EmptyState", () => {
  it("renders Documentation title via EmptyState", () => {
    const { container, unmount } = mount(
      <MemoryRouter>
        <DocsPage />
      </MemoryRouter>
    );
    expect(container.textContent).toContain("Documentation");
    unmount();
  });

  it("renders the docs description text", () => {
    const { container, unmount } = mount(
      <MemoryRouter>
        <DocsPage />
      </MemoryRouter>
    );
    expect(container.textContent).toContain("API catalog documentation");
    unmount();
  });
});
