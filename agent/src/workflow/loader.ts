import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { validateWorkflowManifest, validateWorkflowWorkspaceBinding } from './schema';
import type { WorkflowCheckpointEntry, WorkflowLoadResult } from './types';

const DEFAULT_WORKFLOWS_DIR = path.resolve(process.cwd(), 'agent/.artifacts/workflows');

const isPathInside = (rootDir: string, targetPath: string): boolean => {
    const rel = path.relative(rootDir, targetPath);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const resolveWorkflowPath = (rootDir: string, relativePath: string, scene: string): string => {
    const absolute = path.resolve(rootDir, relativePath);
    if (!isPathInside(rootDir, absolute)) {
        throw new DslRuntimeError(
            `workflow path escape: scene=${scene} root=${rootDir} rel=${relativePath}`,
            'ERR_WORKFLOW_PATH_ESCAPE',
        );
    }
    return absolute;
};

const readYamlFile = (filePath: string): unknown => YAML.parse(fs.readFileSync(filePath, 'utf8'));

const extractCheckpointId = (checkpointDirRelative: string): string => {
    const normalized = checkpointDirRelative.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
};

export const loadWorkflow = (scene: string, workflowsDir = DEFAULT_WORKFLOWS_DIR): WorkflowLoadResult => {
    const rootDir = path.resolve(workflowsDir, scene);
    const manifestPath = path.resolve(rootDir, 'workflow.yaml');
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
        throw new DslRuntimeError(
            `workflow scene not found: scene=${scene} root=${rootDir}`,
            'ERR_WORKFLOW_NOT_FOUND',
        );
    }
    if (!fs.existsSync(manifestPath)) {
        throw new DslRuntimeError(
            `workflow manifest not found: scene=${scene} root=${rootDir} path=workflow.yaml`,
            'ERR_WORKFLOW_NOT_FOUND',
        );
    }

    const manifestRaw = readYamlFile(manifestPath);
    const validatedManifest = validateWorkflowManifest(manifestRaw);
    if (!validatedManifest.ok) {
        throw new DslRuntimeError(
            `workflow manifest invalid: scene=${scene} root=${rootDir} diagnostics=${validatedManifest.diagnostics.join('; ')}`,
            'ERR_WORKFLOW_INVALID_MANIFEST',
        );
    }
    const manifest = validatedManifest.value;

    const dslPath = resolveWorkflowPath(rootDir, manifest.entry.dsl, scene);
    if (!fs.existsSync(dslPath)) {
        throw new DslRuntimeError(
            `workflow dsl entry not found: scene=${scene} root=${rootDir} rel=${manifest.entry.dsl}`,
            'ERR_WORKFLOW_DSL_NOT_FOUND',
        );
    }
    const dslSource = fs.readFileSync(dslPath, 'utf8');

    let inputsPath: string | undefined;
    let inputsExample: unknown;
    if (manifest.entry.inputs) {
        inputsPath = resolveWorkflowPath(rootDir, manifest.entry.inputs, scene);
        if (fs.existsSync(inputsPath)) {
            try {
                inputsExample = readYamlFile(inputsPath);
            } catch (error) {
                throw new DslRuntimeError(
                    `workflow inputs invalid: scene=${scene} root=${rootDir} rel=${manifest.entry.inputs} error=${error instanceof Error ? error.message : String(error)}`,
                    'ERR_WORKFLOW_INPUTS_INVALID',
                );
            }
        }
    }

    let workspaceBindingPath: string | undefined;
    let workspaceBinding;
    if (manifest.workspace?.binding) {
        workspaceBindingPath = resolveWorkflowPath(rootDir, manifest.workspace.binding, scene);
        if (!fs.existsSync(workspaceBindingPath)) {
            throw new DslRuntimeError(
                `workflow workspace binding not found: scene=${scene} root=${rootDir} rel=${manifest.workspace.binding}`,
                'ERR_WORKFLOW_WORKSPACE_BINDING_INVALID',
            );
        }
        const workspaceRaw = readYamlFile(workspaceBindingPath);
        const validatedBinding = validateWorkflowWorkspaceBinding(workspaceRaw);
        if (!validatedBinding.ok) {
            throw new DslRuntimeError(
                `workflow workspace binding invalid: scene=${scene} root=${rootDir} rel=${manifest.workspace.binding} diagnostics=${validatedBinding.diagnostics.join('; ')}`,
                'ERR_WORKFLOW_WORKSPACE_BINDING_INVALID',
            );
        }
        workspaceBinding = validatedBinding.value;
    }

    const records = (manifest.records || []).map((item) => {
        const recordsDir = resolveWorkflowPath(rootDir, item, scene);
        if (!fs.existsSync(recordsDir) || !fs.statSync(recordsDir).isDirectory()) {
            throw new DslRuntimeError(
                `workflow record not found: scene=${scene} root=${rootDir} rel=${item}`,
                'ERR_WORKFLOW_RECORD_NOT_FOUND',
            );
        }
        const stepsPath = path.join(recordsDir, 'steps.yaml');
        if (!fs.existsSync(stepsPath)) {
            throw new DslRuntimeError(
                `workflow record steps not found: scene=${scene} root=${rootDir} rel=${item}/steps.yaml`,
                'ERR_WORKFLOW_RECORD_NOT_FOUND',
            );
        }
        return item;
    });

    const checkpoints: WorkflowCheckpointEntry[] = (manifest.checkpoints || []).map((item) => {
        const checkpointDir = resolveWorkflowPath(rootDir, item, scene);
        if (!fs.existsSync(checkpointDir) || !fs.statSync(checkpointDir).isDirectory()) {
            throw new DslRuntimeError(
                `workflow checkpoint directory not found: scene=${scene} root=${rootDir} rel=${item}`,
                'ERR_WORKFLOW_CHECKPOINT_NOT_FOUND',
            );
        }
        const checkpointPath = path.join(checkpointDir, 'checkpoint.yaml');
        if (!fs.existsSync(checkpointPath)) {
            throw new DslRuntimeError(
                `workflow checkpoint file not found: scene=${scene} root=${rootDir} rel=${item}/checkpoint.yaml`,
                'ERR_WORKFLOW_CHECKPOINT_NOT_FOUND',
            );
        }
        return {
            id: extractCheckpointId(item),
            directory: item,
            checkpointPath,
            checkpointResolvePath: path.join(checkpointDir, 'checkpoint_resolve.yaml'),
            checkpointHintsPath: path.join(checkpointDir, 'checkpoint_hints.yaml'),
        };
    });

    return {
        scene,
        rootDir,
        manifestPath,
        manifest,
        dslPath,
        dslSource,
        inputsPath,
        inputsExample,
        workspaceBindingPath,
        workspaceBinding,
        records,
        checkpoints,
    };
};
