/**
 * recorder：负责在 Playwright Page 上安装录制脚本并接收事件。
 *
 * 依赖关系：
 * - 上游：recording.ts 调用 installRecorder
 * - 下游：payload bundle 注入脚本通过绑定回传事件
 *
 * 关键约束：
 * - 同一 Page 只安装一次，避免重复监听
 * - 事件会尽量携带 selector/语义提示，locatorCandidates 仅作辅助信息
 */
import type { Page } from 'playwright';
import type { LocatorCandidate, ScopeHint } from '../runner/locator_candidates';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installedPages = new WeakSet<Page>();
const bindingName = `__rpa_record__${Math.random().toString(36).slice(2, 8)}`;
const recordDir = path.dirname(fileURLToPath(import.meta.url));
const payloadDir = path.join(recordDir, 'payload');
const payloadBundlePath = path.join(recordDir, 'payload.bundle.js');

let payloadReady: Promise<void> | null = null;

const resolvePayloadInputs = () => {
    if (!fs.existsSync(payloadDir)) return [];
    const entries = fs.readdirSync(payloadDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const nested = path.join(payloadDir, entry.name);
            const nestedEntries = fs.readdirSync(nested, { withFileTypes: true });
            for (const nestedEntry of nestedEntries) {
                if (nestedEntry.isFile() && nestedEntry.name.endsWith('.ts')) {
                    files.push(path.join(nested, nestedEntry.name));
                }
            }
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            files.push(path.join(payloadDir, entry.name));
        }
    }
    return files;
};

const shouldBuildPayload = () => {
    if (!fs.existsSync(payloadBundlePath)) return true;
    const bundleStat = fs.statSync(payloadBundlePath);
    const inputs = resolvePayloadInputs();
    if (!inputs.length) return false;
    const newest = inputs.reduce((max, file) => {
        const stat = fs.statSync(file);
        return stat.mtimeMs > max ? stat.mtimeMs : max;
    }, 0);
    return newest > bundleStat.mtimeMs;
};

const ensurePayloadBundle = async () => {
    if (payloadReady) return payloadReady;
    payloadReady = (async () => {
        if (!shouldBuildPayload()) return;
        const esbuild = await import('esbuild');
        const entry = path.join(payloadDir, 'index.ts');
        await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            format: 'iife',
            platform: 'browser',
            target: ['es2018'],
            sourcemap: true,
            outfile: payloadBundlePath,
        });
    })();
    return payloadReady;
};

export type RecordedEventType =
    | 'click'
    | 'input'
    | 'change'
    | 'check'
    | 'select'
    | 'date'
    | 'keydown'
    | 'navigate'
    | 'scroll'
    | 'paste'
    | 'copy';

export type RecorderEvent = {
    tabToken: string;
    ts: number;
    type: RecordedEventType;
    recorderVersion?: string;
    url?: string;
    a11yNodeId?: string;
    a11yHint?: { role?: string; name?: string; text?: string };
    selector?: string;
    locatorCandidates?: LocatorCandidate[];
    scopeHint?: ScopeHint;
    targetHint?: string;
    value?: string;
    label?: string;
    checked?: boolean;
    inputType?: string;
    key?: string;
    scrollX?: number;
    scrollY?: number;
    source?: 'click' | 'direct';
    pageUrl?: string | null;
    pageTitle?: string;
    viewport?: { width: number; height: number };
};

/**
 * 在 Page 上安装录制脚本，并通过 binding 把事件转发回 Node 侧。
 */
export const installRecorder = async (page: Page, onEvent: (event: RecorderEvent) => void | Promise<void>) => {
    if (installedPages.has(page)) return;
    installedPages.add(page);

    await ensurePayloadBundle();

    try {
        await page.exposeBinding(bindingName, (source, event: RecorderEvent) => {
            onEvent({
                ...event,
                pageUrl: source.page?.url?.() || null,
            });
        });
    } catch {
        // ignore if binding already exists
    }

    await page.addInitScript({ content: `window.__rpa_recorder_binding = ${JSON.stringify(bindingName)};` });
    await page.addInitScript({ path: payloadBundlePath });
    for (const frame of page.frames()) {
        try {
            await frame.evaluate((name) => {
                (window as any).__rpa_recorder_binding = name;
            }, bindingName);
            await frame.addScriptTag({ path: payloadBundlePath });
        } catch {
            // ignore if frame is not ready or cross-origin
        }
    }
};
