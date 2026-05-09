/**
 * recording：维护录制/回放运行时状态，并负责事件去重/脱敏。
 *
 * 依赖关系：
 * - 上游：agent/index.ts 通过 start/stop/ensureRecorder 驱动
 * - 下游：recorder.ts 提供事件流；record/replay 使用 recordings
 *
 * 关键约束：
 * - 录制/回放不可同时进行（回放时忽略录制事件）
 * - 导航事件需去重，避免 click 导航 + framenavigated 双重记录
 */
import type { Page } from 'playwright';
import crypto from 'crypto';
import { installRecorder, type RecorderEvent } from './recorder';
import { getLogger } from '../logging/logger';
import type { ResolveHint, ResolvePolicy, Step, StepArgsMap, StepMeta, StepName, StepResolve, StepUnion } from '../runner/steps/types';
import { enrichRecordedStepWithSnapshot, type RecordSnapshotCacheEntry } from './enrichment';
import type { RecordedStepEnhancement, RecordingEnhancementMap } from './types';

export type RecordingTabManifest = {
    tabName: string;
    tabRef: string;
    firstSeenUrl?: string;
    lastSeenUrl?: string;
    firstSeenAt: number;
    lastSeenAt: number;
};

export type RecordingManifest = {
    recordingToken: string;
    workspaceName?: string;
    entryTabRef?: string;
    activeTabRef?: string;
    entryUrl?: string;
    initialTabs: Array<{
        tabName: string;
        tabRef: string;
        url: string;
        title: string;
        active: boolean;
    }>;
    startedAt: number;
    tabs: RecordingTabManifest[];
};

export type SavedRecordingTabManifest = {
    tabName: string;
    tabRef: string;
    firstSeenUrl?: string;
    lastSeenUrl?: string;
    firstSeenAt: number;
    lastSeenAt: number;
};
export type SavedRecordingManifest = Omit<RecordingManifest, 'tabs'> & {
    tabs: SavedRecordingTabManifest[];
};

export type WorkspaceSavedTab = {
    tabName: string;
    url: string;
    title: string;
    active: boolean;
};

export type WorkspaceSavedSnapshot = {
    workspaceName: string;
    savedAt: number;
    tabs: WorkspaceSavedTab[];
    recording: {
        recordingToken: string | null;
        manifest?: SavedRecordingManifest;
        steps: StepUnion[];
        enrichments?: RecordingEnhancementMap;
    };
};

export type RecordingState = {
    recordingEnabled: Set<string>;
    recordings: Map<string, StepUnion[]>;
    recordingEnhancements: Map<string, RecordingEnhancementMap>;
    recordingManifests: Map<string, RecordingManifest>;
    workspaceUnsavedRecording: Map<string, string>;
    workspaceSnapshots: Map<string, WorkspaceSavedSnapshot>;
    lastNavigateTs: Map<string, number>;
    lastClickTs: Map<string, number>;
    lastScrollY: Map<string, number>;
    recordSnapshotCache: Map<string, RecordSnapshotCacheEntry>;
    pendingEnhancements: Map<string, Set<Promise<void>>>;
    replaying: Set<string>;
    replayCancel: Set<string>;
    pendingFillEvents: Map<string, Map<string, { event: RecorderEvent; tabName: string }>>;
};

type RecorderEventSink = (event: RecorderEvent, page: Page, tabName: string) => void | Promise<void>;
let recorderEventSink: RecorderEventSink | null = null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
type RecordedStepEnricher = typeof enrichRecordedStepWithSnapshot;
let recordedStepEnricher: RecordedStepEnricher = enrichRecordedStepWithSnapshot;

export const setRecordedStepEnricherForTest = (enricher: RecordedStepEnricher | null): void => {
    recordedStepEnricher = enricher || enrichRecordedStepWithSnapshot;
};

export const setRecorderEventSink = (sink: RecorderEventSink | null): void => {
    recorderEventSink = sink;
};

/**
 * 创建录制状态容器，集中维护多个 tab 的录制信息。
 */
export const createRecordingState = (): RecordingState => ({
    recordingEnabled: new Set(),
    recordings: new Map(),
    recordingEnhancements: new Map(),
    recordingManifests: new Map(),
    workspaceUnsavedRecording: new Map(),
    workspaceSnapshots: new Map(),
    lastNavigateTs: new Map(),
    lastClickTs: new Map(),
    lastScrollY: new Map(),
    recordSnapshotCache: new Map(),
    pendingEnhancements: new Map(),
    replaying: new Set(),
    replayCancel: new Set(),
    pendingFillEvents: new Map(),
});

const unsavedRecordingToken = (workspaceName: string): string => `unsaved:${workspaceName}`;

export const resetWorkspaceUnsavedRecording = (
    state: RecordingState,
    workspaceName: string,
    seed?: {
        entryTabRef?: string;
        activeTabRef?: string;
        entryUrl?: string;
        initialTabs?: RecordingManifest['initialTabs'];
    },
): string => {
    const token = unsavedRecordingToken(workspaceName);
    state.workspaceUnsavedRecording.set(workspaceName, token);
    state.recordings.set(token, []);
    state.recordingEnhancements.delete(token);
    state.recordingManifests.set(token, {
        recordingToken: token,
        workspaceName,
        entryTabRef: seed?.entryTabRef,
        activeTabRef: seed?.activeTabRef,
        entryUrl: seed?.entryUrl,
        initialTabs: seed?.initialTabs || [],
        startedAt: Date.now(),
        tabs: [],
    });
    state.lastNavigateTs.set(token, 0);
    state.lastClickTs.set(token, 0);
    state.lastScrollY.set(token, 0);
    state.recordSnapshotCache.delete(token);
    state.pendingEnhancements.delete(token);
    state.pendingFillEvents.delete(token);
    return token;
};

export const getWorkspaceUnsavedRecordingBundle = (
    state: RecordingState,
    workspaceName: string,
): {
    recordingToken: string;
    steps: StepUnion[];
    manifest: RecordingManifest | undefined;
    enrichments: RecordingEnhancementMap;
} => {
    const token = state.workspaceUnsavedRecording.get(workspaceName) || unsavedRecordingToken(workspaceName);
    return {
        recordingToken: token,
        steps: state.recordings.get(token) || [],
        manifest: state.recordingManifests.get(token),
        enrichments: getRecordingEnhancements(state, token),
    };
};

export const clearWorkspaceUnsavedRecording = (state: RecordingState, workspaceName: string): void => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    state.workspaceUnsavedRecording.set(workspaceName, token);
    state.recordings.set(token, []);
    state.recordingEnhancements.delete(token);
    state.recordingManifests.delete(token);
    state.lastNavigateTs.set(token, 0);
    state.lastClickTs.set(token, 0);
    state.lastScrollY.set(token, 0);
    state.recordSnapshotCache.delete(token);
    state.pendingEnhancements.delete(token);
    state.pendingFillEvents.delete(token);
};

export const getWorkspaceUnsavedToken = (state: RecordingState, workspaceName: string): string =>
    state.workspaceUnsavedRecording.get(workspaceName) || unsavedRecordingToken(workspaceName);

export const isWorkspaceRecordingEnabled = (
    state: RecordingState,
    workspaceName: string,
): boolean => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    return state.recordingEnabled.has(token);
};

export const enableWorkspaceRecording = (state: RecordingState, workspaceName: string): void => {
    state.recordingEnabled.add(getWorkspaceUnsavedToken(state, workspaceName));
};

export const disableWorkspaceRecording = (state: RecordingState, workspaceName: string): void => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    flushPendingFillEvents(state, token);
    state.recordingEnabled.delete(token);
};

const setStepEnhancement = (
    state: RecordingState,
    recordingToken: string,
    stepId: string,
    enhancement: RecordedStepEnhancement,
) => {
    const current = state.recordingEnhancements.get(recordingToken) || {};
    current[stepId] = enhancement;
    state.recordingEnhancements.set(recordingToken, current);
};

const getRecordingEnhancements = (state: RecordingState, recordingToken: string): RecordingEnhancementMap => {
    return state.recordingEnhancements.get(recordingToken) || {};
};

const getPendingEnhancementSet = (state: RecordingState, recordingToken: string): Set<Promise<void>> => {
    let set = state.pendingEnhancements.get(recordingToken);
    if (!set) {
        set = new Set();
        state.pendingEnhancements.set(recordingToken, set);
    }
    return set;
};

const isUserActionBeforeGoto = (stepName: StepName): boolean =>
    stepName === 'browser.click' || stepName === 'browser.fill' || stepName === 'browser.press_key';

const isTabLifecycleStep = (stepName: StepName): boolean =>
    stepName === 'browser.create_tab' || stepName === 'browser.switch_tab' || stepName === 'browser.close_tab';

export const normalizeRecordingStepOrder = (steps: StepUnion[], navDedupeWindowMs: number): StepUnion[] => {
    const indexed = steps.map((step, index) => ({ step, index }));
    const lifecycleGotoIds = new Set<string>();
    for (let index = 1; index < steps.length; index += 1) {
        const step = steps[index];
        const previous = steps[index - 1];
        if (step.name !== 'browser.goto') {continue;}
        if (!isTabLifecycleStep(previous.name)) {continue;}
        if (step.meta?.tabName && previous.meta?.tabName && step.meta.tabName !== previous.meta.tabName) {continue;}
        lifecycleGotoIds.add(step.id);
    }
    const isLifecycleBarrier = (step: StepUnion): boolean =>
        isTabLifecycleStep(step.name) || lifecycleGotoIds.has(step.id);
    const compare = (a: (typeof indexed)[number], b: (typeof indexed)[number]): number => {
        if (isLifecycleBarrier(a.step) || isLifecycleBarrier(b.step)) {
            return a.index - b.index;
        }
        const aTs = a.step.meta?.ts;
        const bTs = b.step.meta?.ts;
        const aTab = a.step.meta?.tabName;
        const bTab = b.step.meta?.tabName;
        if (aTab && bTab && aTab === bTab && typeof aTs === 'number' && typeof bTs === 'number') {
            const delta = Math.abs(aTs - bTs);
            if (delta <= navDedupeWindowMs) {
                if (isUserActionBeforeGoto(a.step.name) && b.step.name === 'browser.goto') {return -1;}
                if (a.step.name === 'browser.goto' && isUserActionBeforeGoto(b.step.name)) {return 1;}
            }
        }
        if (typeof aTs === 'number' && typeof bTs === 'number' && aTs !== bTs) {
            return aTs - bTs;
        }
        if (typeof aTs === 'number' && typeof bTs !== 'number') {return -1;}
        if (typeof aTs !== 'number' && typeof bTs === 'number') {return 1;}
        return a.index - b.index;
    };
    return indexed.sort(compare).map((item) => item.step);
};

type StartRecordedStepEnrichmentInput = {
    state: RecordingState;
    recordingToken: string;
    stepId: string;
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
    workspaceName: string;
    stepName: StepName;
    ts?: number;
    tabName?: string;
};

const startRecordedStepEnrichment = (input: StartRecordedStepEnrichmentInput): void => {
    const recordLog = getLogger('record');
    const pending = getPendingEnhancementSet(input.state, input.recordingToken);
    const promise = (async () => {
        const enriched = await recordedStepEnricher({
            event: input.event,
            page: input.page,
            snapshotCache: input.snapshotCache,
            cacheKey: input.cacheKey,
        });
        setStepEnhancement(input.state, input.recordingToken, input.stepId, enriched);
        recordLog('enrichment_done', {
            stepId: input.stepId,
            stepName: input.stepName,
            ts: input.ts,
            tabName: input.tabName,
            workspaceName: input.workspaceName,
        });
    })()
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            recordLog('enrichment_failed', {
                stepId: input.stepId,
                stepName: input.stepName,
                ts: input.ts,
                tabName: input.tabName,
                workspaceName: input.workspaceName,
                message,
            });
        })
        .finally(() => {
            pending.delete(promise);
            if (!pending.size) {
                input.state.pendingEnhancements.delete(input.recordingToken);
            }
        });
    pending.add(promise);
};

export const awaitRecordingEnhancements = async (
    state: RecordingState,
    workspaceName: string,
): Promise<void> => {
    const token = getWorkspaceUnsavedToken(state, workspaceName);
    const pending = state.pendingEnhancements.get(token);
    if (!pending || !pending.size) {return;}
    await Promise.allSettled(Array.from(pending));
};

const createStep = <TName extends StepName>(
    name: TName,
    args: StepArgsMap[TName],
    ts: number,
    metaExtra?: Partial<Pick<StepMeta, 'workspaceName' | 'tabName' | 'tabRef' | 'urlAtRecord'>>,
    resolve?: StepResolve,
): Step<TName> => ({
    id: crypto.randomUUID(),
    name,
    args,
    meta: { source: 'record', ts, ...metaExtra },
    resolve,
});

const buildResolveFromEvent = (event: RecorderEvent): StepResolve | undefined => {
    const hint: ResolveHint = {
        target: {
            role: event.a11yHint?.role,
            name: event.a11yHint?.name,
            text: event.a11yHint?.text,
        },
        raw: {
            selector: event.selector,
            locatorCandidates: event.locatorCandidates?.map((item) => ({ ...item })),
            scopeHint: event.scopeHint || undefined,
            targetHint: event.targetHint,
        },
    };
    const policy: ResolvePolicy = {
        requireVisible: true,
    };
    if (!hint.target?.role && !hint.target?.name && !hint.target?.text && !hint.raw?.selector && !(hint.raw?.locatorCandidates || []).length) {
        return undefined;
    }
    return { hint, policy };
};

const toStep = (event: RecorderEvent): StepUnion | null => {
    if (event.type === 'navigate' && event.url) {
        return createStep('browser.goto', { url: event.url }, event.ts, {
            tabName: event.tabName,
            urlAtRecord: event.url,
        });
    }
    if (event.type === 'click' && (event.selector || event.a11yHint)) {
        return createStep(
            'browser.click',
            { selector: event.selector },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'input' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'change' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'date' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'select' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.select_option',
            { selector: event.selector, values: [event.value] },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'check' && (event.selector || event.a11yHint)) {
        // Current recorder mapping replays check/uncheck as click and does not enforce recorded checked state.
        return createStep(
            'browser.click',
            { selector: event.selector },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'keydown' && event.key) {
        return createStep(
            'browser.press_key',
            {
                key: event.key,
                selector: event.selector || undefined,
            },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'paste' && event.selector && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabName: event.tabName },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'scroll' && typeof event.scrollY === 'number') {
        const delta = event.scrollY;
        if (delta === 0) {return null;}
        return createStep(
            'browser.scroll',
            { direction: delta > 0 ? 'down' : 'up', amount: Math.abs(delta) },
            event.ts,
            { tabName: event.tabName },
        );
    }
    // Copy events are not mapped to steps in the current recorder output.
    return null;
};

const isFillLikeEvent = (event: RecorderEvent): boolean => {
    return (event.type === 'input' || event.type === 'change' || event.type === 'paste' || event.type === 'date')
        && typeof event.selector === 'string'
        && event.selector.trim().length > 0
        && typeof event.value === 'string';
};

const fillEventKey = (tabName: string, selector: string): string => `${tabName}::${selector}`;

const queuePendingFillEvent = (state: RecordingState, recordingToken: string, tabName: string, event: RecorderEvent): void => {
    const selector = (event.selector || '').trim();
    if (!selector) {return;}
    let pending = state.pendingFillEvents.get(recordingToken);
    if (!pending) {
        pending = new Map();
        state.pendingFillEvents.set(recordingToken, pending);
    }
    pending.set(fillEventKey(tabName, selector), { event: { ...event, selector }, tabName });
};

const flushPendingFillEvents = (
    state: RecordingState,
    recordingToken: string,
    options?: { exceptKey?: string; workspaceName?: string; page?: Page },
): void => {
    const pending = state.pendingFillEvents.get(recordingToken);
    if (!pending || pending.size === 0) {return;}
    const list = state.recordings.get(recordingToken) || [];
    const entries = Array.from(pending.entries())
        .filter(([key]) => key !== options?.exceptKey)
        .map(([key, item]) => ({ key, item }))
        .sort((a, b) => (a.item.event.ts || 0) - (b.item.event.ts || 0));
    for (const entry of entries) {
        const step = toStep(entry.item.event);
        if (!step) {
            pending.delete(entry.key);
            continue;
        }
        const normalized = enrichRecordedStep(state, recordingToken, entry.item.tabName, step);
        list.push(normalized);
        state.recordings.set(recordingToken, list);
        pending.delete(entry.key);
        startRecordedStepEnrichment({
            state,
            recordingToken,
            stepId: normalized.id,
            event: entry.item.event,
            page: options?.page,
            snapshotCache: state.recordSnapshotCache,
            cacheKey: recordingToken,
            workspaceName: options?.workspaceName || (normalized.meta?.workspaceName || ''),
            stepName: normalized.name,
            ts: normalized.meta?.ts,
            tabName: normalized.meta?.tabName || entry.item.tabName,
        });
    }
    if (pending.size === 0) {
        state.pendingFillEvents.delete(recordingToken);
    }
};

const ensureManifest = (
    state: RecordingState,
    recordingToken: string,
    seed?: { workspaceName?: string; entryTabRef?: string; entryUrl?: string },
): RecordingManifest => {
    let manifest = state.recordingManifests.get(recordingToken);
    if (!manifest) {
        manifest = {
            recordingToken,
            workspaceName: seed?.workspaceName,
            entryTabRef: seed?.entryTabRef,
            initialTabs: [],
            entryUrl: seed?.entryUrl,
            startedAt: Date.now(),
            tabs: [],
        };
        state.recordingManifests.set(recordingToken, manifest);
        return manifest;
    }
    if (!manifest.workspaceName && seed?.workspaceName) {manifest.workspaceName = seed.workspaceName;}
    if (!manifest.entryTabRef && seed?.entryTabRef) {manifest.entryTabRef = seed.entryTabRef;}
    if (!manifest.entryUrl && seed?.entryUrl) {manifest.entryUrl = seed.entryUrl;}
    return manifest;
};

const ensureTabInManifest = (
    manifest: RecordingManifest,
    tabName: string,
    seed?: { tabRef?: string; url?: string; at?: number },
): RecordingTabManifest => {
    const now = seed?.at || Date.now();
    let tab = manifest.tabs.find((item) => item.tabName === tabName);
    if (!tab) {
        tab = {
            tabName,
            tabRef: seed?.tabRef || tabName,
            firstSeenUrl: seed?.url,
            lastSeenUrl: seed?.url,
            firstSeenAt: now,
            lastSeenAt: now,
        };
        manifest.tabs.push(tab);
        return tab;
    }
    if (!tab.tabRef && seed?.tabRef) {tab.tabRef = seed.tabRef;}
    if (seed?.url) {
        if (!tab.firstSeenUrl) {tab.firstSeenUrl = seed.url;}
        tab.lastSeenUrl = seed.url;
    }
    tab.lastSeenAt = now;
    return tab;
};

export const attachTabToRecordingManifest = (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    seed?: { tabRef?: string; url?: string; at?: number },
): void => {
    const recordingToken = getWorkspaceUnsavedToken(state, workspaceName);
    const manifest = ensureManifest(state, recordingToken, { workspaceName });
    ensureTabInManifest(manifest, tabName, seed);
};

const enrichRecordedStep = (
    state: RecordingState,
    recordingToken: string,
    sourceTabName: string,
    step: StepUnion,
): StepUnion => {
    const ts = step.meta?.ts ?? Date.now();
    const manifest = ensureManifest(state, recordingToken);
    if (step.meta?.workspaceName && !manifest.workspaceName) {
        manifest.workspaceName = step.meta.workspaceName;
    }
    const stepTabName = step.meta?.tabName || sourceTabName;
    const args = step.args as unknown;
    const gotoUrl = isRecord(args) && typeof args.url === 'string' ? args.url : undefined;
    const switchTabUrl = isRecord(args) && typeof args.tabUrl === 'string' ? args.tabUrl : undefined;
    const stepUrl =
        step.meta?.urlAtRecord ||
        (step.name === 'browser.goto' ? gotoUrl : undefined) ||
        (step.name === 'browser.switch_tab' ? switchTabUrl : undefined) ||
        undefined;
    const tab = ensureTabInManifest(manifest, stepTabName, {
        tabRef: step.meta?.tabRef,
        url: stepUrl || undefined,
        at: ts,
    });
    if (!manifest.entryTabRef) {manifest.entryTabRef = tab.tabRef;}
    if (!manifest.entryUrl && stepUrl) {manifest.entryUrl = stepUrl;}
    return {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            tabName: stepTabName,
            tabRef: step.meta?.tabRef || tab.tabRef,
            urlAtRecord: step.meta?.urlAtRecord || stepUrl || undefined,
        },
    };
};

/**
 * 处理单条录制事件：
 * - 去重导航
 * - 脱敏长文本/密码
 * - 写入录制队列
 */
export const appendWorkspaceRecordingEvent = async (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    event: RecorderEvent,
    navDedupeWindowMs: number,
    page?: Page,
): Promise<{ accepted: boolean }> => {
    const recordLog = getLogger('record');
    if (!isWorkspaceRecordingEnabled(state, workspaceName)) {return { accepted: false };}
    const effectiveToken = getWorkspaceUnsavedToken(state, workspaceName);
    if (state.replaying.has(tabName)) {return { accepted: false };}
    const pendingFillKey = event.selector ? fillEventKey(tabName, event.selector.trim()) : undefined;
    if (event.type === 'navigate') {
        flushPendingFillEvents(state, effectiveToken, { workspaceName, page });
    } else if (event.type === 'click' && event.selector) {
        flushPendingFillEvents(state, effectiveToken, { exceptKey: pendingFillKey, workspaceName, page });
    }

    if (event.type === 'click') {
        state.lastClickTs.set(effectiveToken, event.ts);
    }

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (event.ts - last < navDedupeWindowMs) {
            return { accepted: false };
        }
        state.lastNavigateTs.set(effectiveToken, event.ts);
        state.recordSnapshotCache.delete(effectiveToken);
    }

    if (event.type === 'scroll' && typeof event.scrollY === 'number') {
        const last = state.lastScrollY.get(effectiveToken) ?? 0;
        const delta = event.scrollY - last;
        state.lastScrollY.set(effectiveToken, event.scrollY);
        event.scrollY = delta;
    }

    if (event.value && event.value !== '***') {
        const value = event.value.trim();
        if (value.length > 200) {
            event.value = '***';
        } else if (value.length > 80) {
            event.value = value.slice(0, 80);
        } else {
            event.value = value;
        }
    }

    if (isFillLikeEvent(event)) {
        queuePendingFillEvent(state, effectiveToken, tabName, event);
        return { accepted: true };
    }

    const step = toStep(event);
    if (!step) {return { accepted: false };}
    const normalized = enrichRecordedStep(state, effectiveToken, tabName, step);
    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
    recordLog('step_queued', {
        stepId: normalized.id,
        stepName: normalized.name,
        ts: normalized.meta?.ts,
        tabName: normalized.meta?.tabName || tabName,
        workspaceName,
    });
    startRecordedStepEnrichment({
        state,
        recordingToken: effectiveToken,
        stepId: normalized.id,
        event,
        page,
        snapshotCache: state.recordSnapshotCache,
        cacheKey: effectiveToken,
        workspaceName,
        stepName: normalized.name,
        ts: normalized.meta?.ts,
        tabName: normalized.meta?.tabName || tabName,
    });
    return { accepted: true };
};

export const appendWorkspaceRecordingStep = (
    state: RecordingState,
    workspaceName: string,
    tabName: string,
    step: StepUnion,
    navDedupeWindowMs: number,
    options?: { flushPendingFill?: boolean; updateNavigateDedupe?: boolean },
): { accepted: boolean } => {
    const recordLog = getLogger('record');
    if (!isWorkspaceRecordingEnabled(state, workspaceName)) {return { accepted: false };}
    const effectiveToken = getWorkspaceUnsavedToken(state, workspaceName);
    if (state.replaying.has(tabName) || state.replaying.has(effectiveToken)) {return { accepted: false };}
    if (options?.flushPendingFill !== false) {
        flushPendingFillEvents(state, effectiveToken, { workspaceName });
    }

    const ts = step.meta?.ts ?? Date.now();
    const normalized = enrichRecordedStep(state, effectiveToken, tabName, {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            tabName: step.meta?.tabName || tabName,
        },
    });

    if (normalized.name === 'browser.click') {
        state.lastClickTs.set(effectiveToken, ts);
    }
    if (normalized.name === 'browser.goto') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (options?.updateNavigateDedupe !== false) {
            if (ts - last < navDedupeWindowMs) {return { accepted: false };}
            state.lastNavigateTs.set(effectiveToken, ts);
        }
    }

    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
    recordLog('step_queued', {
        stepId: normalized.id,
        stepName: normalized.name,
        ts,
        tabName: normalized.meta?.tabName || tabName,
        workspaceName,
    });
    return { accepted: true };
};

const navListenerPages = new WeakSet<Page>();

/**
 * 监听主 frame 的导航，补充 navigate 事件。
 */
export const installNavigationRecorder = (
    state: RecordingState,
    workspaceName: string,
    page: Page,
    tabName: string,
    navDedupeWindowMs: number,
): void => {
    if (navListenerPages.has(page)) {return;}
    navListenerPages.add(page);
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) {return;}
        if (!isWorkspaceRecordingEnabled(state, workspaceName)) {return;}
        const effectiveToken = getWorkspaceUnsavedToken(state, workspaceName);
        const lastClick = state.lastClickTs.get(effectiveToken) || 0;
        const source = Date.now() - lastClick < navDedupeWindowMs ? 'click' : 'direct';
        const navigateEvent: RecorderEvent = {
            tabName,
            ts: Date.now(),
            type: 'navigate',
            url: frame.url(),
            source,
        };
        if (recorderEventSink) {
            void recorderEventSink(navigateEvent, page, tabName);
            return;
        }
        void appendWorkspaceRecordingEvent(state, workspaceName, tabName, navigateEvent, navDedupeWindowMs, page);
    });
};

/**
 * 确保在指定页面安装录制脚本与导航监听。
 */
export const ensureRecorder = async (
    state: RecordingState,
    workspaceName: string,
    page: Page,
    tabName: string,
    navDedupeWindowMs: number,
): Promise<void> => {
    await installRecorder(page, tabName, (event) => {
        if (recorderEventSink) {
            return recorderEventSink(event, page, tabName);
        }
        void appendWorkspaceRecordingEvent(state, workspaceName, tabName, event, navDedupeWindowMs, page);
    });
    installNavigationRecorder(state, workspaceName, page, tabName, navDedupeWindowMs);
};

/**
 * 标记进入回放，避免录制回放自身的动作。
 */
export const beginReplay = (state: RecordingState, tabName: string): void => {
    state.replaying.add(tabName);
    state.replayCancel.delete(tabName);
};

/**
 * 退出回放状态。
 */
export const endReplay = (state: RecordingState, tabName: string): void => {
    state.replaying.delete(tabName);
    state.replayCancel.delete(tabName);
};

/**
 * 请求取消回放（由上层循环读取）。
 */
export const cancelReplay = (state: RecordingState, tabName: string): void => {
    state.replayCancel.add(tabName);
};

export type WorkspaceRecordingSummary = {
    workspaceName: string;
    recordingToken: string;
    stepCount: number;
    entryUrl?: string;
    startedAt: number;
    updatedAt: number;
};

const sanitizeSavedManifest = (manifest?: RecordingManifest): SavedRecordingManifest | undefined => {
    if (!manifest) {return undefined;}
    return {
        ...manifest,
        tabs: manifest.tabs.map((tab) => ({
            tabRef: tab.tabRef,
            tabName: tab.tabName,
            firstSeenUrl: tab.firstSeenUrl,
            lastSeenUrl: tab.lastSeenUrl,
            firstSeenAt: tab.firstSeenAt,
            lastSeenAt: tab.lastSeenAt,
        })),
    };
};

const sanitizeSavedStep = (step: StepUnion): StepUnion => {
    if (!step.meta) {return { ...step };}
    return {
        ...step,
        meta: { ...step.meta },
    };
};

export const saveWorkspaceSnapshot = (
    state: RecordingState,
    payload: {
        workspaceName: string;
        tabs: WorkspaceSavedTab[];
        recordingToken: string | null;
        steps: StepUnion[];
        manifest?: RecordingManifest;
        enrichments?: RecordingEnhancementMap;
    },
): WorkspaceSavedSnapshot => {
    const snapshot: WorkspaceSavedSnapshot = {
        workspaceName: payload.workspaceName,
        savedAt: Date.now(),
        tabs: payload.tabs.map((tab) => ({
            tabName: tab.tabName,
            url: tab.url,
            title: tab.title,
            active: tab.active,
        })),
        recording: {
            recordingToken: payload.recordingToken,
            manifest: sanitizeSavedManifest(payload.manifest),
            steps: payload.steps.map(sanitizeSavedStep),
            enrichments: payload.enrichments,
        },
    };
    state.workspaceSnapshots.set(payload.workspaceName, snapshot);
    return snapshot;
};

export const getWorkspaceSnapshot = (state: RecordingState, workspaceName: string): WorkspaceSavedSnapshot | undefined => {
    return state.workspaceSnapshots.get(workspaceName);
};

export const listWorkspaceRecordings = (state: RecordingState): WorkspaceRecordingSummary[] => {
    const summaries: WorkspaceRecordingSummary[] = [];
    for (const snapshot of state.workspaceSnapshots.values()) {
        summaries.push({
            workspaceName: snapshot.workspaceName,
            recordingToken: snapshot.recording.recordingToken || snapshot.workspaceName,
            stepCount: snapshot.recording.steps.length,
            entryUrl: snapshot.recording.manifest?.entryUrl,
            startedAt: snapshot.recording.manifest?.startedAt || snapshot.savedAt,
            updatedAt: snapshot.savedAt,
        });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
};

/**
 * tab 关闭时清理所有录制相关状态。
 */
export const cleanupRecording = (state: RecordingState, tabName: string): void => {
    state.replaying.delete(tabName);
    state.replayCancel.delete(tabName);
};
