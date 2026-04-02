import * as core from '@actions/core';

export function setStepOutput(name: string, value: string) {
    core.setOutput(name, value);
}

export function exportStepVariable(name: string, value: string) {
    core.exportVariable(name, value);
}

export function logStepInfo(stepName: string, message: string) {
    core.info(`[${stepName}] ${message}`);
}
