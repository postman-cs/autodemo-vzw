import { setupServer } from "msw/node";
import { _clearDeploymentsCacheForTests, invalidateInfraCache } from "../../src/lib/airtable";
import { invalidateResolvedDeploymentsCache } from "../../src/lib/deployment-state";

export const server = setupServer();
let isListening = false;

const originalClose = server.close.bind(server);
(server as typeof server & { close: typeof server.close }).close = () => {
  isListening = false;
  return originalClose();
};

export function setupFetchMock(): void {
  server.resetHandlers();
  if (!isListening) {
    server.listen({ onUnhandledRequest: "error" });
    isListening = true;
  }
  _clearDeploymentsCacheForTests();
  invalidateInfraCache();
  invalidateResolvedDeploymentsCache();
}

export function teardownFetchMock(options?: {
  assertNoPendingInterceptors?: boolean;
  onFinally?: () => void;
}): void {
  try {
    server.resetHandlers();
  } finally {
    options?.onFinally?.();
  }
}
