import type {RunStepsDeps} from '../run_steps_types';
import {awaitPageBoundBinding} from '../steps/helpers/runtime_binding';
import {
    buildEntityRuleComponentSnapshots,
    captureControlSnapshot,
    executeEntityRules,
    type PageSnapshotSessionEntry,
} from '../../snapshot';

export type FreshPageSessionContext = {
    entry: PageSnapshotSessionEntry;
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>;
};

export const ensureFreshPageSession = async (
    deps: RunStepsDeps,
    workspaceName: string,
    options: {explicit?: boolean} = {},
): Promise<FreshPageSessionContext> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const entry = await deps.pageSession.ensureFresh({
        pageKey: binding.page,
        pageUrl: safePageUrl(binding.page),
        reason: options.explicit ? 'explicit' : undefined,
        capture: async () => {
            const control = await captureControlSnapshot(binding.page);
            const selection = deps.pageSession.resolveSelectionForObservation(
                binding.page,
                control.observation,
            );
            const components = buildEntityRuleComponentSnapshots(
                control,
                selection.status === 'resolved' ? selection.nodeId : undefined,
            );
            return {
                control,
                form: components.form,
                table: components.table,
                entityRules: executeEntityRules({
                    config: deps.config.entityRules,
                    provider: deps.resolveEntityRulesProvider?.(workspaceName) || undefined,
                    snapshots: components,
                }),
            };
        },
    });
    return {entry, binding};
};

const safePageUrl = (page: {url: () => string}): string => {
    try {
        return page.url();
    } catch {
        return '';
    }
};
