import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot';
import { buildNodeSummary, buildTableMeta, toEntityOutputRecord } from './snapshot/core/entity_output';
import { ensureFreshSnapshot } from './snapshot/core/session_store';
import { normalizeText } from './snapshot/core/runtime_store';

export const executeBrowserGetEntity = async (
    step: Step<'browser.get_entity'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.get_entity',
        collectBaseSnapshot: async () => generateSemanticSnapshot(binding.page),
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

    const node = buildNodeSummary(ensured.snapshot, nodeId);
    if (!node) {
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

    const entities = ensured.entry.finalEntityView?.byNodeId[nodeId] || [];
    return {
        stepId: step.id,
        ok: true,
        data: {
            node,
            entities: entities.map((entity) => toEntityOutputRecord(entity)),
            total: entities.length,
            table_meta: buildTableMeta(ensured.snapshot, nodeId) || undefined,
        },
    };
};
