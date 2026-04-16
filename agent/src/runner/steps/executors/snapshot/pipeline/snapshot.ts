import type { Page } from 'playwright';
import crypto from 'node:crypto';
import type { Step, StepResult } from '../../../types';
import type { RunStepsDeps } from '../../../../run_steps';
import { collectRawData } from '../stages/collect';
import type { SnapshotWaitMode } from '../stages/collect';
import { fuseDomAndA11y } from '../stages/fusion';
import { buildSpatialLayers, isNoiseLayer } from '../stages/spatial';
import { detectRegions } from '../stages/regions';
import { processRegion } from './process_region';
import { linkGlobalRelations } from '../stages/relations';
import { assignStableIds } from '../core/stable_id';
import { buildEntityIndex } from '../indexes/entity';
import { buildBackendDomSelectorMap } from '../indexes/dom_backend_selector';
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
import {
    ensureFreshSnapshot,
    getSnapshotSessionEntry,
    readSnapshotDiffBaseline,
    writeSnapshotDiffBaseline,
} from '../core/session_store';
import { getNodeAttr } from '../core/runtime_store';
import {
    buildSnapshotDiffBaselineKey,
    buildSnapshotFromViewRoot,
    buildSnapshotView,
    computeMinimalChangedSubtree,
} from './scoped_diff';
import type {
    RawData,
    SnapshotDiffSkippedReason,
    SnapshotMeta,
    SnapshotPageIdentity,
    SnapshotResult,
    UnifiedNode,
} from '../core/types';

export const executeBrowserSnapshot = async (
    step: Step<'browser.snapshot'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const previousIdentity = clonePageIdentity(getSnapshotSessionEntry(binding)?.pageIdentity);
    const ensured = await ensureFreshSnapshot(binding, {
        forceRefresh: step.args.refresh === true,
        refreshReason: 'browser.snapshot',
        collectBaseSnapshot: async (context) =>
            generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                waitMode: resolveSnapshotWaitMode(context.fromDirty, context.staleReason),
            }),
    });

    const view = buildSnapshotView(ensured.snapshot, {
        contain: step.args.contain,
        depth: step.args.depth,
        filter: step.args.filter,
    });
    if (!view.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: view.error,
        };
    }

    const snapshotId = crypto.randomUUID();
    const baselineKey = buildSnapshotDiffBaselineKey({
        contain: view.resolvedContainId,
        depth: view.resolvedDepth,
        filterSignature: view.filterSignature,
    });
    const currentPageIdentity = clonePageIdentity(ensured.entry.pageIdentity)!;
    const navigationDetected = hasPageIdentityChanged(previousIdentity, currentPageIdentity);

    let outputSnapshot = view.snapshot;
    let mode: SnapshotMeta['mode'] = 'full';
    let baseSnapshotId: string | undefined;
    let diffRootId: string | undefined;
    let changedNodeCount: number | undefined;
    let diffSkipped: SnapshotDiffSkippedReason | undefined;

    if (step.args.diff === true) {
        if (navigationDetected) {
            diffSkipped = 'navigation';
        } else {
            const baseline = readSnapshotDiffBaseline(ensured.entry, baselineKey);
            if (!baseline) {
                diffSkipped = 'no_baseline';
            } else {
                const diffResult = computeMinimalChangedSubtree(view.snapshot.root, baseline.root);
                if (diffResult.mode === 'diff') {
                    mode = 'diff';
                    baseSnapshotId = baseline.snapshotId;
                    diffRootId = diffResult.diffRootId;
                    changedNodeCount = diffResult.changedNodeCount;
                    outputSnapshot = buildSnapshotFromViewRoot(diffResult.root, view.snapshot.cacheStats);
                } else {
                    diffSkipped = diffResult.reason;
                }
            }
        }
    }

    const snapshotMeta: SnapshotMeta = {
        mode,
        snapshotId,
        pageIdentity: currentPageIdentity,
        contain: view.resolvedContainId,
        depth: view.resolvedDepth,
        filterSignature: view.filterSignature,
        truncated: view.truncated || undefined,
        baseSnapshotId,
        diffRootId,
        changedNodeCount,
        diffSkipped,
    };
    outputSnapshot.snapshotMeta = snapshotMeta;

    writeSnapshotDiffBaseline(ensured.entry, baselineKey, {
        snapshotId,
        root: view.snapshot.root,
        createdAt: Date.now(),
        pageIdentity: currentPageIdentity,
    });

    return {
        stepId: step.id,
        ok: true,
        data: {
            ...outputSnapshot.root,
            snapshotMeta,
        },
    };
};

type GenerateSemanticSnapshotOptions = {
    captureRuntimeState?: boolean;
    waitMode?: SnapshotWaitMode;
};

export const generateSemanticSnapshot = async (
    page: Page,
    options: GenerateSemanticSnapshotOptions = {},
): Promise<SnapshotResult> => {
    const currentUrl = typeof (page as { url?: unknown }).url === 'function' ? page.url() : '';
    snapshotDebugLog('start', {
        url: currentUrl,
    });

    // 1) 采集原始观察：runtime(打标+采集)、DOM、A11y。
    const raw = await collectRawData(page, {
        captureRuntimeState: options.captureRuntimeState,
        waitMode: options.waitMode,
    });
    try {
        snapshotDebugLog('collect', {
            domCount: countTreeNodes(raw.domTree),
            a11yCount: countTreeNodes(raw.a11yTree),
        });

        // 2) 融合构建 unified graph。
        return generateSemanticSnapshotFromRaw(raw);
    } finally {
        // 3) 无论成功失败都清理页面临时 state-id，清理失败不阻塞主流程。
        await raw.runtimeStateCleanup?.().catch(() => undefined);
    }
};

export const generateSemanticSnapshotFromRaw = (raw: RawData): SnapshotResult => {
    const cacheStats = createCacheStats();
    const backendSelectorByDomId = buildBackendDomSelectorMap(raw.domTree);
    const graph = stageFuseGraph(raw);
    const layeredGraph = stageBuildSpatialGraph(graph);
    const root = stageAttachLayers(layeredGraph);

    stageProcessLayerRegions(root, cacheStats);
    stageLinkGlobalRelations(root);
    stageAssignStableIds(root);

    return stageBuildSnapshot(root, cacheStats, backendSelectorByDomId);
};

type CacheStats = ReturnType<typeof createCacheStats>;

const stageFuseGraph = (raw: RawData) => {
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree, raw.runtimeStateMap);
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
    const regions = detectRegions(layer);
    snapshotDebugLog('regions', {
        layerId: layer.id,
        layerRole: layer.role,
        regionCount: regions.length,
    });

    const nextChildren: UnifiedNode[] = [];

    for (const region of regions) {
        cacheStats.bucketTotal += 1;
        if (ENABLE_REGION_BUCKET_CACHE) {
            const bucketKey = computeBucketKey(region);
            const bucketHash = computeBucketHash(region);
            const cached = readBucketCache(bucketKey, bucketHash);
            if (cached) {
                cacheStats.bucketHit += 1;
                nextChildren.push(cached);
                continue;
            }

            cacheStats.bucketMiss += 1;
            const processed = processRegion(region);
            if (!processed) {
                continue;
            }

            writeBucketCache(bucketKey, bucketHash, processed);
            nextChildren.push(processed);
            continue;
        }

        cacheStats.bucketMiss += 1;
        const processed = processRegion(region);
        if (!processed) {
            continue;
        }
        nextChildren.push(processed);
    }

    layer.children = nextChildren;
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

const stageBuildSnapshot = (
    root: UnifiedNode,
    cacheStats: CacheStats,
    backendSelectorByDomId?: Record<string, string>,
): SnapshotResult => {
    const entityIndex = buildEntityIndex(root);
    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex,
        backendSelectorByDomId,
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

const isNonPerceivableLayer = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName') || '');
    if (NON_PERCEIVABLE_LAYER_ROLES.has(role)) return true;
    if (NON_PERCEIVABLE_LAYER_TAGS.has(tag)) return true;
    return false;
};

const resolveSnapshotWaitMode = (fromDirty: boolean, staleReason: string | undefined): SnapshotWaitMode => {
    if (!fromDirty) return 'interaction';
    const reason = normalizeLower(staleReason);
    if (reason.includes('browser.goto') || reason.includes('browser.reload') || reason.includes('browser.go_back')) {
        return 'navigation';
    }
    if (reason.includes('page-identity-changed')) return 'navigation';
    return 'interaction';
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();
const NON_PERCEIVABLE_LAYER_ROLES = new Set(['head', 'meta', 'link', 'style', 'script', 'title']);
const NON_PERCEIVABLE_LAYER_TAGS = new Set(['head', 'meta', 'link', 'style', 'script', 'title']);
const ENABLE_REGION_BUCKET_CACHE = false;

const hasPageIdentityChanged = (
    previousIdentity: SnapshotPageIdentity | undefined,
    nextIdentity: SnapshotPageIdentity,
): boolean => {
    if (!previousIdentity) return false;
    return !(
        previousIdentity.workspaceId === nextIdentity.workspaceId &&
        previousIdentity.tabId === nextIdentity.tabId &&
        previousIdentity.tabToken === nextIdentity.tabToken &&
        previousIdentity.url === nextIdentity.url
    );
};

const clonePageIdentity = (identity: SnapshotPageIdentity | undefined): SnapshotPageIdentity | undefined => {
    if (!identity) return undefined;
    return {
        workspaceId: identity.workspaceId,
        tabId: identity.tabId,
        tabToken: identity.tabToken,
        url: identity.url,
    };
};
