import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { ensureFreshSnapshot } from './snapshot/core/session_store';
import { generateSemanticSnapshot } from './snapshot/pipeline/snapshot';
import { filterFinalEntities } from './snapshot/core/entity_query';

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
    workspaceId: string,
): Promise<StepResult> => {
    const { urlIncludes, textVisible, entityExists } = step.args;
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

    const binding = await deps.runtime.ensureActivePage(workspaceId);

    if (urlIncludes) {
        const info = await binding.traceTools['trace.page.getInfo']();
        if (!info.ok) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_INTERNAL',
                    message: info.error?.message || 'failed to get page info',
                    details: info.error?.details,
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
        const evalResult = await binding.traceTools['trace.page.evaluate']({
            expression: `({ needle }) => {
                const text = String(needle || '').trim();
                if (!text) return false;
                const isVisible = (el) => {
                    if (!(el instanceof Element)) return false;
                    const style = window.getComputedStyle(el);
                    if (!style) return false;
                    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };
                const elements = Array.from(document.querySelectorAll('body *'));
                return elements.some((el) => isVisible(el) && (el.textContent || '').includes(text));
            }`,
            arg: { needle: textVisible },
        });
        if (!evalResult.ok) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_INTERNAL',
                    message: evalResult.error?.message || 'failed to evaluate text visibility',
                    details: evalResult.error?.details,
                },
            };
        }
        if (evalResult.data !== true) {
            return assertError(step.id, 'assert textVisible failed', {
                textVisible,
            });
        }
    }

    if (entityExists) {
        const ensured = await ensureFreshSnapshot(binding, {
            refreshReason: 'browser.assert.entityExists',
            collectBaseSnapshot: async (context) =>
                generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                entityRuleConfig: deps.config.entityRules,
            }),
        });

        const finalEntities = ensured.entry.finalEntityView?.entities || [];
        const filtered = filterFinalEntities(finalEntities, {
            kind: entityExists.kind,
            businessTag: entityExists.businessTag,
            query: entityExists.query,
        });
        if (filtered.length === 0) {
            return assertError(step.id, 'assert entityExists failed', {
                entityExists,
            });
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
