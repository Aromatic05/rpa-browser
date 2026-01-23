import { WebSocketServer } from 'ws';
import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { installRecorder, type RecordedEvent } from './recorder';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionPath = path.resolve(__dirname, '../../extension');
const userDataDir = path.resolve(__dirname, '../.user-data');
const TAB_TOKEN_KEY = '__rpa_tab_token';

let contextPromise: Promise<BrowserContext> | undefined;
let contextRef: BrowserContext | undefined;

const tokenToPage = new Map<string, Page>();
const recordingEnabled = new Set<string>();
const recordings = new Map<string, RecordedEvent[]>();
const lastNavigateTs = new Map<string, number>();
const lastClickTs = new Map<string, number>();
const navListenerPages = new WeakSet<Page>();

const log = (...args: unknown[]) => console.log('[RPA:agent]', ...args);

const wss = new WebSocketServer({ host: '127.0.0.1', port: 17333 });

wss.on('listening', () => {
  log('WS listening on ws://127.0.0.1:17333');
});

const getContext = async () => {
  if (contextRef) return contextRef;
  if (contextPromise) return contextPromise;
  log('Launching Chromium with extension from', extensionPath);
  contextPromise = chromium
    .launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    })
    .then((context) => {
      contextRef = context;
      context.on('close', () => {
        contextRef = undefined;
        contextPromise = undefined;
      });
      context.on('page', (page) => {
        void bindPage(page);
      });
      return context;
    })
    .catch((error) => {
      contextPromise = undefined;
      contextRef = undefined;
      throw error;
    });
  return contextPromise;
};

const waitForToken = async (page: Page, attempts = 20, delayMs = 200) => {
  for (let i = 0; i < attempts; i += 1) {
    if (page.isClosed()) return null;
    try {
      const token = await page.evaluate((key) => sessionStorage.getItem(key), TAB_TOKEN_KEY);
      if (token) return token;
    } catch {
      // ignore evaluation failures while page is loading
    }
    await page.waitForTimeout(delayMs);
  }
  return null;
};

const recordEvent = (event: RecordedEvent) => {
  const tabToken = event.tabToken;
  if (!tabToken || !recordingEnabled.has(tabToken)) return;

  if (event.type === 'click') {
    lastClickTs.set(tabToken, event.ts);
  }

  if (event.type === 'navigate') {
    const last = lastNavigateTs.get(tabToken) || 0;
    if (event.ts - last < NAV_DEDUPE_WINDOW_MS) {
      return;
    }
    lastNavigateTs.set(tabToken, event.ts);
  }

  const list = recordings.get(tabToken) || [];
  list.push(event);
  recordings.set(tabToken, list);
  log('record', { tabToken, type: event.type, url: event.url });
};

const installNavigationRecorder = (page: Page, tabToken: string) => {
  if (navListenerPages.has(page)) return;
  navListenerPages.add(page);
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    if (!recordingEnabled.has(tabToken)) return;
    const lastClick = lastClickTs.get(tabToken) || 0;
    const source = Date.now() - lastClick < NAV_DEDUPE_WINDOW_MS ? 'click' : 'direct';
    recordEvent({
      tabToken,
      ts: Date.now(),
      type: 'navigate',
      url: frame.url(),
      source
    });
  });
};

const bindPage = async (page: Page, hintedToken?: string) => {
  if (page.isClosed()) return null;
  const token = hintedToken || (await waitForToken(page));
  if (!token) return null;
  tokenToPage.set(token, page);
  log('bind page', { tabToken: token, pageUrl: page.url() });
  page.on('close', () => {
    const current = tokenToPage.get(token);
    if (current === page) {
      tokenToPage.delete(token);
      recordingEnabled.delete(token);
      recordings.delete(token);
    }
  });
  if (recordingEnabled.has(token)) {
    void installRecorder(page, recordEvent);
    installNavigationRecorder(page, token);
  }
  return token;
};

const rebuildTokenMap = async () => {
  const context = await getContext();
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
      TAB_TOKEN_KEY
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

  const context = await getContext();
  page = await context.newPage();
  await page.addInitScript(
    (token, key) => {
      sessionStorage.setItem(key, token);
    },
    tabToken,
    TAB_TOKEN_KEY
  );

  if (urlHint) {
    await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
  }

  await ensureTokenOnPage(page, tabToken);
  await bindPage(page, tabToken);
  return page;
};

const getA11ySnapshot = async (page: Page) => {
  if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
    return page.accessibility.snapshot({ interestingOnly: false });
  }

  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  return { nodes };
};

type Target = {
  strategy?: 'css' | 'role' | 'text';
  css?: string;
  role?: string;
  name?: string;
  text?: string;
};

const resolveTarget = async (page: Page, target?: Target) => {
  if (!target) {
    throw new Error('missing target');
  }
  let locator;
  if (target.strategy === 'css' && target.css) {
    locator = page.locator(target.css).first();
  } else if (target.role) {
    locator = page.getByRole(target.role as 'button', { name: target.name || undefined }).first();
  } else if (target.text) {
    locator = page.getByText(target.text, { exact: false }).first();
  } else {
    throw new Error('unsupported target');
  }
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator;
};

const resolveSelector = async (page: Page, selector?: string) => {
  if (!selector) {
    throw new Error('missing selector');
  }
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator;
};

const CLICK_DELAY_MS = 300;
const REPLAY_STEP_DELAY_MS = 900;
const NAV_DEDUPE_WINDOW_MS = 1200;
const SCROLL_MIN_DELTA = 220;
const SCROLL_MAX_DELTA = 520;
const SCROLL_MIN_STEPS = 2;
const SCROLL_MAX_STEPS = 4;

const highlightLocator = async (locator: ReturnType<Page['locator']>) => {
  try {
    await locator.evaluate((el: HTMLElement) => {
      el.dataset.rpaHighlight = 'true';
      el.style.outline = '2px solid #f97316';
      el.style.outlineOffset = '2px';
    });
  } catch {
    // ignore highlight failures
  }
};

const clearHighlight = async (locator: ReturnType<Page['locator']>) => {
  try {
    await locator.evaluate((el: HTMLElement) => {
      if (el.dataset.rpaHighlight) {
        delete el.dataset.rpaHighlight;
      }
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  } catch {
    // ignore cleanup failures
  }
};

const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const performHumanScroll = async (page: Page) => {
  const steps = randomBetween(SCROLL_MIN_STEPS, SCROLL_MAX_STEPS);
  for (let i = 0; i < steps; i += 1) {
    const deltaY = randomBetween(SCROLL_MIN_DELTA, SCROLL_MAX_DELTA);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(randomBetween(80, 180));
  }
};

const handleReplay = async (page: Page, tabToken: string) => {
  const events = recordings.get(tabToken) || [];
  const results: Array<Record<string, unknown>> = [];
  let pendingScroll = false;
  for (const event of events) {
    try {
      if (event.type === 'navigate') {
        await page.goto(event.url || 'about:blank', { waitUntil: 'domcontentloaded' });
        pendingScroll = false;
      } else if (event.type === 'click') {
        const locator = await resolveSelector(page, event.selector);
        if (pendingScroll) {
          await locator.scrollIntoViewIfNeeded();
          pendingScroll = false;
        }
        await highlightLocator(locator);
        await page.waitForTimeout(CLICK_DELAY_MS);
        try {
          await locator.click();
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        } finally {
          await clearHighlight(locator);
        }
      } else if (event.type === 'input' || event.type === 'change') {
        if (event.value === '***') {
          results.push({ ts: event.ts, ok: true, note: 'password redacted' });
          continue;
        }
        const locator = await resolveSelector(page, event.selector);
        if (pendingScroll) {
          await locator.scrollIntoViewIfNeeded();
          pendingScroll = false;
        }
        await highlightLocator(locator);
        await page.waitForTimeout(CLICK_DELAY_MS);
        try {
          await locator.fill(event.value || '');
        } finally {
          await clearHighlight(locator);
        }
      } else if (event.type === 'keydown') {
        if (event.selector) {
          const locator = await resolveSelector(page, event.selector);
          if (pendingScroll) {
            await locator.scrollIntoViewIfNeeded();
            pendingScroll = false;
          }
          await locator.press(event.key || 'Enter');
        } else if (event.key) {
          await page.keyboard.press(event.key);
        }
      } else if (event.type === 'scroll') {
        await performHumanScroll(page);
        pendingScroll = true;
        results.push({ ts: event.ts, ok: true, type: event.type, pageUrl: page.url() });
        continue;
      }
      await page.waitForTimeout(REPLAY_STEP_DELAY_MS);
      results.push({ ts: event.ts, ok: true, type: event.type, pageUrl: page.url() });
    } catch (error) {
      results.push({
        ts: event.ts,
        ok: false,
        type: event.type,
        error: error instanceof Error ? error.message : String(error)
      });
      return { ok: false, tabToken, error: 'replay failed', data: { results } };
    }
  }
  return { ok: true, tabToken, data: { results } };
};

type CommandPayload = {
  cmd: string;
  tabToken?: string;
  urlHint?: string;
  target?: Target;
  text?: string;
  timeline?: { steps?: Array<{ type: string; url?: string; target?: Target; text?: string; id?: string; ms?: number }> };
};

const handleCommand = async (command?: CommandPayload) => {
  if (!command?.cmd) {
    return { ok: false, error: 'missing cmd' };
  }

  const tabToken = command.tabToken || '';
  const page = await getPageForToken(tabToken, command.urlHint);

  if (command.cmd === 'startRecording') {
    recordingEnabled.add(tabToken);
    if (!recordings.has(tabToken)) {
      recordings.set(tabToken, []);
    }
    lastNavigateTs.set(tabToken, 0);
    lastClickTs.set(tabToken, 0);
    await installRecorder(page, recordEvent);
    installNavigationRecorder(page, tabToken);
    log('recording start', { tabToken, pageUrl: page.url() });
    return { ok: true, tabToken, data: { pageUrl: page.url() } };
  }

  if (command.cmd === 'stopRecording') {
    recordingEnabled.delete(tabToken);
    lastNavigateTs.delete(tabToken);
    lastClickTs.delete(tabToken);
    log('recording stop', { tabToken, pageUrl: page.url() });
    return { ok: true, tabToken, data: { pageUrl: page.url() } };
  }

  if (command.cmd === 'getRecording') {
    const events = recordings.get(tabToken) || [];
    return { ok: true, tabToken, data: { events } };
  }

  if (command.cmd === 'replayRecording') {
    return handleReplay(page, tabToken);
  }

  if (command.cmd === 'runDemo') {
    const title = await page.title();
    const pageUrl = page.url();
    return { ok: true, tabToken, pageUrl, title };
  }

  if (command.cmd === 'getA11y') {
    const snapshot = await getA11ySnapshot(page);
    const pageUrl = page.url();
    return { ok: true, tabToken, pageUrl, snapshot };
  }

  if (command.cmd === 'click') {
    const locator = await resolveTarget(page, command.target);
    await highlightLocator(locator);
    await page.waitForTimeout(CLICK_DELAY_MS);
    try {
      await locator.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    } finally {
      await clearHighlight(locator);
    }
    return { ok: true, tabToken, pageUrl: page.url() };
  }

  if (command.cmd === 'type') {
    const locator = await resolveTarget(page, command.target);
    await highlightLocator(locator);
    await page.waitForTimeout(CLICK_DELAY_MS);
    try {
      await locator.click({ force: true });
      await locator.fill(command.text || '');
    } finally {
      await clearHighlight(locator);
    }
    return { ok: true, tabToken, pageUrl: page.url() };
  }

  if (command.cmd === 'play') {
    const results: Array<Record<string, unknown>> = [];
    for (const step of command.timeline?.steps || []) {
      try {
        if (step.type === 'goto') {
          await page.goto(step.url || 'about:blank', { waitUntil: 'domcontentloaded' });
        } else if (step.type === 'click') {
          const locator = await resolveTarget(page, step.target);
          await highlightLocator(locator);
          await page.waitForTimeout(CLICK_DELAY_MS);
          try {
            await locator.click();
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          } finally {
            await clearHighlight(locator);
          }
        } else if (step.type === 'type') {
          const locator = await resolveTarget(page, step.target);
          await highlightLocator(locator);
          await page.waitForTimeout(CLICK_DELAY_MS);
          try {
            await locator.click({ force: true });
            await locator.fill(step.text || '');
          } finally {
            await clearHighlight(locator);
          }
        } else if (step.type === 'wait') {
          await page.waitForTimeout(step.ms || 0);
        } else if (step.type === 'a11y') {
          await getA11ySnapshot(page);
        }
        results.push({ stepId: step.id, ok: true });
      } catch (error) {
        results.push({
          stepId: step.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
        return { ok: false, error: 'playback failed', tabToken, pageUrl: page.url(), data: { results } };
      }
    }
    return { ok: true, tabToken, pageUrl: page.url(), data: { results } };
  }

  return { ok: false, tabToken, error: 'unknown cmd' };
};

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let payload: { cmd?: CommandPayload } | undefined;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      socket.send(JSON.stringify({ ok: false, error: 'invalid json' }));
      return;
    }

    (async () => {
      try {
        const response = await handleCommand(payload?.cmd);
        socket.send(JSON.stringify(response));
      } catch (error) {
        socket.send(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }
    })();
  });
});

(async () => {
  try {
    await getContext();
    log('Playwright Chromium launched with extension.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('Failed to launch Playwright Chromium:', message);
  }
})();
