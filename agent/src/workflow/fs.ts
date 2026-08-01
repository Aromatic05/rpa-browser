import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { WorkflowError } from './errors';

const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const requireArtifactName = (value: unknown, label = 'artifact name'): string => {
    if (typeof value !== 'string' || !ARTIFACT_NAME_PATTERN.test(value) || value === '.' || value === '..') {
        throw new WorkflowError(`invalid ${label}: ${String(value)}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    return value;
};

const defaultWorkflowsRootDir = (): string => path.resolve(process.cwd(), '.artifacts', 'workflows');

export const workflowsRootDir = (): string => {
    const configuredRoot = process.env.RPA_WORKFLOW_ROOT?.trim();
    return configuredRoot ? path.resolve(configuredRoot) : defaultWorkflowsRootDir();
};
export const workflowRootDir = (workflowName: string): string =>
    containedWorkflowRoot(workflowName);
export const workflowManifestPath = (workflowName: string): string => workflowArtifactPath(workflowName, 'workflow.yaml');

const containedWorkflowRoot = (workflowName: string): string => {
    const root = path.join(workflowsRootDir(), requireArtifactName(workflowName, 'workflow name'));
    assertContainedPath(workflowsRootDir(), root);
    return root;
};

export const workflowArtifactPath = (workflowName: string, ...parts: string[]): string => {
    const root = workflowRootDir(workflowName);
    const target = path.resolve(root, ...parts);
    assertContainedPath(root, target);
    return target;
};

const assertContainedPath = (root: string, target: string): void => {
    const lexicalRelative = path.relative(path.resolve(root), target);
    if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
        throw new WorkflowError(`workflow artifact path escapes root: ${target}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    let ancestor = target;
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {return;}
        ancestor = parent;
    }
    if (!fs.existsSync(root)) {return;}
    const canonicalRoot = fs.realpathSync(root);
    const canonicalAncestor = fs.realpathSync(ancestor);
    const canonicalRelative = path.relative(canonicalRoot, canonicalAncestor);
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
        throw new WorkflowError(`workflow artifact path escapes root: ${target}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
};

export const existsDir = (dirPath: string): boolean => {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
};

export const ensureDir = (dirPath: string): void => {
    fs.mkdirSync(dirPath, { recursive: true });
};

export const readTextFile = (filePath: string): string => fs.readFileSync(filePath, 'utf8');
export const writeTextFile = (filePath: string, content: string): void => {
    ensureDir(path.dirname(filePath));
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
        fs.writeFileSync(temporaryPath, content, 'utf8');
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        fs.rmSync(temporaryPath, {force: true});
        throw error;
    }
};

export const readYamlFile = (filePath: string): unknown => YAML.parse(readTextFile(filePath));
export const readValidatedYamlFile = <T>(
    filePath: string,
    validate: (value: T) => void,
): T => {
    const value = readYamlFile(filePath) as T;
    validate(value);
    return value;
};
export const writeYamlFile = (filePath: string, value: unknown): void => {
    writeTextFile(filePath, YAML.stringify(value));
};

export const removePath = (targetPath: string): void => {
    fs.rmSync(targetPath, { recursive: true, force: true });
};

export const listDirectories = (root: string): string[] => {
    if (!existsDir(root)) {
        return [];
    }
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
};
