import type { Step, StepResult } from '../../types';
import type { SnapshotResult, UnifiedNode } from '../snapshot/core/types';
import type { SelectOptionControl, SelectOptionKind, SelectOptionOption } from './types';
import { SELECT_OPTION_KINDS } from './types';
import { matchOptions } from './option_match';
import { ambiguous, badArgs, isStepResult, notFound } from './assert';

export type ResolveControlInput = {
    stepId: string;
    stepArgs: Step<'browser.select_option'>['args'];
    targetNode: UnifiedNode | undefined;
    snapshot: SnapshotResult;
    candidateCount?: number;
};

const CHOICE_GROUP_KINDS: ReadonlySet<string> = new Set(['radio_group', 'checkbox_group']);

const toSelectOptions = (component: SelectOptionControl['component']): SelectOptionOption[] => {
    const rawOptions = (component.data.options as Array<Record<string, unknown>>) ?? [];
    return rawOptions.map((opt) => ({
        value: String(opt.value ?? ''),
        label: String(opt.label ?? ''),
        text: opt.text != null ? String(opt.text) : undefined,
        ariaLabel: opt.ariaLabel != null ? String(opt.ariaLabel) : undefined,
        title: opt.title != null ? String(opt.title) : undefined,
        dataValue: opt.dataValue != null ? String(opt.dataValue) : undefined,
        dataKey: opt.dataKey != null ? String(opt.dataKey) : undefined,
        selected: Boolean(opt.selected),
        nodeId: String(opt.nodeId ?? ''),
    }));
};

export const resolveSelectOptionControl = (input: ResolveControlInput): SelectOptionControl | StepResult => {
    const { targetNode, snapshot, stepArgs } = input;

    if (!targetNode) {
        return notFound(input.stepId, 'target node not found in snapshot');
    }

    const controlRef: string | undefined = targetNode.control?.ref;

    if (!controlRef) {
        return notFound(input.stepId, 'no controlRef available from target node', {
            nodeId: targetNode.id,
            nodeRole: targetNode.role,
        });
    }

    if (!snapshot.controlIndex) {
        return notFound(input.stepId, 'snapshot missing controlIndex');
    }

    const component = snapshot.controlIndex[controlRef];
    if (!component) {
        return notFound(input.stepId, 'controlRef not found in controlIndex', { controlRef });
    }

    if (component.owner !== 'browser.select_option') {
        return badArgs(input.stepId, 'control owner is not browser.select_option', {
            owner: component.owner,
            controlRef,
        });
    }

    if (!component.capabilities.includes('select_option')) {
        return badArgs(input.stepId, 'control does not have select_option capability', {
            capabilities: component.capabilities,
            controlRef,
        });
    }

    const componentKind = component.kind;

    if (!SELECT_OPTION_KINDS.has(componentKind)) {
        return badArgs(input.stepId, `unsupported component kind: ${componentKind}`, {
            componentKind,
            allowedKinds: [...SELECT_OPTION_KINDS],
        });
    }

    const kind = componentKind as SelectOptionKind;
    if (stepArgs.kind !== kind) {
        return badArgs(input.stepId, 'select_option kind mismatch between step args and runtime control', {
            expectedKind: stepArgs.kind,
            actualKind: kind,
            controlRef,
            targetNodeId: targetNode.id,
        });
    }

    return { kind, ref: controlRef, component };
};

export const resolveChoiceGroupControl = (input: ResolveControlInput): SelectOptionControl | StepResult => {
    const { snapshot, stepArgs } = input;
    if (!CHOICE_GROUP_KINDS.has(stepArgs.kind)) {
        return badArgs(input.stepId, 'choice group control resolution only supports radio_group and checkbox_group', {
            kind: stepArgs.kind,
        });
    }

    if (!snapshot.controlIndex) {
        return notFound(input.stepId, 'snapshot missing controlIndex', {
            kind: stepArgs.kind,
            values: stepArgs.values,
            matchedControlCount: 0,
            matchedControlRefs: [],
            candidateCount: input.candidateCount ?? 0,
        });
    }

    const candidateControls: SelectOptionControl[] = [];
    const matchedControls: SelectOptionControl[] = [];

    for (const [controlRef, component] of Object.entries(snapshot.controlIndex)) {
        if (component.owner !== 'browser.select_option') {continue;}
        if (!component.capabilities.includes('select_option')) {continue;}
        if (component.kind !== stepArgs.kind) {continue;}

        const kind = component.kind as SelectOptionKind;
        const control = { kind, ref: controlRef, component };
        candidateControls.push(control);

        const options = toSelectOptions(component);
        const matchResult = matchOptions(input.stepId, options, stepArgs.values);
        if (isStepResult(matchResult)) {continue;}
        matchedControls.push(control);
    }

    const details = {
        kind: stepArgs.kind,
        values: stepArgs.values,
        matchedControlCount: matchedControls.length,
        matchedControlRefs: matchedControls.map((control) => control.ref),
        candidateCount: candidateControls.length,
    };

    if (matchedControls.length === 0) {
        return notFound(input.stepId, 'choice group control not found', details);
    }

    if (matchedControls.length > 1) {
        return ambiguous(input.stepId, 'multiple choice group controls matched', details);
    }

    return matchedControls[0];
};
