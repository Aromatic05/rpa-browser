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
};

type ReplayResult = RunStepsResult & { error?: { code: string; message: string; details?: unknown } };

/**
 * replayRecording：执行已录制的 Step 列表。
 */
export const replayRecording = async (req: ReplayRequest): Promise<ReplayResult> => {
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
    const stepResults: RunStepsResult['results'] = [];

    const ensureTargetTabActive = async (targetTabId: string) => {
        const maxAttempts = 3;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const tabs = await req.pageRegistry.listTabs(req.workspaceId);
            const activeFromRegistry = tabs.find((tab) => tab.active)?.tabId;
            const observedActive = activeFromRegistry || currentTabId;
            if (observedActive === targetTabId) {
                return true;
            }
            const switched = await runOne({
                id: `replay-focus-${Date.now()}-${attempt}`,
                name: 'browser.switch_tab',
                args: { tab_id: targetTabId },
                meta: { source: 'play', ts: Date.now() },
            });
            stepResults.push(...switched.results);
            if (!switched.ok) {
                return false;
            }
            currentTabId = targetTabId;
            await wait(140);
        }
        return currentTabId === targetTabId;
    };

    for (const originalStep of req.steps) {
        if (req.isCanceled?.()) {
            return { ok: false, results: stepResults, error: { code: 'ERR_CANCELED', message: 'replay canceled' } };
        }

        const desiredToken = originalStep.meta?.tabToken;
        let remappedStep = originalStep;
        if (desiredToken) {
            let targetTabId = tokenToTab.get(desiredToken);
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

            const ready = await ensureTargetTabActive(targetTabId);
            if (!ready) {
                return {
                    ok: false,
                    results: stepResults,
                    error: { code: 'ERR_ASSERTION_FAILED', message: 'failed to activate target tab before replay step' },
                };
            }

            if (originalStep.name === 'browser.switch_tab') {
                remappedStep = {
                    ...originalStep,
                    args: { ...(originalStep.args as any), tab_id: targetTabId },
                } as StepUnion;
            }
        }

        const response = await runOne(remappedStep);
        stepResults.push(...response.results);
        if (!response.ok && req.stopOnError) {
            return { ok: false, results: stepResults };
        }
    }

    return {
        ok: stepResults.every((item) => item.ok),
        results: stepResults,
    };
};
