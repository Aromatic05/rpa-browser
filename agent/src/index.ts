import { WebSocketServer } from 'ws';
import { createContextManager, resolvePaths } from './runtime/context';
import { createPageRegistry } from './runtime/page_registry';
import { createRecordingState, startRecording, stopRecording, getRecording, cleanupRecording, ensureRecorder } from './record/recording';
import { replayRecording } from './play/replay';
import { resolveTarget } from './runner/actions/locators';
import { clickByTarget } from './runner/actions/click';
import { typeByTarget } from './runner/actions/type';
import { highlightLocator, clearHighlight } from './runner/actions/highlight';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const CLICK_DELAY_MS = 300;
const REPLAY_STEP_DELAY_MS = 900;
const NAV_DEDUPE_WINDOW_MS = 1200;
const SCROLL_CONFIG = { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 };

const log = (...args: unknown[]) => console.log('[RPA:agent]', ...args);

const paths = resolvePaths();
const recordingState = createRecordingState();

const contextManager = createContextManager({
  extensionPath: paths.extensionPath,
  userDataDir: paths.userDataDir,
  onPage: (page) => {
    void pageRegistry.bindPage(page);
  }
});

const pageRegistry = createPageRegistry({
  tabTokenKey: TAB_TOKEN_KEY,
  getContext: contextManager.getContext,
  onPageBound: (page, token) => {
    if (recordingState.recordingEnabled.has(token)) {
      void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
    }
  },
  onTokenClosed: (token) => cleanupRecording(recordingState, token)
});


type CommandPayload = {
  cmd: string;
  tabToken?: string;
  urlHint?: string;
  target?: any;
  text?: string;
};

const handleCommand = async (command?: CommandPayload) => {
  if (!command?.cmd) {
    return { ok: false, error: 'missing cmd' };
  }

  const tabToken = command.tabToken || '';
  const page = await pageRegistry.getPageForToken(tabToken, command.urlHint);

  if (command.cmd === 'startRecording') {
    await startRecording(recordingState, page, tabToken, NAV_DEDUPE_WINDOW_MS);
    log('recording start', { tabToken, pageUrl: page.url() });
    return { ok: true, tabToken, data: { pageUrl: page.url() } };
  }

  if (command.cmd === 'stopRecording') {
    stopRecording(recordingState, tabToken);
    log('recording stop', { tabToken, pageUrl: page.url() });
    return { ok: true, tabToken, data: { pageUrl: page.url() } };
  }

  if (command.cmd === 'getRecording') {
    const events = getRecording(recordingState, tabToken);
    return { ok: true, tabToken, data: { events } };
  }

  if (command.cmd === 'replayRecording') {
    const events = getRecording(recordingState, tabToken);
    const response = await replayRecording(page, events, {
      clickDelayMs: CLICK_DELAY_MS,
      stepDelayMs: REPLAY_STEP_DELAY_MS,
      scroll: SCROLL_CONFIG
    });
    return { ...response, tabToken };
  }

  if (command.cmd === 'runDemo') {
    const title = await page.title();
    return { ok: true, tabToken, pageUrl: page.url(), title };
  }

  if (command.cmd === 'click') {
    await clickByTarget(page, command.target, CLICK_DELAY_MS);
    return { ok: true, tabToken, pageUrl: page.url() };
  }

  if (command.cmd === 'type') {
    await typeByTarget(page, command.target, command.text || '', CLICK_DELAY_MS);
    return { ok: true, tabToken, pageUrl: page.url() };
  }

  if (command.cmd === 'highlight') {
    const locator = await resolveTarget(page, command.target);
    await highlightLocator(locator);
    await page.waitForTimeout(500);
    await clearHighlight(locator);
    return { ok: true, tabToken, pageUrl: page.url() };
  }

  return { ok: false, tabToken, error: 'unknown cmd' };
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: 17333 });

wss.on('listening', () => {
  log('WS listening on ws://127.0.0.1:17333');
});

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
    await contextManager.getContext();
    log('Playwright Chromium launched with extension.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('Failed to launch Playwright Chromium:', message);
  }
})();
