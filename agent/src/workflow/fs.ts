import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const DEFAULT_ARTIFACTS_ROOT = path.resolve(process.cwd(), '.artifacts');

export const workflowsRootDir = (): string => path.join(DEFAULT_ARTIFACTS_ROOT, 'workflows');
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

export const readYamlFile = <T>(filePath: string): T => YAML.parse(readTextFile(filePath)) as T;
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
