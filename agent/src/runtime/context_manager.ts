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
import fs from 'node:fs';
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

/**
 * 创建 context 管理器。内部缓存 BrowserContext，并处理启动与关闭回收。
 */
export const createContextManager = (options: ContextManagerOptions) => {
    const actionLog = getLogger('action');
    let contextPromise: Promise<BrowserContext> | undefined;
    let contextRef: BrowserContext | undefined;
    let cdpBrowserRef: Browser | undefined;
    const startUrl = process.env.RPA_START_URL || 'chrome://newtab/';
    const newTabUrl = process.env.RPA_NEWTAB_URL?.trim() || startUrl;
    const headless = ['1', 'true', 'yes'].includes((process.env.RPA_HEADLESS || '').toLowerCase());
    const browserMode = (process.env.RPA_BROWSER_MODE || 'extension').trim().toLowerCase();
    const cdpEndpoint = process.env.RPA_CDP_ENDPOINT?.trim() || '';
    const cdpPort = Number(process.env.RPA_CDP_PORT || 9222);
    const cdpAutoLaunch = !['0', 'false', 'no'].includes((process.env.RPA_CDP_AUTO_LAUNCH || 'true').toLowerCase());
    const cdpUserDataDir = process.env.RPA_CDP_USER_DATA_DIR?.trim() || path.resolve(options.userDataDir, 'cdp-browser');
    let cdpLocalStop: (() => Promise<void>) | undefined;

    // 启动后强制导航到 startUrl，并关闭多余的初始页签。
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

    /**
     * 获取或创建 BrowserContext。若已有实例则复用。
     * 注意：这里会注册 close 监听以重置内部缓存。
     */
    const getContext = async () => {
        if (contextRef) return contextRef;
        if (contextPromise) return contextPromise;
        if (browserMode === 'cdp') {
            let endpoint = cdpEndpoint;
            if (!endpoint) {
                if (!cdpAutoLaunch) {
                    throw new Error('RPA_CDP_ENDPOINT is required when RPA_CDP_AUTO_LAUNCH=false');
                }
                const launched = await launchLocalChromeForCdp({
                    port: cdpPort,
                    userDataDir: cdpUserDataDir,
                    logger: (...args) => actionLog.info('[RPA:agent]', ...args),
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
                        if (cdpLocalStop) void cdpLocalStop();
                        cdpLocalStop = undefined;
                        cdpBrowserRef = undefined;
                        contextRef = undefined;
                        contextPromise = undefined;
                    });
                    if (options.onPage) {
                        context.on('page', options.onPage);
                        for (const page of context.pages()) {
                            options.onPage(page);
                        }
                    }
                    return context;
                })
                .catch((error) => {
                    contextPromise = undefined;
                    contextRef = undefined;
                    cdpBrowserRef = undefined;
                    throw error;
                });
            return contextPromise;
        }

        actionLog.info('[RPA:agent]', 'Launching Chromium with extensions', options.extensionPaths);
        const policyDir = path.resolve(options.userDataDir, 'enterprise-policies', 'managed');
        const policyFile = path.join(policyDir, 'rpa_browser_policy.json');
        try {
            fs.mkdirSync(policyDir, { recursive: true });
            fs.writeFileSync(
                policyFile,
                `${JSON.stringify({ NewTabPageLocation: newTabUrl }, null, 2)}\n`,
                'utf8',
            );
        } catch (error) {
            actionLog.error('[RPA:agent]', 'Failed to write NewTabPageLocation policy', String(error));
        }
        const extensionArg = options.extensionPaths.join(',');
        const launchArgs = [
            `--disable-extensions-except=${extensionArg}`,
            `--load-extension=${extensionArg}`,
            `--enterprise-policy-path=${policyDir}`,
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
                if (options.onPage) {
                    context.on('page', options.onPage);
                    for (const page of context.pages()) {
                        options.onPage(page);
                    }
                }
                await ensureStartPage(context);
                return context;
            })
            .catch((error) => {
                contextPromise = undefined;
                contextRef = undefined;
                throw error;
            });
        return contextPromise;
    };

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
