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
import type { Step, StepArgsMap, StepMeta, StepName, StepUnion } from '../runner/steps/types';

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

export type RecordingState = {
    recordingEnabled: Set<string>;
    recordings: Map<string, StepUnion[]>;
    recordingManifests: Map<string, RecordingManifest>;
    lastNavigateTs: Map<string, number>;
    lastClickTs: Map<string, number>;
    lastScrollY: Map<string, number>;
    replaying: Set<string>;
    replayCancel: Set<string>;
};

/**
 * 创建录制状态容器，集中维护多个 tab 的录制信息。
 */
export const createRecordingState = (): RecordingState => ({
    recordingEnabled: new Set(),
    recordings: new Map(),
    recordingManifests: new Map(),
    lastNavigateTs: new Map(),
    lastClickTs: new Map(),
    lastScrollY: new Map(),
    replaying: new Set(),
    replayCancel: new Set(),
});

const resolveSingleRecordingToken = (
    state: RecordingState,
    tabToken: string,
    opts?: { mustBeEnabled?: boolean },
) => {
    const mustBeEnabled = opts?.mustBeEnabled !== false;
    if (tabToken && mustBeEnabled && state.recordingEnabled.has(tabToken)) {
        return tabToken;
    }
    if (tabToken && !mustBeEnabled && state.recordings.has(tabToken)) {
        return tabToken;
    }
    if (state.recordingEnabled.size === 1) {
        return Array.from(state.recordingEnabled)[0];
    }
    if (!mustBeEnabled && state.recordings.size === 1) {
        return Array.from(state.recordings.keys())[0];
    }
    return tabToken;
};

const createStep = <TName extends StepName>(
    name: TName,
    args: StepArgsMap[TName],
    ts: number,
    metaExtra?: Partial<Pick<StepMeta, 'workspaceId' | 'tabId' | 'tabToken' | 'tabRef' | 'urlAtRecord'>>,
): Step<TName> => ({
    id: crypto.randomUUID(),
    name,
    args,
    meta: { source: 'record', ts, ...metaExtra },
});

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
            { target: { selector: event.selector, a11yHint: event.a11yHint } },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'input' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { target: { selector: event.selector, a11yHint: event.a11yHint }, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'change' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { target: { selector: event.selector, a11yHint: event.a11yHint }, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'date' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { target: { selector: event.selector, a11yHint: event.a11yHint }, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'select' && (event.selector || event.a11yHint) && typeof event.value === 'string') {
        return createStep(
            'browser.select_option',
            { target: { selector: event.selector, a11yHint: event.a11yHint }, values: [event.value] },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'check' && (event.selector || event.a11yHint)) {
        // TODO: ensure checked state matches (recorded checked flag is not enforced).
        return createStep(
            'browser.click',
            { target: { selector: event.selector, a11yHint: event.a11yHint } },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'keydown' && event.key) {
        return createStep(
            'browser.press_key',
            {
                key: event.key,
                target: event.selector ? { selector: event.selector, a11yHint: event.a11yHint } : undefined,
            },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'paste' && event.selector && typeof event.value === 'string') {
        return createStep(
            'browser.fill',
            { target: { selector: event.selector, a11yHint: event.a11yHint }, value: event.value },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    if (event.type === 'scroll' && typeof event.scrollY === 'number') {
        const delta = event.scrollY;
        if (delta === 0) return null;
        return createStep(
            'browser.scroll',
            { direction: delta > 0 ? 'down' : 'up', amount: Math.abs(delta) },
            event.ts,
            { tabToken: event.tabToken },
        );
    }
    // TODO: map copy to steps if needed.
    return null;
};

const ensureManifest = (
    state: RecordingState,
    recordingToken: string,
    seed?: { workspaceId?: string; entryTabRef?: string; entryUrl?: string },
) => {
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
    if (!manifest.workspaceId && seed?.workspaceId) manifest.workspaceId = seed.workspaceId;
    if (!manifest.entryTabRef && seed?.entryTabRef) manifest.entryTabRef = seed.entryTabRef;
    if (!manifest.entryUrl && seed?.entryUrl) manifest.entryUrl = seed.entryUrl;
    return manifest;
};

const ensureTabInManifest = (
    manifest: RecordingManifest,
    tabToken: string,
    seed?: { tabRef?: string; tabId?: string; url?: string; at?: number },
) => {
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
    if (!tab.tabId && seed?.tabId) tab.tabId = seed.tabId;
    if (!tab.tabRef && seed?.tabRef) tab.tabRef = seed.tabRef;
    if (seed?.url) {
        if (!tab.firstSeenUrl) tab.firstSeenUrl = seed.url;
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
    const stepTabToken = step.meta?.tabToken || sourceTabToken;
    const stepUrl =
        step.meta?.urlAtRecord ||
        (step.name === 'browser.goto' ? String((step.args as any)?.url || '') : undefined) ||
        (step.name === 'browser.switch_tab' ? String((step.args as any)?.tab_url || '') : undefined) ||
        undefined;
    const tab = ensureTabInManifest(manifest, stepTabToken, {
        tabId: step.meta?.tabId,
        tabRef: step.meta?.tabRef || step.meta?.tabId,
        url: stepUrl || undefined,
        at: ts,
    });
    if (!manifest.entryTabRef) manifest.entryTabRef = tab.tabRef;
    if (!manifest.entryUrl && stepUrl) manifest.entryUrl = stepUrl;
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
    } as StepUnion;
};

/**
 * 处理单条录制事件：
 * - 去重导航
 * - 脱敏长文本/密码
 * - 写入录制队列
 */
export const recordEvent = (
    state: RecordingState,
    event: RecorderEvent,
    navDedupeWindowMs: number,
) => {
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
    if (state.replaying.has(tabToken)) return;

    if (event.type === 'click') {
        state.lastClickTs.set(effectiveToken, event.ts);
    }

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (event.ts - last < navDedupeWindowMs) {
            return;
        }
        state.lastNavigateTs.set(effectiveToken, event.ts);
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
    if (!step) return;
    const normalized = enrichRecordedStep(state, effectiveToken, event.tabToken, step);

    const list = state.recordings.get(effectiveToken) || [];
    list.push(normalized);
    state.recordings.set(effectiveToken, list);
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
) => {
    const recordLog = getLogger('record');
    let effectiveToken = tabToken;
    if (!effectiveToken || !state.recordingEnabled.has(effectiveToken)) {
        if (state.recordingEnabled.size === 1) {
            effectiveToken = Array.from(state.recordingEnabled)[0];
        } else {
            return;
        }
    }
    if (state.replaying.has(tabToken) || state.replaying.has(effectiveToken)) return;

    const ts = step.meta?.ts ?? Date.now();
    const normalized = enrichRecordedStep(state, effectiveToken, tabToken, {
        ...step,
        meta: {
            ...step.meta,
            source: step.meta?.source ?? 'record',
            ts,
            tabToken: step.meta?.tabToken || tabToken,
        },
    } as StepUnion);

    if (normalized.name === 'browser.click') {
        state.lastClickTs.set(effectiveToken, ts);
    }
    if (normalized.name === 'browser.goto') {
        const last = state.lastNavigateTs.get(effectiveToken) || 0;
        if (ts - last < navDedupeWindowMs) return;
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
) => {
    if (navListenerPages.has(page)) return;
    navListenerPages.add(page);
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        if (!state.recordingEnabled.has(tabToken)) return;
        const lastClick = state.lastClickTs.get(tabToken) || 0;
        const source = Date.now() - lastClick < navDedupeWindowMs ? 'click' : 'direct';
        recordEvent(
            state,
            {
                tabToken,
                ts: Date.now(),
                type: 'navigate',
                url: frame.url(),
                source,
            },
            navDedupeWindowMs,
        );
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
) => {
    await installRecorder(page, (event) => recordEvent(state, event, navDedupeWindowMs));
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
) => {
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
export const stopRecording = (state: RecordingState, tabToken: string) => {
    const recordLog = getLogger('record');
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, { mustBeEnabled: true });
    state.recordingEnabled.delete(effectiveToken);
    state.lastNavigateTs.delete(effectiveToken);
    state.lastClickTs.delete(effectiveToken);
    state.lastScrollY.delete(effectiveToken);
    recordLog('stop', { tabToken: effectiveToken, sourceTabToken: tabToken });
};

/**
 * 标记进入回放，避免录制回放自身的动作。
 */
export const beginReplay = (state: RecordingState, tabToken: string) => {
    state.replaying.add(tabToken);
    state.replayCancel.delete(tabToken);
};

/**
 * 退出回放状态。
 */
export const endReplay = (state: RecordingState, tabToken: string) => {
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};

/**
 * 请求取消回放（由上层循环读取）。
 */
export const cancelReplay = (state: RecordingState, tabToken: string) => {
    state.replayCancel.add(tabToken);
};

export const getRecording = (state: RecordingState, tabToken: string) => {
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, { mustBeEnabled: false });
    return state.recordings.get(effectiveToken) || [];
};

export const getRecordingBundle = (state: RecordingState, tabToken: string) => {
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, { mustBeEnabled: false });
    return {
        recordingToken: effectiveToken,
        steps: state.recordings.get(effectiveToken) || [],
        manifest: state.recordingManifests.get(effectiveToken),
    };
};

export const clearRecording = (state: RecordingState, tabToken: string) => {
    const effectiveToken = resolveSingleRecordingToken(state, tabToken, { mustBeEnabled: false });
    state.recordings.set(effectiveToken, []);
    state.recordingManifests.delete(effectiveToken);
};

/**
 * tab 关闭时清理所有录制相关状态。
 */
export const cleanupRecording = (state: RecordingState, tabToken: string) => {
    state.recordingEnabled.delete(tabToken);
    state.recordings.delete(tabToken);
    state.recordingManifests.delete(tabToken);
    state.lastNavigateTs.delete(tabToken);
    state.lastClickTs.delete(tabToken);
    state.lastScrollY.delete(tabToken);
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};
