import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type CdpLaunchOptions = {
    port: number;
    userDataDir: string;
    chromePath?: string;
    extensionPaths?: string[];
    enterprisePolicyDir?: string;
    logger?: (...args: unknown[]) => void;
    timeoutMs?: number;
};

export type CdpLaunchResult = {
    endpoint: string;
    stop: () => Promise<void>;
    pid: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultChromeCandidates = () => {
    if (process.platform === 'linux') {
        return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ];
    }
    if (process.platform === 'win32') {
        return [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
    }
    return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
};

const resolveChromeExecutable = (explicitPath?: string) => {
    if (explicitPath?.trim()) return explicitPath.trim();
    const fromEnv = process.env.RPA_CDP_CHROME_PATH?.trim();
    if (fromEnv) return fromEnv;
    const candidates = defaultChromeCandidates();
    for (const candidate of candidates) {
        if (candidate.includes(path.sep)) {
            if (fs.existsSync(candidate)) return candidate;
            continue;
        }
        return candidate;
    }
    return candidates[0];
};

const waitForCdpReady = async (endpoint: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/version`);
            if (response.ok) return;
        } catch {
            // ignore retry errors
        }
        await sleep(250);
    }
    throw new Error(`CDP endpoint not ready: ${endpoint}`);
};

export const launchLocalChromeForCdp = async (opts: CdpLaunchOptions): Promise<CdpLaunchResult> => {
    const timeoutMs = opts.timeoutMs ?? 20000;
    const endpoint = `http://127.0.0.1:${opts.port}`;
    const chromePath = resolveChromeExecutable(opts.chromePath);
    fs.mkdirSync(opts.userDataDir, { recursive: true });

    const args = [
        `--remote-debugging-port=${opts.port}`,
        `--user-data-dir=${opts.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'chrome://newtab',
    ];
    const extensionPaths = (opts.extensionPaths || []).filter(Boolean);
    if (extensionPaths.length > 0) {
        const extensionArg = extensionPaths.join(',');
        args.unshift(`--load-extension=${extensionArg}`);
        args.unshift(`--disable-extensions-except=${extensionArg}`);
    }
    if (opts.enterprisePolicyDir?.trim()) {
        args.unshift(`--enterprise-policy-path=${opts.enterprisePolicyDir.trim()}`);
    }
    opts.logger?.('cdp.launch.start', { chromePath, endpoint, userDataDir: opts.userDataDir });
    const proc = spawn(chromePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
    });

    const stop = async () =>
        new Promise<void>((resolve) => {
            if (proc.exitCode != null || proc.killed) return resolve();
            proc.once('exit', () => resolve());
            proc.kill('SIGTERM');
            setTimeout(() => {
                if (proc.exitCode == null) proc.kill('SIGKILL');
            }, 3000);
        });

    try {
        await waitForCdpReady(endpoint, timeoutMs);
        opts.logger?.('cdp.launch.ready', { endpoint, pid: proc.pid });
    } catch (error) {
        await stop();
        const message = error instanceof Error ? error.message : String(error);
        const detail = stderr.trim();
        throw new Error(detail ? `${message} (${detail})` : message);
    }

    return {
        endpoint,
        stop,
        pid: proc.pid ?? -1,
    };
};
