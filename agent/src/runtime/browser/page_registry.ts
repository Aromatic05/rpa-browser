import type { BrowserContext, Page } from 'playwright';

type PendingBindingClaim = {
    bindingName: string;
    source?: string;
    url?: string;
    createdAt: number;
};

export type PageRegistryOptions = {
    tabNameKey: string;
    getContext: () => Promise<BrowserContext>;
    onPageBound?: (page: Page, bindingName: string) => void;
    onBindingClosed?: (bindingName: string) => void;
};

export type PageRegistry = {
    bindPage: (page: Page, hintedBindingName?: string) => Promise<string | null>;
    getPage: (bindingName: string, urlHint?: string) => Promise<Page>;
    touchBinding: (bindingName: string, at?: number) => boolean;
    listStaleBindings: (timeoutMs: number, now?: number) => Array<{ bindingName: string; lastSeenAt: number }>;
    closePage: (bindingName: string) => Promise<void>;
    createPendingBindingClaim: (claim: { bindingName: string; source?: string; url?: string; createdAt?: number }) => void;
    claimPendingBinding: (bindingName: string) => Promise<boolean>;
};

export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
    const bindingToPage = new Map<string, Page>();
    const bindingUpdatedAt = new Map<string, number>();
    const pendingClaims = new Map<string, PendingBindingClaim>();

    const waitForBindingName = async (page: Page, attempts = 20, delayMs = 200) => {
        for (let i = 0; i < attempts; i += 1) {
            if (page.isClosed()) {return null;}
            try {
                const value = await page.evaluate((key) => sessionStorage.getItem(key), options.tabNameKey);
                if (value) {return value;}
            } catch {}
            try {
                await page.waitForTimeout(delayMs);
            } catch {
                return null;
            }
        }
        return null;
    };

    const installBindingNameToPage = async (page: Page, bindingName: string) => {
        const script = `
            try { sessionStorage.setItem(${JSON.stringify(options.tabNameKey)}, ${JSON.stringify(bindingName)}); } catch {}
            try { window.__rpa_tab_name = ${JSON.stringify(bindingName)}; } catch {}
        `;
        await page.addInitScript({ content: script });
        try {
            await page.evaluate(
                (args: { name: string; key: string }) => {
                    sessionStorage.setItem(args.key, args.name);
                    try {
                        (window as any).__rpa_tab_name = args.name;
                    } catch {}
                },
                { name: bindingName, key: options.tabNameKey },
            );
        } catch {}
    };

    const bindRuntime = (bindingName: string, page: Page) => {
        bindingToPage.set(bindingName, page);
        bindingUpdatedAt.set(bindingName, Date.now());
        page.on('close', () => {
            if (bindingToPage.get(bindingName) !== page) {return;}
            bindingToPage.delete(bindingName);
            bindingUpdatedAt.delete(bindingName);
            options.onBindingClosed?.(bindingName);
        });
    };

    const openPageWithBindingName = async (bindingName: string) => {
        const context = await options.getContext();
        const page = await context.newPage();
        await installBindingNameToPage(page, bindingName);
        return page;
    };

    const bindPage = async (page: Page, hintedBindingName?: string) => {
        if (page.isClosed()) {return null;}
        const bindingName = hintedBindingName || (await waitForBindingName(page));
        if (!bindingName) {return null;}
        bindRuntime(bindingName, page);
        pendingClaims.delete(bindingName);
        options.onPageBound?.(page, bindingName);
        return bindingName;
    };

    const rebuildBindingMap = async () => {
        const context = await options.getContext();
        for (const page of context.pages()) {
            const bindingName = await waitForBindingName(page, 3, 100);
            if (!bindingName) {continue;}
            bindRuntime(bindingName, page);
        }
    };

    const getPage = async (bindingName: string, urlHint?: string) => {
        if (!bindingName) {throw new Error('missing bindingName');}
        let page = bindingToPage.get(bindingName);
        if (page && !page.isClosed()) {return page;}
        await rebuildBindingMap();
        page = bindingToPage.get(bindingName);
        if (page && !page.isClosed()) {return page;}
        page = await openPageWithBindingName(bindingName);
        if (urlHint) {
            await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
        }
        await bindPage(page, bindingName);
        return page;
    };

    return {
        bindPage,
        getPage,
        touchBinding: (bindingName: string, at?: number) => {
            if (!bindingUpdatedAt.has(bindingName)) {return false;}
            bindingUpdatedAt.set(bindingName, typeof at === 'number' ? at : Date.now());
            return true;
        },
        listStaleBindings: (timeoutMs: number, now = Date.now()) => {
            const stale: Array<{ bindingName: string; lastSeenAt: number }> = [];
            for (const [bindingName, lastSeenAt] of bindingUpdatedAt.entries()) {
                if (now - lastSeenAt > timeoutMs) {
                    stale.push({ bindingName, lastSeenAt });
                }
            }
            return stale;
        },
        closePage: async (bindingName: string) => {
            const page = bindingToPage.get(bindingName);
            if (!page || page.isClosed()) {
                bindingToPage.delete(bindingName);
                bindingUpdatedAt.delete(bindingName);
                return;
            }
            await page.close({ runBeforeUnload: true });
        },
        createPendingBindingClaim: (claim) => {
            if (!claim.bindingName) {return;}
            pendingClaims.set(claim.bindingName, {
                bindingName: claim.bindingName,
                source: claim.source,
                url: claim.url,
                createdAt: claim.createdAt ?? Date.now(),
            });
        },
        claimPendingBinding: async (bindingName: string) => {
            if (!pendingClaims.has(bindingName)) {return false;}
            if (!bindingToPage.get(bindingName)) {
                await rebuildBindingMap();
            }
            const page = bindingToPage.get(bindingName);
            if (!page || page.isClosed()) {return false;}
            pendingClaims.delete(bindingName);
            return true;
        },
    };
};
