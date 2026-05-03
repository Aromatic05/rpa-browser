import type { EntityKind } from '../runner/steps/executors/snapshot/core/types';
import type { NormalizedEntityRuleBundle } from '../runner/steps/executors/snapshot/entity_rules/types';
import { toEntityRuleBundle, type Workflow, type WorkflowEntityRules } from '../workflow';
import { createWorkspaceEntityRulesRuntime } from './runtime';

export type ResolveEntityRulesBundleInput = {
    pageKind?: EntityKind;
    pageUrl?: string;
};

export type WorkspaceEntityRulesProvider = {
    listBundles: () => NormalizedEntityRuleBundle[];
    getBundle: (profileName: string) => NormalizedEntityRuleBundle | null;
    resolveBundle: (input?: ResolveEntityRulesBundleInput) => NormalizedEntityRuleBundle | null;
};

const toBundle = (artifact: WorkflowEntityRules): NormalizedEntityRuleBundle => toEntityRuleBundle(artifact);

const isBundleMatched = (bundle: NormalizedEntityRuleBundle, input: ResolveEntityRulesBundleInput): boolean => {
    if (input.pageKind && bundle.page.kind !== input.pageKind) {
        return false;
    }
    if (!bundle.page.urlPattern) {
        return true;
    }
    if (!input.pageUrl) {
        return false;
    }
    return new RegExp(bundle.page.urlPattern).test(input.pageUrl);
};

export const createWorkspaceEntityRulesProvider = (workflow: Workflow): WorkspaceEntityRulesProvider => {
    const runtime = createWorkspaceEntityRulesRuntime(workflow);

    return {
        listBundles: () => runtime.list().map(toBundle),
        getBundle: (profileName) => {
            const artifact = runtime.get(profileName);
            if (!artifact) {
                return null;
            }
            return toBundle(artifact);
        },
        resolveBundle: (input = {}) => {
            const bundles = runtime
                .list()
                .map(toBundle)
                .sort((left, right) => left.id.localeCompare(right.id));
            const matched = bundles.filter((bundle) => isBundleMatched(bundle, input));
            return matched[0] || null;
        },
    };
};
