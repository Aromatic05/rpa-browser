import { matchEntityRules } from '../../runner/steps/executors/snapshot/entity_rules/matcher';
import { applyEntityRuleBindings } from '../../runner/steps/executors/snapshot/entity_rules/apply';
import { validateEntityRules } from '../../runner/steps/executors/snapshot/entity_rules/validate';
import type {
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

const buildVisualTargetRefs = (finalEntityView: FinalEntityView | undefined): VisualTargetRef[] => {
    const refs: VisualTargetRef[] = [];
    if (!finalEntityView) {
        return refs;
    }
    for (const entity of finalEntityView.entities) {
        if (!entity.businessTag && !entity.businessName) {
            continue;
        }
        refs.push({
            entityId: entity.id,
            nodeId: entity.nodeId,
            kind: entity.kind,
            role: 'entity',
        });
        for (const field of entity.formFields || []) {
            if (field.controlNodeId) {
                refs.push({
                    entityId: entity.id,
                    nodeId: field.controlNodeId,
                    kind: entity.kind,
                    role: 'field',
                    fieldKey: field.fieldKey,
                });
            }
            if (field.labelNodeId) {
                refs.push({
                    entityId: entity.id,
                    nodeId: field.labelNodeId,
                    kind: entity.kind,
                    role: 'field',
                    fieldKey: field.fieldKey,
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
                });
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
    const visualTargetRefs = buildVisualTargetRefs(ctx.finalEntityView);

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
