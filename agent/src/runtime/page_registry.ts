import type { BrowserContext, Page } from 'playwright';

export type PageRegistryOptions = {
  tabTokenKey: string;
  getContext: () => Promise<BrowserContext>;
  onPageBound?: (page: Page, token: string) => void;
  onTokenClosed?: (token: string) => void;
};

export const createPageRegistry = (options: PageRegistryOptions) => {
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
        (token, key) => {
          sessionStorage.setItem(key, token);
        },
        tabToken,
        options.tabTokenKey
      );
    } catch {
      // ignore if sessionStorage is unavailable
    }
  };

  const getPageForToken = async (tabToken: string, urlHint?: string) => {
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
    await page.addInitScript(
      (token, key) => {
        sessionStorage.setItem(key, token);
      },
      tabToken,
      options.tabTokenKey
    );

    if (urlHint) {
      await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
    }

    await ensureTokenOnPage(page, tabToken);
    await bindPage(page, tabToken);
    return page;
  };

  return { bindPage, getPageForToken };
};
