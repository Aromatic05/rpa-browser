import type { Checkpoint } from '../checkpoint/types';
import type { StepArgsMap, StepName, StepResolve } from '../steps/types';

export type SerializedStep<TName extends StepName = StepName> = {
    id: string;
    name: TName;
    args: StepArgsMap[TName];
};

export type SerializedStepUnion = {
    [Name in StepName]: SerializedStep<Name>;
}[StepName];

export type StepFile = {
    version: 1;
    steps: SerializedStepUnion[];
};

export type StepResolveFile = {
    version: 1;
    resolves: Record<string, StepResolve>;
};

export type CheckpointFile = {
    version: 1;
    checkpoints: Checkpoint[];
};

export type CheckpointHint = {
    why?: string;
    scope?: {
        businessTag?: string;
    };
    preferredEntityRules?: string[];
    fallbacks?: Array<{
        kind: string;
        text?: string;
        role?: string;
        name?: string;
        query?: string;
    }>;
    notes?: string[];
};

export type CheckpointHintFile = {
    version: 1;
    hints: Record<string, CheckpointHint>;
};

const CORE_FORBIDDEN_FIELDS = new Set(['resolve', 'hint', 'rawContext', 'locatorCandidates', 'replayHints', 'meta']);
const ACTION_STEP_NAMES = new Set([
    'browser.take_screenshot',
    'browser.click',
    'browser.fill',
    'browser.type',
    'browser.select_option',
    'browser.hover',
    'browser.scroll',
    'browser.press_key',
    'browser.drag_and_drop',
]);

export const validateStepFileForSerialization = (file: StepFile): void => {
    if (file.version !== 1) {
        throw new Error(`invalid step file version: ${String(file.version)}`);
    }
    if (!Array.isArray(file.steps)) {
        throw new Error('step file must contain a steps array');
    }
    for (const [index, step] of file.steps.entries()) {
        if (!step || typeof step !== 'object') {
            throw new Error('step entry must be an object');
        }
        if (!step.id || !step.name || !('args' in step)) {
            throw new Error('step entry must include id, name, and args');
        }
        if ('resolveId' in step) {
            throw new Error(`core yaml must not include steps[${index}].resolveId; use steps[${index}].args.resolveId instead`);
        }
        assertNoCoreHintFields(step, `steps[${index}]`);
        assertNoLegacyActionTargetFields(step, `steps[${index}]`);
    }
};

export const validateStepResolveFileForSerialization = (file: StepResolveFile): void => {
    if (file.version !== 1) {
        throw new Error(`invalid step resolve file version: ${String(file.version)}`);
    }
    if (!file.resolves || typeof file.resolves !== 'object' || Array.isArray(file.resolves)) {
        throw new Error('step resolve file must contain a resolves object');
    }
    for (const [resolveId, value] of Object.entries(file.resolves)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`step resolve ${resolveId} must be an object`);
        }
    }
};

export const validateCheckpointFileForSerialization = (file: CheckpointFile): void => {
    if (file.version !== 1) {
        throw new Error(`invalid checkpoint file version: ${String(file.version)}`);
    }
    if (!Array.isArray(file.checkpoints)) {
        throw new Error('checkpoint file must contain a checkpoints array');
    }
    for (const [index, checkpoint] of file.checkpoints.entries()) {
        if (!checkpoint || typeof checkpoint !== 'object') {
            throw new Error('checkpoint entry must be an object');
        }
        if (!checkpoint.id) {
            throw new Error('checkpoint entry must include id');
        }
        if (!checkpoint.trigger || !Array.isArray(checkpoint.trigger.matchRules)) {
            throw new Error(`checkpoint ${checkpoint.id} must use trigger.matchRules`);
        }
        if ('matchRules' in checkpoint) {
            throw new Error(`checkpoint ${checkpoint.id} must use trigger.matchRules`);
        }
        if (checkpoint.policy && 'trigger' in checkpoint.policy) {
            throw new Error(`checkpoint ${checkpoint.id} must keep trigger at checkpoint root`);
        }
        assertNoCoreHintFields(checkpoint, `checkpoints[${index}]`);
        assertCheckpointContentUsesSerializedStepShape(checkpoint, `checkpoints[${index}]`);
    }
};

const assertNoCoreHintFields = (value: unknown, currentPath: string): void => {
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            assertNoCoreHintFields(item, `${currentPath}[${index}]`);
        }
        return;
    }

    if (!value || typeof value !== 'object') {
        return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const nextPath = `${currentPath}.${key}`;
        if (CORE_FORBIDDEN_FIELDS.has(key)) {
            throw new Error(`core yaml must not include ${nextPath}`);
        }
        assertNoCoreHintFields(child, nextPath);
    }
};

const assertNoLegacyActionTargetFields = (step: { name: string; args: unknown }, currentPath: string): void => {
    if (!ACTION_STEP_NAMES.has(step.name)) {
        return;
    }
    if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
        return;
    }

    const args = step.args as Record<string, unknown>;
    if ('target' in args) {
        throw new Error(`core yaml must not include ${currentPath}.args.target`);
    }
    if ('id' in args) {
        throw new Error(`core yaml must not include ${currentPath}.args.id; use nodeId instead`);
    }
};

const assertCheckpointContentUsesSerializedStepShape = (checkpoint: Checkpoint, currentPath: string): void => {
    for (const [index, item] of (checkpoint.content || []).entries()) {
        if (!item || typeof item !== 'object' || !('name' in item)) {
            if (item && typeof item === 'object' && 'type' in item && (item as { type?: string }).type === 'act') {
                const step = (item as { step?: { name?: string; args?: unknown } }).step;
                if (step && typeof step === 'object') {
                    if ('resolveId' in step) {
                        throw new Error(
                            `core yaml must not include ${currentPath}.content[${index}].step.resolveId; use ${currentPath}.content[${index}].step.args.resolveId instead`,
                        );
                    }
                    assertNoCoreHintFields(step, `${currentPath}.content[${index}].step`);
                    assertNoLegacyActionTargetFields(
                        { name: String(step.name || ''), args: step.args },
                        `${currentPath}.content[${index}].step`,
                    );
                }
            }
            continue;
        }

        assertNoLegacyActionTargetFields(
            { name: String((item as { name?: string }).name || ''), args: (item as { args?: unknown }).args },
            `${currentPath}.content[${index}]`,
        );
    }
};
