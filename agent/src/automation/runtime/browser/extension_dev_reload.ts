import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, {type FSWatcher} from 'chokidar';
import type {BrowserContext, CDPSession, Page, Worker} from 'playwright';
import {getLogger} from '../../../platform/logging/logger';

export type ExtensionBuildInfo = {
    buildId: string;
    builtAt?: string;
};

export type ExtensionDevReloader = {
    close: () => Promise<void>;
};

export type ExtensionDevReloaderOptions = {
    stampPath: string;
    extensionPaths: string[];
    workspaceName: string;
    getContext: () => Promise<BrowserContext>;
    configureMainExtension: (context: BrowserContext) => Promise<void>;
    startUrl: () => string;
    onError?: (error: unknown) => void;
};

type DevRuntimeResult = {
    buildId: string;
    tabCount: number;
    snapshot: {
        tabs: Array<Record<string, unknown>>;
        bindings: Array<Record<string, unknown>>;
        activeChromeTabNo: number | null;
        activeWindowId: number | null;
    };
};

type ExtensionInfo = {
    id: string;
    name: string;
    version: string;
    path: string;
    enabled: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const readBuildInfo = async (stampPath: string): Promise<ExtensionBuildInfo> => {
    const raw = await fs.readFile(stampPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ExtensionBuildInfo>;
    const buildId = typeof parsed.buildId === 'string' ? parsed.buildId.trim() : '';
    if (!buildId) {throw new Error(`extension build stamp has no buildId: ${stampPath}`);}
    return {buildId, ...(typeof parsed.builtAt === 'string' ? {builtAt: parsed.builtAt} : {})};
};

const canonicalPath = (value: string): string => path.resolve(value);

const workerBuildId = async (worker: Worker): Promise<string | null> => {
    try {
        return await worker.evaluate(() => {
            const manifest = (globalThis as typeof globalThis & {
                chrome: {runtime: {getManifest: () => {version: string; version_name?: string}}};
            }).chrome.runtime.getManifest();
            return manifest.version_name || manifest.version || null;
        });
    } catch {
        return null;
    }
};

const resolveMainWorker = async (context: BrowserContext, expectedBuildId?: string): Promise<Worker> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        for (const worker of context.serviceWorkers()) {
            if (!worker.url().includes('/entry/sw.js')) {continue;}
            if (!expectedBuildId || await workerBuildId(worker) === expectedBuildId) {return worker;}
        }
        await sleep(100);
    }
    throw new Error(expectedBuildId
        ? `main extension service worker did not reach build ${expectedBuildId}`
        : 'main extension service worker unavailable');
};

const prepareMainExtensionReload = async (worker: Worker): Promise<DevRuntimeResult> =>
    await worker.evaluate(async () => {
        const bridge = (globalThis as typeof globalThis & {
            __rpaDevRuntime?: {
                buildId: string;
                prepareReload: () => Promise<DevRuntimeResult>;
            };
        }).__rpaDevRuntime;
        if (!bridge) {
            throw new Error('extension development reload bridge is unavailable; restart pnpm dev:cdp once');
        }
        return await bridge.prepareReload();
    });

const sendCdp = async <T>(
    session: CDPSession,
    method: string,
    params?: Record<string, unknown>,
): Promise<T> => await (session as unknown as {
    send: (method: string, params?: Record<string, unknown>) => Promise<T>;
}).send(method, params);

const getExtensions = async (session: CDPSession): Promise<ExtensionInfo[]> => {
    const result = await sendCdp<{extensions?: ExtensionInfo[]}>(session, 'Extensions.getExtensions');
    return result.extensions || [];
};

const findExtensionByPath = (
    extensions: ExtensionInfo[],
    extensionPath: string,
): ExtensionInfo | null => {
    const expectedPath = canonicalPath(extensionPath);
    return extensions.find((extension) => canonicalPath(extension.path) === expectedPath) ?? null;
};

const loadExtensionPaths = async (
    session: CDPSession,
    extensionPaths: string[],
): Promise<Array<{path: string; id: string}>> => {
    const loaded: Array<{path: string; id: string}> = [];
    for (const extensionPath of extensionPaths) {
        const resolvedPath = canonicalPath(extensionPath);
        const result = await sendCdp<{id?: string}>(session, 'Extensions.loadUnpacked', {path: resolvedPath});
        if (!result.id) {throw new Error(`CDP did not return an extension id for ${resolvedPath}`);}
        loaded.push({path: resolvedPath, id: result.id});
    }
    return loaded;
};

const verifyLoadedExtensions = async (
    session: CDPSession,
    loaded: Array<{path: string; id: string}>,
): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const infos = await getExtensions(session);
        const ready = loaded.every((item) => infos.some((info) =>
            info.id === item.id &&
            canonicalPath(info.path) === item.path &&
            info.enabled,
        ));
        if (ready) {return;}
        await sleep(100);
    }
    const infos = await getExtensions(session);
    throw new Error(`extensions were not enabled after CDP reload: ${JSON.stringify(infos)}`);
};

const shouldReloadPage = (page: Page): boolean => {
    if (page.isClosed()) {return false;}
    try {
        const protocol = new URL(page.url()).protocol;
        return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
    } catch {
        return false;
    }
};

const reloadContentPages = async (context: BrowserContext): Promise<Page[]> => {
    const reloaded: Page[] = [];
    for (const page of context.pages()) {
        if (!shouldReloadPage(page)) {continue;}
        await page.reload({waitUntil: 'domcontentloaded', timeout: 15_000});
        reloaded.push(page);
    }
    return reloaded;
};

const expectedBadge = (buildId: string): string =>
    `#${buildId.includes('-') ? buildId.slice(buildId.lastIndexOf('-') + 1) : buildId}`;

const verifyContentPageBuild = async (page: Page, buildId: string): Promise<void> => {
    const badge = expectedBadge(buildId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (page.isClosed()) {throw new Error(`content page closed while verifying build ${buildId}`);}
        const value = await page.evaluate(() =>
            document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.build-id')?.textContent.trim() || '',
        );
        if (value === badge) {return;}
        await sleep(100);
    }
    throw new Error(`content page did not load extension build ${buildId}: ${page.url()}`);
};

const restoreNewTabPages = async (
    context: BrowserContext,
    mainExtensionId: string,
    startUrl: string,
    buildId: string,
): Promise<number> => {
    const candidates = context.pages().filter((page) => {
        const url = page.url();
        return url === 'chrome://new-tab-page/' ||
            url.startsWith('chrome://newtab/') ||
            url.startsWith(`chrome-extension://${mainExtensionId}/`);
    });
    let restored = 0;
    for (const page of candidates) {
        if (page.isClosed()) {continue;}
        if (!page.url().startsWith(`chrome-extension://${mainExtensionId}/`)) {
            await page.goto(startUrl, {waitUntil: 'domcontentloaded', timeout: 15_000});
        } else {
            await page.reload({waitUntil: 'domcontentloaded', timeout: 15_000});
        }
        const activeBuildId = await page.evaluate(() => {
            const manifest = (globalThis as typeof globalThis & {
                chrome: {runtime: {getManifest: () => {version: string; version_name?: string}}};
            }).chrome.runtime.getManifest();
            return manifest.version_name || manifest.version;
        });
        if (activeBuildId !== buildId) {
            throw new Error(`newtab page is build ${activeBuildId}, expected ${buildId}`);
        }
        restored += 1;
    }
    return restored;
};

export const reloadExtensionsForBuild = async (
    options: ExtensionDevReloaderOptions,
    buildInfo: ExtensionBuildInfo,
): Promise<void> => {
    const log = getLogger('infra');
    const context = await options.getContext();
    const browser = context.browser();
    if (!browser) {throw new Error('browser connection unavailable for extension reload');}
    const session = await browser.newBrowserCDPSession();
    try {
        log.info('[RPA:infra]', 'extension.dev.reload.start', {
            workspaceName: options.workspaceName,
            buildId: buildInfo.buildId,
        });

        const oldWorker = await resolveMainWorker(context);
        const previousBuildId = await workerBuildId(oldWorker);
        const prepared = await prepareMainExtensionReload(oldWorker);
        const existingExtensions = await getExtensions(session);
        const mainExtensionPath = options.extensionPaths[0] || '';
        const mainExtension = findExtensionByPath(existingExtensions, mainExtensionPath);
        if (!mainExtension) {
            throw new Error(`main extension is not loaded from ${mainExtensionPath || '<missing>'}`);
        }
        const loaded = await loadExtensionPaths(session, options.extensionPaths);
        await verifyLoadedExtensions(session, loaded);
        const mainLoaded = loaded[0];

        const newWorker = await resolveMainWorker(context, buildInfo.buildId);
        await options.configureMainExtension(context);
        const contentPages = await reloadContentPages(context);
        await Promise.all(contentPages.map((page) => verifyContentPageBuild(page, buildInfo.buildId)));
        const newTabPages = await restoreNewTabPages(
            context,
            mainLoaded.id,
            options.startUrl(),
            buildInfo.buildId,
        );

        const activeBuildId = await workerBuildId(newWorker);
        if (activeBuildId !== buildInfo.buildId) {
            throw new Error(`main extension is build ${String(activeBuildId)}, expected ${buildInfo.buildId}`);
        }
        log.info('[RPA:infra]', 'extension.dev.reload.complete', {
            workspaceName: options.workspaceName,
            previousBuildId,
            buildId: activeBuildId,
            preservedTabCount: prepared.tabCount,
            contentPageReloads: contentPages.length,
            newTabPageReloads: newTabPages,
        });
    } finally {
        await session.detach().catch(() => undefined);
    }
};

export const startExtensionDevReloader = (
    options: ExtensionDevReloaderOptions,
): ExtensionDevReloader => {
    const watcher: FSWatcher = chokidar.watch(options.stampPath, {
        ignoreInitial: true,
        awaitWriteFinish: {stabilityThreshold: 80, pollInterval: 20},
    });
    let closed = false;
    let lastBuildId = '';
    let chain = Promise.resolve();

    const queueReload = () => {
        chain = chain.then(async () => {
            if (closed) {return;}
            const buildInfo = await readBuildInfo(options.stampPath);
            if (buildInfo.buildId === lastBuildId) {return;}
            lastBuildId = buildInfo.buildId;
            await reloadExtensionsForBuild(options, buildInfo);
        }).catch((error: unknown) => {
            options.onError?.(error);
            getLogger('infra').error('[RPA:infra]', 'extension.dev.reload.failed', {
                workspaceName: options.workspaceName,
                message: error instanceof Error ? error.message : String(error),
            });
        });
    };

    watcher.on('add', queueReload);
    watcher.on('change', queueReload);
    watcher.on('error', (error) => options.onError?.(error));

    return {
        close: async () => {
            closed = true;
            await watcher.close();
            await chain;
        },
    };
};

export const resolveExtensionBuildStampPath = (extensionPaths: string[]): string => {
    const configured = process.env.RPA_EXTENSION_BUILD_STAMP?.trim();
    if (configured) {return path.resolve(configured);}
    const mainExtensionPath = extensionPaths[0];
    if (!mainExtensionPath) {throw new Error('main extension path is unavailable');}
    const resolvedMainPath = path.resolve(mainExtensionPath);
    const versionedMarker = `${path.sep}.dev${path.sep}extensions${path.sep}`;
    const markerIndex = resolvedMainPath.lastIndexOf(versionedMarker);
    if (markerIndex >= 0) {
        const repositoryRoot = resolvedMainPath.slice(0, markerIndex);
        return path.join(repositoryRoot, '.dev', 'extension-build.json');
    }
    return path.resolve(resolvedMainPath, '..', '..', '.dev', 'extension-build.json');
};
