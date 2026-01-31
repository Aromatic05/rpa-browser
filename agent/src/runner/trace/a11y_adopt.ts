/**
 * a11y_adopt：将 A11y nodeId 绑定为 Playwright Locator。
 *
 * 绑定规则（v0）：
 * 1) 优先使用 snapshotA11y 的缓存（role + name）进行语义定位
 * 2) 如果 role/name 不足，退化到文本定位
 * 3) 多匹配 => ERR_AMBIGUOUS；无匹配 => ERR_NOT_FOUND
 *
 * 说明：
 * - 这里不执行 click/wait 等动作，只做“绑定”
 * - cache 的生命周期由 TraceContext 管理，默认使用最近一次 snapshot
 */

import type { Locator, Page } from 'playwright';
import type { A11yNodeInfo, ToolResult, TraceCache } from './types';

export type A11ySnapshotNode = {
    id: string;
    role?: string;
    name?: string;
    description?: string;
    value?: string;
    children?: A11ySnapshotNode[];
};

type RawA11yNode = {
    role?: string;
    name?: string;
    description?: string;
    value?: string;
    children?: RawA11yNode[];
};

/**
 * 根据 snapshot 原始 JSON 构建可展示树，并更新 cache 的 node map。
 * 该函数由 snapshotA11y 调用，保证 adopt 时有完整索引。
 */
export const cacheA11ySnapshot = (cache: TraceCache, raw: string): A11ySnapshotNode | null => {
    let parsed: RawA11yNode | null = null;
    try {
        parsed = JSON.parse(raw) as RawA11yNode;
    } catch {
        return null;
    }
    const map = new Map<string, A11yNodeInfo>();
    const tree = buildTree(parsed, 'n0', map);
    cache.a11ySnapshotRaw = raw;
    cache.a11yNodeMap = map;
    return tree;
};

const buildTree = (node: RawA11yNode, id: string, map: Map<string, A11yNodeInfo>): A11ySnapshotNode => {
    const info: A11yNodeInfo = {
        id,
        role: node.role,
        name: node.name,
        description: node.description,
        value: node.value,
    };
    map.set(id, info);
    const children = (node.children || []).map((child, idx) =>
        buildTree(child, `${id}.${idx}`, map),
    );
    return {
        id,
        role: node.role,
        name: node.name,
        description: node.description,
        value: node.value,
        children: children.length ? children : undefined,
    };
};

export const adoptA11yNode = async (
    page: Page,
    a11yNodeId: string,
    cache: TraceCache,
): Promise<ToolResult<Locator>> => {
    if (!cache.a11yNodeMap) {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'a11y cache empty', phase: 'trace' } };
    }
    const info = cache.a11yNodeMap.get(a11yNodeId);
    if (!info) {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'node not found', phase: 'trace' } };
    }

    const locator = buildLocatorFromNode(page, info);
    if (!locator) {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'node not bindable', phase: 'trace' } };
    }

    let count = 0;
    try {
        count = await locator.count();
    } catch (error) {
        return { ok: false, error: { code: 'ERR_UNKNOWN', message: 'locator error', phase: 'trace', details: error } };
    }

    if (count === 0) {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'no match', phase: 'trace' } };
    }
    if (count > 1) {
        const details = await summarizeCandidates(locator);
        return {
            ok: false,
            error: {
                code: 'ERR_AMBIGUOUS',
                message: 'multiple matches',
                phase: 'trace',
                details,
            },
        };
    }

    return { ok: true, data: locator.first() };
};

const buildLocatorFromNode = (page: Page, info: A11yNodeInfo): Locator | null => {
    if (info.role && info.name) {
        return (page as any).getByRole(info.role as any, { name: info.name });
    }
    if (info.name) {
        return page.getByText(info.name, { exact: true });
    }
    if (info.description) {
        return page.getByText(info.description, { exact: true });
    }
    return null;
};

const summarizeCandidates = async (locator: Locator) => {
    try {
        const items = await locator.evaluateAll((nodes) =>
            nodes.slice(0, 10).map((node) => {
                const el = node as HTMLElement;
                const text = (el.innerText || el.textContent || '').trim().slice(0, 80);
                return { tag: el.tagName.toLowerCase(), text };
            }),
        );
        return { count: items.length, items };
    } catch {
        return { count: null, items: [] };
    }
};
