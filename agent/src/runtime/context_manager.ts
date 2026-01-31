import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ContextManagerOptions = {
    extensionPath: string;
    userDataDir: string;
    onPage?: (page: Page) => void;
};

export const createContextManager = (options: ContextManagerOptions) => {
    let contextPromise: Promise<BrowserContext> | undefined;
    let contextRef: BrowserContext | undefined;
    const startUrl =
        process.env.RPA_START_URL || 'http://localhost:4173/pages/start.html#beta';

    const ensureStartPage = async (context: BrowserContext) => {
        try {
            const pages = context.pages();
            const primary = await context.newPage();
            await primary.goto(startUrl, { waitUntil: 'domcontentloaded' });
            await primary.bringToFront();
            const toClose = pages.filter((page) => page !== primary);
            for (const page of toClose) {
                try {
                    if (!page.isClosed()) {
                        await page.close({ runBeforeUnload: true });
                    }
                } catch {
                    // ignore close errors
                }
            }
        } catch {
            // ignore start page navigation failures
        }
    };

    const getContext = async () => {
        if (contextRef) return contextRef;
        if (contextPromise) return contextPromise;
        console.log('[RPA:agent]', 'Launching Chromium with extension from', options.extensionPath);
        contextPromise = chromium
            .launchPersistentContext(options.userDataDir, {
                headless: false,
                viewport: null,
                args: [
                    `--disable-extensions-except=${options.extensionPath}`,
                    `--load-extension=${options.extensionPath}`,
                ],
            })
            .then(async (context) => {
                contextRef = context;
                context.on('close', () => {
                    contextRef = undefined;
                    contextPromise = undefined;
                });
                if (options.onPage) {
                    context.on('page', options.onPage);
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

export const resolvePaths = () => {
    const extensionPath = path.resolve(__dirname, '../../../extension/dist');
    const userDataDir = path.resolve(__dirname, '../../.user-data');
    return { extensionPath, userDataDir };
};
