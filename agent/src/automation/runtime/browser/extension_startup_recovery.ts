import path from 'node:path';
import type {BrowserContext} from 'playwright';

/** Recover only the bundled main extension; preserve the user's profile and other extensions. */
export const recoverDisabledMainExtension = async (
    context: BrowserContext,
    mainExtensionPath: string,
): Promise<boolean> => {
    if (!mainExtensionPath) {return false;}
    const page = await context.newPage();
    try {
        await page.goto('chrome://extensions/', {waitUntil: 'domcontentloaded', timeout: 10_000});
        return await page.evaluate(async (expectedPath: string) => {
            type ExtensionInfo = {id: string; name: string; path?: string; state: string};
            const api = (globalThis as typeof globalThis & {chrome: {
                developerPrivate: {getExtensionsInfo: (options: {includeDisabled: boolean; includeTerminated: boolean}) => Promise<ExtensionInfo[]>};
                management: {setEnabled: (id: string, enabled: boolean) => Promise<void>};
            }}).chrome;
            const extensions = await api.developerPrivate.getExtensionsInfo({includeDisabled: true, includeTerminated: true});
            const extension = extensions.find(item => item.name === 'RPA Browser'
                && item.path?.replace(/\\/gu, '/').replace(/\/$/u, '') === expectedPath);
            if (extension?.state !== 'DISABLED') {return false;}
            await api.management.setEnabled(extension.id, true);
            return true;
        }, path.resolve(mainExtensionPath).replace(/\\/gu, '/').replace(/\/$/u, ''));
    } finally {
        await page.close().catch(() => undefined);
    }
};
