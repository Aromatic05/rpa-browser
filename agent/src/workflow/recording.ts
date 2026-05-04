import path from 'node:path';
import type { StepUnion } from '../runner/steps/types';
import type { StepResolve } from '../runner/steps/types';
import type { StepFile, StepResolveFile } from '../runner/serialization/types';
import { validateStepFileForSerialization, validateStepResolveFileForSerialization } from '../runner/serialization/types';
import { listDirectories, readYamlFile, removePath, workflowRootDir, writeYamlFile } from './fs';
import type { WorkflowCodec } from './store';

export type WorkflowRecording = {
    kind: 'recording';
    name: string;
    recording: {
        version: 1;
        recordingName: string;
        workspaceName: string;
        entryUrl?: string;
        tabs?: Array<{ tabName: string; url?: string }>;
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
    is: (value: unknown): value is WorkflowRecording => {
        const rec = value as Partial<WorkflowRecording>;
        return !!rec && rec.kind === 'recording' && typeof rec.name === 'string' && !!rec.name;
    },
    load: (name) => {
        const dir = recordingDir(workflowName, name);
        try {
            const recording = readYamlFile<WorkflowRecording['recording']>(path.join(dir, 'recording.yaml'));
            const stepsFile = readYamlFile<StepFile>(path.join(dir, 'steps.yaml'));
            validateStepFileForSerialization(stepsFile);
            let stepResolves: Record<string, StepResolve> = {};
            try {
                const resolveFile = readYamlFile<StepResolveFile>(path.join(dir, 'step_resolve.yaml'));
                validateStepResolveFileForSerialization(resolveFile);
                stepResolves = resolveFile.resolves;
            } catch {}
            return { kind: 'recording', name, recording, steps: stepsFile.steps as StepUnion[], stepResolves };
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
        const stepsFile: StepFile = { version: 1, steps: value.steps.map((step) => ({ id: step.id, name: step.name, args: step.args })) as StepFile['steps'] };
        validateStepFileForSerialization(stepsFile);
        const stepResolveFile: StepResolveFile = { version: 1, resolves: value.stepResolves || {} };
        validateStepResolveFileForSerialization(stepResolveFile);
        writeYamlFile(path.join(dir, 'recording.yaml'), value.recording);
        writeYamlFile(path.join(dir, 'steps.yaml'), stepsFile);
        writeYamlFile(path.join(dir, 'step_resolve.yaml'), stepResolveFile);
        return value;
    },
    delete: (name) => {
        removePath(recordingDir(workflowName, name));
        return true;
    },
});
