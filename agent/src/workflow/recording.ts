import path from 'node:path';
import type { StepUnion } from '../runner/steps/types';
import type { StepResolve } from '../runner/steps/types';
import type { StepFile, StepResolveFile } from '../runner/serialization/types';
import { validateStepFileForSerialization, validateStepResolveFileForSerialization } from '../runner/serialization/types';
import { listDirectories, readValidatedYamlFile, readYamlFile, removePath, workflowRootDir, writeYamlFile } from './fs';
import type { WorkflowCodec } from './store';

export type WorkflowRecording = {
    kind: 'recording';
    name: string;
    recording: {
        version: 1;
        recordingName: string;
        workspaceName: string;
        entryUrl?: string;
        activeTabRef: string;
        initialTabs: Array<{ tabName: string; tabRef: string; url: string; title: string; active: boolean }>;
        tabs: Array<{ tabName: string; url?: string }>;
        createdAt?: number;
        stepCount?: number;
    };
    steps: StepUnion[];
    stepResolves: Record<string, StepResolve>;
};

const recordingDir = (workflowName: string, recordingName: string): string =>
    path.join(workflowRootDir(workflowName), 'recordings', recordingName);

export const createRecordingCodec = (workflowName: string): WorkflowCodec<WorkflowRecording> => ({
    kind: 'recording',
    is: (value: unknown): value is WorkflowRecording =>
        isRecord(value) && value.kind === 'recording' && typeof value.name === 'string' && value.name.length > 0,
    load: (name) => {
        const dir = recordingDir(workflowName, name);
        try {
            const recording = parseRecordingMetadata(readYamlFile(path.join(dir, 'recording.yaml')));
            const stepsFile = readValidatedYamlFile<StepFile>(
                path.join(dir, 'steps.yaml'),
                validateStepFileForSerialization,
            );
            let stepResolves: Record<string, StepResolve> = {};
            try {
                const resolveFile = readValidatedYamlFile<StepResolveFile>(
                    path.join(dir, 'step_resolve.yaml'),
                    validateStepResolveFileForSerialization,
                );
                stepResolves = resolveFile.resolves;
            } catch {
                // Optional sidecar: absence or invalid content falls back to no resolves.
            }
            return { kind: 'recording', name, recording, steps: stepsFile.steps, stepResolves };
        } catch {
            return null;
        }
    },
    list: () =>
        listDirectories(path.join(workflowRootDir(workflowName), 'recordings'))
            .map((name) => createRecordingCodec(workflowName).load(name))
            .filter((item): item is WorkflowRecording => item !== null),
    save: (value) => {
        const dir = recordingDir(workflowName, value.name);
        const stepsFile: StepFile = {
            version: 1,
            steps: value.steps.map((step) => ({
                id: step.id,
                name: step.name,
                args: step.args,
                entityRules: step.entityRules,
            })) as StepFile['steps'],
        };
        validateStepFileForSerialization(stepsFile);
        const stepResolveFile: StepResolveFile = { version: 1, resolves: value.stepResolves };
        validateStepResolveFileForSerialization(stepResolveFile);
        writeYamlFile(path.join(dir, 'recording.yaml'), value.recording);
        writeYamlFile(path.join(dir, 'steps.yaml'), stepsFile);
        if (process.env.RPA_RECORD_DEBUG_STEPS === '1') {
            writeYamlFile(path.join(dir, 'steps.debug.yaml'), {
                version: 1,
                steps: value.steps,
            });
        }
        writeYamlFile(path.join(dir, 'step_resolve.yaml'), stepResolveFile);
        return value;
    },
    delete: (name) => {
        removePath(recordingDir(workflowName, name));
        return true;
    },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseRecordingMetadata = (value: unknown): WorkflowRecording['recording'] => {
    if (!isRecord(value) || value.version !== 1 || typeof value.recordingName !== 'string'
        || typeof value.workspaceName !== 'string' || typeof value.activeTabRef !== 'string'
        || !Array.isArray(value.initialTabs) || !Array.isArray(value.tabs)) {
        throw new Error('invalid recording metadata');
    }
    return value as WorkflowRecording['recording'];
};
