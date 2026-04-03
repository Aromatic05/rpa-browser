import type { Page } from 'playwright';
import { cacheA11ySnapshot, type A11ySnapshotNode } from './adopt';
import type { TraceCache } from '../types';

type CdpAXNode = {
    nodeId: string;
    ignored?: boolean;
    role?: { value?: string };
    name?: { value?: string };
    parentId?: string;
    childIds?: string[];
};

type MinimalA11yNode = {
    role?: string;
    name?: string;
    children?: MinimalA11yNode[];
};

export const getA11yTree = async (page: Page, cache?: TraceCache): Promise<A11ySnapshotNode | null> => {
    // 第一阶段最小实现：拿到浏览器 A11y 树（role/name/children）并写入可复用缓存。
    const targetCache: TraceCache = cache || {};
    if (targetCache.a11yTree) {
        return targetCache.a11yTree as A11ySnapshotNode;
    }

    try {
        const snapshot = await (page as any).accessibility?.snapshot?.({
            interestingOnly: false,
        });
        if (snapshot) {
            const normalized = normalizeFromSnapshot(snapshot);
            if (!normalized) return null;
            return cacheA11ySnapshot(targetCache, JSON.stringify(normalized));
        }
    } catch {
        // 第一阶段先忽略该分支错误，尝试 CDP 回退。
    }

    try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Accessibility.enable');
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const tree = buildA11yTreeFromCdp(nodes as CdpAXNode[]);
        await cdp.detach().catch(() => undefined);
        return cacheA11ySnapshot(targetCache, JSON.stringify(tree));
    } catch {
        // 第一阶段失败时返回空，避免阻塞上层流程。
        return null;
    }
};

const normalizeFromSnapshot = (node: any): MinimalA11yNode | null => {
    if (!node || typeof node !== 'object') return null;
    const role = typeof node.role === 'string' ? node.role : undefined;
    const name = typeof node.name === 'string' ? node.name : undefined;
    const children = Array.isArray(node.children)
        ? node.children
              .map((child: any) => normalizeFromSnapshot(child))
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
        nodes[0];

    const visited = new Set<string>();
    const walk = (id: string): MinimalA11yNode | null => {
        if (visited.has(id)) return null;
        const node = map.get(id);
        if (!node) return null;
        visited.add(id);

        const children = (node.childIds || [])
            .map((childId) => walk(childId))
            .filter((child): child is MinimalA11yNode => Boolean(child));

        return {
            role: node.role?.value,
            name: node.name?.value,
            children: children.length > 0 ? children : undefined,
        };
    };

    return root ? walk(root.nodeId) || { role: 'document' } : { role: 'document' };
};
