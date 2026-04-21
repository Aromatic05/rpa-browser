import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import {
    ensureFreshSnapshot,
    updateSnapshotOverlays,
} from './snapshot/core/session_store';
import { normalizeText } from './snapshot/core/runtime_store';

export const executeBrowserDeleteEntity = async (
    step: Step<'browser.delete_entity'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.delete_entity',
        collectBaseSnapshot: async (context) =>
            generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                entityRuleConfig: deps.config.entityRules,
            }),
    });

    const nodeId = normalizeText(step.args.nodeId);
    if (!nodeId) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'nodeId is required',
            },
        };
    }

    const businessTag = normalizeText(step.args.businessTag);
    const before = (ensured.entry.finalEntityView?.byNodeId[nodeId] || []).filter((entity) => {
        if (step.args.kind && entity.kind !== step.args.kind) return false;
        if (businessTag && entity.businessTag !== businessTag) return false;
        return true;
    }).length;

    const entry = updateSnapshotOverlays(binding, 'browser.delete_entity', (overlays) => {
        overlays.deletedEntities.push({
            nodeId,
            kind: step.args.kind,
            businessTag,
        });
    });

    const after = (entry.finalEntityView?.byNodeId[nodeId] || []).filter((entity) => {
        if (step.args.kind && entity.kind !== step.args.kind) return false;
        if (businessTag && entity.businessTag !== businessTag) return false;
        return true;
    }).length;

    return {
        stepId: step.id,
        ok: true,
        data: {
            node_id: nodeId,
            matched_before: before,
            matched_after: after,
            deleted_count: Math.max(0, before - after),
            node_exists: Boolean(ensured.snapshot.nodeIndex[nodeId]),
            overlay_summary: {
                rename_count: Object.keys(entry.overlays.renamedNodes).length,
                add_count: entry.overlays.addedEntities.length,
                delete_count: entry.overlays.deletedEntities.length,
            },
        },
    };
};
