import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const defaultWorkflowsRootDir = (): string => path.resolve(process.cwd(), '.artifacts', 'workflows');

export const workflowsRootDir = (): string => {
    const configuredRoot = process.env.RPA_WORKFLOW_ROOT?.trim();
    return configuredRoot ? path.resolve(configuredRoot) : defaultWorkflowsRootDir();
};
export const workflowRootDir = (workflowName: string): string => path.join(workflowsRootDir(), workflowName);
export const workflowManifestPath = (workflowName: string): string => path.join(workflowRootDir(workflowName), 'workflow.yaml');

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
    fs.writeFileSync(filePath, content, 'utf8');
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
