import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../../logging/logger';

export type CdpLaunchOptions = {
    port: number;
    userDataDir: string;
    chromePath?: string;
    startUrl?: string;
    extensionPaths?: string[];
    logger?: (...args: unknown[]) => void;
    timeoutMs?: number;
    onExit?: (code: number | null, signal: string | null) => void;
};

export type CdpLaunchResult = {
    endpoint: string;
    stop: () => Promise<void>;
    pid: number;
    stderr: () => string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));


export type BrowserProfileOwner = {
    pid: number;
    alive: boolean;
    lockTarget: string;
};

const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

export const readBrowserProfileOwner = (userDataDir: string): BrowserProfileOwner | null => {
    const lockPath = path.join(userDataDir, 'SingletonLock');
    let lockTarget: string;
    try {
        lockTarget = fs.readlinkSync(lockPath);
    } catch {
        return null;
    }
    const match = lockTarget.match(/-(\d+)$/);
    if (!match) {return null;}
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) {return null;}
    return {pid, alive: isProcessAlive(pid), lockTarget};
};

const clearStaleBrowserProfileLocks = (userDataDir: string): void => {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try {fs.rmSync(path.join(userDataDir, name), {force: true});} catch { /* ignore stale lock cleanup */ }
    }
};

const managedChromeProcesses = new Set<ReturnType<typeof spawn>>();
let agentExitHookInstalled = false;

const registerManagedChromeProcess = (proc: ReturnType<typeof spawn>) => {
    managedChromeProcesses.add(proc);
    if (!agentExitHookInstalled) {
        agentExitHookInstalled = true;
        process.once('exit', () => {
            for (const child of managedChromeProcesses) {
                if (child.exitCode === null) {
                    try { child.kill('SIGKILL'); } catch { /* ignore */ }
                }
            }
        });
    }
};

const defaultChromeCandidates = () => {
    if (process.platform === 'linux') {
        return ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ];
    }
    if (process.platform === 'win32') {
        return [
            'C:\\Program Files\\Chromium\\Application\\chromium.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chromium.exe',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
    }
    return ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
};

const resolveCommandPath = (command: string): string | null => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(probe, [command], { encoding: 'utf8' });
    if (result.status !== 0) {return null;}
    const first = result.stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean);
    return first || null;
};

export const resolveChromeExecutable = (explicitPath?: string): string => {
    if (explicitPath?.trim()) {return explicitPath.trim();}
    const fromEnv = process.env.RPA_CDP_CHROME_PATH?.trim();
    if (fromEnv) {return fromEnv;}
    const candidates = defaultChromeCandidates();
    const unavailable: string[] = [];
    for (const candidate of candidates) {
        if (candidate.includes(path.sep)) {
            if (fs.existsSync(candidate)) {return candidate;}
            unavailable.push(candidate);
            continue;
        }
        const resolved = resolveCommandPath(candidate);
        if (resolved) {return resolved;}
        unavailable.push(candidate);
    }
    throw new Error(`No Chrome/Chromium executable found. Tried: ${unavailable.join(', ')}`);
};

const waitForCdpReady = async (endpoint: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/version`);
            if (response.ok) {return;}
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
    const startUrl = opts.startUrl?.trim() || process.env.RPA_START_URL?.trim() || 'chrome://newtab/';
    fs.mkdirSync(opts.userDataDir, { recursive: true });
    const profileOwner = readBrowserProfileOwner(opts.userDataDir);
    if (profileOwner?.alive) {
        throw new Error(
            `CDP browser profile is already in use by Chrome pid ${String(profileOwner.pid)}: ${opts.userDataDir}`,
        );
    }
    if (profileOwner && !profileOwner.alive) {
        clearStaleBrowserProfileLocks(opts.userDataDir);
    }

    const args = [
        `--remote-debugging-port=${opts.port}`,
        `--user-data-dir=${opts.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--enable-unsafe-extension-debugging',
        startUrl,
    ];
    const extensionPaths = (opts.extensionPaths || []).filter(Boolean);
    if (extensionPaths.length > 0) {
        const extensionArg = extensionPaths.join(',');
        args.unshift(`--load-extension=${extensionArg}`);
        args.unshift(`--disable-extensions-except=${extensionArg}`);
    }
    opts.logger?.('cdp.launch.start', { chromePath, endpoint, userDataDir: opts.userDataDir });
    const infraLog = getLogger('infra');
    const proc = spawn(chromePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });

    registerManagedChromeProcess(proc);

    proc.on('exit', (code, signal) => {
        managedChromeProcesses.delete(proc);
        const isError = code !== 0 && code !== null;
        infraLog.warning('[RPA:infra]', 'Chrome process exited', {
            pid: proc.pid,
            exitCode: code,
            signal: signal || null,
            isError,
            stderrTail: stderr.slice(-2000) || null,
        });
        opts.onExit?.(code, signal);
    });

    const stop = async () =>
        { await new Promise<void>((resolve) => {
            if (proc.exitCode !== null) {resolve(); return;}
            proc.once('exit', () => { resolve(); });
            proc.kill('SIGTERM');
            setTimeout(() => {
                if (proc.exitCode === null) {proc.kill('SIGKILL');}
            }, 3000);
        }); };

    try {
        await Promise.race([
            waitForCdpReady(endpoint, timeoutMs),
            new Promise<never>((_resolve, reject) => {
                proc.once('exit', (code, signal) => {
                    reject(new Error(
                        `Chrome exited before CDP became ready: code=${String(code)} signal=${String(signal)}`,
                    ));
                });
            }),
        ]);
        opts.logger?.('cdp.launch.ready', { endpoint, pid: proc.pid });
    } catch (error) {
        await stop();
        const message = error instanceof Error ? error.message : String(error);
        const detail = stderr.trim();
        throw new Error(detail ? `${message} (${detail})` : message, { cause: error });
    }

    return {
        endpoint,
        stop,
        pid: proc.pid ?? -1,
        stderr: () => stderr,
    };
};
