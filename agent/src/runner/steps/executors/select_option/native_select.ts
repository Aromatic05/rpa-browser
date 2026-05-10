import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import type { SelectOptionControl } from './types';
import { mapTraceError } from '../../helpers/target';
import { assertionFailed } from './assert';

export const executeNativeSelect = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
    selector: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;

    const before = await binding.traceTools['trace.locator.readSelectState']({ selector });

    const select = await binding.traceTools['trace.locator.selectOption']({
        selector,
        values: step.args.values,
        timeout,
    });
    if (!select.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(select.error) };
    }

    const after = await binding.traceTools['trace.locator.readSelectState']({ selector });

    const beforeValues = readValues(before);
    const afterValues = readValues(after);
    const afterLabels = readLabels(after);

    const stateUnchanged = setsEqual(beforeValues, afterValues);

    if (stateUnchanged) {
        const targetSet = new Set(step.args.values.map((v) => v.trim()));
        const alreadyHit = isSuperset(afterValues, targetSet);
        if (alreadyHit) {
            return { stepId: step.id, ok: true };
        }
        return assertionFailed(step.id, 'state not changed after selection', {
            expected: step.args.values,
            before: [...beforeValues],
            after: [...afterValues],
        });
    }

    const targetValues = step.args.values.map((v) => v.trim());
    const hitViaValues = targetValues.every((v) => afterValues.has(v));
    const hitViaLabels = targetValues.every((v) => afterLabels.has(v));

    if (!hitViaValues && !hitViaLabels) {
        return assertionFailed(step.id, 'selected values/labels do not match target', {
            expected: step.args.values,
            selectedValues: [...afterValues],
            selectedLabels: [...afterLabels],
        });
    }

    return { stepId: step.id, ok: true };
};

const readValues = (state: { ok: boolean; data?: Record<string, unknown> }): Set<string> => {
    if (!state.ok) {return new Set();}
    const arr = (state.data?.selectedValues as unknown[]) ?? [];
    return new Set(arr.map((v: unknown) => String(v).trim()).filter(Boolean));
};

const readLabels = (state: { ok: boolean; data?: Record<string, unknown> }): Set<string> => {
    if (!state.ok) {return new Set();}
    const arr = (state.data?.selectedLabels as unknown[]) ?? [];
    return new Set(arr.map((v: unknown) => String(v).trim()).filter(Boolean));
};

const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) {return false;}
    for (const item of a) {
        if (!b.has(item)) {return false;}
    }
    return true;
};

const isSuperset = (superset: Set<string>, subset: Set<string>): boolean => {
    for (const item of subset) {
        if (!superset.has(item)) {return false;}
    }
    return true;
};
