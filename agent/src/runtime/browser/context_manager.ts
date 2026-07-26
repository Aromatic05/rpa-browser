/**
 * ContextManager：负责启动并缓存 Playwright 的持久化 Chromium context。
 *
 * 依赖关系：
 * - 上游：agent/index.ts 调用 createContextManager 并提供扩展路径与用户数据目录
 * - 下游：page_registry 通过 getContext 创建/复用 Page
 *
 * 关键约束：
 * - 必须使用 persistent context 以加载 extension
 * - 只在首次调用时真正启动浏览器，后续复用同一 context
 * - start page 失败不能影响整体启动（容错）
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../logging/logger';
import { launchLocalChromeForCdp, resolveChromeExecutable } from './cdp_launcher';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ContextManagerOptions = {
    extensionPaths: string[];
    userDataDir: string;
    startUrl?: string;
    cdpPort?: number;
    cdpEndpoint?: string;
    chromePath?: string;
    onPage?: (page: Page) => void;
};

type ContextProvider = {
    getContext: () => Promise<BrowserContext>;
    close: () => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForBrowserDisconnected = async (
    browser: ReturnType<BrowserContext['browser']> | undefined,
    timeoutMs = 5000,
): Promise<void> => {
    if (!browser || !browser.isConnected()) {return;}
    await Promise.race([
        new Promise<void>((resolve) => browser.once('disconnected', () => resolve())),
        sleep(timeoutMs).then(() => {
            if (browser.isConnected()) {
                throw new Error(`browser did not disconnect within ${timeoutMs}ms`);
            }
        }),
    ]);
};

const hasPathEntry = (entryPath: string): boolean => {
    try {
        fs.lstatSync(entryPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return false;}
        throw error;
    }
};

const waitForProfileRelease = async (userDataDir: string, timeoutMs = 5000): Promise<void> => {
    const lockPath = path.join(userDataDir, 'SingletonLock');
    const deadline = Date.now() + timeoutMs;
    while (hasPathEntry(lockPath) && Date.now() < deadline) {
        await sleep(50);
    }
    if (hasPathEntry(lockPath)) {
        throw new Error(`browser profile lock was not released: ${lockPath}`);
    }
};

const bindContextPages = (context: BrowserContext, onPage?: (page: Page) => void, onPageClosed?: (page: Page) => void) => {
    if (onPage) {
        context.on('page', onPage);
        for (const page of context.pages()) {
            onPage(page);
        }
    }
    if (onPageClosed) {
        context.on('page', (page) => {
            page.on('close', () => onPageClosed(page));
        });
        for (const page of context.pages()) {
            page.on('close', () => onPageClosed(page));
        }
    }
};

const createCdpContextProvider = (options: ContextManagerOptions): ContextProvider => {
    const actionLog = getLogger('action');
    const infraLog = getLogger('infra');
    let contextPromise: Promise<BrowserContext> | undefined;
    let contextRef: BrowserContext | undefined;
    let cdpLocalStop: (() => Promise<void>) | undefined;
    let cdpStderr: (() => string) | undefined;
    let cdpPid: number | undefined;
    let cdpSelfLaunched = false;
    const startUrl = options.startUrl || process.env.RPA_START_URL || 'chrome://newtab/';
    const pageLifecycle: Array<{ ts: number; event: string; url: string }> = [];

    const cdpEndpoint = options.cdpEndpoint?.trim() || process.env.RPA_CDP_ENDPOINT?.trim() || '';
    const cdpPort = options.cdpPort ?? Number(process.env.RPA_CDP_PORT || 9222);
    const cdpAutoLaunch = !['0', 'false', 'no'].includes((process.env.RPA_CDP_AUTO_LAUNCH || 'true').toLowerCase());
    const configuredCdpUserDataDir = process.env.RPA_CDP_USER_DATA_DIR?.trim();
    const cdpUserDataDir = options.cdpPort !== undefined
        ? path.resolve(options.userDataDir, 'cdp-browser')
        : configuredCdpUserDataDir || path.resolve(options.userDataDir, 'cdp-browser');

    const onPageOpened = (page: Page) => {
        pageLifecycle.push({ ts: Date.now(), event: 'opened', url: page.url() });
        if (pageLifecycle.length > 64) {pageLifecycle.shift();}
    };
    const onPageClosed = (page: Page) => {
        pageLifecycle.push({ ts: Date.now(), event: 'closed', url: page.url() });
        if (pageLifecycle.length > 64) {pageLifecycle.shift();}
    };

    const ensureStartPage = async (context: BrowserContext) => {
        try {
            const pages = context.pages();
            const primary = pages[0] || (await context.newPage());
            if (primary.url() !== startUrl) {
                await primary.goto(startUrl, { waitUntil: 'domcontentloaded' });
            }
            await primary.bringToFront();
            const toClose = context.pages().filter((page) => page !== primary);
            for (const page of toClose) {
                if (!page.isClosed()) {
                    await page.close({ runBeforeUnload: true });
                }
            }
        } catch {
            // ignore start page navigation failures
        }
    };

    const getContext = async () => {
        if (contextRef) {return contextRef;}
        if (contextPromise) {return await contextPromise;}

        let endpoint = cdpEndpoint;
        if (!endpoint) {
            if (!cdpAutoLaunch) {
                throw new Error('RPA_CDP_ENDPOINT is required when RPA_CDP_AUTO_LAUNCH=false');
            }
            const launched = await launchLocalChromeForCdp({
                port: cdpPort,
                userDataDir: cdpUserDataDir,
                chromePath: options.chromePath,
                startUrl,
                extensionPaths: options.extensionPaths,
                logger: (...args) => { actionLog.info('[RPA:agent]', ...args); },
            });
            endpoint = launched.endpoint;
            cdpLocalStop = launched.stop;
            cdpStderr = launched.stderr;
            cdpPid = launched.pid;
            cdpSelfLaunched = true;
            actionLog.info('[RPA:agent]', 'Local Chrome started for CDP', {
                endpoint,
                pid: launched.pid,
                userDataDir: cdpUserDataDir,
            });
        }

        actionLog.info('[RPA:agent]', 'Connecting Chromium over CDP', endpoint);
        contextPromise = chromium
            .connectOverCDP(endpoint)
            .then(async (browser) => {
                const context = browser.contexts()[0] || (await browser.newContext());
                contextRef = context;

                context.on('close', () => {
                    const openPages = context.pages().filter((p) => !p.isClosed()).map((p) => p.url());
                    infraLog.error('[RPA:infra]', 'Browser context closed (CDP)', {
                        endpoint,
                        pid: cdpPid,
                        selfLaunched: cdpSelfLaunched,
                        openPageCount: openPages.length,
                        lastPageUrls: openPages.slice(-5),
                        pageLifecycle: pageLifecycle.slice(-20),
                    });
                });

                browser.on('disconnected', () => {
                    const openPages = context.pages().filter((p) => !p.isClosed()).map((p) => p.url());
                    const stderrTail = cdpStderr?.().slice(-4000) || null;
                    infraLog.error('[RPA:infra]', 'Chrome CDP disconnected (browser process exited or crashed)', {
                        endpoint,
                        pid: cdpPid,
                        selfLaunched: cdpSelfLaunched,
                        openPageCount: openPages.length,
                        lastPageUrls: openPages.slice(-5),
                        stderrTail,
                        hasStderr: stderrTail !== null && stderrTail.length > 0,
                        pageLifecycle: pageLifecycle.slice(-20),
                    });
                    if (cdpLocalStop) {void cdpLocalStop();}
                    cdpLocalStop = undefined;
                    cdpStderr = undefined;
                    cdpPid = undefined;
                    cdpSelfLaunched = false;
                    contextRef = undefined;
                    contextPromise = undefined;
                });
                const onPageComposite = (page: Page) => {
                    onPageOpened(page);
                    options.onPage?.(page);
                };
                bindContextPages(context, onPageComposite, onPageClosed);
                await ensureStartPage(context);
                return context;
            })
            .catch((error) => {
                contextPromise = undefined;
                contextRef = undefined;
                throw error;
            });
        return await contextPromise;
    };

    const close = async () => {
        const context = contextRef;
        contextRef = undefined;
        contextPromise = undefined;
        if (context) {
            await context.close().catch(() => undefined);
        }
        if (cdpLocalStop) {
            await cdpLocalStop().catch(() => undefined);
        }
        cdpLocalStop = undefined;
        cdpStderr = undefined;
        cdpPid = undefined;
        cdpSelfLaunched = false;
    };

    return { getContext, close };
};

const createExtensionContextProvider = (options: ContextManagerOptions): ContextProvider => {
    const actionLog = getLogger('action');
    const infraLog = getLogger('infra');
    let contextPromise: Promise<BrowserContext> | undefined;
    let contextRef: BrowserContext | undefined;
    const startUrl = options.startUrl || process.env.RPA_START_URL || 'chrome://newtab/';
    const headless = ['1', 'true', 'yes'].includes((process.env.RPA_HEADLESS || '').toLowerCase());
    const pageLifecycle: Array<{ ts: number; event: string; url: string }> = [];
    let browserDisconnected = false;

    const onPageOpened = (page: Page) => {
        pageLifecycle.push({ ts: Date.now(), event: 'opened', url: page.url() });
        if (pageLifecycle.length > 64) {pageLifecycle.shift();}
    };
    const onPageClosed = (page: Page) => {
        pageLifecycle.push({ ts: Date.now(), event: 'closed', url: page.url() });
        if (pageLifecycle.length > 64) {pageLifecycle.shift();}
    };

    const ensureStartPage = async (context: BrowserContext) => {
        try {
            const pages = context.pages();
            const primary = pages[0] || (await context.newPage());
            if (primary.url() !== startUrl) {
                await primary.goto(startUrl, { waitUntil: 'domcontentloaded' });
            }
            await primary.bringToFront();
            const toClose = context.pages().filter((page) => page !== primary);
            for (const page of toClose) {
                if (!page.isClosed()) {
                    await page.close({ runBeforeUnload: true });
                }
            }
        } catch {
            // ignore start page navigation failures
        }
    };

    const getContext = async () => {
        if (contextRef) {return contextRef;}
        if (contextPromise) {return await contextPromise;}

        actionLog.info('[RPA:agent]', 'Launching Chromium with extensions', options.extensionPaths);
        const extensionArg = options.extensionPaths.join(',');
        const launchArgs = [
            `--disable-extensions-except=${extensionArg}`,
            `--load-extension=${extensionArg}`,
            '--disable-popup-blocking',
        ];
        const explicitChromePath =
            options.chromePath?.trim() ||
            process.env.RPA_CHROME_PATH?.trim() ||
            process.env.RPA_CDP_CHROME_PATH?.trim();
        const bundledChromePath = chromium.executablePath();
        const executablePath = explicitChromePath ||
            (bundledChromePath && fs.existsSync(bundledChromePath)
                ? bundledChromePath
                : resolveChromeExecutable());
        contextPromise = chromium
            .launchPersistentContext(options.userDataDir, {
                headless,
                executablePath,
                viewport: null,
                args: launchArgs,
            })
            .then(async (context) => {
                const browser = context.browser();
                contextRef = context;

                browser?.on('disconnected', () => {
                    browserDisconnected = true;
                    const openPages = context.pages().filter((p) => !p.isClosed()).map((p) => p.url());
                    infraLog.error('[RPA:infra]', 'Browser disconnected (process exited)', {
                        mode: 'extension',
                        openPageCount: openPages.length,
                        lastPageUrls: openPages.slice(-5),
                        pageLifecycle: pageLifecycle.slice(-20),
                    });
                    contextRef = undefined;
                    contextPromise = undefined;
                });

                context.on('close', () => {
                    const openPages = context.pages().filter((p) => !p.isClosed()).map((p) => p.url());
                    infraLog.error('[RPA:infra]', 'Browser context closed', {
                        mode: 'extension',
                        browserDisconnected,
                        browserConnected: browser?.isConnected() ?? false,
                        openPageCount: openPages.length,
                        lastPageUrls: openPages.slice(-5),
                        pageLifecycle: pageLifecycle.slice(-20),
                    });
                    if (!browserDisconnected) {
                        contextRef = undefined;
                        contextPromise = undefined;
                    }
                });

                const onPageComposite = (page: Page) => {
                    onPageOpened(page);
                    options.onPage?.(page);
                };
                bindContextPages(context, onPageComposite, onPageClosed);
                await ensureStartPage(context);
                return context;
            })
            .catch((error) => {
                contextPromise = undefined;
                contextRef = undefined;
                throw error;
            });
        return await contextPromise;
    };

    const close = async () => {
        const context = contextRef;
        const browser = context?.browser();
        contextRef = undefined;
        contextPromise = undefined;
        if (context) {
            await context.close();
        }
        if (browser?.isConnected()) {
            await browser.close();
        }
        await waitForBrowserDisconnected(browser);
        await waitForProfileRelease(options.userDataDir);
    };

    return { getContext, close };
};

/**
 * 创建 context 管理器。内部缓存 BrowserContext，并处理启动与关闭回收。
 */
export const createContextManager = (options: ContextManagerOptions) => {
    const browserMode = (process.env.RPA_BROWSER_MODE || 'extension').trim().toLowerCase();
    const provider =
        browserMode === 'cdp' ? createCdpContextProvider(options) : createExtensionContextProvider(options);

    return provider;
};

/**
 * 解析扩展与用户数据目录路径。
 * 使用相对路径，便于 monorepo 下的运行与打包。
 */
export const resolvePaths = () => {
    const extensionPaths = [
        path.resolve(__dirname, '../../../../extension/dist'),
        path.resolve(__dirname, '../../../../start_extension/dist'),
    ];
    const userDataRoot = process.env.RPA_USER_DATA_DIR?.trim() || path.resolve(__dirname, '../../../.user-data');
    return { extensionPaths, userDataRoot };
};
