import * as core from '@actions/core';

export async function retry<T>(
    operation: () => Promise<T>,
    retries = 3,
    delayMs = 2000
): Promise<T> {
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            core.info(`Attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);

            if (attempt < retries) {
                core.info(`Waiting ${delayMs}ms before retrying...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    throw lastError;
}
