/**
 * tabGroups 分组服务：封装 chrome.tabGroups/tabs.group 细节。
 *
 * 降级策略：
 * - API 不可用时返回 unsupported，不抛出异常。
 * - 调用失败返回 failed，业务层继续运行。
 */

import type { TabGroupColor } from './name_store.js';

export type GroupingResult =
    | { ok: true; groupId: number }
    | { ok: false; reason: 'unsupported' | 'no-active-tab' | 'failed' };

type ChromeLike = {
    tabs?: {
        query: (queryInfo: { active: boolean; currentWindow: boolean }) => Promise<Array<{ id?: number }>>;
        group: (options: { tabIds: number[]; groupId?: number }) => Promise<number>;
    };
    tabGroups?: {
        update: (groupId: number, updateProperties: { title: string; color: TabGroupColor }) => Promise<any>;
    };
};

export const supportsTabGrouping = (chromeLike: ChromeLike | undefined) =>
    Boolean(chromeLike?.tabs?.group && chromeLike?.tabs?.query);

export const safeGroupActiveTab = async (
    chromeLike: ChromeLike | undefined,
    options: { groupId?: number; title: string; color: TabGroupColor },
): Promise<GroupingResult> => {
    if (!supportsTabGrouping(chromeLike)) {
        return { ok: false, reason: 'unsupported' };
    }
    try {
        const tabs = await chromeLike!.tabs!.query({ active: true, currentWindow: true });
        const active = tabs[0];
        if (!active?.id) return { ok: false, reason: 'no-active-tab' };
        const groupId = await chromeLike!.tabs!.group({
            tabIds: [active.id],
            ...(options.groupId != null ? { groupId: options.groupId } : {}),
        });
        if (chromeLike!.tabGroups?.update) {
            await chromeLike!.tabGroups.update(groupId, {
                title: options.title,
                color: options.color,
            });
        }
        return { ok: true, groupId };
    } catch {
        return { ok: false, reason: 'failed' };
    }
};
