/**
 * replay：执行录制产出的 Step 序列。
 *
 * 设计说明：
 * - 回放不再直接调用旧 execute/action，而是走统一 Step 模型
 * - 当前录制已统一为 Step 序列
 */

import type { RunStepsResult } from '../runner/steps/types';
import type { StepUnion } from '../runner/steps/types';
import type { StepResolve } from '../runner/steps/types';
import type { RunStepsDeps } from '../runner/run_steps';
import { runStepList } from '../runner/run_steps';
import type { RecordingManifest } from './recording';
import type { RecordingEnhancementMap } from './types';
import type { RuntimeWorkspace } from '../runtime/workspace/workspace';
import type { ExecutionBindings } from '../runtime/execution/bindings';
import type { PageRegistry } from '../runtime/browser/page_registry';
import { isValidStepResolve } from '../runner/steps/resolve_utils';
import { getLogger } from '../logging/logger';

export type ReplayOptions = {
    clickDelayMs: number;
    stepIntervalMs: number;
    scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};

type ReplayRequest = {
    workspaceName: string;
    initialTabName: string;
    steps: StepUnion[];
    enrichments?: RecordingEnhancementMap;
    stepResolves?: Record<string, StepResolve>;
    recordingManifest?: RecordingManifest;
    stopOnError: boolean;
    workspace: RuntimeWorkspace;
    runtime: ExecutionBindings;
    pageRegistry: PageRegistry;
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
          stepDurationMs: number;
          stepIntervalMs: number;
          sleepMs: number;
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

type ReplayTabBinding = {
    recordedTabName: string;
    recordedTabRef: string;
    recordedUrl?: string;
    runtimeTabName?: string;
    runtimeUrl?: string;
    status: 'reused' | 'created';
    closed?: boolean;
};

type ReplayTabBindings = Map<string, ReplayTabBinding>;

type TabEffectSlot<T> =
    | { state: 'empty' }
    | { state: 'ready'; value: T }
    | { state: 'conflict'; reason: string };

type TabEffectRegister = {
    pendingCreatedTab: TabEffectSlot<{ runtimeTabName: string }>;
    pendingClosedTab: TabEffectSlot<{ runtimeTabName: string }>;
};

export const createTabEffectRegisterForTest = (): TabEffectRegister => ({
    pendingCreatedTab: { state: 'empty' },
    pendingClosedTab: { state: 'empty' },
});

export const recordCreatedTabEffectForTest = (register: TabEffectRegister, runtimeTabName: string): void => {
    if (register.pendingCreatedTab.state === 'conflict') {return;}
    if (register.pendingCreatedTab.state === 'ready') {
        register.pendingCreatedTab = {
            state: 'conflict',
            reason: `duplicate created tab effect: ${register.pendingCreatedTab.value.runtimeTabName}, ${runtimeTabName}`,
        };
        return;
    }
    register.pendingCreatedTab = { state: 'ready', value: { runtimeTabName } };
};

export const recordClosedTabEffectForTest = (register: TabEffectRegister, runtimeTabName: string): void => {
    if (register.pendingClosedTab.state === 'conflict') {return;}
    if (register.pendingClosedTab.state === 'ready') {
        register.pendingClosedTab = {
            state: 'conflict',
            reason: `duplicate closed tab effect: ${register.pendingClosedTab.value.runtimeTabName}, ${runtimeTabName}`,
        };
        return;
    }
    register.pendingClosedTab = { state: 'ready', value: { runtimeTabName } };
};

const withResolveFromEnhancement = (step: StepUnion, enhancement?: RecordingEnhancementMap[string]): StepUnion => {
    if (!enhancement) {return step;}
    const nextResolve = {
        hint: enhancement.resolveHint,
        policy: enhancement.resolvePolicy,
    };
    if (!isValidStepResolve(nextResolve)) {return step;}
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
    const stepLogger = getLogger('step');
    const stepIntervalMs =
        typeof req.replayOptions?.stepIntervalMs === 'number' && req.replayOptions.stepIntervalMs > 0
            ? Math.floor(req.replayOptions.stepIntervalMs)
            : 0;
    const runOne = async (step: StepUnion): Promise<RunStepsResult> => {
        const { pipe, checkpoint } = await runStepList(req.workspaceName, [step], req.deps, { stopOnError: true, stepResolves: req.stepResolves });
        const items = pipe.items;
        const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data, error: item.error }));
        return { ok: checkpoint.status !== 'failed' && results.every((item) => item.ok), results };
    };
    const urlMatches = (left?: string, right?: string): boolean => {
        if (!left || !right) {return false;}
        if (left === right) {return true;}
        const normalize = (url: string) => url.split('#')[0];
        return normalize(left) === normalize(right);
    };

    const tabBindings: ReplayTabBindings = new Map();
    const tabEffectRegister = createTabEffectRegisterForTest();
    void tabEffectRegister;
    const upsertTabBinding = (recordedTabName: string, patch: Partial<ReplayTabBinding>) => {
        const current = tabBindings.get(recordedTabName) || {
            recordedTabName,
            recordedTabRef: patch.recordedTabRef || recordedTabName,
            recordedUrl: patch.recordedUrl,
            runtimeTabName: patch.runtimeTabName,
            runtimeUrl: patch.runtimeUrl,
            status: patch.status || 'reused',
            closed: patch.closed,
        };
        tabBindings.set(recordedTabName, { ...current, ...patch });
    };
    for (const item of req.recordingManifest?.initialTabs || []) {
        upsertTabBinding(item.tabName, {
            recordedTabRef: item.tabRef,
            recordedUrl: item.url,
            runtimeTabName: item.active ? req.initialTabName : undefined,
            status: item.active ? 'reused' : 'created',
        });
    }
    if (req.recordingManifest?.activeTabRef) {
        const activeFromManifest = req.recordingManifest.initialTabs.find((tab) => tab.tabRef === req.recordingManifest?.activeTabRef);
        if (activeFromManifest) {
            upsertTabBinding(activeFromManifest.tabName, { runtimeTabName: req.initialTabName, status: 'reused' });
        }
    }
    if (req.recordingManifest?.entryTabRef) {
        const entryFromManifest = req.recordingManifest.initialTabs.find((tab) => tab.tabRef === req.recordingManifest?.entryTabRef);
        if (entryFromManifest) {
            upsertTabBinding(entryFromManifest.tabName, { runtimeTabName: req.initialTabName, status: 'reused' });
        }
    }
    const stepResults: RunStepsResult['results'] = [];

    for (let index = 0; index < req.steps.length; index += 1) {
        const startedAt = Date.now();
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

        const recordedTabName = originalStep.meta?.tabName;
        const recordedTabRef = originalStep.meta?.tabRef || recordedTabName;
        const recordedUrl = originalStep.meta?.urlAtRecord || readStepStringArg(originalStep, 'tabUrl') || readStepStringArg(originalStep, 'url');
        let targetTabName: string | undefined = recordedTabName ? tabBindings.get(recordedTabName)?.runtimeTabName : undefined;
        let remappedStep = originalStep;
        if (recordedTabName && !targetTabName) {
            const runtimeTabs = req.workspace.tabs.listTabs();
            const exactByName = runtimeTabs.find((tab) => tab.name === recordedTabName && (!recordedUrl || urlMatches(tab.url, recordedUrl)));
            const byUrl = !exactByName && recordedUrl ? runtimeTabs.find((tab) => urlMatches(tab.url, recordedUrl)) : undefined;
            targetTabName = exactByName?.name || byUrl?.name;
            if (!targetTabName) {
                const created = await runOne({
                    id: `replay-create-${Date.now()}`,
                    name: 'browser.create_tab',
                    args: { url: recordedUrl },
                    meta: { source: 'play', ts: Date.now() },
                });
                stepResults.push(...created.results);
                if (!created.ok) { return { ok: false, results: stepResults }; }
                const createdData = asRecord(created.results[0]?.data);
                targetTabName = typeof createdData.tab_id === 'string' ? createdData.tab_id : undefined;
                if (!targetTabName) {
                    return { ok: false, results: stepResults, error: { code: 'ERR_ASSERTION_FAILED', message: 'failed to create replay tab' } };
                }
                upsertTabBinding(recordedTabName, { recordedTabRef: recordedTabRef || recordedTabName, recordedUrl, runtimeTabName: targetTabName, runtimeUrl: recordedUrl, status: 'created' });
            } else {
                upsertTabBinding(recordedTabName, { recordedTabRef: recordedTabRef || recordedTabName, recordedUrl, runtimeTabName: targetTabName, runtimeUrl: req.workspace.tabs.getTab(targetTabName)?.url, status: 'reused' });
            }
        }
        if (originalStep.name === 'browser.switch_tab') {
            if (!targetTabName) {
                return { ok: false, results: stepResults, error: { code: 'ERR_NOT_FOUND', message: 'replay target tab not found' } };
            }
            remappedStep = {
                ...originalStep,
                args: { ...asRecord(originalStep.args), tabName: targetTabName },
            };
        } else if (originalStep.name === 'browser.create_tab' && recordedTabName) {
            const mapped = tabBindings.get(recordedTabName);
            if (mapped?.runtimeTabName && req.workspace.tabs.hasTab(mapped.runtimeTabName)) {
                remappedStep = {
                    id: `${originalStep.id}-switch-existing`,
                    name: 'browser.switch_tab',
                    args: { tabName: mapped.runtimeTabName, tabRef: mapped.recordedTabRef, tabUrl: mapped.recordedUrl },
                    meta: originalStep.meta,
                };
            }
        } else if (targetTabName) {
            await req.runtime.ensureExecutableTab({ workspace: req.workspace, pageRegistry: req.pageRegistry, tabName: targetTabName, urlHint: recordedUrl });
        }

        const response = await runOne(remappedStep);
        const stepDurationMs = Date.now() - startedAt;
        const sleepMs = Math.max(0, stepIntervalMs - stepDurationMs);
        stepResults.push(...response.results);
        const primary = response.results[response.results.length - 1];
        await req.onEvent?.({
            type: 'step.finished',
            index,
            total: req.steps.length,
            stepId: remappedStep.id,
            stepName: remappedStep.name,
            ok: response.ok,
            stepDurationMs,
            stepIntervalMs,
            sleepMs,
            data: primary.data,
            error: primary.error,
        });
        stepLogger.info('[RPA:replay:step]', {
            workspaceName: req.workspaceName,
            stepId: remappedStep.id,
            stepName: remappedStep.name,
            stepDurationMs,
            stepIntervalMs,
            sleepMs,
            ok: response.ok,
        });
        await req.onEvent?.({
            type: 'progress',
            completed: index + 1,
            total: req.steps.length,
        });
        if (!response.ok && req.stopOnError) {
            return { ok: false, results: stepResults };
        }
        if (recordedTabName && remappedStep.name === 'browser.create_tab' && response.ok) {
            const data = asRecord(primary.data);
            const createdTabName = typeof data.tab_id === 'string' ? data.tab_id : undefined;
            if (createdTabName) {
                upsertTabBinding(recordedTabName, { recordedTabRef: recordedTabRef || recordedTabName, recordedUrl, runtimeTabName: createdTabName, runtimeUrl: req.workspace.tabs.getTab(createdTabName)?.url, status: 'created', closed: false });
            }
        }
        if (recordedTabName && remappedStep.name === 'browser.switch_tab' && response.ok) {
            const switchedTo = readStepStringArg(remappedStep, 'tabName');
            if (switchedTo) { upsertTabBinding(recordedTabName, { recordedTabRef: recordedTabRef || recordedTabName, recordedUrl, runtimeTabName: switchedTo, runtimeUrl: req.workspace.tabs.getTab(switchedTo)?.url, closed: false }); }
        }
        if (recordedTabName && remappedStep.name === 'browser.close_tab' && response.ok) {
            upsertTabBinding(recordedTabName, { recordedTabRef: recordedTabRef || recordedTabName, recordedUrl, closed: true });
        }
        if (sleepMs > 0) {
            await wait(sleepMs);
        }
    }

    return {
        ok: stepResults.every((item) => item.ok),
        results: stepResults,
    };
};
