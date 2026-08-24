import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { ACTION_TYPES } from '../../../interface/actions/action_types';
import crypto from 'node:crypto';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const failureText = (payload: unknown, key: 'code' | 'message', fallback: string): string => {
    if (!isRecord(payload)) {return fallback;}
    const value = payload[key];
    return typeof value === 'string' && value ? value : fallback;
};

export const executeBrowserCloseTab = async (
    step: Step<'browser.close_tab'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const waitUntilTabRemoved = async (targetTabName: string, timeoutMs: number): Promise<boolean> => {
        const workspace = deps.resolveWorkspace(workspaceName);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!workspace.tabs.hasTab(targetTabName)) {return true;}
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return !workspace.tabs.hasTab(targetTabName);
    };

    const tabName = step.args.tabName;
    if (!tabName) {
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_BAD_ARGS', message: 'browser.close_tab requires tabName' },
        };
    }
    const closed = await deps.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.TAB_CLOSE,
        workspaceName,
        payload: {
            source: 'agent.step',
            tabName,
            at: Date.now(),
        },
        at: Date.now(),
    });
    if (closed.type.endsWith('.failed')) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: failureText(closed.payload, 'code', 'ERR_TAB_CLOSE'),
                message: failureText(closed.payload, 'message', 'tab.close failed'),
            },
        };
    }
    let removed = await waitUntilTabRemoved(tabName, 15_000);
    if (!removed) {
        // Fallback: close lifecycle may be missing when extension cannot map
        // tabName -> chromeTabNo for a previously created/bound tab.
        const closedFallback = await deps.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.TAB_CLOSED,
            workspaceName,
            payload: {
                source: 'agent.step.fallback',
                tabName,
                at: Date.now(),
            },
            at: Date.now(),
        });
        if (closedFallback.type.endsWith('.failed')) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: failureText(closedFallback.payload, 'code', 'ERR_TAB_CLOSE_TIMEOUT'),
                    message: failureText(closedFallback.payload, 'message', `tab.close fallback failed: ${tabName}`),
                },
            };
        }
        removed = await waitUntilTabRemoved(tabName, 3_000);
    }
    if (!removed) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_TAB_CLOSE_TIMEOUT',
                message: `tab.close did not remove tab from workspace within timeout: ${tabName}`,
            },
        };
    }
    return { stepId: step.id, ok: true };
};
