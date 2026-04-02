import { describe, expect, it } from "vitest";
import { isRateLimitedResponse } from "../../.github/actions/_lib/github-api";

describe("precommit class 4 rate limit classification", () => {
  it("detects primary rate limits from x-ratelimit-remaining == 0", () => {
    expect(isRateLimitedResponse({
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      body: { message: "API rate limit exceeded" },
    })).toBe(true);
  });

  it("detects secondary rate limits from retry-after or body text", () => {
    expect(isRateLimitedResponse({
      status: 403,
      headers: { "retry-after": "60", "x-ratelimit-remaining": "12" },
      body: { message: "You have exceeded a secondary rate limit." },
    })).toBe(true);

    expect(isRateLimitedResponse({
      status: 429,
      headers: {},
      body: "secondary rate limit triggered",
    })).toBe(true);
  });

  it("does not confuse permission failures with rate limits", () => {
    expect(isRateLimitedResponse({
      status: 403,
      headers: { "x-ratelimit-reset": "9999999999", "x-ratelimit-remaining": "42" },
      body: { message: "Resource not accessible by integration" },
    })).toBe(false);

    expect(isRateLimitedResponse({
      status: 403,
      headers: { "x-ratelimit-remaining": "12" },
      body: { message: "Must have admin rights to Repository." },
    })).toBe(false);
  });

  it("does not retry unrelated server failures", () => {
    expect(isRateLimitedResponse({
      status: 500,
      headers: {},
      body: { message: "Internal Server Error" },
    })).toBe(false);
  });
});
