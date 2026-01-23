(() => {
  if (window.top !== window) return;
  if ((window as any).__rpaTokenInjected) return;
  (window as any).__rpaTokenInjected = true;

  const TAB_TOKEN_KEY = '__rpa_tab_token';
  let tabToken = sessionStorage.getItem(TAB_TOKEN_KEY);
  if (!tabToken) {
    tabToken = crypto.randomUUID();
    sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
  }

  const sendHello = () => {
    console.log('[RPA] HELLO', { tabToken, url: location.href });
    chrome.runtime.sendMessage({
      type: 'RPA_HELLO',
      tabToken,
      url: location.href
    });
  };

  chrome.runtime.onMessage.addListener(
    (message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    if (message?.type === 'RPA_GET_TOKEN') {
      sendResponse({ ok: true, tabToken, url: location.href });
      return true;
    }
  });

  const patchHistory = () => {
    const wrap = (method: typeof history.pushState) =>
      function (...args: Parameters<typeof history.pushState>) {
        const result = method.apply(history, args as unknown as [any, any, any]);
        sendHello();
        return result;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
  };

  patchHistory();
  window.addEventListener('popstate', sendHello);
  window.addEventListener('hashchange', sendHello);
  sendHello();

  const ROOT_ID = 'rpa-floating-panel';
  if (document.getElementById(ROOT_ID)) return;

  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.position = 'fixed';
  host.style.top = '16px';
  host.style.right = '16px';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'auto';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .ball {
      width: 44px; height: 44px; border-radius: 999px; border: none;
      background: #111827; color: #f9fafb; font-size: 12px; font-weight: 600;
      cursor: pointer; box-shadow: 0 10px 20px rgba(15, 23, 42, 0.3);
    }
    .panel {
      width: 260px; padding: 10px; border-radius: 12px; background: #fff;
      box-shadow: 0 12px 26px rgba(15, 23, 42, 0.2); border: 1px solid #e2e8f0;
      display: none;
    }
    .panel.open { display: block; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
    button {
      padding: 6px 8px; font-size: 12px; border-radius: 8px;
      border: 1px solid #cbd5f5; background: #fff; cursor: pointer;
    }
    button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    pre {
      margin: 6px 0 0; background: #0f172a; color: #e2e8f0;
      padding: 6px; border-radius: 8px; font-size: 11px; max-height: 140px; overflow: auto;
      white-space: pre-wrap;
    }
    .meta { font-size: 11px; color: #6b7280; margin-bottom: 6px; }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const ball = document.createElement('button');
  ball.className = 'ball';
  ball.textContent = 'RPA';

  const panel = document.createElement('div');
  panel.className = 'panel';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `tabToken: ${tabToken.slice(0, 8)}…`;

  const row1 = document.createElement('div');
  row1.className = 'row';
  const startBtn = document.createElement('button');
  startBtn.className = 'primary';
  startBtn.textContent = 'Start Rec';
  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'Stop Rec';
  row1.append(startBtn, stopBtn);

  const row2 = document.createElement('div');
  row2.className = 'row';
  const showBtn = document.createElement('button');
  showBtn.textContent = 'Show Rec';
  const replayBtn = document.createElement('button');
  replayBtn.className = 'primary';
  replayBtn.textContent = 'Replay';
  row2.append(showBtn, replayBtn);

  const out = document.createElement('pre');

  panel.append(meta, row1, row2, out);
  wrap.append(ball, panel);
  shadow.append(style, wrap);

  const mount = () => {
    if (!document.documentElement) {
      setTimeout(mount, 50);
      return;
    }
    document.documentElement.appendChild(host);
  };
  mount();

  let isOpen = false;
  ball.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
  });

  const render = (payload: unknown) => {
    out.textContent = JSON.stringify(payload, null, 2);
  };

  const sendPanelCommand = (type: string) => {
    chrome.runtime.sendMessage({ type }, (response: any) => {
      if (chrome.runtime.lastError) {
        render({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      render(response);
    });
  };

  startBtn.addEventListener('click', () => sendPanelCommand('START_RECORDING'));
  stopBtn.addEventListener('click', () => sendPanelCommand('STOP_RECORDING'));
  showBtn.addEventListener('click', () => sendPanelCommand('GET_RECORDING'));
  replayBtn.addEventListener('click', () => sendPanelCommand('REPLAY_RECORDING'));
})();
