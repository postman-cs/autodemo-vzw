export type AuthMode = "github_token_first" | "fallback_pat_first" | "app_token";
export type AuthStrategy = "github-token" | "pat" | "app-token";

export interface RequestPlan {
    method: string;
    pathname: string;
    sameRepository: boolean;
    explicitStrategy?: AuthStrategy;
}

export interface GitHubHttpFailure {
    status: number;
    headers: Record<string, string | undefined>;
    body?: unknown;
}

export interface GitHubApiClientOptions {
    fallbackToken?: string;
    authMode?: AuthMode;
    appToken?: string;
}

interface TelemetryCounters {
    variables: number;
    contents: number;
    dispatch: number;
    other: number;
}

export class GitHubApiClient {
    private owner: string;
    private repo: string;
    private token: string;
    private fallbackToken: string;
    private options: GitHubApiClientOptions;
    private apiBase = "https://api.github.com";
    private fallbackTelemetry: TelemetryCounters = {
        variables: 0,
        contents: 0,
        dispatch: 0,
        other: 0,
    };
    private variableCache: Record<string, string> | null = null;

    constructor(token: string, repository: string, fallbackTokenOrOptions: string | GitHubApiClientOptions = "") {
        this.token = token;

        const normalizedOptions = typeof fallbackTokenOrOptions === "string"
            ? { fallbackToken: fallbackTokenOrOptions }
            : (fallbackTokenOrOptions || {});

        this.fallbackToken = String(normalizedOptions.fallbackToken || "").trim();
        this.options = {
            authMode: normalizedOptions.authMode || "github_token_first",
            appToken: String(normalizedOptions.appToken || "").trim(),
            fallbackToken: this.fallbackToken,
        };

        const [owner, repo] = repository.split('/');
        this.owner = owner;
        this.repo = repo;
    }

    getTelemetry(): { fallbackUses: TelemetryCounters } {
        return {
            fallbackUses: { ...this.fallbackTelemetry },
        };
    }

    private classifyEndpoint(path: string): keyof TelemetryCounters {
        if (this.isVariablesEndpoint(path)) return "variables";
        if (path.includes("/contents") || path.includes("/git/")) return "contents";
        if (path.includes("/dispatches")) return "dispatch";
        return "other";
    }

    private countFallback(path: string): void {
        const family = this.classifyEndpoint(path);
        this.fallbackTelemetry[family] += 1;
    }

    private tokenOrderForPlan(plan: RequestPlan): string[] {
        const mode = this.options.authMode || "github_token_first";
        const strategy = selectAuthStrategyForRequest(plan);
        const primaryToken = String(this.token || "").trim();
        const fallbackToken = String(this.fallbackToken || "").trim();
        const appToken = String(this.options.appToken || "").trim();

        if (mode === "app_token") {
            return [appToken, primaryToken, fallbackToken].filter(Boolean)
                .filter((token, idx, arr) => arr.indexOf(token) === idx);
        }

        if (mode === "fallback_pat_first") {
            return [fallbackToken, primaryToken, appToken].filter(Boolean)
                .filter((token, idx, arr) => arr.indexOf(token) === idx);
        }

        if (strategy === "app-token") {
            return [appToken, primaryToken, fallbackToken].filter(Boolean)
                .filter((token, idx, arr) => arr.indexOf(token) === idx);
        }

        if (strategy === "pat") {
            return [fallbackToken, primaryToken, appToken].filter(Boolean)
                .filter((token, idx, arr) => arr.indexOf(token) === idx);
        }

        return [primaryToken, fallbackToken, appToken].filter(Boolean)
            .filter((token, idx, arr) => arr.indexOf(token) === idx);
    }

    private rateLimitDelayMs(response: Response, attempt: number): number {
        const retryAfter = Number(response.headers.get("retry-after") || "");
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return Math.min(retryAfter * 1000, 120_000);
        }

        const resetAtSeconds = Number(response.headers.get("x-ratelimit-reset") || "");
        if (Number.isFinite(resetAtSeconds) && resetAtSeconds > 0) {
            const delta = (resetAtSeconds * 1000) - Date.now();
            if (delta > 0) {
                return Math.min(delta + 250, 120_000);
            }
        }

        const base = Math.min(5000 * Math.pow(2, attempt), 120_000);
        const jitter = Math.floor(Math.random() * 250);
        return Math.min(base + jitter, 120_000);
    }

    private async requestWithToken(path: string, init: RequestInit = {}, token: string) {
        const MAX_RETRIES = 5;
        const normalizedToken = String(token || "").trim();
        if (!normalizedToken) {
            throw new Error(`Missing GitHub auth token for request ${path}`);
        }

        for (let attempt = 0; ; attempt++) {
            const response = await fetch(`${this.apiBase}${path}`, {
                ...init,
                headers: {
                    Authorization: `Bearer ${normalizedToken}`,
                    Accept: "application/vnd.github+json",
                    "Content-Type": "application/json",
                    ...(init.headers || {}),
                },
            });
            const body = (response.status === 403 || response.status === 429)
                ? await response.clone().text().catch(() => "")
                : "";
            if (attempt < MAX_RETRIES && isRateLimitedResponse({
                status: response.status,
                headers: {
                    "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining") || undefined,
                    "retry-after": response.headers.get("retry-after") || undefined,
                    "x-ratelimit-reset": response.headers.get("x-ratelimit-reset") || undefined,
                },
                body,
            })) {
                const delay = this.rateLimitDelayMs(response, attempt);
                console.log(`GitHub API rate limited, retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return response;
        }
    }

    private isVariablesEndpoint(path: string): boolean {
        return path.startsWith(`/repos/${this.owner}/${this.repo}/actions/variables`);
    }

    private canUseFallback(path: string): boolean {
        return this.isVariablesEndpoint(path)
            || path.includes(`/repos/${this.owner}/${this.repo}/contents`)
            || path.includes("/dispatches");
    }

    private async request(path: string, init: RequestInit = {}) {
        const normalizedMethod = String(init.method || "GET").toUpperCase();
        const orderedTokens = this.tokenOrderForPlan({
            method: normalizedMethod,
            pathname: path,
            sameRepository: path.startsWith(`/repos/${this.owner}/${this.repo}/`),
        });
        if (orderedTokens.length === 0) {
            throw new Error("No GitHub auth token configured");
        }

        const first = await this.requestWithToken(path, init, orderedTokens[0]);
        const second = orderedTokens[1];
        if (
            (first.status === 403 || first.status === 429)
            && second
            && this.canUseFallback(path)
        ) {
            this.countFallback(path);
            console.log(`[gh-api] fallback auth used for ${path} (mode=${this.options.authMode || "github_token_first"})`);
            return this.requestWithToken(path, init, second);
        }
        return first;
    }

    async setRepositoryVariable(name: string, value: string) {
        if (!value) {
            throw new Error(`Repo variable ${name} is empty`);
        }
        const body = JSON.stringify({ name, value: String(value) });
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Create-first: on new repos most vars don't exist, saving 1 call per var
            const createResp = await this.request(
                `/repos/${this.owner}/${this.repo}/actions/variables`,
                { method: "POST", body }
            );
            if (createResp.ok || createResp.status === 201) {
                if (this.variableCache) this.variableCache[name] = String(value);
                return;
            }
            // Variable already exists — update it
            if (createResp.status === 409 || createResp.status === 422) {
                const updateResp = await this.request(
                    `/repos/${this.owner}/${this.repo}/actions/variables/${name}`,
                    { method: "PATCH", body }
                );
                if (updateResp.ok) {
                    if (this.variableCache) this.variableCache[name] = String(value);
                    return;
                }
                if (updateResp.status >= 500 && attempt < maxRetries - 1) {
                    console.log(`[gh-api] retrying update variable ${name} (${updateResp.status}, attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                const text = await updateResp.text().catch(() => "");
                throw new Error(`Failed to update repo variable ${name}: ${updateResp.status} ${text}`);
            }
            // Retry on transient server errors (502 Unicorn, 503, etc.)
            if (createResp.status >= 500 && attempt < maxRetries - 1) {
                console.log(`[gh-api] retrying create variable ${name} (${createResp.status}, attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            const text = await createResp.text().catch(() => "");
            throw new Error(`Failed to create repo variable ${name}: ${createResp.status} ${text}`);
        }
    }

    async listRepositoryVariables(forceRefresh = false): Promise<Record<string, string>> {
        if (this.variableCache && !forceRefresh) {
            return { ...this.variableCache };
        }

        const variables: Record<string, string> = {};
        let page = 1;
        for (;;) {
            const response = await this.request(
                `/repos/${this.owner}/${this.repo}/actions/variables?per_page=100&page=${page}`,
                { method: "GET" }
            );
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(`Failed to list repo variables: ${response.status} ${text}`);
            }
            const data = await response.json() as {
                variables?: Array<{ name?: string; value?: string }>;
            };
            const batch = Array.isArray(data.variables) ? data.variables : [];
            for (const entry of batch) {
                const name = String(entry?.name || "").trim();
                if (!name) continue;
                variables[name] = String(entry?.value || "");
            }
            if (batch.length < 100) break;
            page += 1;
        }

        this.variableCache = variables;
        return { ...variables };
    }

    async getRepositoryVariable(name: string): Promise<string> {
        if (this.variableCache) {
            return String(this.variableCache[name] || "");
        }
        const response = await this.request(
            `/repos/${this.owner}/${this.repo}/actions/variables/${name}`,
            { method: "GET" }
        );
        if (response.status === 404) return "";
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Failed to fetch repo variable ${name}: ${response.status} ${text}`);
        }
        const data = await response.json() as { value?: string };
        return String(data.value || "");
    }
    async triggerWorkflow(workflow: string, inputs: Record<string, string>, ref = "main"): Promise<void> {
        const response = await this.request(
            `/repos/${this.owner}/${this.repo}/actions/workflows/${workflow}/dispatches`,
            { method: "POST", body: JSON.stringify({ ref, inputs }) }
        );
        if (!response.ok && response.status !== 204) {
            const text = await response.text().catch(() => "");
            throw new Error(`Failed to trigger workflow ${workflow}: ${response.status} ${text}`);
        }
    }
}
function normalizeHeaders(headers: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value ?? "")]),
    );
}

function extractMessage(body: unknown): string {
    if (typeof body === "string") return body;
    if (body && typeof body === "object" && "message" in body) {
        return String((body as { message?: unknown }).message ?? "");
    }
    return "";
}

export function selectAuthStrategyForRequest(plan: RequestPlan): AuthStrategy {
    if (plan.explicitStrategy) return plan.explicitStrategy;

    const normalizedMethod = plan.method.toUpperCase();
    const isRepoVariableWrite = /^\/repos\/[^/]+\/[^/]+\/actions\/variables(?:\/|$)/.test(plan.pathname)
        && ["POST", "PATCH", "PUT", "DELETE"].includes(normalizedMethod);

    if (isRepoVariableWrite && plan.sameRepository) {
        return "github-token";
    }

    const isWorkflowContentsWrite = /^\/repos\/[^/]+\/[^/]+\/contents\/\.github\/workflows\//.test(plan.pathname);
    if (isWorkflowContentsWrite) {
        return "pat";
    }

    if (!plan.sameRepository) {
        return "pat";
    }

    return "github-token";
}

export function isRateLimitedResponse(failure: GitHubHttpFailure): boolean {
    if (failure.status !== 403 && failure.status !== 429) return false;

    const headers = normalizeHeaders(failure.headers);
    const remaining = headers["x-ratelimit-remaining"];
    const retryAfter = headers["retry-after"];
    const message = extractMessage(failure.body).toLowerCase();

    if (remaining === "0") return true;
    if (retryAfter) return true;
    if (message.includes("secondary rate limit")) return true;
    if (message.includes("api rate limit exceeded")) return true;

    return false;
}
