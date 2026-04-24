import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import { toEntityOutputRecord } from './snapshot/core/entity_output';
import { filterFinalEntities } from './snapshot/core/entity_query';
import { ensureFreshSnapshot } from './snapshot/core/session_store';

export const executeBrowserFindEntities = async (
    step: Step<'browser.find_entities'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.find_entities',
        collectBaseSnapshot: async (context) =>
            await generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                entityRuleConfig: deps.config.entityRules,
            }),
    });

    const finalEntities = ensured.entry.finalEntityView?.entities || [];
    const filtered = filterFinalEntities(finalEntities, {
        kind: step.args.kind,
        businessTag: step.args.businessTag,
        query: step.args.query,
    });

    return {
        stepId: step.id,
        ok: true,
        data: {
            total: filtered.length,
            entities: filtered.map((entity) => toEntityOutputRecord(entity)),
        },
    };
};
