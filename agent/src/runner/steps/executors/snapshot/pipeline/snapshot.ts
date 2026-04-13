import type { Page } from 'playwright';
import type { Step, StepResult } from '../../../types';
import type { RunStepsDeps } from '../../../../run_steps';
import { collectRawData } from '../stages/collect';
import { fuseDomAndA11y } from '../stages/fusion';
import { buildSpatialLayers, isNoiseLayer } from '../stages/spatial';
import { detectRegions } from '../stages/regions';
import { processRegion } from './process_region';
import { linkGlobalRelations } from '../stages/relations';
import { assignStableIds } from '../core/stable_id';
import { buildEntityIndex } from '../indexes/entity';
import { buildLocatorIndex } from '../indexes/locator';
import { buildExternalIndexes } from '../indexes/external_indexes';
import {
    computeBucketHash,
    computeBucketKey,
    createCacheStats,
    readBucketCache,
    writeBucketCache,
} from '../core/cache';
import { buildSnapshot } from './build_snapshot';
import { countTreeNodes, snapshotDebugLog, summarizeTopNodes } from '../core/debug';
import { ensureFreshSnapshot } from '../core/session_store';
import { getNodeAttr } from '../core/runtime_store';
import type { RawData, SnapshotResult, UnifiedNode } from '../core/types';

export const executeBrowserSnapshot = async (
    step: Step<'browser.snapshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        forceRefresh: step.args.refresh === true,
        refreshReason: 'browser.snapshot',
        collectBaseSnapshot: async () => generateSemanticSnapshot(binding.page),
    });

    return {
        stepId: step.id,
        ok: true,
        data: ensured.snapshot.root,
    };
};

export const generateSemanticSnapshot = async (page: Page): Promise<SnapshotResult> => {
    const currentUrl = typeof (page as { url?: unknown }).url === 'function' ? page.url() : '';
    snapshotDebugLog('start', {
        url: currentUrl,
    });

    // 1) 采集原始观察：DOM、A11y 等基础数据。
    const raw = await collectRawData(page);
    snapshotDebugLog('collect', {
        domCount: countTreeNodes(raw.domTree),
        a11yCount: countTreeNodes(raw.a11yTree),
    });

    return generateSemanticSnapshotFromRaw(raw);
};

export const generateSemanticSnapshotFromRaw = (raw: RawData): SnapshotResult => {
    const cacheStats = createCacheStats();
    const graph = stageFuseGraph(raw);
    const layeredGraph = stageBuildSpatialGraph(graph);
    const root = stageAttachLayers(layeredGraph);

    stageProcessLayerRegions(root, cacheStats);
    stageLinkGlobalRelations(root);
    stageAssignStableIds(root);

    return stageBuildSnapshot(root, cacheStats);
};

type CacheStats = ReturnType<typeof createCacheStats>;

const stageFuseGraph = (raw: RawData) => {
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);
    snapshotDebugLog('fuse', {
        unifiedCount: countTreeNodes(graph.root),
        topNodes: summarizeTopNodes(graph.root),
    });
    return graph;
};

const stageBuildSpatialGraph = (graph: ReturnType<typeof stageFuseGraph>) => {
    const layeredGraph = buildSpatialLayers(graph);
    snapshotDebugLog('spatial', {
        layeredCount: countTreeNodes(layeredGraph.root),
        topNodes: summarizeTopNodes(layeredGraph.root),
    });
    return layeredGraph;
};

const stageAttachLayers = (layeredGraph: ReturnType<typeof stageBuildSpatialGraph>): UnifiedNode => {
    const root = createVirtualRoot();
    const [mainBody, ...overlays] = layeredGraph.root.children;
    if (mainBody) {
        root.children.push(mainBody);
    } else {
        root.children.push(layeredGraph.root);
    }

    for (const overlay of overlays) {
        if (isNoiseLayer(overlay)) continue;
        root.children.push(overlay);
    }

    root.children = root.children.filter((layer) => !isNonPerceivableLayer(layer));
    snapshotDebugLog('attach-layers', {
        virtualRootChildren: root.children.length,
        topNodes: summarizeTopNodes(root),
    });
    return root;
};

const stageProcessLayerRegions = (root: UnifiedNode, cacheStats: CacheStats) => {
    for (const layer of root.children) {
        processLayerRegions(layer, cacheStats);
    }
};

const processLayerRegions = (layer: UnifiedNode, cacheStats: CacheStats) => {
    const regions = [...detectRegions(layer)];
    snapshotDebugLog('regions', {
        layerId: layer.id,
        layerRole: layer.role,
        regionCount: regions.length,
    });

    for (const region of regions) {
        cacheStats.bucketTotal += 1;
        const bucketKey = computeBucketKey(region);
        const bucketHash = computeBucketHash(region);
        const cached = readBucketCache(bucketKey, bucketHash);
        if (cached) {
            cacheStats.bucketHit += 1;
            replaceRegion(layer, region, cached);
            continue;
        }

        cacheStats.bucketMiss += 1;
        const processed = processRegion(region);
        if (!processed) {
            removeRegion(layer, region);
            continue;
        }

        writeBucketCache(bucketKey, bucketHash, processed);
        replaceRegion(layer, region, processed);
    }
};

const stageLinkGlobalRelations = (root: UnifiedNode) => {
    linkGlobalRelations(root);
};

const stageAssignStableIds = (root: UnifiedNode) => {
    assignStableIds(root);
    snapshotDebugLog('stable-id', {
        snapshotCount: countTreeNodes(root),
        topNodes: summarizeTopNodes(root),
    });
};

const stageBuildSnapshot = (root: UnifiedNode, cacheStats: CacheStats): SnapshotResult => {
    const entityIndex = buildEntityIndex(root);
    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex,
    });
    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex,
        bboxIndex,
        attrIndex,
        contentStore,
        cacheStats,
    });
    snapshotDebugLog('done', {
        snapshotCount: countTreeNodes(snapshot.root),
        topNodes: summarizeTopNodes(snapshot.root),
    });
    return snapshot;
};

const createVirtualRoot = (): UnifiedNode => ({
    id: 'virtual-root',
    role: 'root',
    children: [],
});

const replaceRegion = (layer: UnifiedNode, target: UnifiedNode, next: UnifiedNode) => {
    const index = layer.children.findIndex((child) => child === target || child.id === target.id);
    if (index >= 0) {
        layer.children[index] = next;
        return;
    }
    for (const child of layer.children) {
        replaceRegion(child, target, next);
    }
};

const removeRegion = (layer: UnifiedNode, target: UnifiedNode): boolean => {
    const index = layer.children.findIndex((child) => child === target || child.id === target.id);
    if (index >= 0) {
        layer.children.splice(index, 1);
        return true;
    }
    for (const child of layer.children) {
        if (removeRegion(child, target)) return true;
    }
    return false;
};

const isNonPerceivableLayer = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName') || '');
    if (NON_PERCEIVABLE_LAYER_ROLES.has(role)) return true;
    if (NON_PERCEIVABLE_LAYER_TAGS.has(tag)) return true;
    return false;
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();
const NON_PERCEIVABLE_LAYER_ROLES = new Set(['head', 'meta', 'link', 'style', 'script', 'title']);
const NON_PERCEIVABLE_LAYER_TAGS = new Set(['head', 'meta', 'link', 'style', 'script', 'title']);
