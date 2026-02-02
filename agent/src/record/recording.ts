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
import crypto from 'crypto';
import type { Page } from 'playwright';
import { installRecorder, type RecordedEvent } from './recorder';
import { getLogger } from '../logging/logger';
import type { RawEvent, TargetDescriptor } from './raw_event';
import type { StepUnion } from '../runner/steps/types';
import type { A11yHint, Target } from '../runner/steps/types';

export type RecordingState = {
    recordingEnabled: Set<string>;
    recordings: Map<string, RecordedEvent[]>;
    recordedSteps: Map<string, StepUnion[]>;
    lastNavigateTs: Map<string, number>;
    lastClickTs: Map<string, number>;
    lastScrollPos: Map<string, { x: number; y: number }>;
    replaying: Set<string>;
    replayCancel: Set<string>;
};

/**
 * 创建录制状态容器，集中维护多个 tab 的录制信息。
 */
export const createRecordingState = (): RecordingState => ({
    recordingEnabled: new Set(),
    recordings: new Map(),
    recordedSteps: new Map(),
    lastNavigateTs: new Map(),
    lastClickTs: new Map(),
    lastScrollPos: new Map(),
    replaying: new Set(),
    replayCancel: new Set(),
});

/**
 * 处理单条录制事件：
 * - 去重导航
 * - 脱敏长文本/密码
 * - 写入录制队列
 */
export const recordEvent = (
    state: RecordingState,
    event: RecordedEvent,
    navDedupeWindowMs: number,
) => {
    const recordLog = getLogger('record');
    const tabToken = event.tabToken;
    if (!tabToken || !state.recordingEnabled.has(tabToken)) return;
    if (state.replaying.has(tabToken)) return;

    if (event.type === 'click') {
        state.lastClickTs.set(tabToken, event.ts);
    }

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(tabToken) || 0;
        if (event.ts - last < navDedupeWindowMs) {
            return;
        }
        state.lastNavigateTs.set(tabToken, event.ts);
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

    const list = state.recordings.get(tabToken) || [];
    list.push(event);
    state.recordings.set(tabToken, list);
    recordLog('event', {
        type: event.type,
        tabToken,
        ts: event.ts,
        url: (event as any).url,
    });
};

const buildA11yHint = (target: TargetDescriptor, fallbackText?: string): A11yHint => {
    const role = target.roleAttr || inferRoleFromTag(target.tag, target.typeAttr);
    const name =
        target.ariaLabel ||
        target.nameAttr ||
        target.text ||
        fallbackText ||
        target.id ||
        target.tag;
    const text = target.text || fallbackText || name || target.id || target.tag;
    return { role, name, text };
};

const inferRoleFromTag = (tag: string, typeAttr?: string) => {
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
        if (typeAttr === 'checkbox') return 'checkbox';
        if (typeAttr === 'radio') return 'radio';
        return 'textbox';
    }
    return undefined;
};

const buildTarget = (target: TargetDescriptor, fallbackText?: string): Target => {
    const hint = buildA11yHint(target, fallbackText);
    return {
        a11yHint: hint,
        selector: target.selector,
    };
};

const appendStep = (state: RecordingState, tabToken: string, step: StepUnion) => {
    const list = state.recordedSteps.get(tabToken) || [];
    list.push(step);
    state.recordedSteps.set(tabToken, list);
};

export const recordRawEvent = (
    state: RecordingState,
    event: RawEvent,
    tabToken: string,
    navDedupeWindowMs: number,
) => {
    const recordLog = getLogger('record');
    if (!tabToken || !state.recordingEnabled.has(tabToken)) return;
    if (state.replaying.has(tabToken)) return;

    if (event.type === 'navigate') {
        const last = state.lastNavigateTs.get(tabToken) || 0;
        if (event.ts - last < navDedupeWindowMs) return;
        state.lastNavigateTs.set(tabToken, event.ts);
        appendStep(state, tabToken, {
            id: crypto.randomUUID(),
            name: 'browser.goto',
            args: { url: event.url },
            meta: { source: 'record', ts: event.ts },
        });
        recordLog('event', { type: event.type, tabToken, ts: event.ts, url: event.url });
        return;
    }

    if (event.type === 'click') {
        state.lastClickTs.set(tabToken, event.ts);
        appendStep(state, tabToken, {
            id: crypto.randomUUID(),
            name: 'browser.click',
            args: { target: buildTarget(event.target) },
            meta: { source: 'record', ts: event.ts },
        });
        recordLog('event', { type: event.type, tabToken, ts: event.ts, url: event.url });
        return;
    }

    if (event.type === 'input') {
        appendStep(state, tabToken, {
            id: crypto.randomUUID(),
            name: 'browser.fill',
            args: { target: buildTarget(event.target), value: event.value },
            meta: { source: 'record', ts: event.ts },
        });
        recordLog('event', { type: event.type, tabToken, ts: event.ts, url: event.url });
        return;
    }

    if (event.type === 'change') {
        if (event.target.tag === 'select') {
            appendStep(state, tabToken, {
                id: crypto.randomUUID(),
                name: 'browser.select_option',
                args: { target: buildTarget(event.target, event.selectedText), values: [event.value] },
                meta: { source: 'record', ts: event.ts },
            });
        } else {
            appendStep(state, tabToken, {
                id: crypto.randomUUID(),
                name: 'browser.click',
                args: { target: buildTarget(event.target) },
                meta: { source: 'record', ts: event.ts },
            });
        }
        recordLog('event', { type: event.type, tabToken, ts: event.ts, url: event.url });
        return;
    }

    if (event.type === 'keydown') {
        appendStep(state, tabToken, {
            id: crypto.randomUUID(),
            name: 'browser.press_key',
            args: { key: event.key.key, target: buildTarget(event.target) },
            meta: { source: 'record', ts: event.ts },
        });
        recordLog('event', { type: event.type, tabToken, ts: event.ts, url: event.url });
        return;
    }

    if (event.type === 'scroll') {
        const last = state.lastScrollPos.get(tabToken) || { x: event.scroll.x, y: event.scroll.y };
        const deltaY = event.scroll.y - last.y;
        state.lastScrollPos.set(tabToken, { x: event.scroll.x, y: event.scroll.y });
        if (deltaY === 0) return;
        const target = event.target.tag === 'html' || event.target.tag === 'body' ? undefined : buildTarget(event.target);
        appendStep(state, tabToken, {
            id: crypto.randomUUID(),
            name: 'browser.scroll',
            args: {
                direction: deltaY < 0 ? 'up' : 'down',
                amount: Math.abs(deltaY),
                target,
            },
            meta: { source: 'record', ts: event.ts },
        });
        recordLog('event', { type: event.type, tabToken, ts: event.ts, url: event.url });
    }
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
) => {
    const recordLog = getLogger('record');
    state.recordingEnabled.add(tabToken);
    if (!state.recordings.has(tabToken)) {
        state.recordings.set(tabToken, []);
    }
    state.lastNavigateTs.set(tabToken, 0);
    state.lastClickTs.set(tabToken, 0);
    recordLog('start', { tabToken, url: page.url() });
    await ensureRecorder(state, page, tabToken, navDedupeWindowMs);
};

/**
 * 停止录制：仅关闭录制开关，保留已有记录。
 */
export const stopRecording = (state: RecordingState, tabToken: string) => {
    const recordLog = getLogger('record');
    state.recordingEnabled.delete(tabToken);
    state.lastNavigateTs.delete(tabToken);
    state.lastClickTs.delete(tabToken);
    state.lastScrollPos.delete(tabToken);
    recordLog('stop', { tabToken });
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

export const getRecording = (state: RecordingState, tabToken: string) =>
    state.recordings.get(tabToken) || [];

export const clearRecording = (state: RecordingState, tabToken: string) => {
    state.recordings.set(tabToken, []);
    state.recordedSteps.set(tabToken, []);
    state.lastScrollPos.delete(tabToken);
};

/**
 * tab 关闭时清理所有录制相关状态。
 */
export const cleanupRecording = (state: RecordingState, tabToken: string) => {
    state.recordingEnabled.delete(tabToken);
    state.recordings.delete(tabToken);
    state.recordedSteps.delete(tabToken);
    state.lastNavigateTs.delete(tabToken);
    state.lastClickTs.delete(tabToken);
    state.lastScrollPos.delete(tabToken);
    state.replaying.delete(tabToken);
    state.replayCancel.delete(tabToken);
};
