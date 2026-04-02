import type { Page } from 'playwright';
import { cacheA11ySnapshot, type A11ySnapshotNode } from './a11y_adopt';
import type { TraceCache } from './types';

type CdpAXNode = {
    nodeId: string;
    ignored?: boolean;
    role?: { value?: string };
    name?: { value?: string };
    description?: { value?: string };
    value?: { value?: string };
    parentId?: string;
    childIds?: string[];
};

type RawA11yNode = {
    role?: string;
    name?: string;
    description?: string;
    value?: string;
    children?: RawA11yNode[];
};

export const getA11yTree = async (page: Page, cache?: TraceCache): Promise<A11ySnapshotNode | null> => {
    // 这是 trace 层基础能力：只负责拿到原始 A11y 树并可选写入缓存。
    // 更高阶语义融合由 snapshot 模块处理。
    const targetCache: TraceCache = cache || {};
    if (targetCache.a11yTree) {
        return targetCache.a11yTree as A11ySnapshotNode;
    }

    try {
        const snapshot = await (page as any).accessibility?.snapshot?.({
            interestingOnly: false,
        });
        if (snapshot) {
            return cacheA11ySnapshot(targetCache, JSON.stringify(snapshot));
        }
    } catch {
        // 占位：后续补观测与错误分类。
    }

    try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Accessibility.enable');
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        const tree = buildA11yTreeFromCdp(nodes);
        await cdp.detach().catch(() => undefined);
        return cacheA11ySnapshot(targetCache, JSON.stringify(tree));
    } catch {
        // 占位：当前失败时返回空，避免阻塞上层骨架流程。
        return null;
    }
};

const buildA11yTreeFromCdp = (nodes: CdpAXNode[]): RawA11yNode => {
    const map = new Map<string, CdpAXNode>();
    for (const node of nodes) {
        map.set(node.nodeId, node);
    }

    const root =
        nodes.find((node) => !node.parentId && !node.ignored) ||
        nodes.find((node) => !node.parentId) ||
        nodes[0];

    const visited = new Set<string>();
    const walk = (id: string): RawA11yNode | null => {
        if (visited.has(id)) return null;
        const node = map.get(id);
        if (!node) return null;
        visited.add(id);

        const children = (node.childIds || [])
            .map((childId) => walk(childId))
            .filter((child): child is RawA11yNode => Boolean(child));

        return {
            role: node.role?.value,
            name: node.name?.value,
            description: node.description?.value,
            value: node.value?.value,
            children: children.length > 0 ? children : undefined,
        };
    };

    return root ? walk(root.nodeId) || { role: 'document' } : { role: 'document' };
};
