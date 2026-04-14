import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot';
import { buildNodeSummary } from './snapshot/core/entity_output';
import {
    ensureFreshSnapshot,
    updateSnapshotOverlays,
} from './snapshot/core/session_store';
import { normalizeText } from './snapshot/core/runtime_store';

export const executeBrowserRenameEntity = async (
    step: Step<'browser.rename_entity'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.rename_entity',
        collectBaseSnapshot: async (context) =>
            generateSemanticSnapshot(binding.page, { captureRuntimeState: context.fromDirty }),
    });

    const nodeId = normalizeText(step.args.nodeId);
    const name = normalizeText(step.args.name);
    if (!nodeId || !name) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'nodeId and name are required',
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

    const entry = updateSnapshotOverlays(binding, 'browser.rename_entity', (overlays) => {
        overlays.renamedNodes[nodeId] = name;
    });

    const node = entry.finalSnapshot ? buildNodeSummary(entry.finalSnapshot, nodeId) : null;

    return {
        stepId: step.id,
        ok: true,
        data: {
            node,
            name,
            overlay_summary: {
                rename_count: Object.keys(entry.overlays.renamedNodes).length,
                add_count: entry.overlays.addedEntities.length,
                delete_count: entry.overlays.deletedEntities.length,
            },
        },
    };
};
