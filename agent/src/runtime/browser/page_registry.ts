import type { BrowserContext, Page } from 'playwright';

type PendingBindingClaim = {
    bindingName: string;
    source?: string;
    url?: string;
    createdAt: number;
};

export type AwaitPageBindingOptions = {
    timeoutMs: number;
};

export type PageBindingDebugState = {
    bindingName: string;
    knownBindings: string[];
    knownPagesSummary: string[];
    pendingClaims: Array<{ bindingName: string; source?: string; url?: string; createdAt: number }>;
};

export type PageRegistryOptions = {
    tabNameKey: string;
    tabNameConfirmedKey?: string;
    getContext: () => Promise<BrowserContext>;
    onPageBound?: (page: Page, bindingName: string) => void;
    onBindingClosed?: (bindingName: string) => void;
};

export type PageRegistry = {
    createPage: () => Promise<Page>;
    bindPage: (page: Page, hintedBindingName?: string) => Promise<string | null>;
    awaitPageBinding: (bindingName: string, options: AwaitPageBindingOptions) => Promise<Page>;
    createPageBinding: (bindingName: string, input?: { startUrl?: string; newWindow?: boolean }) => Promise<Page>;
    touchBinding: (bindingName: string, at?: number) => boolean;
    listStaleBindings: (timeoutMs: number, now?: number) => Array<{ bindingName: string; lastSeenAt: number }>;
    closePage: (bindingName: string) => Promise<void>;
    debugPageBindings: (bindingName: string) => Promise<PageBindingDebugState>;
    createPendingBindingClaim: (claim: { bindingName: string; source?: string; url?: string; createdAt?: number }) => void;
    claimPendingBinding: (bindingName: string) => Promise<boolean>;
};

export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
    const confirmedKey = options.tabNameConfirmedKey ?? '__rpa_tab_name_confirmed';
    const tabNameWinNamePrefix = '__RPA_TAB_NAME__:';
    const bindingToPage = new Map<string, Page>();
    const bindingUpdatedAt = new Map<string, number>();
    const pendingClaims = new Map<string, PendingBindingClaim>();
    const bindingWaiters = new Map<string, Set<(page: Page | null) => void>>();

    const waitForBindingName = async (page: Page, attempts = 20, delayMs = 200) => {
        for (let i = 0; i < attempts; i += 1) {
            if (page.isClosed()) {return null;}
            try {
                const value = await page.evaluate(
                    (keys) => {
                        const rawWinName = typeof window.name === 'string' ? window.name : '';
                        if (rawWinName.startsWith(keys.winNamePrefix)) {
                            const nameToken = rawWinName.slice(keys.winNamePrefix.length).trim();
                            if (nameToken) {return nameToken;}
                        }
                        // window.open-ed page can inherit opener sessionStorage;
                        // never trust sessionStorage token while opener is present.
                        if (window.opener && !window.opener.closed) {return null;}
                        const confirmed = sessionStorage.getItem(keys.confirmedKey);
                        if (!confirmed) {return null;}
                        return sessionStorage.getItem(keys.tabNameKey);
                    },
                    { tabNameKey: options.tabNameKey, confirmedKey, winNamePrefix: tabNameWinNamePrefix },
                );
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
            try { sessionStorage.setItem(${JSON.stringify(confirmedKey)}, '1'); } catch {}
            try { window.name = ${JSON.stringify(tabNameWinNamePrefix)} + ${JSON.stringify(bindingName)}; } catch {}
            try { window.__rpa_tab_name = ${JSON.stringify(bindingName)}; } catch {}
        `;
        await page.addInitScript({ content: script });
        try {
            await page.evaluate(
                (args: { name: string; key: string; confirmedKey: string; winNamePrefix: string }) => {
                    sessionStorage.setItem(args.key, args.name);
                    sessionStorage.setItem(args.confirmedKey, '1');
                    try { window.name = `${args.winNamePrefix}${args.name}`; } catch {}
                    try {
                        (window as any).__rpa_tab_name = args.name;
                    } catch {}
                },
                { name: bindingName, key: options.tabNameKey, confirmedKey, winNamePrefix: tabNameWinNamePrefix },
            );
        } catch {}
    };

    const resolveKnownPage = (bindingName: string): Page | null => {
        const page = bindingToPage.get(bindingName);
        if (!page || page.isClosed()) {
            if (page?.isClosed()) {
                bindingToPage.delete(bindingName);
                bindingUpdatedAt.delete(bindingName);
            }
            return null;
        }
        return page;
    };

    const notifyBindingWaiters = (bindingName: string, page: Page | null) => {
        const waiters = bindingWaiters.get(bindingName);
        if (!waiters || waiters.size === 0) {return;}
        bindingWaiters.delete(bindingName);
        for (const waiter of waiters) {
            waiter(page);
        }
    };

    const bindRuntime = (bindingName: string, page: Page) => {
        bindingToPage.set(bindingName, page);
        bindingUpdatedAt.set(bindingName, Date.now());
        notifyBindingWaiters(bindingName, page);
        page.on('close', () => {
            if (bindingToPage.get(bindingName) !== page) {return;}
            bindingToPage.delete(bindingName);
            bindingUpdatedAt.delete(bindingName);
            notifyBindingWaiters(bindingName, null);
            options.onBindingClosed?.(bindingName);
        });
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

    const scanContextPages = async () => {
        const context = await options.getContext();
        for (const page of context.pages()) {
            if (page.isClosed()) {continue;}
            const bindingName = await waitForBindingName(page, 3, 100);
            if (!bindingName) {continue;}
            if (resolveKnownPage(bindingName) === page) {continue;}
            bindRuntime(bindingName, page);
        }
    };

    const isBoundPage = (candidate: Page) => {
        for (const [bindingName, page] of bindingToPage.entries()) {
            if (page.isClosed()) {
                bindingToPage.delete(bindingName);
                bindingUpdatedAt.delete(bindingName);
                continue;
            }
            if (page === candidate) {return true;}
        }
        return false;
    };

    const isLikelyClaimPage = (page: Page, claim: PendingBindingClaim) => {
        const claimUrl = claim.url?.trim();
        if (!claimUrl) {return false;}
        const pageUrl = page.url();
        if (pageUrl === claimUrl) {return true;}
        if (pageUrl.startsWith(claimUrl) || claimUrl.startsWith(pageUrl)) {return true;}
        if (claimUrl.startsWith('chrome://newtab')) {
            return pageUrl.startsWith('chrome://newtab') || pageUrl.startsWith('chrome-extension://');
        }
        return false;
    };

    const claimPageFromContext = async (claim: PendingBindingClaim) => {
        const context = await options.getContext();
        const candidates = context.pages().filter((page) => !page.isClosed() && !isBoundPage(page));
        const matched = candidates.find((page) => isLikelyClaimPage(page, claim));
        const page = matched || (candidates.length === 1 ? candidates[0] : null);
        if (!page) {return false;}
        await bindPage(page, claim.bindingName);
        return resolveKnownPage(claim.bindingName) === page;
    };

    const awaitPageBinding = async (bindingName: string, awaitOptions: AwaitPageBindingOptions) => {
        if (!bindingName) {throw new Error('missing bindingName');}
        const existing = resolveKnownPage(bindingName);
        if (existing) {return existing;}

        await scanContextPages();
        const scanned = resolveKnownPage(bindingName);
        if (scanned) {return scanned;}

        return await new Promise<Page>((resolve, reject) => {
            let done = false;
            const timeoutMs = awaitOptions.timeoutMs;
            const timer = setTimeout(() => {
                if (done) {return;}
                done = true;
                const waiters = bindingWaiters.get(bindingName);
                waiters?.delete(onBound);
                reject(new Error(`page binding timeout: ${bindingName}`));
            }, timeoutMs);

            const onBound = (page: Page | null) => {
                if (done) {return;}
                if (!page || page.isClosed()) {return;}
                done = true;
                clearTimeout(timer);
                resolve(page);
            };

            const waiters = bindingWaiters.get(bindingName) || new Set<(page: Page | null) => void>();
            waiters.add(onBound);
            bindingWaiters.set(bindingName, waiters);

            const rebound = resolveKnownPage(bindingName);
            if (rebound) {
                done = true;
                clearTimeout(timer);
                waiters.delete(onBound);
                resolve(rebound);
            }
        });
    };

    const createPageInNewWindow = async (context: BrowserContext): Promise<Page> => {
        const seedPage = context.pages().find((page) => !page.isClosed()) || await context.newPage();
        const pagePromise = context.waitForEvent('page', { timeout: 5000 });
        const cdp = await context.newCDPSession(seedPage);
        await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
        return await pagePromise;
    };

    const createPageBinding = async (bindingName: string, input?: { startUrl?: string; newWindow?: boolean }) => {
        if (!bindingName) {throw new Error('missing bindingName');}
        const existing = resolveKnownPage(bindingName);
        if (existing) {return existing;}
        const context = await options.getContext();
        const page = input?.newWindow === true ? await createPageInNewWindow(context) : await context.newPage();
        await installBindingNameToPage(page, bindingName);
        if (input?.startUrl) {
            await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' });
        }
        await bindPage(page, bindingName);
        return page;
    };

    const createPage = async (): Promise<Page> => {
        const context = await options.getContext();
        return await context.newPage();
    };

    const debugPageBindings = async (bindingName: string): Promise<PageBindingDebugState> => {
        const context = await options.getContext();
        const knownPagesSummary = context.pages().map((page, index) => {
            const closed = page.isClosed();
            const url = closed ? '(closed)' : page.url();
            return `${index}:${closed ? 'closed' : 'open'}:${url}`;
        });
        return {
            bindingName,
            knownBindings: Array.from(bindingToPage.keys()),
            knownPagesSummary,
            pendingClaims: Array.from(pendingClaims.values()).map((claim) => ({ ...claim })),
        };
    };

    return {
        createPage,
        bindPage,
        awaitPageBinding,
        createPageBinding,
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
        debugPageBindings,
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
            const claim = pendingClaims.get(bindingName);
            if (!claim) {return false;}
            if (!bindingToPage.get(bindingName)) {
                await scanContextPages();
            }
            const page = bindingToPage.get(bindingName);
            if ((!page || page.isClosed()) && !await claimPageFromContext(claim)) {return false;}
            pendingClaims.delete(bindingName);
            return true;
        },
    };
};
