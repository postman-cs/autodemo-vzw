import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server, setupFetchMock, teardownFetchMock } from "./helpers/fetch-mock";
import {
  createRepo,
  lookupUser,
  addCollaborator,
  deleteRepo,
  createRepoVariable,
  triggerWorkflow,
  getLatestWorkflowRun,
  listWorkflowRuns,
  getWorkflowRunById,
  getWorkflowJobs,
  pushTree,
  appendCommit,
  createRepoSecret,
  encryptSecret,
  retryFetch,
  normalizeGitHubToken,
  setGitHubOrg,
  setGitHubTokenPool,
  clearRepoPublicKeyCache,
  clearWorkflowPollCache,
  RATE_LIMIT_MAX_RETRIES,
  ORG,
  GH_API,
} from "../src/lib/github";
describe("github helpers", () => {
  beforeEach(() => {
    setupFetchMock();
    clearRepoPublicKeyCache();
    clearWorkflowPollCache();
  });

  afterEach(() => {
    teardownFetchMock({
      onFinally: () => {
        vi.restoreAllMocks();
        setGitHubOrg(ORG);
        setGitHubTokenPool([]);
      },
    });
  });

  afterAll(() => server.close());

  describe("createRepo", () => {
    it("creates a repo and returns metadata", async () => {
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ full_name: "postman-cs/test", html_url: "https://github.com/postman-cs/test", default_branch: "main" }, { status: 201 }), { once: true }),
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
      );

      const result = await createRepo("token", "test", "A test repo");
      expect(result.full_name).toBe("postman-cs/test");
      expect(result.html_url).toContain("postman-cs/test");
    });

    it("continues when createRepo loses a race and the repo now exists", async () => {
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ message: "already exists" }, { status: 422 }), { once: true }),
        http.get(`https://api.github.com/repos/${ORG}/test`, () =>
          HttpResponse.json({ full_name: `postman-cs/test`, html_url: `https://github.com/${ORG}/test`, default_branch: "main" }), { once: true }),
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
      );

      const result = await createRepo("token", "test", "desc");
      expect(result.full_name).toBe("postman-cs/test");
      expect(result.default_branch).toBe("main");
    });

    it("throws on non-conflict error response", async () => {
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ message: "Invalid repository name" }, { status: 422 }), { once: true }),
      );

      await expect(createRepo("token", "test", "desc")).rejects.toThrow("Failed to create repo");
    });

    it("retries on 5xx and succeeds on third attempt", async () => {
      vi.useFakeTimers();
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ message: "error code: 502" }, { status: 502 }), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ message: "error code: 502" }, { status: 502 }), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ full_name: "postman-cs/test", html_url: "https://github.com/postman-cs/test", default_branch: "main" }, { status: 201 }), { once: true }),
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
      );

      const promise = createRepo("token", "test", "A test repo");
      await vi.advanceTimersByTimeAsync(10000);
      const result = await promise;
      expect(result.full_name).toBe("postman-cs/test");
      vi.useRealTimers();
    });
  });

  describe("normalizeGitHubToken", () => {
    it("trims surrounding whitespace and newlines", () => {
      expect(normalizeGitHubToken("  token-value \n")).toBe("token-value");
    });

    it("throws when token is empty after trimming", () => {
      expect(() => normalizeGitHubToken("  \n\t  ")).toThrow("GH_TOKEN is missing or empty");
    });
  });

  describe("lookupUser", () => {
    it("returns username when found", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/search/users"), () =>
          HttpResponse.json({ total_count: 1, items: [{ login: "jsmith" }] }), { once: true }),
      );

      const result = await lookupUser("token", "j@test.com");
      expect(result).toBe("jsmith");
    });

    it("returns null when not found", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/search/users"), () =>
          HttpResponse.json({ total_count: 0, items: [] }), { once: true }),
      );

      const result = await lookupUser("token", "nobody@test.com");
      expect(result).toBeNull();
    });

    it("returns null on API error", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/search/users"), () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      const result = await lookupUser("token", "x@test.com");
      expect(result).toBeNull();
    });
  });

  describe("addCollaborator", () => {
    it("adds collaborator without error on 204", async () => {
      server.use(
        http.put(`https://api.github.com/repos/${ORG}/test/collaborators/user1`, () =>
          HttpResponse.json({}), { once: true }),
      );

      await addCollaborator("token", "test", "user1");
    });

    it("handles non-204 non-ok gracefully", async () => {
      server.use(
        http.put(`https://api.github.com/repos/${ORG}/test/collaborators/user1`, () =>
          HttpResponse.json({ message: "not found" }, { status: 404 }), { once: true }),
      );

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await addCollaborator("token", "test", "user1");
      expect(warn).toHaveBeenCalledWith("Failed to add collaborator user1: 404");
    });
  });

  describe("deleteRepo", () => {
    it("calls DELETE on the repo", async () => {
      server.use(
        http.delete(`https://api.github.com/repos/${ORG}/test`, () =>
          HttpResponse.json({}), { once: true }),
      );

      await deleteRepo("token", "test");
    });

    it("treats 404 as already deleted", async () => {
      server.use(
        http.delete(`https://api.github.com/repos/${ORG}/test-missing`, () =>
          HttpResponse.json({ message: "Not Found" }, { status: 404 }), { once: true }),
      );

      await deleteRepo("token", "test-missing");
    });

    it("throws when delete is forbidden", async () => {
      server.use(
        http.delete(`https://api.github.com/repos/${ORG}/test-forbidden`, () =>
          HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }), { once: true }),
      );

      await expect(deleteRepo("token", "test-forbidden")).rejects.toThrow("Failed to delete repo");
    });
  });

  describe("createRepoVariable", () => {
    it("creates variable first on fresh repos", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/actions/variables`, () =>
          HttpResponse.json({}, { status: 201 }), { once: true }),
      );

      await createRepoVariable("token", "test", "MY_VAR", "my-value");
    });

    it("updates existing variable when create reports conflict", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/actions/variables`, () =>
          new HttpResponse("already exists", { status: 409 }), { once: true }),
        http.patch(`https://api.github.com/repos/${ORG}/test/actions/variables/NEW_VAR`, () =>
          new HttpResponse("", { status: 200 }), { once: true }),
      );

      await createRepoVariable("token", "test", "NEW_VAR", "new-value");
    });

    it("handles create failure gracefully", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/actions/variables`, () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await createRepoVariable("token", "test", "BAD_VAR", "val");
      expect(warn).toHaveBeenCalledWith("Failed to create variable BAD_VAR: 500");
    });
  });

  describe("triggerWorkflow", () => {
    it("dispatches workflow successfully", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/actions/workflows/ci.yml/dispatches`, () =>
          HttpResponse.json({}), { once: true }),
      );

      await triggerWorkflow("token", "test", "ci.yml", { key: "val" });
    });

    it("throws on failure", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/actions/workflows/ci.yml/dispatches`, () =>
          new HttpResponse("server error", { status: 500 }), { once: true }),
      );

      await expect(triggerWorkflow("token", "test", "ci.yml", {})).rejects.toThrow("Failed to trigger");
    });
  });

  describe("getLatestWorkflowRun", () => {
    it("returns latest run when available", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/test/actions/workflows/ci\\.yml/runs"), () =>
          HttpResponse.json({
            total_count: 1,
            workflow_runs: [{ id: 42, status: "completed", conclusion: "success", html_url: "https://example.com" }],
          }), { once: true }),
      );

      const run = await getLatestWorkflowRun("token", "test", "ci.yml");
      expect(run).not.toBeNull();
      expect(run!.id).toBe(42);
      expect(run!.status).toBe("completed");
    });

    it("returns null when no runs exist", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/test/actions/workflows/ci\\.yml/runs"), () =>
          HttpResponse.json({ total_count: 0, workflow_runs: [] }), { once: true }),
      );

      const run = await getLatestWorkflowRun("token", "test", "ci.yml");
      expect(run).toBeNull();
    });

    it("returns null on API error", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/test/actions/workflows/ci\\.yml/runs"), () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      const run = await getLatestWorkflowRun("token", "test", "ci.yml");
      expect(run).toBeNull();
    });

    it("reuses cached latest workflow run on 304 with If-None-Match", async () => {
      let ifNoneMatch = "";
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 42, status: "in_progress", conclusion: null, html_url: "https://example.com/run/42", updated_at: "2026-03-07T00:00:00Z" }],
        }), { status: 200, headers: { etag: '"latest-run-etag"', "Content-Type": "application/json" } }))
        .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers || {});
          ifNoneMatch = String(headers.get("if-none-match") || "");
          return new Response(null, { status: 304 });
        });

      const first = await getLatestWorkflowRun("token", "test", "ci.yml");
      const second = await getLatestWorkflowRun("token", "test", "ci.yml");

      expect(first?.id).toBe(42);
      expect(second?.id).toBe(42);
      expect(ifNoneMatch).toBe('"latest-run-etag"');
    });
  });

  describe("listWorkflowRuns", () => {
    it("returns recent workflow runs with path and name metadata", async () => {
      server.use(
        http.get(new RegExp("https://api\\.github\\.com/repos/postman-cs/test/actions/runs"), () =>
          HttpResponse.json({
            workflow_runs: [{
              id: 77,
              name: "Provision API Lifecycle",
              path: ".github/workflows/provision.yml",
              status: "completed",
              conclusion: "success",
              html_url: "https://example.com/run/77",
              updated_at: "2026-03-08T06:48:06Z",
              event: "workflow_dispatch",
              head_branch: "main",
              created_at: "2026-03-08T06:45:52Z",
            }],
          }), { once: true }),
      );

      const runs = await listWorkflowRuns("token", "test", 5);
      expect(runs).toEqual([
        expect.objectContaining({
          id: 77,
          name: "Provision API Lifecycle",
          path: ".github/workflows/provision.yml",
          status: "completed",
          conclusion: "success",
        }),
      ]);
    });
  });

  describe("getWorkflowRunById", () => {
    it("reuses cached workflow run on 304 with If-None-Match", async () => {
      let ifNoneMatch = "";
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, status: "queued", conclusion: null, html_url: "https://example.com/run/42", updated_at: "2026-03-07T00:00:00Z" }), { status: 200, headers: { etag: '"run-etag"', "Content-Type": "application/json" } }))
        .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers || {});
          ifNoneMatch = String(headers.get("if-none-match") || "");
          return new Response(null, { status: 304 });
        });

      const first = await getWorkflowRunById("token", "test", 42);
      const second = await getWorkflowRunById("token", "test", 42);

      expect(first?.status).toBe("queued");
      expect(second?.status).toBe("queued");
      expect(ifNoneMatch).toBe('"run-etag"');
    });
  });

  describe("getWorkflowJobs", () => {
    it("returns mapped jobs with steps", async () => {
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/actions/runs/42/jobs`, () =>
          HttpResponse.json({
            jobs: [{
              name: "build",
              status: "completed",
              conclusion: "success",
              steps: [
                { name: "Checkout", status: "completed", conclusion: "success", number: 1 },
                { name: "Build", status: "completed", conclusion: "success", number: 2 },
              ],
            }],
          }), { once: true }),
      );

      const jobs = await getWorkflowJobs("token", "test", 42);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("build");
      expect(jobs[0].steps).toHaveLength(2);
      expect(jobs[0].steps[0].name).toBe("Checkout");
    });

    it("returns empty array on error", async () => {
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/actions/runs/42/jobs`, () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      const jobs = await getWorkflowJobs("token", "test", 42);
      expect(jobs).toEqual([]);
    });

    it("handles jobs with no steps", async () => {
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/actions/runs/42/jobs`, () =>
          HttpResponse.json({
            jobs: [{ name: "job1", status: "queued", conclusion: null, steps: undefined }],
          }), { once: true }),
      );

      const jobs = await getWorkflowJobs("token", "test", 42);
      expect(jobs[0].steps).toEqual([]);
    });

    it("reuses cached workflow jobs on 304 with If-None-Match", async () => {
      let ifNoneMatch = "";
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({
          jobs: [{
            name: "build",
            status: "completed",
            conclusion: "success",
            steps: [{ name: "Checkout", status: "completed", conclusion: "success", number: 1 }],
          }],
        }), { status: 200, headers: { etag: '"jobs-etag"', "Content-Type": "application/json" } }))
        .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers || {});
          ifNoneMatch = String(headers.get("if-none-match") || "");
          return new Response(null, { status: 304 });
        });

      const first = await getWorkflowJobs("token", "test", 42);
      const second = await getWorkflowJobs("token", "test", 42);

      expect(first[0]?.name).toBe("build");
      expect(second[0]?.name).toBe("build");
      expect(ifNoneMatch).toBe('"jobs-etag"');
    });
  });

  describe("pushTree", () => {
    it("creates tree with inline content, commit, and ref", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "tree-sha" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          HttpResponse.json({ sha: "commit-sha" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/refs`, () =>
          HttpResponse.json({ ref: "refs/heads/main" }, { status: 201 }), { once: true }),
      );

      const sha = await pushTree("token", "test", [
        { path: "a.txt", content: "aaa" },
        { path: "b.txt", content: "bbb" },
      ], "initial commit");

      expect(sha).toBe("commit-sha");
    });

    it("throws when tree creation fails after retries", async () => {
      let callCount = 0;
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () => {
          callCount++;
          return new HttpResponse("server error", { status: 500 });
        }),
      );

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg", "main", 0))
        .rejects.toThrow("Failed to create tree: 500");
      expect(callCount).toBe(4);
    });

    it("retries tree creation on transient failure", async () => {
      let treeCallCount = 0;
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () => {
          treeCallCount++;
          if (treeCallCount === 1) {
            return new HttpResponse("not ready", { status: 500 });
          }
          return HttpResponse.json({ sha: "tree-sha" }, { status: 201 });
        }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          HttpResponse.json({ sha: "commit-sha" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/refs`, () =>
          HttpResponse.json({ ref: "refs/heads/main" }, { status: 201 }), { once: true }),
      );

      const sha = await pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg", "main", 0);
      expect(sha).toBe("commit-sha");
    });

    it("throws when commit creation fails", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "t1" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create commit");
    });

    it("throws when ref creation fails", async () => {
      server.use(
        http.post(`https://api.github.com/repos/${ORG}/test/git/refs`, () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          HttpResponse.json({ sha: "c1" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "t1" }, { status: 201 }), { once: true }),
      );

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create ref");
    });
  });

  describe("appendCommit", () => {
    it("creates commit on existing branch", async () => {
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ object: { sha: "parent-sha" } }), { once: true }),
        http.get(`https://api.github.com/repos/${ORG}/test/git/commits/parent-sha`, () =>
          HttpResponse.json({ tree: { sha: "parent-tree-sha" } }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "new-tree-sha" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          HttpResponse.json({ sha: "new-commit-sha" }, { status: 201 }), { once: true }),
        http.patch(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ ref: "refs/heads/main" }), { once: true }),
      );

      const sha = await appendCommit("token", "test", [{ path: "file.txt", content: "hi" }], "update");
      expect(sha).toBe("new-commit-sha");
    });

    it("throws when ref lookup fails", async () => {
      vi.useFakeTimers();
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          new HttpResponse("not found", { status: 404 })),
      );

      const promise = appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg")
        .then(() => { throw new Error("should have rejected"); })
        .catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(60000);
      const err = await promise;
      expect(err.message).toContain("Failed to get ref");
      vi.useRealTimers();
    });

    it("throws when parent commit lookup fails", async () => {
      vi.useFakeTimers();
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ object: { sha: "parent-sha" } })),
        http.get(`https://api.github.com/repos/${ORG}/test/git/commits/parent-sha`, () =>
          new HttpResponse("error", { status: 500 })),
      );

      const promise = appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg")
        .then(() => { throw new Error("should have rejected"); })
        .catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(60000);
      const err = await promise;
      expect(err.message).toContain("Failed to get parent commit");
      vi.useRealTimers();
    });

    it("throws when tree creation fails in appendCommit", async () => {
      vi.useFakeTimers();
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ object: { sha: "ps" } })),
        http.get(`https://api.github.com/repos/${ORG}/test/git/commits/ps`, () =>
          HttpResponse.json({ tree: { sha: "ts" } })),
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          new HttpResponse("error", { status: 500 })),
      );

      const promise = appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg")
        .then(() => { throw new Error("should have rejected"); })
        .catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(60000);
      const err = await promise;
      expect(err.message).toContain("Failed to create tree");
      vi.useRealTimers();
    });

    it("throws when commit creation fails in appendCommit", async () => {
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ object: { sha: "ps" } }), { once: true }),
        http.get(`https://api.github.com/repos/${ORG}/test/git/commits/ps`, () =>
          HttpResponse.json({ tree: { sha: "ts" } }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "t1" }, { status: 201 }), { once: true }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create commit");
    });

    it("throws when ref update fails", async () => {
      vi.useFakeTimers();
      server.use(
        http.patch(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          new HttpResponse("error", { status: 500 })),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () =>
          HttpResponse.json({ sha: "c1" }, { status: 201 })),
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "t1" }, { status: 201 })),
        http.get(`https://api.github.com/repos/${ORG}/test/git/commits/ps`, () =>
          HttpResponse.json({ tree: { sha: "ts" } })),
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ object: { sha: "ps" } })),
      );

      const promise = appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg")
        .then(() => { throw new Error("should have rejected"); })
        .catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(60000);
      const err = await promise;
      expect(err.message).toContain("Failed to update ref");
      vi.useRealTimers();
    });

    it("retries when branch ref advances before update", async () => {
      vi.useFakeTimers();
      let refCallCount = 0;
      server.use(
        http.patch(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () => {
          refCallCount++;
          if (refCallCount === 1) {
            return new HttpResponse("reference update failed", { status: 409 });
          }
          return HttpResponse.json({ ref: "refs/heads/main" });
        }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/commits`, () => {
          return HttpResponse.json({ sha: "c-2" }, { status: 201 });
        }),
        http.post(`https://api.github.com/repos/${ORG}/test/git/trees`, () =>
          HttpResponse.json({ sha: "t-1" }, { status: 201 })),
        http.get(new RegExp(`https://api\\.github\\.com/repos/${ORG}/test/git/commits/ps-[12]$`), ({ request }) => {
          const commitSha = new URL(request.url).pathname.split("/").pop();
          return HttpResponse.json({ tree: { sha: commitSha === "ps-2" ? "ts-2" : "ts-1" } });
        }),
        http.get(`https://api.github.com/repos/${ORG}/test/git/refs/heads/main`, () =>
          HttpResponse.json({ object: { sha: refCallCount > 0 ? "ps-2" : "ps-1" } })),
      );

      const promise = appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg", "main", 0);
      await vi.advanceTimersByTimeAsync(5000);
      const sha = await promise;
      expect(sha).toBe("c-2");
      vi.useRealTimers();
    });

    it("uses configured org for parent commit lookup", async () => {
      setGitHubOrg("custom-org");
      server.use(
        http.get("https://api.github.com/repos/custom-org/test/git/refs/heads/main", () =>
          HttpResponse.json({ object: { sha: "ps" } }), { once: true }),
        http.get("https://api.github.com/repos/custom-org/test/git/commits/ps", () =>
          HttpResponse.json({ tree: { sha: "ts" } }), { once: true }),
        http.post("https://api.github.com/repos/custom-org/test/git/trees", () =>
          HttpResponse.json({ sha: "t1" }, { status: 201 }), { once: true }),
        http.post("https://api.github.com/repos/custom-org/test/git/commits", () =>
          HttpResponse.json({ sha: "c1" }, { status: 201 }), { once: true }),
        http.patch("https://api.github.com/repos/custom-org/test/git/refs/heads/main", () =>
          HttpResponse.json({ ref: "refs/heads/main" }), { once: true }),
      );

      const sha = await appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg");
      expect(sha).toBe("c1");
    });
  });

  describe("createRepoSecret", () => {
    it("encrypts and stores a secret", async () => {
      const keyBytes = new Uint8Array(32);
      crypto.getRandomValues(keyBytes);
      const publicKeyB64 = btoa(String.fromCharCode(...keyBytes));

      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/actions/secrets/public-key`, () =>
          HttpResponse.json({ key: publicKeyB64, key_id: "key-123" }), { once: true }),
        http.put(`https://api.github.com/repos/${ORG}/test/actions/secrets/MY_SECRET`, () =>
          HttpResponse.json({}), { once: true }),
      );

      await createRepoSecret("token", "test", "MY_SECRET", "secret-value");
    });

    it("throws when public key fetch fails", async () => {
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/actions/secrets/public-key`, () =>
          new HttpResponse("error", { status: 500 }), { once: true }),
      );

      await expect(createRepoSecret("token", "test", "S", "v"))
        .rejects.toThrow("Failed to get repo public key");
    });

    it("throws when secret PUT fails with non-204", async () => {
      const keyBytes = new Uint8Array(32);
      crypto.getRandomValues(keyBytes);
      const keyB64 = btoa(String.fromCharCode(...keyBytes));

      // createRepoSecret: GET key -> PUT (fails) -> GET key (retry) -> PUT (fails). Use stateful handler.
      let getKeyCalls = 0;
      let putCalls = 0;
      server.use(
        http.get(`https://api.github.com/repos/${ORG}/test/actions/secrets/public-key`, () => {
          getKeyCalls++;
          return HttpResponse.json({ key: keyB64, key_id: `k${getKeyCalls}` });
        }),
        http.put(`https://api.github.com/repos/${ORG}/test/actions/secrets/BAD`, () => {
          putCalls++;
          return new HttpResponse("error", { status: 500 });
        }),
      );

      await expect(createRepoSecret("token", "test", "BAD", "v"))
        .rejects.toThrow("Failed to create secret");
      expect(putCalls).toBe(2);
    });
  });

  describe("encryptSecret", () => {
    it("returns a base64 string", () => {
      const keyBytes = new Uint8Array(32);
      crypto.getRandomValues(keyBytes);
      const publicKeyB64 = btoa(String.fromCharCode(...keyBytes));

      const result = encryptSecret(publicKeyB64, "my-secret");
      expect(typeof result).toBe("string");
      expect(() => atob(result)).not.toThrow();
      const decoded = atob(result);
      expect(decoded.length).toBeGreaterThan(48);
    });
  });

  describe("retryFetch", () => {
    it("returns immediately on success", async () => {
      server.use(
        http.get("https://api.github.com/test", () =>
          new HttpResponse("ok", { status: 200 }), { once: true }),
      );

      const resp = await retryFetch(
        () => fetch("https://api.github.com/test"),
        "test op",
        3,
        10
      );
      expect(resp.ok).toBe(true);
    });

    it("retries on failure then succeeds", async () => {
      vi.useFakeTimers();
      let callCount = 0;
      server.use(
        http.get("https://api.github.com/test", () => {
          callCount++;
          if (callCount <= 2) {
            return new HttpResponse("fail", { status: 500 });
          }
          return new HttpResponse("ok", { status: 200 });
        }),
      );

      const promise = retryFetch(
        () => fetch("https://api.github.com/test"),
        "test op",
        3,
        10
      );
      await vi.advanceTimersByTimeAsync(1000);
      const resp = await promise;

      expect(resp.ok).toBe(true);
      // Note: With fake timers, the exact call count can vary based on timing
      expect(callCount).toBeGreaterThanOrEqual(3);
      vi.useRealTimers();
    });

    it("throws after exhausting retries with status and body", async () => {
      vi.useFakeTimers();
      server.use(
        http.get("https://api.github.com/test", () =>
          new HttpResponse("service unavailable", { status: 503 })),
      );

      const promise = retryFetch(
        () => fetch("https://api.github.com/test"),
        "test op",
        3,
        10
      ).catch((e: Error) => e);

      // Advance timers to let all retries complete
      await vi.advanceTimersByTimeAsync(1000);
      const err = await promise;

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("test op: 503");
      vi.useRealTimers();
    });
  });

  it("exports ORG and GH_API constants", () => {
    expect(ORG).toBe("postman-cs");
    expect(GH_API).toBe("https://api.github.com");
  });

  describe("rate limit retry (ghFetch)", () => {
    it("retries on 429 and succeeds", async () => {
      vi.useFakeTimers();
      let repoCallCount = 0;
      server.use(
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () => {
          repoCallCount++;
          if (repoCallCount === 1) {
            return new HttpResponse("rate limited", { status: 429, headers: { "retry-after": "1" } });
          }
          return HttpResponse.json({ full_name: "org/test", html_url: "https://github.com/org/test", default_branch: "main" }, { status: 201 });
        }),
      );

      const promise = createRepo("token", "test", "desc");
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.full_name).toBe("org/test");
      vi.useRealTimers();
    });

    it("retries on 403 with x-ratelimit-remaining: 0", async () => {
      vi.useFakeTimers();
      const futureReset = String(Math.floor(Date.now() / 1000) + 2);
      let repoCallCount = 0;
      server.use(
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () => {
          repoCallCount++;
          if (repoCallCount === 1) {
            return HttpResponse.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": futureReset } });
          }
          return HttpResponse.json({ full_name: "org/test", html_url: "https://github.com/org/test", default_branch: "main" }, { status: 201 });
        }),
      );

      const promise = createRepo("token", "test", "desc");
      await vi.advanceTimersByTimeAsync(10000);
      const result = await promise;

      expect(result.full_name).toBe("org/test");
      vi.useRealTimers();
    });

    it("does NOT retry 403 without rate limit indicators", async () => {
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 }), { once: true }),
      );

      await expect(createRepo("token", "test", "desc")).rejects.toThrow("Failed to create repo");
    });

    it("retries on 403 when body contains 'rate limit'", async () => {
      vi.useFakeTimers();
      let repoCallCount = 0;
      server.use(
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () => {
          repoCallCount++;
          if (repoCallCount === 1) {
            return HttpResponse.json({ message: "API rate limit exceeded for user ID 12345" }, { status: 403 });
          }
          return HttpResponse.json({ full_name: "org/test", html_url: "https://github.com/org/test", default_branch: "main" }, { status: 201 });
        }),
      );

      const promise = createRepo("token", "test", "desc");
      await vi.advanceTimersByTimeAsync(15000);
      const result = await promise;

      expect(result.full_name).toBe("org/test");
      vi.useRealTimers();
    });

    it("returns rate-limited response after exhausting retries", async () => {
      vi.useFakeTimers();
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          new HttpResponse("rate limited", { status: 429, headers: { "retry-after": "1" } })),
      );

      const promise = createRepo("token", "test", "desc").catch((e: Error) => e);
      for (let i = 0; i < RATE_LIMIT_MAX_RETRIES; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }
      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("Failed to create repo");
      vi.useRealTimers();
    });

    it("RATE_LIMIT_MAX_RETRIES is at least 3", () => {
      expect(RATE_LIMIT_MAX_RETRIES).toBeGreaterThanOrEqual(3);
    });

    it("rotates to secondary token on rate limit", async () => {
      setGitHubTokenPool(["primary-token", "secondary-token"]);
      let repoCallCount = 0;
      server.use(
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () => {
          repoCallCount++;
          if (repoCallCount === 1) {
            return new HttpResponse("rate limited", { status: 429, headers: { "retry-after": "60" } });
          }
          return HttpResponse.json({ full_name: "org/test", html_url: "https://github.com/org/test", default_branch: "main" }, { status: 201 });
        }),
      );

      const result = await createRepo("primary-token", "test", "desc");
      expect(result.full_name).toBe("org/test");
    });

    it("falls back to retry loop when all tokens are rate limited", async () => {
      vi.useFakeTimers();
      setGitHubTokenPool(["primary-token", "secondary-token"]);
      server.use(
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          new HttpResponse("rate limited", { status: 429, headers: { "retry-after": "1" } }), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          new HttpResponse("rate limited", { status: 429, headers: { "retry-after": "1" } }), { once: true }),
        http.post(`https://api.github.com/orgs/${ORG}/repos`, () =>
          HttpResponse.json({ full_name: "org/test", html_url: "https://github.com/org/test", default_branch: "main" }, { status: 201 }), { once: true }),
        http.put(`https://api.github.com/repos/${ORG}/test/topics`, () =>
          HttpResponse.json({}), { once: true }),
      );

      const promise = createRepo("primary-token", "test", "desc");
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result.full_name).toBe("org/test");
      vi.useRealTimers();
    });
  });
});
