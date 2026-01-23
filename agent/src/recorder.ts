import type { Page } from 'playwright';

const installedPages = new WeakSet<Page>();
const bindingName = '__rpa_record';

export type RecordedEventType =
  | 'click'
  | 'input'
  | 'change'
  | 'keydown'
  | 'navigate'
  | 'scroll';

export type RecordedEvent = {
  tabToken: string;
  ts: number;
  type: RecordedEventType;
  url?: string;
  selector?: string;
  targetHint?: string;
  value?: string;
  key?: string;
  source?: 'click' | 'direct';
  pageUrl?: string | null;
};

const recorderSource = `
(() => {
  if (window.__rpa_recorder_installed) return;
  window.__rpa_recorder_installed = true;

  const tokenKey = '__rpa_tab_token';
  const bindingName = '__rpa_record';
  const specialKeys = new Set([
    'Enter',
    'Escape',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight'
  ]);

  const getToken = () => sessionStorage.getItem(tokenKey);

  const safeEscape = (value) => {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, '');
  };

  const selectorFor = (el) => {
    if (!el || !el.tagName) return null;
    const dataAttrs = ['data-testid', 'data-test', 'data-qa'];
    for (const attr of dataAttrs) {
      const val = el.getAttribute(attr);
      if (val) return `[\${attr}="\${safeEscape(val)}"]`;
    }
    if (el.id) return `#\${safeEscape(el.id)}`;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 7) {
      const tag = node.tagName.toLowerCase();
      let part = tag;
      const classList = Array.from(node.classList || []).slice(0, 2).map(safeEscape);
      if (classList.length) {
        part += `.\${classList.join('.')}`;
      }
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(
          (child) => child.tagName === node.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(node) + 1;
          part += `:nth-of-type(\${index})`;
        }
      }
      parts.unshift(part);
      if (node.id) break;
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const emit = (payload) => {
    const tabToken = getToken();
    if (!tabToken) return;
    window[bindingName]({
      tabToken,
      ts: Date.now(),
      url: location.href,
      ...payload
    });
  };

  const isPassword = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'password' || el.getAttribute('autocomplete') === 'current-password';
  };

  const getValue = (el) => {
    if (isPassword(el)) return '***';
    if ('value' in el) return el.value;
    return el.textContent || '';
  };

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const selector = selectorFor(target);
      if (!selector) return;
      emit({ type: 'click', selector, targetHint: target.tagName.toLowerCase() });
    },
    true
  );

  document.addEventListener(
    'input',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const selector = selectorFor(target);
      if (!selector) return;
      emit({ type: 'input', selector, value: getValue(target) });
    },
    true
  );

  document.addEventListener(
    'change',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const selector = selectorFor(target);
      if (!selector) return;
      emit({ type: 'change', selector, value: getValue(target) });
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!specialKeys.has(event.key)) return;
      const target = event.target;
      const selector = target instanceof Element ? selectorFor(target) : null;
      emit({ type: 'keydown', selector, key: event.key });
    },
    true
  );

  let scrollTimer = null;
  const onScroll = () => {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
    }
    scrollTimer = window.setTimeout(() => {
      scrollTimer = null;
      emit({ type: 'scroll' });
    }, 200);
  };
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
})();
`;

export const installRecorder = async (
  page: Page,
  onEvent: (event: RecordedEvent) => void
) => {
  if (installedPages.has(page)) return;
  installedPages.add(page);

  try {
    await page.exposeBinding(bindingName, (source, event: RecordedEvent) => {
      onEvent({
        ...event,
        pageUrl: source.page?.url?.() || null
      });
    });
  } catch {
    // ignore if binding already exists
  }

  await page.addInitScript({ content: recorderSource });
  try {
    await page.evaluate(recorderSource);
  } catch {
    // ignore if page is not ready yet
  }
};
