import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import { ensureFreshSnapshot } from './snapshot/core/session_store';
import { resolveBusinessEntityTarget } from './snapshot/core/business_entity_resolver';

export const executeBrowserResolveEntityTarget = async (
    step: Step<'browser.resolve_entity_target'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'browser.resolve_entity_target',
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

    const resolved = resolveBusinessEntityTarget(
        ensured.snapshot,
        finalEntityView,
        step.args.businessTag,
        step.args.target,
    );
    if (!resolved.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: resolved.error,
        };
    }

    return {
        stepId: step.id,
        ok: true,
        data: resolved.data,
    };
};
