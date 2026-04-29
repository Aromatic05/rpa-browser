/**
 * recording：维护录制/回放运行时状态，并负责事件去重/脱敏。
 *
 * 依赖关系：
 * - 上游：agent/index.ts 通过 start/stop/ensureRecorder 驱动
 * - 下游：recorder.ts 提供事件流；play/replay 使用 recordings
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
    tabToken: string;
    tabRef: string;
    tabId?: string;
    firstSeenUrl?: string;
    lastSeenUrl?: string;
    firstSeenAt: number;
    lastSeenAt: number;
};

export type RecordingManifest = {
    recordingToken: string;
    workspaceId?: string;
    entryTabRef?: string;
    entryUrl?: string;
    startedAt: number;
    tabs: RecordingTabManifest[];
};

export type SavedRecordingTabManifest = Omit<RecordingTabManifest, 'tabToken'>;
export type SavedRecordingManifest = Omit<RecordingManifest, 'tabs'> & {
    tabs: SavedRecordingTabManifest[];
};

export type WorkspaceSavedTab = {
    tabId: string;
    url: string;
    title: string;
    active: boolean;
};

export type WorkspaceSavedSnapshot = {
    workspaceId: string;
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
    workspaceLatestRecording: Map<string, string>;
    workspaceSnapshots: Map<string, WorkspaceSavedSnapshot>;
    lastNavigateTs: Map<string, number>;
    lastClickTs: Map<string, number>;
    lastScrollY: Map<string, number>;
    recordSnapshotCache: Map<string, RecordSnapshotCacheEntry>;
    replaying: Set<string>;
    replayCancel: Set<string>;
};

type RecorderEventSink = (event: RecorderEvent, page: Page, tabToken: string) => void | Promise<void>;
let recorderEventSink: RecorderEventSink | null = null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

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
    workspaceLatestRecording: new Map(),
    workspaceSnapshots: new Map(),
    lastNavigateTs: new Map(),
    lastClickTs: new Map(),
    lastScrollY: new Map(),
    recordSnapshotCache: new Map(),
    replaying: new Set(),
    replayCancel: new Set(),
});

const resolveSingleRecordingToken = (
    state: RecordingState,
    tabToken: string,
    opts?: { mustBeEnabled?: boolean; workspaceId?: string },
): string => {
    const mustBeEnabled = opts?.mustBeEnabled !== false;
    const workspaceId = opts?.workspaceId;
    if (tabToken && mustBeEnabled && state.recordingEnabled.has(tabToken)) {
        return tabToken;
    }
    if (tabToken && !mustBeEnabled && state.recordings.has(tabToken)) {
        return tabToken;
    }
    if (workspaceId) {
        const workspaceToken = state.workspaceLatestRecording.get(workspaceId);
        if (workspaceToken) {
            if (mustBeEnabled && state.recordingEnabled.has(workspaceToken)) {return workspaceToken;}
            if (!mustBeEnabled && state.recordings.has(workspaceToken)) {return workspaceToken;}
        }
        for (const [token, manifest] of state.recordingManifests.entries()) {
            if (manifest.workspaceId !== workspaceId) {continue;}
            if (mustBeEnabled && state.recordingEnabled.has(token)) {return token;}
            if (!mustBeEnabled && state.recordings.has(token)) {return token;}
        }
    }
    if (state.recordingEnabled.size === 1) {
        return Array.from(state.recordingEnabled)[0];
    }
    if (!mustBeEnabled && state.recordings.size === 1) {
        return Array.from(state.recordings.keys())[0];
    }
    return tabToken;
};

const indexWorkspaceRecording = (state: RecordingState, recordingToken: string, workspaceId?: string) => {
    if (!workspaceId) {return;}
    state.workspaceLatestRecording.set(workspaceId, recordingToken);
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

const createStep = <TName extends StepName>(
    name: TName,
    args: StepArgsMap[TName],
    ts: number,
    metaExtra?: Partial<Pick<StepMeta, 'workspaceId' | 'tabId' | 'tabToken' | 'tabRef' | 'urlAtRecord'>>,
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
            tabToken: event.tabToken,
            urlAtRecord: event.url,
        });
    }
    if (event.type === 'click' && (event.selector || event.a11yHint)) {
        return createStep(
            'browser.click',
            { selector: event.selector },
            event.ts,
            { tabToken: event.tabToken },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'input' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'change' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'date' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'select' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.select_option',
            { selector: event.selector, values: [event.value] },
            event.ts,
            { tabToken: event.tabToken },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'check' && (event.selector || event.a11yHint)) {
        // Current recorder mapping replays check/uncheck as click and does not enforce recorded checked state.
        return createStep(
            'browser.click',
            { selector: event.selector },
            event.ts,
            { tabToken: event.tabToken },
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
            { tabToken: event.tabToken },
            buildResolveFromEvent(event),
        );
    }
    if (event.type === 'paste' && event.selector && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { selector: event.selector, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
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
            { tabToken: event.tabToken },
        );
    }
    // Copy events are not mapped to steps in the current recorder output.
    return null;
};

const ensureManifest = (
    state: RecordingState,
    recordingToken: string,
    seed?: { workspaceId?: string; entryTabRef?: string; entryUrl?: string },
): RecordingManifest => {
    let manifest = state.recordingManifests.get(recordingToken);
    if (!manifest) {
        manifest = {
            recordingToken,
            workspaceId: seed?.workspaceId,
            entryTabRef: seed?.entryTabRef,
            entryUrl: seed?.entryUrl,
            startedAt: Date.now(),
            tabs: [],
        };
        state.recordingManifests.set(recordingToken, manifest);
        return manifest;
    }
    if (!manifest.workspaceId && seed?.workspaceId) {manifest.workspaceId = seed.workspaceId;}
    if (manifest.workspaceId) {
        indexWorkspaceRecording(state, recordingToken, manifest.workspaceId);
    }
    if (!manifest.entryTabRef && seed?.entryTabRef) {manifest.entryTabRef = seed.entryTabRef;}
    if (!manifest.entryUrl && seed?.entryUrl) {manifest.entryUrl = seed.entryUrl;}
    return manifest;
};

const ensureTabInManifest = (
    manifest: RecordingManifest,
    tabToken: string,
    seed?: { tabRef?: string; tabId?: string; url?: string; at?: number },
): RecordingTabManifest => {
    const now = seed?.at || Date.now();
    let tab = manifest.tabs.find((item) => item.tabToken === tabToken);
    if (!tab) {
        tab = {
            tabToken,
            tabRef: seed?.tabRef || seed?.tabId || tabToken,
            tabId: seed?.tabId,
            firstSeenUrl: seed?.url,
            lastSeenUrl: seed?.url,
            firstSeenAt: now,
            lastSeenAt: now,
        };
        manifest.tabs.push(tab);
        return tab;
    }
    if (!tab.tabId && seed?.tabId) {tab.tabId = seed.tabId;}
    if (!tab.tabRef && seed?.tabRef) {tab.tabRef = seed.tabRef;}
    if (seed?.url) {
        if (!tab.firstSeenUrl) {tab.firstSeenUrl = seed.url;}
        tab.lastSeenUrl = seed.url;
    }
    tab.lastSeenAt = now;
    return tab;
};

const enrichRecordedStep = (
    state: RecordingState,
    recordingToken: string,
    sourceTabToken: string,
    step: StepUnion,
): StepUnion => {
    const ts = step.meta?.ts ?? Date.now();
    const manifest = ensureManifest(state, recordingToken);
    if (step.meta?.workspaceId && !manifest.workspaceId) {
        manifest.workspaceId = step.meta.workspaceId;
    }
    if (manifest.workspaceId) {
        indexWorkspaceRecording(state, recordingToken, manifest.workspaceId);
    }
    const stepTabToken = step.meta?.tabToken || sourceTabToken;
    const args = step.args as unknown;
    const gotoUrl = isRecord(args) && typeof args.url === 'string' ? args.url : undefined;
    const switchTabUrl = isRecord(args) && typeof args.tabUrl === 'string' ? args.tabUrl : undefined;
    const stepUrl =
        step.meta?.urlAtRecord ||
        (step.name === 'browser.goto' ? gotoUrl : undefined) ||
        (step.name === 'browser.switch_tab' ? switchTabUrl : undefined) ||
        undefined;
    const tab = ensureTabInManifest(manifest, stepTabToken, {
        tabId: step.meta?.tabId,
        tabRef: step.meta?.tabRef || step.meta?.tabId,
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
            tabToken: stepTabToken,
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
export const recordEvent = async (
    state: RecordingState,
    event: RecorderEvent,
    navDedupeWindowMs: number,
    page?: Page,
): Promise<void> => {
    const recordLog = getLogger('record');
    const tabToken = event.tabToken;
    let effectiveToken = tabToken;
    if (!effectiveToken || !state.recordingEnabled.has(effectiveToken)) {
        if (state.recordingEnabled.size === 1) {
            effectiveToken = Array.from(state.recordingEnabled)[0];
        } else {
            return;
        }
    }
    if (state.replaying.has(tabToken)) {return;}

    if (event.type === 'click') {
        state.lastClickTs.set(effectiveToken, event.ts);
    }

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (event.ts - last < navDedupeWindowMs) {
            return;
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

    const step = toStep(event);
    if (!step) {return;}
    const normalized = enrichRecordedStep(state, effectiveToken, event.tabToken, step);
    const enriched = await enrichRecordedStepWithSnapshot({
        event,
        page,
        snapshotCache: state.recordSnapshotCache,
        cacheKey: effectiveToken,
    });

    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
    setStepEnhancement(state, effectiveToken, normalized.id, enriched);
    recordLog('event', {
        type: normalized.name,
        tabToken: effectiveToken,
        sourceTabToken: event.tabToken,
        ts: event.ts,
    });
};

export const recordStep = (
    state: RecordingState,
    tabToken: string,
    step: StepUnion,
    navDedupeWindowMs: number,
): void => {
    const recordLog = getLogger('record');
    let effectiveToken = tabToken;
    if (!effectiveToken || !state.recordingEnabled.has(effectiveToken)) {
        if (state.recordingEnabled.size === 1) {
            effectiveToken = Array.from(state.recordingEnabled)[0];
        } else {
            return;
        }
    }
    if (state.replaying.has(tabToken) || state.replaying.has(effectiveToken)) {return;}

    const ts = step.meta?.ts ?? Date.now();
    const normalized = enrichRecordedStep(state, effectiveToken, tabToken, {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            tabToken: step.meta?.tabToken || tabToken,
        },
    });

    if (normalized.name === 'browser.click') {
        state.lastClickTs.set(effectiveToken, ts);
    }
    if (normalized.name === 'browser.goto') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (ts - last < navDedupeWindowMs) {return;}
        state.lastNavigateTs.set(effectiveToken, ts);
    }

    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
    recordLog('event', {
        type: normalized.name,
        tabToken: effectiveToken,
        sourceTabToken: tabToken,
        ts,
    });
};

const navListenerPages = new WeakSet<Page>();

/**
 * 监听主 frame 的导航，补充 navigate 事件。
 */
export const installNavigationRecorder = (
    state: RecordingState,
    page: Page,
    tabToken: string,
    navDedupeWindowMs: number,
): void => {
    if (navListenerPages.has(page)) {return;}
    navListenerPages.add(page);
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) {return;}
        if (!state.recordingEnabled.has(tabToken)) {return;}
        const lastClick = state.lastClickTs.get(tabToken) || 0;
        const source = Date.now() - lastClick < navDedupeWindowMs ? 'click' : 'direct';
        const navigateEvent: RecorderEvent = {
            tabToken,
            ts: Date.now(),
            type: 'navigate',
            url: frame.url(),
            source,
        };
        if (recorderEventSink) {
            void recorderEventSink(navigateEvent, page, tabToken);
            return;
        }
        void recordEvent(state, navigateEvent, navDedupeWindowMs, page);
    });
};

/**
 * 确保在指定页面安装录制脚本与导航监听。
 */
export const ensureRecorder = async (
    state: RecordingState,
    page: Page,
    tabToken: string,
    navDedupeWindowMs: number,
): Promise<void> => {
    await installRecorder(page, (event) => {
        if (recorderEventSink) {
            return recorderEventSink(event, page, tabToken);
        }
        void recordEvent(state, event, navDedupeWindowMs, page);
    });
    installNavigationRecorder(state, page, tabToken, navDedupeWindowMs);
};

/**
 * 开始录制：初始化状态并安装 recorder。
 */
export const startRecording = async (
    state: RecordingState,
    page: Page,
    tabToken: string,
    navDedupeWindowMs: number,
    seed?: { workspaceId?: string; tabId?: string; entryUrl?: string },
): Promise<void> => {
    const recordLog = getLogger('record');
    state.recordingEnabled.add(tabToken);
    if (!state.recordings.has(tabToken)) {
        state.recordings.set(tabToken, []);
    }
    state.lastNavigateTs.set(tabToken, 0);
    state.lastClickTs.set(tabToken, 0);
    state.lastScrollY.set(tabToken, 0);
    const manifest = ensureManifest(state, tabToken, {
        workspaceId: seed?.workspaceId,
        entryTabRef: seed?.tabId || tabToken,
        entryUrl: seed?.entryUrl || page.url(),
    });
    indexWorkspaceRecording(state, tabToken, manifest.workspaceId);
    ensureTabInManifest(manifest, tabToken, {
        tabId: seed?.tabId,
        tabRef: seed?.tabId || tabToken,
        url: seed?.entryUrl || page.url(),
    });
    recordLog('start', { tabToken, url: page.url() });
    await ensureRecorder(state, page, tabToken, navDedupeWindowMs);
};

/**
 * 停止录制：仅关闭录制开关，保留已有记录。
 */
export const stopRecording = (state: RecordingState, tabToken: string, opts?: { workspaceId?: string }): void => {
    const recordLog = getLogger('record');
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, {
        mustBeEnabled: true,
        workspaceId: opts?.workspaceId,
    });
    state.recordingEnabled.delete(effectiveToken);
    state.lastNavigateTs.delete(effectiveToken);
    state.lastClickTs.delete(effectiveToken);
    state.lastScrollY.delete(effectiveToken);
    state.recordSnapshotCache.delete(effectiveToken);
    recordLog('stop', {
        tabToken: effectiveToken,
        sourceTabToken: tabToken,
        workspaceId: opts?.workspaceId,
    });
};

/**
 * 标记进入回放，避免录制回放自身的动作。
 */
export const beginReplay = (state: RecordingState, tabToken: string): void => {
    state.replaying.add(tabToken);
    state.replayCancel.delete(tabToken);
};

/**
 * 退出回放状态。
 */
export const endReplay = (state: RecordingState, tabToken: string): void => {
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};

/**
 * 请求取消回放（由上层循环读取）。
 */
export const cancelReplay = (state: RecordingState, tabToken: string): void => {
    state.replayCancel.add(tabToken);
};

export const getRecording = (state: RecordingState, tabToken: string): StepUnion[] => {
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, { mustBeEnabled: false });
    return state.recordings.get(effectiveToken) || [];
};

export const getRecordingBundle = (
    state: RecordingState,
    tabToken: string,
    opts?: { workspaceId?: string },
): {
    recordingToken: string;
    steps: StepUnion[];
    manifest: RecordingManifest | undefined;
    enrichments: RecordingEnhancementMap;
} => {
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, {
        mustBeEnabled: false,
        workspaceId: opts?.workspaceId,
    });
    return {
        recordingToken: effectiveToken,
        steps: state.recordings.get(effectiveToken) || [],
        manifest: state.recordingManifests.get(effectiveToken),
        enrichments: getRecordingEnhancements(state, effectiveToken),
    };
};

export const clearRecording = (state: RecordingState, tabToken: string, opts?: { workspaceId?: string }): void => {
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, {
        mustBeEnabled: false,
        workspaceId: opts?.workspaceId,
    });
    const manifest = state.recordingManifests.get(effectiveToken);
    state.recordings.set(effectiveToken, []);
    state.recordingEnhancements.delete(effectiveToken);
    state.recordingManifests.delete(effectiveToken);
    if (manifest?.workspaceId && state.workspaceLatestRecording.get(manifest.workspaceId) === effectiveToken) {
        state.workspaceLatestRecording.delete(manifest.workspaceId);
    }
};

export type WorkspaceRecordingSummary = {
    workspaceId: string;
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
            tabId: tab.tabId,
            firstSeenUrl: tab.firstSeenUrl,
            lastSeenUrl: tab.lastSeenUrl,
            firstSeenAt: tab.firstSeenAt,
            lastSeenAt: tab.lastSeenAt,
        })),
    };
};

const sanitizeSavedStep = (step: StepUnion): StepUnion => {
    if (!step.meta) {return { ...step };}
    const { tabToken: _dropTabToken, ...metaNoToken } = step.meta;
    return {
        ...step,
        meta: metaNoToken,
    };
};

export const saveWorkspaceSnapshot = (
    state: RecordingState,
    payload: {
        workspaceId: string;
        tabs: WorkspaceSavedTab[];
        recordingToken: string | null;
        steps: StepUnion[];
        manifest?: RecordingManifest;
        enrichments?: RecordingEnhancementMap;
    },
): WorkspaceSavedSnapshot => {
    const snapshot: WorkspaceSavedSnapshot = {
        workspaceId: payload.workspaceId,
        savedAt: Date.now(),
        tabs: payload.tabs.map((tab) => ({
            tabId: tab.tabId,
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
    state.workspaceSnapshots.set(payload.workspaceId, snapshot);
    return snapshot;
};

export const getWorkspaceSnapshot = (state: RecordingState, workspaceId: string): WorkspaceSavedSnapshot | undefined => {
    return state.workspaceSnapshots.get(workspaceId);
};

export const listWorkspaceRecordings = (state: RecordingState): WorkspaceRecordingSummary[] => {
    const summaries: WorkspaceRecordingSummary[] = [];
    for (const snapshot of state.workspaceSnapshots.values()) {
        summaries.push({
            workspaceId: snapshot.workspaceId,
            recordingToken: snapshot.recording.recordingToken || snapshot.workspaceId,
            stepCount: snapshot.recording.steps.length,
            entryUrl: snapshot.recording.manifest?.entryUrl,
            startedAt: snapshot.recording.manifest?.startedAt || snapshot.savedAt,
            updatedAt: snapshot.savedAt,
        });
    }
    const seen = new Set(summaries.map((item) => item.workspaceId));
    for (const [workspaceId, recordingToken] of state.workspaceLatestRecording.entries()) {
        if (seen.has(workspaceId)) {continue;}
        const manifest = state.recordingManifests.get(recordingToken);
        if (!manifest) {continue;}
        const latestTabTs = manifest.tabs.reduce((maxTs, tab) => Math.max(maxTs, tab.lastSeenAt || 0), 0);
        summaries.push({
            workspaceId,
            recordingToken,
            stepCount: (state.recordings.get(recordingToken) || []).length,
            entryUrl: manifest.entryUrl,
            startedAt: manifest.startedAt,
            updatedAt: latestTabTs || manifest.startedAt,
        });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
};

/**
 * tab 关闭时清理所有录制相关状态。
 */
export const cleanupRecording = (state: RecordingState, tabToken: string): void => {
    state.recordingEnabled.delete(tabToken);
    state.lastNavigateTs.delete(tabToken);
    state.lastClickTs.delete(tabToken);
    state.lastScrollY.delete(tabToken);
    state.recordingEnhancements.delete(tabToken);
    state.recordSnapshotCache.delete(tabToken);
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};
