import type {Page} from 'playwright';
import type {RunStepsDeps} from '../run_steps_types';
import {awaitPageBoundBinding} from '../steps/helpers/runtime_binding';
import {
    buildEntityRuleComponentSnapshots,
    captureControlSnapshot,
    executeEntityRules,
    type PageSnapshotSessionEntry,
} from '../../snapshot';
import type {StepEntityRulesControl} from '../../snapshot/rules/model';
import type {WorkspaceEntityRulesProvider} from '../../snapshot/rules/runtime';

export type FreshPageSessionContext = {
    entry: PageSnapshotSessionEntry;
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>;
};

export const ensurePageSessionForPage = async (
    deps: RunStepsDeps,
    workspaceName: string,
    page: Page,
    options: {explicit?: boolean; entityRules?: StepEntityRulesControl; entityRulesProvider?: WorkspaceEntityRulesProvider} = {},
): Promise<PageSnapshotSessionEntry> => await deps.pageSession.ensureFresh({
    pageKey: page,
    pageUrl: safePageUrl(page),
    reason: options.explicit ? 'explicit' : undefined,
    capture: async () => {
        const control = await captureControlSnapshot(page);
        const selection = deps.pageSession.resolveSelectionForObservation(page, control.observation);
        const components = buildEntityRuleComponentSnapshots(
            control,
            selection.status === 'resolved' ? selection.nodeId : undefined,
        );
        return {
            control,
            form: components.form,
            table: components.table,
            entityRules: executeEntityRules({
                control: options.entityRules,
                config: deps.config.entityRules,
                provider: options.entityRulesProvider ?? deps.resolveEntityRulesProvider?.(workspaceName) ?? undefined,
                pageUrl: safePageUrl(page),
                snapshots: components,
            }),
        };
    },
});

export const ensureFreshPageSession = async (
    deps: RunStepsDeps,
    workspaceName: string,
    options: {explicit?: boolean; tabName?: string; entityRules?: StepEntityRulesControl; entityRulesProvider?: WorkspaceEntityRulesProvider} = {},
): Promise<FreshPageSessionContext> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName, options.tabName);
    const entry = await ensurePageSessionForPage(deps, workspaceName, binding.page, options);
    return {entry, binding};
};

const safePageUrl = (page: {url: () => string}): string => {
    try {
        return page.url();
    } catch {
        return '';
    }
};
