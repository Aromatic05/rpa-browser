import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import { ensureFreshSnapshot } from './snapshot/core/session_store';
import { queryBusinessEntity } from './snapshot/core/business_entity_resolver';

export const executeBrowserQueryEntity = async (
    step: Step<'browser.query_entity'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.query_entity',
        collectBaseSnapshot: async (context) =>
            await generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                entityRuleConfig: deps.config.entityRules,
            }),
    });

    const finalEntityView = ensured.entry.finalEntityView;
    if (!finalEntityView) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'final entity view not found',
            },
        };
    }

    const queried = queryBusinessEntity(
        ensured.snapshot,
        finalEntityView,
        step.args.businessTag,
        step.args.query,
    );
    if (!queried.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: queried.error,
        };
    }

    return {
        stepId: step.id,
        ok: true,
        data: queried.data,
    };
};
