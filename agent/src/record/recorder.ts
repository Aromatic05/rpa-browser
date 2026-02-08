/**
 * recorder：负责在 Playwright Page 上安装录制脚本并接收事件。
 *
 * 依赖关系：
 * - 上游：recording.ts 调用 installRecorder
 * - 下游：recorder_payload.ts 的注入脚本通过绑定回传事件
 *
 * 关键约束：
 * - 同一 Page 只安装一次，避免重复监听
 * - 事件携带 locatorCandidates，用于回放时的自愈定位
 */
import type { Page } from 'playwright';
import type { LocatorCandidate, ScopeHint } from '../runner/locator_candidates';
import type { A11yHint } from '../runner/steps/types';
import { RECORDER_SOURCE } from './recorder_payload';
import { getLogger } from '../logging/logger';

const installedPages = new WeakSet<Page>();
const bindingName = '__rpa_record';

export type RecordedEventType =
    | 'click'
    | 'input'
    | 'change'
    | 'check'
    | 'select'
    | 'date'
    | 'keydown'
    | 'navigate'
    | 'scroll'
    | 'paste'
    | 'copy';

export type RecorderEvent = {
    tabToken: string;
    ts: number;
    type: RecordedEventType;
    url?: string;
    a11yNodeId?: string;
    a11yHint?: A11yHint;
    selector?: string;
    locatorCandidates?: LocatorCandidate[];
    scopeHint?: ScopeHint;
    targetHint?: string;
    value?: string;
    label?: string;
    checked?: boolean;
    inputType?: string;
    key?: string;
    scrollX?: number;
    scrollY?: number;
    source?: 'click' | 'direct';
    pageUrl?: string | null;
};

/**
 * 在 Page 上安装录制脚本，并通过 binding 把事件转发回 Node 侧。
 */
export const installRecorder = async (page: Page, onEvent: (event: RecorderEvent) => void) => {
    if (installedPages.has(page)) return;
    installedPages.add(page);
    const recordLog = getLogger('record');
    let eventCount = 0;

    try {
        await page.exposeBinding(bindingName, (source, event: RecorderEvent) => {
            eventCount += 1;
            if (eventCount <= 1) {
                recordLog('recorder.event', {
                    tabToken: event.tabToken,
                    type: event.type,
                    url: event.url || event.pageUrl,
                    frameUrl: source.frame?.url?.() || null,
                });
            }
            onEvent({
                ...event,
                pageUrl: source.page?.url?.() || null,
            });
        });
    } catch {
        // ignore if binding already exists
    }

    await page.addInitScript({ content: RECORDER_SOURCE });
    const frames = page.frames();
    for (const frame of frames) {
        try {
            await frame.evaluate(RECORDER_SOURCE);
        } catch {
            // ignore if frame is not ready or cross-origin
        }
    }
    try {
        const status = await Promise.all(
            frames.map(async (frame) => {
                try {
                    const installed = await frame.evaluate(() => Boolean((window as any).__rpa_recorder_installed));
                    return { url: frame.url(), installed };
                } catch {
                    return { url: frame.url(), installed: null };
                }
            }),
        );
        recordLog('recorder.install', { frames: status });
    } catch {
        // ignore diagnostics failures
    }
};
