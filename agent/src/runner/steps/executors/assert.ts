import type {RunStepsDeps} from '../../run_steps';
import {
    buildPageSessionEntityView,
    ensureFreshPageSession,
    filterPageSessionEntities,
} from '../../session';
import {visibleTextEvaluation} from '../../page/visible_text';
import {awaitPageBoundBinding} from '../helpers/runtime_binding';
import type {Step, StepResult} from '../types';

const assertError = (stepId: string, message: string, details?: unknown): StepResult => ({
    stepId,
    ok: false,
    error: {
        code: 'ERR_CHECKPOINT_ASSERT_FAILED',
        message,
        details,
    },
});

export const executeBrowserAssert = async (
    step: Step<'browser.assert'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const {urlIncludes, textVisible, entityExists} = step.args;
    if (!urlIncludes && !textVisible && !entityExists) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'browser.assert requires at least one assertion rule',
            },
        };
    }

    const binding = await awaitPageBoundBinding(deps, workspaceName);

    if (urlIncludes) {
        const info = await binding.traceTools['trace.page.getInfo']();
        if (!info.ok) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_INTERNAL',
                    message: info.error.message || 'failed to get page info',
                    details: info.error.details,
                },
            };
        }
        if (!(info.data?.url || '').includes(urlIncludes)) {
            return assertError(step.id, 'assert urlIncludes failed', {
                urlIncludes,
                actualUrl: info.data?.url,
            });
        }
    }

    if (textVisible) {
        const evalResult = await binding.traceTools['trace.page.evaluate'](visibleTextEvaluation(textVisible));
        if (!evalResult.ok) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_INTERNAL',
                    message: evalResult.error.message || 'failed to evaluate text visibility',
                    details: evalResult.error.details,
                },
            };
        }
        if (evalResult.data !== true) {
            return assertError(step.id, 'assert textVisible failed', {textVisible});
        }
    }

    if (entityExists) {
        const {entry} = await ensureFreshPageSession(
            deps,
            workspaceName,
            {explicit: true, entityRules: step.entityRules},
        );
        const entities = filterPageSessionEntities(
            buildPageSessionEntityView(entry).entities,
            entityExists,
        );
        if (entities.length === 0) {
            return assertError(step.id, 'assert entityExists failed', {entityExists});
        }
    }

    return {
        stepId: step.id,
        ok: true,
        data: {
            urlIncludes: urlIncludes || null,
            textVisible: textVisible || null,
            entityExists: entityExists || null,
        },
    };
};
