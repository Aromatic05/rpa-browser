import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import type { SelectOptionControl } from './types';
import type { SnapshotResult } from '../snapshot/core/types';
import { mapTraceError } from '../../helpers/target';
import { assertionFailed, notFound } from './assert';

export const executeNativeSelect = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
    snapshot: SnapshotResult,
): Promise<StepResult> => {
    const controlNodeId = control.component.controlNodeId;
    if (!controlNodeId) {
        return notFound(step.id, 'native_select missing controlNodeId');
    }

    const nativeSelector = snapshot.locatorIndex[controlNodeId]?.direct?.query;
    if (!nativeSelector) {
        return notFound(step.id, 'no selector for native select control node', { controlNodeId });
    }

    const binding = await deps.runtime.resolveBinding(workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;

    const availableOptions = await binding.page.locator(nativeSelector).evaluate((node) => {
        const select = node as HTMLSelectElement;
        if (!select || !('options' in select)) {
            return { values: [] as string[], labels: [] as string[] };
        }
        const opts = Array.from(select.options);
        return {
            values: opts.map((o) => (o.value || '').trim()).filter(Boolean),
            labels: opts.map((o) => (o.textContent || '').trim()).filter(Boolean),
        };
    });
    const availValues = new Set(availableOptions.values);
    const availLabels = new Set(availableOptions.labels);
    const targetList = step.args.values.map((v) => v.trim());
    const anyMissing = targetList.some((v) => !availValues.has(v) && !availLabels.has(v));
    if (anyMissing) {
        return notFound(step.id, 'option not found in native select', {
            targetValues: targetList,
            availableValues: availableOptions.values,
            availableLabels: availableOptions.labels,
        });
    }

    const before = await binding.traceTools['trace.locator.readSelectState']({ selector: nativeSelector });
    if (!before.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(before.error) };
    }

    const select = await binding.traceTools['trace.locator.selectOption']({
        selector: nativeSelector,
        values: step.args.values,
        timeout,
    });
    if (!select.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(select.error) };
    }

    const after = await binding.traceTools['trace.locator.readSelectState']({ selector: nativeSelector });
    if (!after.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(after.error) };
    }

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
