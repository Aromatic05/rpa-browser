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

export type ReplayOptions = {
    clickDelayMs: number;
    stepDelayMs: number;
    scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};

type ReplayRequest = {
    workspaceName: string;
    initialTabName: string;
    initialTabId: string;
    steps: StepUnion[];
    enrichments?: RecordingEnhancementMap;
    recordingManifest?: RecordingManifest;
    stopOnError: boolean;
    pageRegistry: {
        listTabs: (workspaceName: string) => Promise<Array<{ tabName: string; active?: boolean }>>;
        resolveTabNameFromToken?: (tabName: string) => string | undefined;
        resolveTabNameFromRef?: (tabRef: string) => string | undefined;
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

const asRecord = (value: unknown): Record<string, unknown> =>
    (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

const readStepStringArg = (step: StepUnion, key: string): string | undefined => {
    const args = asRecord(step.args);
    return typeof args[key] === 'string' ? args[key] : undefined;
};

const withResolveFromEnhancement = (step: StepUnion, enhancement?: RecordingEnhancementMap[string]): StepUnion => {
    if (!enhancement) {return step;}
    const nextResolve = {
        hint: enhancement.resolveHint,
        policy: enhancement.resolvePolicy,
    };
    if (!nextResolve.hint && !nextResolve.policy) {return step;}
    return {
        ...step,
        resolve: nextResolve,
    };
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
        const { pipe, checkpoint } = await runStepList(req.workspaceName, [step], req.deps, { stopOnError: true });
        const items = pipe.items;
        const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data, error: item.error }));
        return { ok: checkpoint.status !== 'failed' && results.every((item) => item.ok), results };
    };
    const forceActivateTab = async (tabName: string, desiredToken?: string, desiredTabRef?: string): Promise<boolean> => {
        const switched = await runOne({
            id: `replay-switch-${Date.now()}`,
            name: 'browser.switch_tab',
            args: { tabName },
            meta: { source: 'play', ts: Date.now() },
        });
        stepResults.push(...switched.results);
        if (!switched.ok) {
            return false;
        }
        if (desiredToken) {
            tokenToTab.set(desiredToken, tabName);
        }
        if (desiredTabRef) {
            refToTab.set(desiredTabRef, tabName);
        }
        return true;
    };

    const tokenToTab = new Map<string, string>([[req.initialTabName, req.initialTabId]]);
    const refToTab = new Map<string, string>();
    if (req.recordingManifest?.entryTabRef) {
        refToTab.set(req.recordingManifest.entryTabRef, req.initialTabName);
    }
    const stepResults: RunStepsResult['results'] = [];

    for (let index = 0; index < req.steps.length; index += 1) {
        const originalStep = withResolveFromEnhancement(
            req.steps[index],
            req.enrichments?.[req.steps[index].id],
        );
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

        const desiredToken = originalStep.meta?.tabName;
        const desiredTabRef = originalStep.meta?.tabRef || originalStep.meta?.tabName;
        let targetTabName: string | undefined;
        let remappedStep = originalStep;
        if (desiredToken) {
            targetTabName = tokenToTab.get(desiredToken);
            if (!targetTabName) {
                const tabs = await req.pageRegistry.listTabs(req.workspaceName);
                targetTabName = req.pageRegistry.resolveTabNameFromToken?.(desiredToken);
                if (!targetTabName && desiredTabRef) {
                    targetTabName = refToTab.get(desiredTabRef) || req.pageRegistry.resolveTabNameFromRef?.(desiredTabRef);
                }
                const recordedTabName = originalStep.meta?.tabName;
                if (!targetTabName || !tabs.some((tab) => tab.tabName === targetTabName)) {
                    targetTabName =
                        recordedTabName && tabs.some((tab) => tab.tabName === recordedTabName)
                            ? recordedTabName
                            : undefined;
                }
                if (!targetTabName) {
                    const fallbackUrl =
                        originalStep.meta?.urlAtRecord ||
                        (originalStep.name === 'browser.goto'
                            ? readStepStringArg(originalStep, 'url')
                            : undefined) ||
                        (originalStep.name === 'browser.switch_tab'
                            ? readStepStringArg(originalStep, 'tabUrl')
                            : undefined) ||
                        req.recordingManifest?.tabs.find((tab) => {
                            if (!desiredTabRef) {return false;}
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
                    const createdFirst = created.results[0];
                    const createdData = asRecord(createdFirst.data);
                    const createdTabName = typeof createdData.tab_id === 'string' ? createdData.tab_id : undefined;
                    if (createdTabName === undefined) {
                        return {
                            ok: false,
                            results: stepResults,
                            error: { code: 'ERR_ASSERTION_FAILED', message: 'failed to create replay tab' },
                        };
                    }
                    targetTabName = createdTabName;
                }
                tokenToTab.set(desiredToken, targetTabName);
                if (desiredTabRef) {
                    refToTab.set(desiredTabRef, targetTabName);
                }
            }
        } else if (desiredTabRef) {
            targetTabName = refToTab.get(desiredTabRef) || req.pageRegistry.resolveTabNameFromRef?.(desiredTabRef);
        }
        if (originalStep.name === 'browser.switch_tab') {
            if (targetTabName) {
                remappedStep = {
                    ...originalStep,
                    args: { ...asRecord(originalStep.args), tabName: targetTabName },
                };
            }
        } else if (targetTabName) {
            const activated = await forceActivateTab(targetTabName, desiredToken, desiredTabRef);
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
            data: primary.data,
            error: primary.error,
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
            const switchedTo = readStepStringArg(remappedStep, 'tabName') || '';
            if (desiredTabRef && switchedTo) {
                refToTab.set(desiredTabRef, switchedTo);
            }
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
