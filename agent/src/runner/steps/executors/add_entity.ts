import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import { buildNodeSummary, toEntityOutputRecord } from './snapshot/core/entity_output';
import {
    ensureFreshSnapshot,
    updateSnapshotOverlays,
} from './snapshot/core/session_store';
import { normalizeText } from './snapshot/core/runtime_store';

export const executeBrowserAddEntity = async (
    step: Step<'browser.add_entity'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.add_entity',
        collectBaseSnapshot: async (context) =>
            generateSemanticSnapshot(binding.page, { captureRuntimeState: context.fromDirty }),
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

    if (!ensured.snapshot.nodeIndex[nodeId]) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'node id not found in snapshot',
                details: { nodeId },
            },
        };
    }

    const name = normalizeText(step.args.name);
    const businessTag = normalizeText(step.args.businessTag);
    const entry = updateSnapshotOverlays(binding, 'browser.add_entity', (overlays) => {
        overlays.addedEntities.push({
            nodeId,
            kind: step.args.kind,
            name,
            businessTag,
        });
    });

    const latest = entry.finalSnapshot;
    const node = latest ? buildNodeSummary(latest, nodeId) : null;
    const added = [...(entry.finalEntityView?.byNodeId[nodeId] || [])]
        .reverse()
        .find(
            (entity) =>
                entity.source === 'overlay_add' &&
                entity.kind === step.args.kind &&
                (name ? entity.name === name : true) &&
                (businessTag ? entity.businessTag === businessTag : true),
        );

    return {
        stepId: step.id,
        ok: true,
        data: {
            node,
            entity: added ? toEntityOutputRecord(added) : undefined,
            overlay_summary: {
                rename_count: Object.keys(entry.overlays.renamedNodes).length,
                add_count: entry.overlays.addedEntities.length,
                delete_count: entry.overlays.deletedEntities.length,
            },
        },
    };
};
