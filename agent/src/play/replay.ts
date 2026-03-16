/**
 * replay：执行录制产出的 Step 序列。
 *
 * 设计说明：
 * - 回放不再直接调用旧 execute/action，而是走统一 Step 模型
 * - 当前录制已统一为 Step 序列
 */

import type { RunStepsResult } from '../runner/steps/types';
import type { StepUnion } from '../runner/steps/types';
import type { RunStepsDeps } from '../runner/run_steps';
import { runSteps } from '../runner/run_steps';

export type ReplayOptions = {
    clickDelayMs: number;
    stepDelayMs: number;
    scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};

type ReplayRequest = {
    workspaceId: string;
    initialTabId: string;
    initialTabToken: string;
    steps: StepUnion[];
    stopOnError: boolean;
    pageRegistry: {
        listTabs: (workspaceId: string) => Promise<Array<{ tabId: string; active?: boolean }>>;
    };
    isCanceled?: () => boolean;
    deps?: RunStepsDeps;
    replayOptions?: ReplayOptions;
};

type ReplayResult = RunStepsResult & { error?: { code: string; message: string; details?: unknown } };

/**
 * replayRecording：执行已录制的 Step 列表。
 */
export const replayRecording = async (req: ReplayRequest): Promise<ReplayResult> => {
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const stepDelayMs =
        typeof req.replayOptions?.stepDelayMs === 'number' && req.replayOptions.stepDelayMs > 0
            ? Math.floor(req.replayOptions.stepDelayMs)
            : 0;
    const runOne = async (step: StepUnion) =>
        runSteps(
            {
                workspaceId: req.workspaceId,
                steps: [step],
                options: { stopOnError: true },
            },
            req.deps,
        );

    const tokenToTab = new Map<string, string>([[req.initialTabToken, req.initialTabId]]);
    let currentTabId = req.initialTabId;
    let currentToken = req.initialTabToken;
    const stepResults: RunStepsResult['results'] = [];

    for (const originalStep of req.steps) {
        if (req.isCanceled?.()) {
            return { ok: false, results: stepResults, error: { code: 'ERR_CANCELED', message: 'replay canceled' } };
        }

        const desiredToken = originalStep.meta?.tabToken;
        let targetTabId: string | undefined;
        let remappedStep = originalStep;
        if (desiredToken) {
            targetTabId = tokenToTab.get(desiredToken);
            if (!targetTabId) {
                const tabs = await req.pageRegistry.listTabs(req.workspaceId);
                const recordedTabId = originalStep.meta?.tabId;
                targetTabId =
                    recordedTabId && tabs.some((tab) => tab.tabId === recordedTabId)
                        ? recordedTabId
                        : undefined;
                if (!targetTabId) {
                    const created = await runOne({
                        id: `replay-create-${Date.now()}`,
                        name: 'browser.create_tab',
                        args: {},
                        meta: { source: 'play', ts: Date.now() },
                    });
                    stepResults.push(...created.results);
                    if (!created.ok) {
                        return { ok: false, results: stepResults };
                    }
                    const createdTabId = created.results[0]?.data && (created.results[0].data as any).tab_id;
                    if (!createdTabId) {
                        return {
                            ok: false,
                            results: stepResults,
                            error: { code: 'ERR_ASSERTION_FAILED', message: 'failed to create replay tab' },
                        };
                    }
                    targetTabId = String(createdTabId);
                }
                tokenToTab.set(desiredToken, targetTabId);
            }
        }
        if (originalStep.name === 'browser.switch_tab') {
            if (desiredToken && targetTabId) {
                remappedStep = {
                    ...originalStep,
                    args: { ...(originalStep.args as any), tab_id: targetTabId },
                } as StepUnion;
            }
        } else if (desiredToken && targetTabId && targetTabId !== currentTabId) {
            return {
                ok: false,
                results: stepResults,
                error: {
                    code: 'ERR_ASSERTION_FAILED',
                    message: `missing browser.switch_tab before step ${originalStep.id}`,
                    details: {
                        currentTabId,
                        targetTabId,
                        currentToken,
                        desiredToken,
                        stepId: originalStep.id,
                        stepName: originalStep.name,
                    },
                },
            };
        }

        const response = await runOne(remappedStep);
        stepResults.push(...response.results);
        if (!response.ok && req.stopOnError) {
            return { ok: false, results: stepResults };
        }
        if (remappedStep.name === 'browser.switch_tab') {
            const switchedTo = String((remappedStep.args as any)?.tab_id || '');
            if (switchedTo) {
                currentTabId = switchedTo;
            }
            if (desiredToken) {
                currentToken = desiredToken;
            }
        } else if (desiredToken) {
            currentToken = desiredToken;
        }
        if (stepDelayMs > 0) {
            await wait(stepDelayMs);
        }
    }

    return {
        ok: stepResults.every((item) => item.ok),
        results: stepResults,
    };
};
