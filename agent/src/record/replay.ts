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

const REPLAY_ERROR_CODES = {
    TAB_NOT_BOUND: 'ERR_REPLAY_TAB_NOT_BOUND',
    TAB_EFFECT_CONFLICT: 'ERR_REPLAY_TAB_EFFECT_CONFLICT',
    TAB_EFFECT_MISMATCH: 'ERR_REPLAY_TAB_EFFECT_MISMATCH',
} as const;

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

type TabCreatedEffect = {
    runtimeTabName: string;
    url: string;
    title: string;
    createdAt: number;
};

type TabEffectRegister = {
    pendingCreatedTab: TabEffectSlot<TabCreatedEffect>;
    pendingClosedTab: TabEffectSlot<{ runtimeTabName: string }>;
};

const createTabEffectRegister = (): TabEffectRegister => ({
    pendingCreatedTab: { state: 'empty' },
    pendingClosedTab: { state: 'empty' },
});

const recordCreatedTabEffect = (register: TabEffectRegister, runtimeTabName: string, facts?: Partial<Omit<TabCreatedEffect, 'runtimeTabName'>>): void => {
    if (register.pendingCreatedTab.state === 'conflict') {return;}
    if (register.pendingCreatedTab.state === 'ready') {
        register.pendingCreatedTab = {
            state: 'conflict',
            reason: `duplicate created tab effect: ${register.pendingCreatedTab.value.runtimeTabName}, ${runtimeTabName}`,
        };
        return;
    }
    register.pendingCreatedTab = {
        state: 'ready',
        value: {
            runtimeTabName,
            url: facts?.url || '',
            title: facts?.title || '',
            createdAt: facts?.createdAt || Date.now(),
        },
    };
};

const recordClosedTabEffect = (register: TabEffectRegister, runtimeTabName: string): void => {
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

const clearPendingCreatedTabEffect = (register: TabEffectRegister): void => {
    register.pendingCreatedTab = { state: 'empty' };
};

const clearPendingClosedTabEffect = (register: TabEffectRegister): void => {
    register.pendingClosedTab = { state: 'empty' };
};

const snapshotRuntimeTabNames = (workspace: RuntimeWorkspace): Set<string> =>
    new Set(workspace.tabs.listTabs().map((tab) => tab.name));

const inferExpectedCreatedTabUrl = (steps: StepUnion[], createTabIndex: number): string | undefined => {
    const createStep = steps[createTabIndex];
    if (!createStep || createStep.name !== 'browser.create_tab') {return undefined;}
    const createdTabName = readStepStringArg(createStep, 'tabName');
    if (!createdTabName) {return undefined;}
    for (let index = createTabIndex + 1; index < steps.length; index += 1) {
        const step = steps[index];
        if ((step.name === 'browser.close_tab' || step.name === 'browser.create_tab') && readStepStringArg(step, 'tabName') === createdTabName) {
            return undefined;
        }
        if (step.name !== 'browser.goto') {continue;}
        let activeTabName: string | undefined;
        for (let back = index - 1; back >= createTabIndex; back -= 1) {
            const previous = steps[back];
            if (previous.name === 'browser.switch_tab') {
                activeTabName = readStepStringArg(previous, 'tabName');
                break;
            }
        }
        if (activeTabName === createdTabName) {
            return readStepStringArg(step, 'url') || undefined;
        }
    }
    return undefined;
};

export const inferExpectedCreatedTabUrlForTest = inferExpectedCreatedTabUrl;

const createdTabEffectMatchesExpectedUrl = (
    effect: TabCreatedEffect,
    expectedUrl: string | undefined,
    urlMatches: (left?: string, right?: string) => boolean,
): boolean => !expectedUrl || urlMatches(effect.url, expectedUrl);

const createTabEffectMismatchError = (
    effect: TabCreatedEffect,
    expectedUrl: string | undefined,
    recordedTabName: string,
    createTabStepId: string,
): ReplayResult['error'] => ({
    code: REPLAY_ERROR_CODES.TAB_EFFECT_MISMATCH,
    message: `pending created tab url mismatch: expected ${expectedUrl || ''}, got ${effect.url}`,
    details: {
        expectedUrl: expectedUrl || '',
        actualUrl: effect.url,
        runtimeTabName: effect.runtimeTabName,
        recordedTabName,
        createTabStepId,
    },
});

const collectTabEffectsFromDiff = (
    register: TabEffectRegister,
    before: Set<string>,
    after: Set<string>,
    currentStepName: string,
    workspace?: RuntimeWorkspace,
): void => {
    for (const tabName of after) {
        if (!before.has(tabName) && currentStepName !== 'browser.create_tab') {
            const tab = workspace?.tabs.getTab(tabName);
            recordCreatedTabEffect(register, tabName, {
                url: typeof tab?.url === 'string' ? tab.url : '',
                title: typeof tab?.title === 'string' ? tab.title : '',
                createdAt: Date.now(),
            });
        }
    }
    for (const tabName of before) {
        if (!after.has(tabName) && currentStepName !== 'browser.close_tab') {
            recordClosedTabEffect(register, tabName);
        }
    }
};

export const createTabEffectRegisterForTest = createTabEffectRegister;
export const recordCreatedTabEffectForTest = recordCreatedTabEffect;
export const recordClosedTabEffectForTest = recordClosedTabEffect;
export const collectTabEffectsFromDiffForTest = collectTabEffectsFromDiff;

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
    const tabEffectRegister = createTabEffectRegister();
    const effectStateSnapshot = () => ({
        pendingCreatedTab: tabEffectRegister.pendingCreatedTab.state,
        pendingClosedTab: tabEffectRegister.pendingClosedTab.state,
    });
    const logEffectStateChange = (stepId: string, reason: string, before: ReturnType<typeof effectStateSnapshot>) => {
        const after = effectStateSnapshot();
        if (before.pendingCreatedTab !== after.pendingCreatedTab || before.pendingClosedTab !== after.pendingClosedTab) {
            stepLogger.info('[RPA:replay:tab-effects]', { stepId, reason, before, after });
        }
    };
    const upsertTabBinding = (recordedTabName: string, patch: Partial<ReplayTabBinding>) => {
        const before = tabBindings.get(recordedTabName);
        const current = before || {
            recordedTabName,
            runtimeTabName: patch.runtimeTabName,
            runtimeUrl: patch.runtimeUrl,
            status: patch.status || 'reused',
            closed: patch.closed,
        };
        const next = { ...current, ...patch };
        tabBindings.set(recordedTabName, next);
        if (!before || JSON.stringify(before) !== JSON.stringify(next)) {
            stepLogger.info('[RPA:replay:tab-binding]', { recordedTabName, before, after: next });
        }
    };
    let recordedActiveTabName: string | undefined = req.recordingManifest?.activeTabRef;
    if (req.recordingManifest?.activeTabRef) {
        const activeFromManifest = req.recordingManifest.initialTabs.find((tab) => tab.tabRef === req.recordingManifest?.activeTabRef);
        if (activeFromManifest) { recordedActiveTabName = activeFromManifest.tabName; }
        if (recordedActiveTabName) {
            upsertTabBinding(recordedActiveTabName, { runtimeTabName: req.initialTabName, status: 'reused' });
        }
    }
    const stepResults: RunStepsResult['results'] = [];

    for (let index = 0; index < req.steps.length; index += 1) {
        const startedAt = Date.now();
        const effectBeforeStep = effectStateSnapshot();
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

        const tabStepRecordedTabName = originalStep.name === 'browser.create_tab' || originalStep.name === 'browser.switch_tab' || originalStep.name === 'browser.close_tab'
            ? readStepStringArg(originalStep, 'tabName')
            : undefined;
        const recordedTabName = tabStepRecordedTabName || recordedActiveTabName;
        let targetTabName: string | undefined = recordedTabName ? tabBindings.get(recordedTabName)?.runtimeTabName : undefined;
        let remappedStep = originalStep;
        let syntheticResponse: RunStepsResult | undefined;
        const runtimeTabsBeforeStep = snapshotRuntimeTabNames(req.workspace);

        if (originalStep.name === 'browser.switch_tab') {
            if (!recordedTabName) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            const switchBinding = tabBindings.get(recordedTabName);
            if (!switchBinding?.runtimeTabName) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            if (switchBinding.closed) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            remappedStep = {
                ...originalStep,
                args: { ...asRecord(originalStep.args), tabName: switchBinding.runtimeTabName },
            };
        } else if (originalStep.name === 'browser.close_tab') {
            if (!recordedTabName) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            const mapped = tabBindings.get(recordedTabName);
            if (!mapped) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            const mappedRuntimeTabName = mapped.runtimeTabName;
            if (mapped.closed) {
                syntheticResponse = { ok: true, results: [{ stepId: originalStep.id, ok: true }] };
            } else if (tabEffectRegister.pendingClosedTab.state === 'conflict') {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_EFFECT_CONFLICT, message: tabEffectRegister.pendingClosedTab.reason } };
            } else if (tabEffectRegister.pendingClosedTab.state === 'ready') {
                if (!mappedRuntimeTabName || tabEffectRegister.pendingClosedTab.value.runtimeTabName !== mappedRuntimeTabName) {
                    return {
                        ok: false,
                        results: stepResults,
                        error: {
                            code: REPLAY_ERROR_CODES.TAB_EFFECT_MISMATCH,
                            message: `pending closed tab mismatch: expected ${mappedRuntimeTabName || 'unbound'}, got ${tabEffectRegister.pendingClosedTab.value.runtimeTabName}`,
                        },
                    };
                }
                upsertTabBinding(recordedTabName, { closed: true });
                clearPendingClosedTabEffect(tabEffectRegister);
                logEffectStateChange(originalStep.id, 'consume_pending_closed_effect', effectBeforeStep);
                syntheticResponse = { ok: true, results: [{ stepId: originalStep.id, ok: true }] };
            } else if (mappedRuntimeTabName && req.workspace.tabs.hasTab(mappedRuntimeTabName)) {
                remappedStep = {
                    ...originalStep,
                    args: { ...asRecord(originalStep.args), tabName: mappedRuntimeTabName },
                };
            } else {
                upsertTabBinding(recordedTabName, { closed: true });
                syntheticResponse = { ok: true, results: [{ stepId: originalStep.id, ok: true }] };
            }
        } else if (originalStep.name === 'browser.create_tab') {
            if (!recordedTabName) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            const mapped = tabBindings.get(recordedTabName);
            const expectedCreatedTabUrl = inferExpectedCreatedTabUrl(req.steps, index);
            if (mapped?.runtimeTabName && req.workspace.tabs.hasTab(mapped.runtimeTabName) && !mapped.closed) {
                syntheticResponse = { ok: true, results: [{ stepId: originalStep.id, ok: true, data: { tab_id: mapped.runtimeTabName } }] };
            } else if (tabEffectRegister.pendingCreatedTab.state === 'ready') {
                const createdEffect = tabEffectRegister.pendingCreatedTab.value;
                if (!createdTabEffectMatchesExpectedUrl(createdEffect, expectedCreatedTabUrl, urlMatches)) {
                    return {
                        ok: false,
                        results: stepResults,
                        error: createTabEffectMismatchError(createdEffect, expectedCreatedTabUrl, recordedTabName, originalStep.id),
                    };
                }
                const runtimeTab = createdEffect.runtimeTabName;
                upsertTabBinding(recordedTabName, { runtimeTabName: runtimeTab, runtimeUrl: req.workspace.tabs.getTab(runtimeTab)?.url, closed: false, status: 'created' });
                clearPendingCreatedTabEffect(tabEffectRegister);
                logEffectStateChange(originalStep.id, 'consume_pending_created_effect', effectBeforeStep);
                syntheticResponse = { ok: true, results: [{ stepId: originalStep.id, ok: true, data: { tab_id: runtimeTab } }] };
            }
            if (!syntheticResponse && tabEffectRegister.pendingCreatedTab.state === 'conflict') {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_EFFECT_CONFLICT, message: tabEffectRegister.pendingCreatedTab.reason } };
            }
            if (!syntheticResponse) {
                remappedStep = {
                    ...originalStep,
                    args: { tabName: recordedTabName },
                };
            }
        } else {
            if (!recordedTabName || !targetTabName) {
                return { ok: false, results: stepResults, error: { code: REPLAY_ERROR_CODES.TAB_NOT_BOUND, message: 'replay target tab not bound' } };
            }
            await req.runtime.ensureExecutableTab({ workspace: req.workspace, pageRegistry: req.pageRegistry, tabName: targetTabName });
        }

        const response = syntheticResponse || await runOne(remappedStep);
        const runtimeTabsAfterStep = snapshotRuntimeTabNames(req.workspace);
        collectTabEffectsFromDiff(tabEffectRegister, runtimeTabsBeforeStep, runtimeTabsAfterStep, remappedStep.name, req.workspace);
        logEffectStateChange(originalStep.id, 'collect_step_tab_diff', effectBeforeStep);
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
                upsertTabBinding(recordedTabName, { runtimeTabName: createdTabName, runtimeUrl: req.workspace.tabs.getTab(createdTabName)?.url, status: 'created', closed: false });
                clearPendingCreatedTabEffect(tabEffectRegister);
                logEffectStateChange(originalStep.id, 'create_tab_success', effectBeforeStep);
            }
        }
        if (recordedTabName && remappedStep.name === 'browser.switch_tab' && response.ok) {
            const switchedTo = readStepStringArg(remappedStep, 'tabName');
            if (switchedTo) {
                upsertTabBinding(recordedTabName, { runtimeTabName: switchedTo, runtimeUrl: req.workspace.tabs.getTab(switchedTo)?.url, closed: false });
                recordedActiveTabName = recordedTabName;
            }
        }
        if (recordedTabName && remappedStep.name === 'browser.close_tab' && response.ok) {
            upsertTabBinding(recordedTabName, { closed: true });
            if (recordedActiveTabName === recordedTabName) {
                recordedActiveTabName = undefined;
            }
            clearPendingClosedTabEffect(tabEffectRegister);
            logEffectStateChange(originalStep.id, 'close_tab_success', effectBeforeStep);
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
