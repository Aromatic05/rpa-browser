import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import type { SnapshotResult, UnifiedNode } from './snapshot/core/types';
import { normalizeText } from './snapshot/core/runtime_store';

const MAX_LIMIT = 500;
const ROOT_FROM_REFS = new Set(['snapshot', 'snapshot.latest']);

export const executeBrowserQuery = async (
    step: Step<'browser.query'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const snapshot = readLatestSnapshot(binding.traceCtx?.cache);
    if (!snapshot) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'snapshot is required before browser.query',
            },
        };
    }

    const relation = step.args.relation || 'descendant';
    if (relation !== 'child' && relation !== 'descendant') {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'relation must be child or descendant',
            },
        };
    }

    if (
        step.args.limit !== undefined &&
        (!Number.isInteger(step.args.limit) || step.args.limit <= 0 || step.args.limit > MAX_LIMIT)
    ) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
            },
        };
    }

    const sourceNodes = resolveSourceNodes(snapshot, step.args.from);
    if (!sourceNodes.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: sourceNodes.error,
        };
    }

    const limit = step.args.limit || MAX_LIMIT;
    const nodes = collectCandidates(sourceNodes.data, relation)
        .filter((node) => matchesWhere(node, snapshot, step.args.where))
        .slice(0, limit)
        .map((node) => toNodeLike(node, snapshot));

    return {
        stepId: step.id,
        ok: true,
        data: {
            nodes,
            count: nodes.length,
        },
    };
};

const readLatestSnapshot = (cache: unknown): SnapshotResult | null => {
    if (!cache || typeof cache !== 'object') {return null;}
    const snapshot = (cache as { latestSnapshot?: unknown }).latestSnapshot;
    if (!snapshot || typeof snapshot !== 'object') {return null;}
    const typed = snapshot as Partial<SnapshotResult>;
    if (!typed.root || !typed.nodeIndex || !typed.attrIndex || !typed.contentStore) {
        return null;
    }
    return typed as SnapshotResult;
};

const resolveSourceNodes = (
    snapshot: SnapshotResult,
    from: Step<'browser.query'>['args']['from'],
): { ok: true; data: UnifiedNode[] } | { ok: false; error: StepResult['error'] } => {
    if (typeof from === 'string') {
        const normalized = normalizeText(from);
        if (!normalized) {
            return badArgs('from is required');
        }
        if (ROOT_FROM_REFS.has(normalized)) {
            return { ok: true, data: [snapshot.root] };
        }
        return badArgs('from must be snapshot or snapshot.latest');
    }

    if ('nodeIds' in from) {
        if (!Array.isArray(from.nodeIds) || from.nodeIds.length === 0) {
            return badArgs('from.nodeIds must be a non-empty array');
        }
        const nodes = from.nodeIds.map((id) => snapshot.nodeIndex[id]).filter(Boolean);
        return { ok: true, data: nodes };
    }

    if ('nodes' in from) {
        if (!Array.isArray(from.nodes) || from.nodes.length === 0) {
            return badArgs('from.nodes must be a non-empty array');
        }
        const ids = from.nodes.map((item) => {
            if (item && typeof item === 'object') {
                if ('id' in item && typeof item.id === 'string') {return item.id;}
                if ('handle' in item && item.handle && typeof item.handle === 'object' && 'nodeId' in item.handle) {
                    const nodeId = (item.handle as { nodeId?: unknown }).nodeId;
                    if (typeof nodeId === 'string') {return nodeId;}
                }
            }
            return '';
        });
        const nodes = ids.map((id) => snapshot.nodeIndex[id]).filter(Boolean);
        return { ok: true, data: nodes };
    }

    return badArgs('unsupported from type');
};

const badArgs = (message: string) => ({
    ok: false as const,
    error: {
        code: 'ERR_BAD_ARGS',
        message,
    },
});

const collectCandidates = (sources: UnifiedNode[], relation: 'child' | 'descendant'): UnifiedNode[] => {
    const seen = new Set<string>();
    const out: UnifiedNode[] = [];
    for (const source of sources) {
        const items = relation === 'child' ? source.children : getDescendants(source);
        for (const item of items) {
            if (seen.has(item.id)) {continue;}
            seen.add(item.id);
            out.push(item);
        }
    }
    return out;
};

const getDescendants = (source: UnifiedNode): UnifiedNode[] => {
    const out: UnifiedNode[] = [];
    const stack = [...source.children];
    while (stack.length > 0) {
        const node = stack.shift()!;
        out.push(node);
        if (node.children.length > 0) {
            stack.unshift(...node.children);
        }
    }
    return out;
};

const matchesWhere = (
    node: UnifiedNode,
    snapshot: SnapshotResult,
    where: Step<'browser.query'>['args']['where'],
): boolean => {
    if (!where) {return true;}
    if (where.role && normalizeLower(node.role) !== normalizeLower(where.role)) {return false;}

    const attrs = snapshot.attrIndex[node.id] || {};
    const tag = attrs.tag || attrs.tagName;
    if (where.tag && normalizeLower(tag) !== normalizeLower(where.tag)) {return false;}

    if (where.text?.contains) {
        const text = normalizeLower(readNodeText(node, snapshot));
        if (!text.includes(normalizeLower(where.text.contains))) {return false;}
    }

    if (where.attrs) {
        for (const [key, value] of Object.entries(where.attrs)) {
            if ((attrs[key] || '') !== value) {return false;}
        }
    }
    return true;
};

const toNodeLike = (node: UnifiedNode, snapshot: SnapshotResult) => {
    const attrs = snapshot.attrIndex[node.id];
    const tag = attrs?.tag || attrs?.tagName;
    return {
        id: node.id,
        role: node.role || undefined,
        tag,
        text: readNodeText(node, snapshot),
        attrs: attrs && Object.keys(attrs).length > 0 ? attrs : undefined,
        children: node.children.length > 0 ? node.children.map((child) => child.id) : undefined,
        handle: {
            nodeId: node.id,
        },
    };
};

const readNodeText = (node: UnifiedNode, snapshot: SnapshotResult) => {
    const name = normalizeText(node.name);
    if (name) {return name;}
    if (typeof node.content === 'string') {return normalizeText(node.content);}
    if (node.content?.ref) {
        return normalizeText(snapshot.contentStore[node.content.ref]);
    }
    return undefined;
};

const normalizeLower = (value: string | undefined) => normalizeText(value)?.toLowerCase() || '';
