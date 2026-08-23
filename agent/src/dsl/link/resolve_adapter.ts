import type { StepResolve } from '../../runner/steps/types';
import type { Workflow } from '../../workflow';
import type { DslResolveResolver } from './types';

export const createDslResolveResolver = (
    workflow: Workflow,
    overlay: ReadonlyMap<string, Record<string, StepResolve>> = new Map(),
): DslResolveResolver => ({
    resolveBundle: (bundleName) => {
        const candidate = overlay.get(bundleName);
        if (candidate) {return {resolves: candidate, diagnostics: []};}
        try {
            const artifact = workflow.get(bundleName, {kind: 'dsl'});
            if (artifact?.kind !== 'dsl') {return {resolves: null, diagnostics: []};}
            return {resolves: artifact.stepResolves, diagnostics: []};
        } catch (error) {
            return {
                resolves: null,
                diagnostics: [{
                    code: 'ERR_DSL_RESOLVE_BUNDLE_INVALID',
                    message: `resolve bundle ${bundleName} is invalid: ${error instanceof Error ? error.message : String(error)}`,
                }],
            };
        }
    },
});
