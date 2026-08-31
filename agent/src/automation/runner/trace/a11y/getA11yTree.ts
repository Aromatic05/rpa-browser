import type { Page } from 'playwright';
import { cacheA11ySnapshot, type A11ySnapshotNode } from './adopt';
import type { TraceCache } from '../types';

type CdpAXNode = {
    nodeId: string;
    ignored?: boolean;
    role?: { value?: string };
    name?: { value?: string };
    backendDOMNodeId?: number;
    parentId?: string;
    childIds?: string[];
};

type MinimalA11yNode = {
    role?: string;
    name?: string;
    backendDOMNodeId?: string;
    children?: MinimalA11yNode[];
};

type SnapshotAccessibilityNode = {
    role?: unknown;
    name?: unknown;
    children?: unknown;
};

const asSnapshotNode = (value: unknown): SnapshotAccessibilityNode | null =>
    value && typeof value === 'object' ? value : null;
const isSnapshotFn = (value: unknown): value is (options: { interestingOnly: boolean }) => Promise<unknown> =>
    typeof value === 'function';

export const getA11yTree = async (page: Page, cache?: TraceCache): Promise<A11ySnapshotNode | null> => {
    // 优先 CDP：保留 backendDOMNodeId，实现与 DOM 树的稳定对齐。
    const targetCache: TraceCache = cache || {};
    if (targetCache.a11yTree) {
        return targetCache.a11yTree as A11ySnapshotNode;
    }

    try {
        const cdp = await page.context().newCDPSession(page);
        try {
            await cdp.send('Accessibility.enable');
            const { nodes } = await cdp.send('Accessibility.getFullAXTree');
            const tree = buildA11yTreeFromCdp(nodes);
            return cacheA11ySnapshot(targetCache, JSON.stringify(tree));
        } finally {
            await cdp.detach().catch(() => undefined);
        }
    } catch {
        // CDP 失败时再回退到 Playwright accessibility.snapshot。
    }

    try {
        const pageRecord = page as unknown as Record<string, unknown>;
        const accessibility = pageRecord.accessibility;
        const snapshotFn =
            accessibility && typeof accessibility === 'object'
                ? (accessibility as Record<string, unknown>).snapshot
                : undefined;
        const snapshot =
            isSnapshotFn(snapshotFn)
                ? await snapshotFn({
                      interestingOnly: false,
                  })
                : null;
        if (snapshot) {
            const normalized = normalizeFromSnapshot(snapshot);
            if (!normalized) {return null;}
            return cacheA11ySnapshot(targetCache, JSON.stringify(normalized));
        }
    } catch {
        // fallback 失败时返回空，避免阻塞上层流程。
    }
    return null;
};

const normalizeFromSnapshot = (node: unknown): MinimalA11yNode | null => {
    const source = asSnapshotNode(node);
    if (!source) {return null;}
    const role = typeof source.role === 'string' ? source.role : undefined;
    const name = typeof source.name === 'string' ? source.name : undefined;
    const children = Array.isArray(source.children)
        ? source.children
              .map((child: unknown) => normalizeFromSnapshot(child))
              .filter((child: MinimalA11yNode | null): child is MinimalA11yNode => Boolean(child))
        : [];
    return {
        role,
        name,
        children: children.length > 0 ? children : undefined,
    };
};

const buildA11yTreeFromCdp = (nodes: CdpAXNode[]): MinimalA11yNode => {
    const map = new Map<string, CdpAXNode>();
    for (const node of nodes) {
        map.set(node.nodeId, node);
    }

    const root =
        nodes.find((node) => !node.parentId && !node.ignored) ||
        nodes.find((node) => !node.parentId) ||
        nodes.at(0);

    const visited = new Set<string>();
    const walk = (id: string): MinimalA11yNode | null => {
        if (visited.has(id)) {return null;}
        const node = map.get(id);
        if (!node) {return null;}
        visited.add(id);

        const children = (node.childIds || [])
            .map((childId) => walk(childId))
            .filter((child): child is MinimalA11yNode => Boolean(child));

        return {
            role: node.role?.value,
            name: node.name?.value,
            backendDOMNodeId: node.backendDOMNodeId ? String(node.backendDOMNodeId) : undefined,
            children: children.length > 0 ? children : undefined,
        };
    };

    if (!root) {return { role: 'document' };}
    return walk(root.nodeId) || { role: 'document' };
};
