import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps_types';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveAtomicActionTarget } from '../../../snapshot';

export const executeBrowserDragAndDrop = async (
    step: Step<'browser.drag_and_drop'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const source = await resolveAtomicActionTarget(binding.page, {
        nodeId: step.args.sourceNodeId,
        selector: step.args.sourceSelector,
    });
    if (!source.ok) {
        return { stepId: step.id, ok: false, error: {
            code: source.error.code,
            message: source.error.message,
            details: source.error.details,
        } };
    }

    try {
        if (step.args.destNodeId || step.args.destSelector) {
            const destination = await resolveAtomicActionTarget(binding.page, {
                nodeId: step.args.destNodeId,
                selector: step.args.destSelector,
            });
            if (!destination.ok) {
                return { stepId: step.id, ok: false, error: {
                    code: destination.error.code,
                    message: destination.error.message,
                    details: destination.error.details,
                } };
            }
            await source.target.locator.dragTo(destination.target.locator, {
                timeout: deps.config.waitPolicy.visibleTimeoutMs,
            });
        } else if (step.args.destCoord) {
            const box = await source.target.locator.boundingBox();
            if (!box) {
                return { stepId: step.id, ok: false, error: {
                    code: 'ERR_UNRESOLVED',
                    message: 'drag source has no visible bounding box',
                    details: { nodeId: source.target.nodeId },
                } };
            }
            await binding.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await binding.page.mouse.down();
            await binding.page.mouse.move(step.args.destCoord.x, step.args.destCoord.y, { steps: 8 });
            await binding.page.mouse.up();
        } else {
            return { stepId: step.id, ok: false, error: { code: 'ERR_BAD_ARGS', message: 'missing drag destination' } };
        }
    } catch (error) {
        return { stepId: step.id, ok: false, error: {
            code: /timeout/i.test(String(error)) ? 'ERR_TIMEOUT' : 'ERR_INTERNAL',
            message: error instanceof Error ? error.message : String(error),
        } };
    }

    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.clickDelayMsRange.min,
            deps.config.humanPolicy.clickDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return {
        stepId: step.id,
        ok: true,
        data: {
            sourceNodeId: source.target.nodeId,
            captureRevision: source.target.snapshot.observation.identity.captureRevision,
            resolver: 'snapshot-v2-canonical-locator',
        },
    };
};
