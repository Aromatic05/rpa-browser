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
    const { targetNode, snapshot, stepArgs } = input;

    if (!targetNode) {
        return notFound('step', 'target node not found in snapshot');
    }

    const controlRef: string | undefined = targetNode.control?.ref;

    if (!controlRef) {
        return notFound('step', 'no controlRef available from target node', {
            nodeId: targetNode.id,
            nodeRole: targetNode.role,
        });
    }

    if (!snapshot.controlIndex) {
        return notFound('step', 'snapshot missing controlIndex');
    }

    const component = snapshot.controlIndex[controlRef];
    if (!component) {
        return notFound('step', 'controlRef not found in controlIndex', { controlRef });
    }

    if (component.owner !== 'browser.select_option') {
        return badArgs('step', 'control owner is not browser.select_option', {
            owner: component.owner,
            controlRef,
        });
    }

    if (!component.capabilities.includes('select_option')) {
        return badArgs('step', 'control does not have select_option capability', {
            capabilities: component.capabilities,
            controlRef,
        });
    }

    const componentKind = component.kind;

    if (!SELECT_OPTION_KINDS.has(componentKind)) {
        return badArgs('step', `unsupported component kind: ${componentKind}`, {
            componentKind,
            allowedKinds: [...SELECT_OPTION_KINDS],
        });
    }

    const kind = componentKind as SelectOptionKind;
    if (stepArgs.kind !== kind) {
        return badArgs('step', 'select_option kind mismatch between step args and runtime control', {
            expectedKind: stepArgs.kind,
            actualKind: kind,
            controlRef,
            targetNodeId: targetNode.id,
        });
    }

    return { kind, ref: controlRef, component };
};
