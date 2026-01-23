import type { BrowserContext, Page } from 'playwright';

export type PageRegistryOptions = {
  tabTokenKey: string;
  getContext: () => Promise<BrowserContext>;
  onPageBound?: (page: Page, token: string) => void;
  onTokenClosed?: (token: string) => void;
};

export type PageRegistry = {
  bindPage: (page: Page, hintedToken?: string) => Promise<string | null>;
  getPage: (tabToken: string, urlHint?: string) => Promise<Page>;
  listPages: () => Array<{ tabToken: string; page: Page }>;
  cleanup: (tabToken?: string) => void;
};

export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
  const tokenToPage = new Map<string, Page>();

  const waitForToken = async (page: Page, attempts = 20, delayMs = 200) => {
    for (let i = 0; i < attempts; i += 1) {
      if (page.isClosed()) return null;
      try {
        const token = await page.evaluate(
          (key) => sessionStorage.getItem(key),
          options.tabTokenKey
        );
        if (token) return token;
      } catch {
        // ignore evaluation failures while page is loading
      }
      await page.waitForTimeout(delayMs);
    }
    return null;
  };

  const bindPage = async (page: Page, hintedToken?: string) => {
    if (page.isClosed()) return null;
    const token = hintedToken || (await waitForToken(page));
    if (!token) return null;
    tokenToPage.set(token, page);
    console.log('[RPA:agent]', 'bind page', { tabToken: token, pageUrl: page.url() });
    page.on('close', () => {
      const current = tokenToPage.get(token);
      if (current === page) {
        tokenToPage.delete(token);
        options.onTokenClosed?.(token);
      }
    });
    options.onPageBound?.(page, token);
    return token;
  };

  const rebuildTokenMap = async () => {
    const context = await options.getContext();
    const pages = context.pages();
    for (const page of pages) {
      const token = await waitForToken(page, 3, 100);
      if (token) {
        tokenToPage.set(token, page);
      }
    }
  };

  const ensureTokenOnPage = async (page: Page, tabToken: string) => {
    try {
      await page.evaluate(
        (args: { token: string; key: string }) => {
          sessionStorage.setItem(args.key, args.token);
        },
        { token: tabToken, key: options.tabTokenKey }
      );
    } catch {
      // ignore if sessionStorage is unavailable
    }
  };

  const getPage = async (tabToken: string, urlHint?: string) => {
    if (!tabToken) {
      throw new Error('missing tabToken');
    }
    let page = tokenToPage.get(tabToken);
    if (page && !page.isClosed()) return page;

    await rebuildTokenMap();
    page = tokenToPage.get(tabToken);
    if (page && !page.isClosed()) return page;

    const context = await options.getContext();
    page = await context.newPage();
    const initContent = `sessionStorage.setItem(${JSON.stringify(
      options.tabTokenKey
    )}, ${JSON.stringify(tabToken)});`;
    await page.addInitScript({ content: initContent });

    if (urlHint) {
      await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
    }

    await ensureTokenOnPage(page, tabToken);
    await bindPage(page, tabToken);
    return page;
  };

  const listPages = () =>
    Array.from(tokenToPage.entries()).map(([tabToken, page]) => ({ tabToken, page }));

  const cleanup = (tabToken?: string) => {
    if (!tabToken) {
      tokenToPage.clear();
      return;
    }
    tokenToPage.delete(tabToken);
  };

  return { bindPage, getPage, listPages, cleanup };
};
