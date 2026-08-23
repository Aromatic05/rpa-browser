import fs from 'node:fs';
import path from 'node:path';
import type { StepUnion } from '../runner/steps/types';
import type { StepResolve } from '../runner/steps/types';
import type { StepFile, StepResolveFile } from '../runner/serialization/types';
import { validateStepFileForSerialization, validateStepResolveFileForSerialization } from '../runner/serialization/types';
import { listDirectories, readValidatedYamlFile, readYamlFile, removePath, requireArtifactName, workflowArtifactPath, writeYamlFile } from './fs';
import { invalidWorkflowArtifact } from './errors';
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
    workflowArtifactPath(workflowName, 'recordings', requireArtifactName(recordingName, 'recording name'));

export const createRecordingCodec = (workflowName: string): WorkflowCodec<WorkflowRecording> => ({
    kind: 'recording',
    is: (value: unknown): value is WorkflowRecording =>
        isRecord(value) && value.kind === 'recording' && typeof value.name === 'string' && isArtifactName(value.name),
    load: (name) => {
        const dir = recordingDir(workflowName, name);
        if (!fs.existsSync(dir)) {return null;}
        try {
            const recording = parseRecordingMetadata(readYamlFile(path.join(dir, 'recording.yaml')));
            assertRecordingIdentity(recording, name);
            const stepsFile = readValidatedYamlFile<StepFile>(
                path.join(dir, 'steps.yaml'),
                validateStepFileForSerialization,
            );
            const resolveFile = readOptionalResolveFile(path.join(dir, 'step_resolve.yaml'));
            const stepResolves = resolveFile?.resolves ?? {};
            return { kind: 'recording', name, recording, steps: stepsFile.steps, stepResolves };
        } catch (error) {
            throw invalidWorkflowArtifact('recording', name, error);
        }
    },
    list: () =>
        listDirectories(workflowArtifactPath(workflowName, 'recordings'))
            .filter(isArtifactName)
            .map((name) => createRecordingCodec(workflowName).load(name))
            .filter((item): item is WorkflowRecording => item !== null),
    save: (value) => {
        const recording = parseRecordingMetadata(structuredClone(value.recording));
        assertRecordingIdentity(recording, value.name);
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
        writeYamlFile(path.join(dir, 'recording.yaml'), recording);
        writeYamlFile(path.join(dir, 'steps.yaml'), stepsFile);
        if (process.env.RPA_RECORD_DEBUG_STEPS === '1') {
            writeYamlFile(path.join(dir, 'steps.debug.yaml'), {
                version: 1,
                steps: value.steps,
            });
        }
        writeYamlFile(path.join(dir, 'step_resolve.yaml'), stepResolveFile);
        return {...value, recording, stepResolves: stepResolveFile.resolves};
    },
    delete: (name) => {
        removePath(recordingDir(workflowName, name));
        return true;
    },
});

const readOptionalResolveFile = (filePath: string): StepResolveFile | null => {
    try {
        return readValidatedYamlFile<StepResolveFile>(filePath, validateStepResolveFileForSerialization);
    } catch (error) {
        if (isMissingFile(error)) {return null;}
        throw error;
    }
};

const isMissingFile = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const isArtifactName = (name: string): boolean => {
    try {
        requireArtifactName(name, 'recording name');
        return true;
    } catch {
        return false;
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseRecordingMetadata = (value: unknown): WorkflowRecording['recording'] => {
    if (!isRecord(value) || value.version !== 1 || typeof value.recordingName !== 'string'
        || typeof value.workspaceName !== 'string' || typeof value.activeTabRef !== 'string'
        || !Array.isArray(value.initialTabs) || !Array.isArray(value.tabs)) {
        throw new Error('invalid recording metadata');
    }
    if (!value.recordingName.trim() || !value.workspaceName.trim() || !value.activeTabRef.trim()) {
        throw new Error('invalid recording metadata identity');
    }
    if (!value.initialTabs.every(isInitialTabMetadata) || !value.tabs.every(isTabMetadata)) {
        throw new Error('invalid recording tab metadata');
    }
    if (value.entryUrl !== undefined && typeof value.entryUrl !== 'string') {
        throw new Error('invalid recording entryUrl');
    }
    if (value.createdAt !== undefined && (
        typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0
    )) {
        throw new Error('invalid recording createdAt');
    }
    if (value.stepCount !== undefined && (
        typeof value.stepCount !== 'number' || !Number.isInteger(value.stepCount) || value.stepCount < 0
    )) {
        throw new Error('invalid recording stepCount');
    }
    return value as WorkflowRecording['recording'];
};

const assertRecordingIdentity = (
    recording: WorkflowRecording['recording'],
    artifactName: string,
): void => {
    if (recording.recordingName !== artifactName) {
        throw new Error(
            `recording identity mismatch: artifact=${artifactName} recording.recordingName=${recording.recordingName}`,
        );
    }
};

const isInitialTabMetadata = (value: unknown): boolean => isRecord(value)
    && typeof value.tabName === 'string' && value.tabName.trim().length > 0
    && typeof value.tabRef === 'string' && value.tabRef.trim().length > 0
    && typeof value.url === 'string'
    && typeof value.title === 'string'
    && typeof value.active === 'boolean';

const isTabMetadata = (value: unknown): boolean => isRecord(value)
    && typeof value.tabName === 'string' && value.tabName.trim().length > 0
    && (value.url === undefined || typeof value.url === 'string');
