import type { RunStepsDeps } from '../../run_steps';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import { ensureFreshSnapshot } from './snapshot/core/session_store';
import { buildFinalEntityViewFromSnapshot } from './snapshot/core/overlay';
import type { FinalEntityView, SnapshotSessionEntry, SnapshotResult } from './snapshot/core/types';

export type FreshEntityContext = {
    snapshot: SnapshotResult;
    finalEntityView: FinalEntityView;
    entry: SnapshotSessionEntry;
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>;
};

export const ensureFreshEntityContext = async (
    deps: RunStepsDeps,
    workspaceName: string,
    refreshReason: string,
): Promise<FreshEntityContext> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason,
        collectBaseSnapshot: async (context) =>
            await generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                entityRulesProvider: deps.resolveEntityRulesProvider?.(workspaceName) || undefined,
            }),
    });

    const finalEntityView =
        ensured.entry.finalEntityView ||
        buildFinalEntityViewFromSnapshot(ensured.snapshot, ensured.entry.overlays, true);

    return {
        snapshot: ensured.snapshot,
        finalEntityView,
        entry: ensured.entry,
        binding,
    };
};
