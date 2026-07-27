import { matchEntityRules } from '../../runner/steps/executors/snapshot/entity_rules/matcher';
import { applyEntityRuleBindings } from '../../runner/steps/executors/snapshot/entity_rules/apply';
import { validateEntityRules } from '../../runner/steps/executors/snapshot/entity_rules/validate';
import type { ResolvedRuleBinding } from '../../runner/steps/executors/snapshot/entity_rules/types';
import type {
    BBox,
    EntityRuleDiagnostic,
    FinalEntityView,
    SnapshotPageIdentity,
    SnapshotResult,
} from '../../runner/steps/executors/snapshot/core/types';
import type { WorkflowEntityRules } from '../../workflow';
import type { WorkspaceEntityRulesProvider } from '../provider';
import { compileCanvasDraft } from './compile';
import { importEntityRulesToCanvasDraft } from './import';
import { paginationItemCanvasId, paginationPageCanvasId } from './identifiers';
import { inferPageKind } from './recognize';
import { computeArtifactRevision } from './revision';
import type {
    AnnotatorCheckResult,
    AnnotatorOpenResult,
    CheckResultByAnnotation,
    CheckStatus,
    VisualTargetRef,
    VisualTargetRole,
} from './runtime_types';
import type { CanvasDraft } from './types';

type OpenContext = {
    snapshot: SnapshotResult;
    finalEntityView: FinalEntityView;
    pageIdentity: SnapshotPageIdentity;
    provider: WorkspaceEntityRulesProvider;
    getArtifact: (profileName: string) => WorkflowEntityRules | null;
};

const collectAnnotationIds = (
    draft: CanvasDraft,
): Array<{ id: string; expect: 'unique' | 'one_or_more' }> => {
    const out: Array<{ id: string; expect: 'unique' | 'one_or_more' }> = [];
    for (const entity of draft.entities) {
        for (const annotation of entity.annotations) {
            out.push({
                id: annotation.id,
                expect:
                    annotation.expect ?? (annotation.type === 'action' ? 'one_or_more' : 'unique'),
            });
        }
        for (const column of entity.columns) {
            for (const action of column.actions) {
                out.push({ id: action.id, expect: 'one_or_more' });
            }
        }
        if (entity.pagination) {
            out.push({ id: paginationItemCanvasId(entity.id), expect: 'unique' });
            out.push({ id: paginationPageCanvasId(entity.id), expect: 'unique' });
        }
    }
    return out;
};

type VisualTargetContext = {
    snapshot: SnapshotResult;
    canvasDraft?: CanvasDraft | null;
    ruleIdByAnnotationId?: Record<string, string>;
    ruleIdByEntityId?: Record<string, string>;
    bindings?: Record<string, ResolvedRuleBinding>;
};

const boxesForNodeIds = (nodeIds: string[], bboxIndex: Record<string, BBox>): BBox[] => {
    const out: BBox[] = [];
    for (const nodeId of nodeIds) {
        const box = bboxIndex[nodeId];
        if (box) {
            out.push(box);
        }
    }
    return out;
};

type NodeInfo = { matchedNodeIds: string[]; canvasId?: string };

const buildNodeInfoLookup = (
    ctx: VisualTargetContext,
): Map<string, NodeInfo> => {
    const lookup = new Map<string, NodeInfo>();
    const { bindings, ruleIdByAnnotationId, ruleIdByEntityId } = ctx;
    if (!bindings) {
        return lookup;
    }
    const canvasIdByRuleId: Record<string, string> = {};
    if (ruleIdByAnnotationId) {
        for (const [annId, ruleId] of Object.entries(ruleIdByAnnotationId)) {
            canvasIdByRuleId[ruleId] = annId;
        }
    }
    if (ruleIdByEntityId) {
        for (const [entId, ruleId] of Object.entries(ruleIdByEntityId)) {
            if (!canvasIdByRuleId[ruleId]) {
                canvasIdByRuleId[ruleId] = entId;
            }
        }
    }
    for (const [ruleId, binding] of Object.entries(bindings)) {
        const canvasId = canvasIdByRuleId[ruleId];
        for (const nodeId of binding.matchedNodeIds) {
            lookup.set(nodeId, { matchedNodeIds: binding.matchedNodeIds, canvasId });
        }
    }
    return lookup;
};

const enrichRef = (
    nodeId: string,
    ctx: VisualTargetContext,
    nodeInfo: Map<string, NodeInfo>,
): { bbox?: BBox; matchedNodeBoxes?: BBox[]; canvasAnnotationId?: string } => {
    const result: { bbox?: BBox; matchedNodeBoxes?: BBox[]; canvasAnnotationId?: string } = {};
    const bbox = ctx.snapshot.bboxIndex[nodeId];
    if (bbox) {
        result.bbox = bbox;
    }
    const info = nodeInfo.get(nodeId);
    if (info) {
        if (info.matchedNodeIds.length > 1) {
            const boxes = boxesForNodeIds(info.matchedNodeIds, ctx.snapshot.bboxIndex);
            if (boxes.length > 0) {
                result.matchedNodeBoxes = boxes;
            }
        }
        if (info.canvasId) {
            result.canvasAnnotationId = info.canvasId;
        }
    }
    return result;
};

const buildVisualTargetRefs = (
    finalEntityView: FinalEntityView | undefined,
    ctx: VisualTargetContext,
): VisualTargetRef[] => {
    const refs: VisualTargetRef[] = [];
    if (!finalEntityView) {
        return refs;
    }

    const nodeInfo = buildNodeInfoLookup(ctx);

    for (const entity of finalEntityView.entities) {
        if (!entity.businessTag && !entity.businessName) {
            continue;
        }
        refs.push({
            entityId: entity.id,
            nodeId: entity.nodeId,
            kind: entity.kind,
            role: 'entity',
            ...enrichRef(entity.nodeId, ctx, nodeInfo),
        });
        for (const field of entity.formFields || []) {
            if (field.controlNodeId) {
                refs.push({
                    entityId: entity.id,
                    nodeId: field.controlNodeId,
                    kind: entity.kind,
                    role: 'field',
                    fieldKey: field.fieldKey,
                    ...enrichRef(field.controlNodeId, ctx, nodeInfo),
                });
            }
            if (field.labelNodeId) {
                refs.push({
                    entityId: entity.id,
                    nodeId: field.labelNodeId,
                    kind: entity.kind,
                    role: 'field',
                    fieldKey: field.fieldKey,
                    ...enrichRef(field.labelNodeId, ctx, nodeInfo),
                });
            }
        }
        for (const action of entity.formActions || []) {
            if (action.nodeId) {
                refs.push({
                    entityId: entity.id,
                    nodeId: action.nodeId,
                    kind: entity.kind,
                    role: 'action',
                    actionIntent: action.actionIntent,
                    ...enrichRef(action.nodeId, ctx, nodeInfo),
                });
            }
        }
        for (const column of entity.columns || []) {
            if (column.headerNodeId) {
                refs.push({
                    entityId: entity.id,
                    nodeId: column.headerNodeId,
                    kind: entity.kind,
                    role: 'column',
                    fieldKey: column.fieldKey,
                    ...enrichRef(column.headerNodeId, ctx, nodeInfo),
                });
            }
        }
    }

    if (ctx.canvasDraft && ctx.ruleIdByAnnotationId && ctx.ruleIdByEntityId && ctx.bindings) {
        const covered = new Set<string>();
        for (const ref of refs) {
            if (ref.canvasAnnotationId) {
                covered.add(ref.canvasAnnotationId);
            }
        }

        const tryAddFromBinding = (
            canvasId: string,
            entityId: string,
            role: VisualTargetRole,
            fieldKey?: string,
            actionIntent?: string,
        ): void => {
            if (covered.has(canvasId)) {
                return;
            }
            const annotationRuleId = ctx.ruleIdByAnnotationId![canvasId];
            const entityRuleId = ctx.ruleIdByEntityId![canvasId];
            const ruleId = annotationRuleId ?? entityRuleId;
            if (!ruleId) {
                return;
            }
            const binding = ctx.bindings![ruleId];
            if (!binding || binding.matchedNodeIds.length === 0) {
                return;
            }
            const firstNodeId = binding.matchedNodeIds[0];
            const enriched = enrichRef(firstNodeId, ctx, nodeInfo);
            enriched.canvasAnnotationId = canvasId;
            if (binding.matchedNodeIds.length > 1) {
                const boxes = boxesForNodeIds(binding.matchedNodeIds, ctx.snapshot.bboxIndex);
                if (boxes.length > 0) {
                    enriched.matchedNodeBoxes = boxes;
                }
            }
            const ref: VisualTargetRef = {
                entityId,
                nodeId: firstNodeId,
                role,
                ...(fieldKey ? { fieldKey } : {}),
                ...(actionIntent ? { actionIntent } : {}),
                ...enriched,
            };
            refs.push(ref);
            covered.add(canvasId);
        };

        for (const entity of ctx.canvasDraft.entities) {
            tryAddFromBinding(entity.id, entity.id, 'entity');
            for (const annotation of entity.annotations) {
                const role: VisualTargetRole =
                    annotation.type === 'field' ? 'field'
                    : annotation.type === 'action' ? 'action'
                    : 'pagination';
                tryAddFromBinding(
                    annotation.id,
                    entity.id,
                    role,
                    annotation.type === 'field' ? annotation.businessKey : undefined,
                    annotation.type === 'action' ? annotation.businessKey : undefined,
                );
            }
            for (const column of entity.columns) {
                for (const action of column.actions) {
                    tryAddFromBinding(action.id, entity.id, 'action', undefined, action.actionIntent);
                }
            }
        }
    }

    return refs;
};

export const buildOpenResult = (ctx: OpenContext): AnnotatorOpenResult => {
    const pageKind = inferPageKind(ctx.finalEntityView);
    const pageUrl = ctx.pageIdentity.url;
    const bundle = ctx.provider.resolveBundle({ pageUrl, pageKind });
    const profileName = bundle?.id || null;
    const currentArtifact = profileName ? ctx.getArtifact(profileName) : null;
    const canvasDraft = currentArtifact ? importEntityRulesToCanvasDraft(currentArtifact) : null;
    const artifactRevision = currentArtifact ? computeArtifactRevision(currentArtifact) : null;

    let ruleIdByAnnotationId: Record<string, string> | undefined;
    let ruleIdByEntityId: Record<string, string> | undefined;
    let bindings: Record<string, ResolvedRuleBinding> | undefined;
    if (canvasDraft) {
        const compileResult = compileCanvasDraft(canvasDraft);
        if (compileResult.ok) {
            const validated = validateEntityRules(
                compileResult.artifact.name,
                compileResult.artifact.match,
                compileResult.artifact.annotation,
            );
            if (validated.ok) {
                bindings = matchEntityRules(validated.bundle, {
                    root: ctx.snapshot.root,
                    entityIndex: ctx.snapshot.entityIndex,
                    nodeIndex: ctx.snapshot.nodeIndex,
                });
                ruleIdByAnnotationId = compileResult.ruleIdByAnnotationId;
                ruleIdByEntityId = compileResult.ruleIdByEntityId;
            }
        }
    }

    const visualTargetRefs = buildVisualTargetRefs(ctx.finalEntityView, {
        snapshot: ctx.snapshot,
        canvasDraft,
        ruleIdByAnnotationId,
        ruleIdByEntityId,
        bindings,
    });

    return {
        workspaceName: ctx.pageIdentity.workspaceName,
        tabName: ctx.pageIdentity.tabName,
        url: pageUrl,
        pageKind,
        profileName,
        canvasDraft,
        artifactRevision,
        visualTargetRefs,
    };
};

export const detectStale = (currentUrl: string, draft: CanvasDraft): boolean => {
    const pattern = draft.page.urlPattern;
    if (!pattern) {
        return false;
    }
    try {
        return !new RegExp(pattern).test(currentUrl);
    } catch {
        return false;
    }
};

const statusFromCount = (count: number, expect: 'unique' | 'one_or_more'): CheckStatus => {
    if (count === 0) {
        return 'missing';
    }
    if (expect === 'unique' && count > 1) {
        return 'multiple';
    }
    return 'unique';
};

const messageForStatus = (status: CheckStatus, count: number, stale: boolean): string => {
    if (status === 'invalid') {
        return '规则无效';
    }
    if (status === 'missing') {
        return stale ? '目标所在页面已变化' : '没有找到目标';
    }
    if (status === 'unique') {
        return count > 1 ? `已识别 ${count} 个对象` : '已唯一识别';
    }
    return '匹配到多个对象';
};

export const runCheck = (
    snapshot: SnapshotResult,
    draft: CanvasDraft,
    currentUrl: string,
): AnnotatorCheckResult => {
    const stale = detectStale(currentUrl, draft);
    const annotationSpecs = collectAnnotationIds(draft);
    const diagnostics: EntityRuleDiagnostic[] = [];

    const compileResult = compileCanvasDraft(draft);
    if (!compileResult.ok) {
        const results: CheckResultByAnnotation[] = annotationSpecs.map((spec) => ({
            canvasAnnotationId: spec.id,
            status: 'invalid',
            matchCount: 0,
            expected: spec.expect,
            message: `规则编译失败: ${compileResult.errors[0] || ''}`,
            nodeIds: [],
        }));
        return { results, stale };
    }

    const artifact = compileResult.artifact;
    const validated = validateEntityRules(artifact.name, artifact.match, artifact.annotation);
    if (!validated.ok) {
        const results: CheckResultByAnnotation[] = annotationSpecs.map((spec) => ({
            canvasAnnotationId: spec.id,
            status: 'invalid',
            matchCount: 0,
            expected: spec.expect,
            message: `规则校验失败: ${validated.errors[0] || ''}`,
            nodeIds: [],
        }));
        return { results, stale };
    }

    const bundle = validated.bundle;
    const bindings = matchEntityRules(bundle, {
        root: snapshot.root,
        entityIndex: snapshot.entityIndex,
        nodeIndex: snapshot.nodeIndex,
    });
    const overlay = applyEntityRuleBindings(bundle, snapshot.root, snapshot.entityIndex, bindings);
    diagnostics.push(...(overlay.diagnostics || []));

    const results: CheckResultByAnnotation[] = annotationSpecs.map((spec) => {
        const ruleId = compileResult.ruleIdByAnnotationId[spec.id];
        if (!ruleId) {
            return {
                canvasAnnotationId: spec.id,
                status: 'invalid',
                matchCount: 0,
                expected: spec.expect,
                message: messageForStatus('invalid', 0, stale),
                nodeIds: [],
            };
        }
        const binding = bindings[ruleId];
        const matchCount = binding?.matchedNodeIds.length ?? 0;
        const status = statusFromCount(matchCount, spec.expect);
        return {
            canvasAnnotationId: spec.id,
            status,
            matchCount,
            expected: spec.expect,
            message: messageForStatus(status, matchCount, stale),
            nodeIds: binding?.matchedNodeIds || [],
        };
    });

    return { results, stale };
};

export type SavePreparation =
    | { ok: true; artifact: WorkflowEntityRules }
    | { ok: false; errors: string[] };

export const prepareSaveArtifact = (draft: CanvasDraft, profileName: string): SavePreparation => {
    const draftToCompile: CanvasDraft = { ...draft, profileName };
    const compileResult = compileCanvasDraft(draftToCompile);
    if (!compileResult.ok) {
        return { ok: false, errors: compileResult.errors };
    }
    return { ok: true, artifact: compileResult.artifact };
};
