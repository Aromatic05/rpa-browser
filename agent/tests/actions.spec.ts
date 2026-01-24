import { test, expect, chromium, type Browser } from '@playwright/test';
import path from 'path';
import { promises as fs } from 'fs';
import { startFixtureServer } from './helpers/server';
import type { ActionContext } from '../src/runner/execute';
import { executeCommand } from '../src/runner/execute';
import { createRecordingState } from '../src/record/recording';
import type { PageRegistry } from '../src/runtime/page_registry';

const createRegistry = (page: import('playwright').Page, tabToken: string): PageRegistry => ({
  bindPage: async () => tabToken,
  getPage: async () => page,
  listPages: () => [{ tabToken, page }],
  cleanup: () => {}
});

const createCtx = (page: import('playwright').Page, tabToken: string): ActionContext => {
  const pageRegistry = createRegistry(page, tabToken);
  const ctx: ActionContext = {
    page,
    tabToken,
    pageRegistry,
    log: () => {},
    recordingState: createRecordingState(),
    replayOptions: {
      clickDelayMs: 0,
      stepDelayMs: 0,
      scroll: { minDelta: 200, maxDelta: 300, minSteps: 1, maxSteps: 2 }
    },
    navDedupeWindowMs: 300,
    execute: undefined
  };
  ctx.execute = (cmd) => executeCommand(ctx, cmd);
  return ctx;
};

let browser: Browser;
let baseURL: string;
let closeServer: () => Promise<void>;

test.beforeAll(async () => {
  const server = await startFixtureServer();
  baseURL = server.baseURL;
  closeServer = server.close;
  browser = await chromium.launch({
    headless: true,
    args: [`--unsafely-treat-insecure-origin-as-secure=${baseURL}`]
  });
});

test.afterAll(async () => {
  await browser.close();
  await closeServer();
});

test.describe('navigation', () => {
  test('page.goto succeeds', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = createCtx(page, 'nav-token');
    const res = await executeCommand(ctx, {
      cmd: 'page.goto',
      tabToken: 'nav-token',
      args: { url: `${baseURL}/choices.html`, waitUntil: 'domcontentloaded' }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });

  test('wait.forURL times out', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = createCtx(page, 'nav-timeout');
    await page.goto(`${baseURL}/choices.html`);
    const res = await executeCommand(ctx, {
      cmd: 'wait.forURL',
      tabToken: 'nav-timeout',
      args: { urlOrPattern: 'not-found', timeout: 200 }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('element_click', () => {
  test('click updates UI', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'click-token');
    const res = await executeCommand(ctx, {
      cmd: 'element.click',
      tabToken: 'click-token',
      args: { target: { selector: '#clickMe' } }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#clickResult')).toHaveText('clicked');
    await context.close();
  });

  test('click missing selector fails', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'click-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.click',
      tabToken: 'click-fail',
      args: { target: { selector: '#does-not-exist' }, options: { timeout: 200 } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('element_form', () => {
  test('fill writes text', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'form-token');
    const res = await executeCommand(ctx, {
      cmd: 'element.fill',
      tabToken: 'form-token',
      args: { target: { selector: '#nameInput' }, text: 'hello' }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#nameResult')).toHaveText('hello');
    await context.close();
  });

  test('type fails on missing selector', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'form-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.type',
      tabToken: 'form-fail',
      args: { target: { selector: '#nope' }, text: 'x', options: { timeout: 200 } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('element_choice', () => {
  test('check and select option', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'choice-token');
    const check = await executeCommand(ctx, {
      cmd: 'element.setChecked',
      tabToken: 'choice-token',
      args: { target: { selector: '#agree' }, checked: true }
    });
    expect(check.ok).toBe(true);
    const select = await executeCommand(ctx, {
      cmd: 'element.selectOption',
      tabToken: 'choice-token',
      args: { target: { selector: '#country' }, value: 'jp' }
    });
    expect(select.ok).toBe(true);
    await context.close();
  });

  test('select option missing fails', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'choice-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.selectOption',
      tabToken: 'choice-fail',
      args: { target: { selector: '#country' }, value: 'missing' }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('element_date', () => {
  test('set date on native input', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/date.html`);
    const ctx = createCtx(page, 'date-token');
    const res = await executeCommand(ctx, {
      cmd: 'element.setDate',
      tabToken: 'date-token',
      args: { target: { selector: '#nativeDate' }, value: '2025-01-02' }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#nativeDate')).toHaveValue('2025-01-02');
    await context.close();
  });

  test('set date fails when no strategy matches', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/date.html`);
    const ctx = createCtx(page, 'date-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.setDate',
      tabToken: 'date-fail',
      args: { target: { selector: '#customDate' }, value: '2025-01-10', mode: 'picker' }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('element_scroll', () => {
  test('page.scrollBy moves viewport', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div style=\"height:2000px\"></div>');
    const ctx = createCtx(page, 'scroll-token');
    const res = await executeCommand(ctx, {
      cmd: 'page.scrollBy',
      tabToken: 'scroll-token',
      args: { dx: 0, dy: 200 }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });

  test('scrollIntoView fails for missing selector', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div style=\"height:2000px\"></div>');
    const ctx = createCtx(page, 'scroll-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.scrollIntoView',
      tabToken: 'scroll-fail',
      args: { target: { selector: '#missing' } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('dialogs_popups', () => {
  test('handle next dialog', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/dialog.html`);
    const ctx = createCtx(page, 'dialog-token');
    const handle = await executeCommand(ctx, {
      cmd: 'page.handleNextDialog',
      tabToken: 'dialog-token',
      args: { mode: 'accept' }
    });
    expect(handle.ok).toBe(true);
    const click = await executeCommand(ctx, {
      cmd: 'element.click',
      tabToken: 'dialog-token',
      args: { target: { selector: '#confirmBtn' } }
    });
    expect(click.ok).toBe(true);
    await context.close();
  });

  test('expectPopup fails when blocked', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'popup-fail');
    const res = await executeCommand(ctx, {
      cmd: 'page.expectPopup',
      tabToken: 'popup-fail',
      args: {
        action: { cmd: 'element.click', tabToken: 'popup-fail', args: { target: { selector: '#clickMe' } } },
        timeout: 300
      }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('clipboard', () => {
  test('clipboard write/read', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'clip-token');
    const writeRes = await executeCommand(ctx, {
      cmd: 'clipboard.write',
      tabToken: 'clip-token',
      args: { text: 'hello-clip' }
    });
    expect(writeRes.ok).toBe(true);
    const readRes = await executeCommand(ctx, {
      cmd: 'clipboard.read',
      tabToken: 'clip-token',
      args: {}
    });
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.data.text).toContain('hello-clip');
    }
    await context.close();
  });

  test('paste requires allowSensitive', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'clip-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.paste',
      tabToken: 'clip-fail',
      args: { target: { selector: '#nameInput' }, text: 'secret' }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('keyboard_mouse', () => {
  test('keyboard press triggers handler', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<input id=\"field\" /><div id=\"out\"></div><script>document.getElementById(\"field\").addEventListener(\"keydown\", e=>{if(e.key===\"Enter\")document.getElementById(\"out\").textContent=\"ok\";});</script>');
    await page.focus('#field');
    const ctx = createCtx(page, 'key-token');
    const res = await executeCommand(ctx, {
      cmd: 'keyboard.press',
      tabToken: 'key-token',
      args: { key: 'Enter' }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#out')).toHaveText('ok');
    await context.close();
  });

  test('dragAndDrop fails for missing target', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/drag.html`);
    const ctx = createCtx(page, 'drag-fail');
    const res = await executeCommand(ctx, {
      cmd: 'mouse.dragAndDrop',
      tabToken: 'drag-fail',
      args: { from: { selector: '#missing' }, to: { selector: '#target' } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('file_upload', () => {
  test('set files from path', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'file-token');
    const tmpPath = path.join(process.cwd(), 'tests/fixtures/tmp.txt');
    await fs.writeFile(tmpPath, 'hello');
    const res = await executeCommand(ctx, {
      cmd: 'element.setFilesFromPath',
      tabToken: 'file-token',
      args: { target: { selector: '#fileInput' }, paths: [tmpPath] }
    });
    expect(res.ok).toBe(true);
    await fs.unlink(tmpPath);
    await context.close();
  });

  test('set files from missing path fails', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'file-fail');
    const res = await executeCommand(ctx, {
      cmd: 'element.setFilesFromPath',
      tabToken: 'file-fail',
      args: { target: { selector: '#fileInput' }, paths: ['missing.txt'] }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('waits_asserts', () => {
  test('assert text contains', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'assert-token');
    const res = await executeCommand(ctx, {
      cmd: 'assert.text',
      tabToken: 'assert-token',
      args: { target: { selector: '#clickResult' }, contains: 'idle' }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });

  test('assert visible fails', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div id=\"hidden\" style=\"display:none\">hidden</div>');
    const ctx = createCtx(page, 'assert-fail');
    const res = await executeCommand(ctx, {
      cmd: 'assert.visible',
      tabToken: 'assert-fail',
      args: { target: { selector: '#hidden' }, value: true }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});

test.describe('replay self heal', () => {
  test('fallback from css to role within scope', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/menu-replay.html`);
    const ctx = createCtx(page, 'replay-token');
    const events = [
      {
        tabToken: 'replay-token',
        ts: Date.now(),
        type: 'click',
        selector: 'aside nav.menu > a:nth-of-type(5)',
        scopeHint: 'aside',
        locatorCandidates: [
          { kind: 'css', selector: 'aside nav.menu > a:nth-of-type(5)' },
          { kind: 'role', role: 'link', name: 'Orders', exact: true },
          { kind: 'text', text: 'Orders', exact: true }
        ]
      }
    ];
    const replay = await import('../src/play/replay');
    const res = await replay.replayRecording(page, events as any, ctx.replayOptions, { stopOnError: true }, ctx.execute!);
    expect(res.ok).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
    await context.close();
  });

  test('ambiguous candidate skipped', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/menu-replay.html`);
    const ctx = createCtx(page, 'replay-token-2');
    const events = [
      {
        tabToken: 'replay-token-2',
        ts: Date.now(),
        type: 'click',
        selector: 'a',
        scopeHint: 'aside',
        locatorCandidates: [
          { kind: 'css', selector: 'a' },
          { kind: 'role', role: 'link', name: 'Orders', exact: true }
        ]
      }
    ];
    const replay = await import('../src/play/replay');
    const res = await replay.replayRecording(page, events as any, ctx.replayOptions, { stopOnError: true }, ctx.execute!);
    expect(res.ok).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
    await context.close();
  });
});

test.describe('a11y scan', () => {
  test('detects violations', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/a11y-broken.html`);
    const ctx = createCtx(page, 'a11y-token');
    const res = await executeCommand(ctx, {
      cmd: 'page.a11yScan',
      tabToken: 'a11y-token',
      args: { resultDetail: 'summary' }
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.violations.length).toBeGreaterThan(0);
    }
    await context.close();
  });

  test('ok page returns zero violations', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/a11y-ok.html`);
    const ctx = createCtx(page, 'a11y-ok');
    const res = await executeCommand(ctx, {
      cmd: 'page.a11yScan',
      tabToken: 'a11y-ok',
      args: { resultDetail: 'summary' }
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.violations.length).toBe(0);
    }
    await context.close();
  });

  test('impact filter works', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/a11y-broken.html`);
    const ctx = createCtx(page, 'a11y-filter');
    const res = await executeCommand(ctx, {
      cmd: 'page.a11yScan',
      tabToken: 'a11y-filter',
      args: { includedImpacts: ['critical'] }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });
});
