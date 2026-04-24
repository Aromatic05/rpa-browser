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
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../logging/logger';
import { launchLocalChromeForCdp } from './cdp_launcher';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ContextManagerOptions = {
    extensionPaths: string[];
    userDataDir: string;
    onPage?: (page: Page) => void;
};

type ContextProvider = () => Promise<BrowserContext>;

const bindContextPages = (context: BrowserContext, onPage?: (page: Page) => void) => {
    if (!onPage) {return;}
    context.on('page', onPage);
    for (const page of context.pages()) {
        onPage(page);
    }
};

const createCdpContextProvider = (options: ContextManagerOptions): ContextProvider => {
    const actionLog = getLogger('action');
    let contextPromise: Promise<BrowserContext> | undefined;
    let contextRef: BrowserContext | undefined;
    let cdpBrowserRef: Browser | undefined;
    let cdpLocalStop: (() => Promise<void>) | undefined;

    const cdpEndpoint = process.env.RPA_CDP_ENDPOINT?.trim() || '';
    const cdpPort = Number(process.env.RPA_CDP_PORT || 9222);
    const cdpAutoLaunch = !['0', 'false', 'no'].includes((process.env.RPA_CDP_AUTO_LAUNCH || 'true').toLowerCase());
    const cdpUserDataDir = process.env.RPA_CDP_USER_DATA_DIR?.trim() || path.resolve(options.userDataDir, 'cdp-browser');
    const startUrl = process.env.RPA_START_URL || 'chrome://newtab/';

    return async () => {
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
                extensionPaths: options.extensionPaths,
                logger: (...args) => { actionLog.info('[RPA:agent]', ...args); },
            });
            endpoint = launched.endpoint;
            cdpLocalStop = launched.stop;
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
                cdpBrowserRef = browser;
                const context = browser.contexts()[0] || (await browser.newContext());
                contextRef = context;
                browser.on('disconnected', () => {
                    if (cdpLocalStop) {void cdpLocalStop();}
                    cdpLocalStop = undefined;
                    cdpBrowserRef = undefined;
                    contextRef = undefined;
                    contextPromise = undefined;
                });
                bindContextPages(context, options.onPage);
                return context;
            })
            .catch((error) => {
                contextPromise = undefined;
                contextRef = undefined;
                cdpBrowserRef = undefined;
                throw error;
            });
        return await contextPromise;
    };
};

const createExtensionContextProvider = (options: ContextManagerOptions): ContextProvider => {
    const actionLog = getLogger('action');
    let contextPromise: Promise<BrowserContext> | undefined;
    let contextRef: BrowserContext | undefined;
    const startUrl = process.env.RPA_START_URL || 'chrome://newtab/';
    const headless = ['1', 'true', 'yes'].includes((process.env.RPA_HEADLESS || '').toLowerCase());

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

    return async () => {
        if (contextRef) {return contextRef;}
        if (contextPromise) {return await contextPromise;}

        actionLog.info('[RPA:agent]', 'Launching Chromium with extensions', options.extensionPaths);
        const extensionArg = options.extensionPaths.join(',');
        const launchArgs = [
            `--disable-extensions-except=${extensionArg}`,
            `--load-extension=${extensionArg}`,
        ];
        contextPromise = chromium
            .launchPersistentContext(options.userDataDir, {
                headless,
                viewport: null,
                args: launchArgs,
            })
            .then(async (context) => {
                contextRef = context;
                context.on('close', () => {
                    contextRef = undefined;
                    contextPromise = undefined;
                });
                bindContextPages(context, options.onPage);
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
};

/**
 * 创建 context 管理器。内部缓存 BrowserContext，并处理启动与关闭回收。
 */
export const createContextManager = (options: ContextManagerOptions) => {
    const browserMode = (process.env.RPA_BROWSER_MODE || 'extension').trim().toLowerCase();
    const getContext =
        browserMode === 'cdp' ? createCdpContextProvider(options) : createExtensionContextProvider(options);

    return { getContext };
};

/**
 * 解析扩展与用户数据目录路径。
 * 使用相对路径，便于 monorepo 下的运行与打包。
 */
export const resolvePaths = () => {
    const extensionPaths = [
        path.resolve(__dirname, '../../../extension/dist'),
        path.resolve(__dirname, '../../../start_extension/dist'),
    ];
    const userDataDir = process.env.RPA_USER_DATA_DIR?.trim() || path.resolve(__dirname, '../../.user-data');
    return { extensionPaths, userDataDir };
};
