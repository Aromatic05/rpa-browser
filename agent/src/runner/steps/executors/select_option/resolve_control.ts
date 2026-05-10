import type { Step, StepResult } from '../../types';
import type { SnapshotResult, UnifiedNode } from '../snapshot/core/types';
import type { SelectOptionControl, SelectOptionKind } from './types';
import { SELECT_OPTION_KINDS } from './types';
import { badArgs, notFound } from './assert';

export type ResolveControlInput = {
    stepArgs: Step<'browser.select_option'>['args'];
    targetNode: UnifiedNode | undefined;
    snapshot: SnapshotResult;
};

export const resolveControl = (input: ResolveControlInput): SelectOptionControl | StepResult => {
    const { stepArgs, targetNode, snapshot } = input;

    if (!targetNode) {
        return notFound('step', 'target node not found in snapshot');
    }

    // Prefer step.args.controlRef
    let controlRef: string | undefined = stepArgs.controlRef;

    // Fallback to target node's control.ref
    if (!controlRef) {
        controlRef = targetNode.control?.ref;
    }

    if (!controlRef) {
        return notFound('step', 'no controlRef available from args or target node', {
            nodeId: targetNode.id,
            nodeRole: targetNode.role,
        });
    }

    // Lookup in controlIndex
    if (!snapshot.controlIndex) {
        return notFound('step', 'snapshot missing controlIndex');
    }

    const component = snapshot.controlIndex[controlRef];
    if (!component) {
        return notFound('step', 'controlRef not found in controlIndex', { controlRef });
    }

    // Verify owner is browser.select_option
    if (component.owner !== 'browser.select_option') {
        return badArgs('step', 'control owner is not browser.select_option', {
            owner: component.owner,
            controlRef,
        });
    }

    // Verify capabilities includes select_option
    if (!component.capabilities.includes('select_option')) {
        return badArgs('step', 'control does not have select_option capability', {
            capabilities: component.capabilities,
            controlRef,
        });
    }

    const componentKind = component.kind;

    // Validate / derive kind
    if (stepArgs.kind) {
        if (!SELECT_OPTION_KINDS.has(stepArgs.kind)) {
            return badArgs('step', `unsupported kind: ${stepArgs.kind}`, {
                kind: stepArgs.kind,
                allowedKinds: [...SELECT_OPTION_KINDS],
            });
        }
        if (stepArgs.kind !== componentKind) {
            return badArgs('step',
                `kind mismatch: args.kind=${stepArgs.kind} vs component.kind=${componentKind}`,
                { argsKind: stepArgs.kind, componentKind },
            );
        }
    } else {
        if (!SELECT_OPTION_KINDS.has(componentKind)) {
            return badArgs('step', `unsupported component kind: ${componentKind}`, {
                componentKind,
                allowedKinds: [...SELECT_OPTION_KINDS],
            });
        }
    }

    const kind = (stepArgs.kind || componentKind) as SelectOptionKind;

    return { kind, ref: controlRef, component };
};
