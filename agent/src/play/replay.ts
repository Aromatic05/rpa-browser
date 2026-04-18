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
import { runStepList } from '../runner/run_steps';
import type { RecordingManifest } from '../record/recording';
import type { RecordingEnhancementMap } from '../record/types';
import { clearReplayEnhancementContext, setReplayEnhancementContext } from '../runner/steps/helpers/replay_ctx';

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
    enrichments?: RecordingEnhancementMap;
    recordingManifest?: RecordingManifest;
    stopOnError: boolean;
    pageRegistry: {
        listTabs: (workspaceId: string) => Promise<Array<{ tabId: string; active?: boolean }>>;
        resolveTabIdFromToken?: (tabToken: string) => string | undefined;
        resolveTabIdFromRef?: (tabRef: string) => string | undefined;
    };
    isCanceled?: () => boolean;
    onEvent?: (event: ReplayEvent) => void | Promise<void>;
    deps?: RunStepsDeps;
    replayOptions?: ReplayOptions;
};

type ReplayResult = RunStepsResult & { error?: { code: string; message: string; details?: unknown } };

export type ReplayEvent =
    | {
          type: 'step.started';
          index: number;
          total: number;
          stepId: string;
          stepName: string;
      }
    | {
          type: 'step.finished';
          index: number;
          total: number;
          stepId: string;
          stepName: string;
          ok: boolean;
          data?: unknown;
          error?: { code: string; message: string; details?: unknown };
      }
    | {
          type: 'progress';
          completed: number;
          total: number;
      };

/**
 * replayRecording：执行已录制的 Step 列表。
 */
export const replayRecording = async (req: ReplayRequest): Promise<ReplayResult> => {
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const stepDelayMs =
        typeof req.replayOptions?.stepDelayMs === 'number' && req.replayOptions.stepDelayMs > 0
            ? Math.floor(req.replayOptions.stepDelayMs)
            : 0;
    const runOne = async (step: StepUnion): Promise<RunStepsResult> => {
        const { pipe, checkpoint } = await runStepList(req.workspaceId, [step], req.deps, { stopOnError: true });
        const items = pipe.items;
        const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data, error: item.error }));
        return { ok: checkpoint.status !== 'failed' && results.every((item) => item.ok), results };
    };
    const forceActivateTab = async (tabId: string, desiredToken?: string, desiredTabRef?: string): Promise<boolean> => {
        const switched = await runOne({
            id: `replay-switch-${Date.now()}`,
            name: 'browser.switch_tab',
            args: { tab_id: tabId },
            meta: { source: 'play', ts: Date.now() },
        });
        stepResults.push(...switched.results);
        if (!switched.ok) {
            return false;
        }
        currentTabId = tabId;
        if (desiredToken) {
            currentToken = desiredToken;
            tokenToTab.set(desiredToken, tabId);
        }
        if (desiredTabRef) {
            refToTab.set(desiredTabRef, tabId);
        }
        return true;
    };

    const tokenToTab = new Map<string, string>([[req.initialTabToken, req.initialTabId]]);
    const refToTab = new Map<string, string>();
    if (req.recordingManifest?.entryTabRef) {
        refToTab.set(req.recordingManifest.entryTabRef, req.initialTabId);
    }
    let currentTabId = req.initialTabId;
    let currentToken = req.initialTabToken;
    const stepResults: RunStepsResult['results'] = [];

    const replayEnhancements = req.enrichments || {};
    const hasReplayEnhancements = Object.keys(replayEnhancements).length > 0;
    if (hasReplayEnhancements) {
        setReplayEnhancementContext(req.workspaceId, replayEnhancements);
    }

    try {
    for (let index = 0; index < req.steps.length; index += 1) {
        const originalStep = req.steps[index];
        if (req.isCanceled?.()) {
            return { ok: false, results: stepResults, error: { code: 'ERR_CANCELED', message: 'replay canceled' } };
        }
        await req.onEvent?.({
            type: 'step.started',
            index,
            total: req.steps.length,
            stepId: originalStep.id,
            stepName: originalStep.name,
        });

        const desiredToken = originalStep.meta?.tabToken;
        const desiredTabRef = originalStep.meta?.tabRef || originalStep.meta?.tabId;
        let targetTabId: string | undefined;
        let remappedStep = originalStep;
        if (desiredToken) {
            targetTabId = tokenToTab.get(desiredToken);
            if (!targetTabId) {
                const tabs = await req.pageRegistry.listTabs(req.workspaceId);
                targetTabId = req.pageRegistry.resolveTabIdFromToken?.(desiredToken);
                if (!targetTabId && desiredTabRef) {
                    targetTabId = refToTab.get(desiredTabRef) || req.pageRegistry.resolveTabIdFromRef?.(desiredTabRef);
                }
                const recordedTabId = originalStep.meta?.tabId;
                if (!targetTabId || !tabs.some((tab) => tab.tabId === targetTabId)) {
                    targetTabId =
                        recordedTabId && tabs.some((tab) => tab.tabId === recordedTabId)
                            ? recordedTabId
                            : undefined;
                }
                if (!targetTabId) {
                    const fallbackUrl =
                        originalStep.meta?.urlAtRecord ||
                        (originalStep.name === 'browser.goto' ? String((originalStep.args as any)?.url || '') : undefined) ||
                        (originalStep.name === 'browser.switch_tab'
                            ? String((originalStep.args as any)?.tab_url || '')
                            : undefined) ||
                        req.recordingManifest?.tabs.find((tab) => {
                            if (!desiredTabRef) return false;
                            return tab.tabRef === desiredTabRef;
                        })?.lastSeenUrl ||
                        undefined;
                    const created = await runOne({
                        id: `replay-create-${Date.now()}`,
                        name: 'browser.create_tab',
                        args: { url: fallbackUrl || undefined },
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
                if (desiredTabRef) {
                    refToTab.set(desiredTabRef, targetTabId);
                }
            }
        } else if (desiredTabRef) {
            targetTabId = refToTab.get(desiredTabRef) || req.pageRegistry.resolveTabIdFromRef?.(desiredTabRef);
        }
        if (originalStep.name === 'browser.switch_tab') {
            if (targetTabId) {
                remappedStep = {
                    ...originalStep,
                    args: { ...(originalStep.args as any), tab_id: targetTabId },
                } as StepUnion;
            }
        } else if (targetTabId) {
            const activated = await forceActivateTab(targetTabId, desiredToken, desiredTabRef);
            if (!activated) {
                return { ok: false, results: stepResults };
            }
        }

        const response = await runOne(remappedStep);
        stepResults.push(...response.results);
        const primary = response.results[response.results.length - 1];
        await req.onEvent?.({
            type: 'step.finished',
            index,
            total: req.steps.length,
            stepId: remappedStep.id,
            stepName: remappedStep.name,
            ok: response.ok,
            data: primary?.data,
            error: primary?.error,
        });
        await req.onEvent?.({
            type: 'progress',
            completed: index + 1,
            total: req.steps.length,
        });
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
            if (desiredTabRef && switchedTo) {
                refToTab.set(desiredTabRef, switchedTo);
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
    } finally {
        if (hasReplayEnhancements) {
            clearReplayEnhancementContext(req.workspaceId);
        }
    }
};
