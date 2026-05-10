import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import type { SnapshotResult, UnifiedNode } from '../snapshot/core/types';
import { mapTraceError } from '../../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../../helpers/delay';
import { resolveTarget } from '../../helpers/resolve_target';
import { generateSemanticSnapshot } from '../snapshot/pipeline/snapshot';
import type { SelectOptionControl } from './types';
import { badArgs, isStepResult } from './assert';
import { resolveControl } from './resolve_control';
import { executeNativeSelect } from './native_select';
import { executeRadioGroup, executeCheckboxGroup } from './choice_group';
import { executeCustomSelect } from './custom_select';

export { registerSelectOptionControls } from './register_controls';

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>,
    selector: string,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector });
    if (!scroll.ok) {return scroll;}
    return await binding.traceTools['trace.locator.waitForVisible']({ selector, timeout });
};

export const findTargetNode = (
    snapshot: SnapshotResult,
    step: Step<'browser.select_option'>,
    candidateSelector: string,
): UnifiedNode | undefined => {
    const nodeId = step.args.nodeId || step.resolve?.hint?.target?.nodeId;
    if (nodeId) {
        return snapshot.nodeIndex[nodeId];
    }

    const sel = candidateSelector || step.args.selector;
    if (!sel) return undefined;

    const cleanSel = sel.replace(/:visible$/, '');

    for (const [nid, locator] of Object.entries(snapshot.locatorIndex)) {
        if (locator.direct?.query === cleanSel || locator.direct?.fallback === cleanSel) {
            return snapshot.nodeIndex[nid];
        }
    }

    const idMatch = cleanSel.match(/^#([A-Za-z][A-Za-z0-9_-]*)$/);
    if (idMatch) {
        const targetId = idMatch[1];
        for (const [nid, attrs] of Object.entries(snapshot.attrIndex)) {
            if (attrs['id'] === targetId) {
                return snapshot.nodeIndex[nid];
            }
        }
    }

    const testIdMatch = cleanSel.match(/^\[data-testid="([^"]+)"\]$/);
    if (testIdMatch) {
        const targetTestId = testIdMatch[1];
        for (const [nid, attrs] of Object.entries(snapshot.attrIndex)) {
            if (attrs['data-testid'] === targetTestId) {
                return snapshot.nodeIndex[nid];
            }
        }
    }

    return undefined;
};

export const executeBrowserSelectOption = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    if (!Array.isArray(step.args.values) || step.args.values.length === 0) {
        return badArgs(step.id, 'values must be a non-empty array', { values: step.args.values });
    }

    const binding = await deps.runtime.resolveBinding(workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;

    const resolved = await resolveTarget(binding, {
        nodeId: step.args.nodeId,
        selector: step.args.selector,
        resolve: step.resolve,
    }, {
        deps,
        workspaceName,
        reason: 'browser.select_option',
        stepId: step.id,
        stepName: step.name,
    });
    if (!resolved.ok) {
        return { stepId: step.id, ok: false, error: resolved.error };
    }

    const highlightBeforeActionMs = deps.config.waitPolicy.highlightBeforeActionMs;
    let lastError: StepResult['error'] | undefined;

    for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
        const candidate = resolved.target.candidates[candidateIndex];

        const visible = await ensureVisible(binding, candidate.selector, timeout);
        if (!visible.ok) {
            lastError = mapTraceError(visible.error);
            continue;
        }

        const highlight = await binding.traceTools['trace.locator.highlight']({
            selector: candidate.selector,
            highlightMs: highlightBeforeActionMs,
            candidateIndex,
            stepId: step.id,
            stepName: step.name,
        });
        if (!highlight.ok) {
            lastError = mapTraceError(highlight.error);
            continue;
        }

        const snapshot = await generateSemanticSnapshot(binding.page);
        const targetNode = findTargetNode(snapshot, step, candidate.selector);

        const controlResult = resolveControl({
            stepArgs: step.args,
            targetNode,
            snapshot,
        });
        if (isStepResult(controlResult)) {
            lastError = controlResult.error;
            continue;
        }
        const control = controlResult;

        let execResult: StepResult;
        switch (control.kind) {
            case 'native_select':
                execResult = await executeNativeSelect(
                    step, deps, workspaceName, control, snapshot,
                );
                break;
            case 'radio_group':
                execResult = await executeRadioGroup(step, deps, workspaceName, control);
                break;
            case 'checkbox_group':
                execResult = await executeCheckboxGroup(step, deps, workspaceName, control);
                break;
            case 'custom_select':
                execResult = await executeCustomSelect(step, deps, workspaceName, control);
                break;
            default:
                lastError = {
                    code: 'ERR_BAD_ARGS',
                    message: `unsupported control kind: ${(control as SelectOptionControl).kind}`,
                    details: { kind: (control as SelectOptionControl).kind },
                };
                continue;
        }

        if (!execResult.ok) {
            lastError = execResult.error;
            continue;
        }

        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            );
            if (delayMs > 0) {
                await waitForHumanDelay(binding.page, delayMs);
            }
        }

        return { stepId: step.id, ok: true };
    }

    return {
        stepId: step.id,
        ok: false,
        error: lastError || {
            code: 'ERR_NOT_FOUND',
            message: 'no select target candidate matched',
        },
    };
};
