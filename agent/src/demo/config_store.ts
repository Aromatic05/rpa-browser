import { promises as fs } from 'fs';
import path from 'path';

export type DemoConfig = {
    apiBase?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
};

const CONFIG_DIR = path.resolve(process.cwd(), '.rpa');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const ensureDir = async () => {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
};

export const readConfig = async (): Promise<DemoConfig> => {
    try {
        const raw = await fs.readFile(CONFIG_PATH, 'utf8');
        const data = JSON.parse(raw) as DemoConfig;
        return data || {};
    } catch {
        return {};
    }
};

export const writeConfig = async (next: DemoConfig): Promise<void> => {
    await ensureDir();
    const json = JSON.stringify(next, null, 2);
    await fs.writeFile(CONFIG_PATH, json, 'utf8');
    if (process.platform !== 'win32') {
        try {
            await fs.chmod(CONFIG_PATH, 0o600);
        } catch {
            // ignore chmod failures
        }
    }
};

export const maskApiKey = (apiKey?: string) => {
    if (!apiKey) return '';
    const tail = apiKey.slice(-4);
    return `${'*'.repeat(Math.max(0, apiKey.length - 4))}${tail}`;
};

export const getMaskedConfig = async (): Promise<DemoConfig> => {
    const cfg = await readConfig();
    return { ...cfg, apiKey: maskApiKey(cfg.apiKey) };
};

export const mergeConfig = (current: DemoConfig, patch: DemoConfig): DemoConfig => {
    const next: DemoConfig = { ...current };
    if (typeof patch.apiBase === 'string') next.apiBase = patch.apiBase;
    if (typeof patch.model === 'string') next.model = patch.model;
    if (typeof patch.temperature === 'number') next.temperature = patch.temperature;
    if (typeof patch.maxTokens === 'number') next.maxTokens = patch.maxTokens;
    if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) {
        next.apiKey = patch.apiKey;
    }
    return next;
};

export const getConfigPath = () => CONFIG_PATH;
