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

const recorderSource = String.raw`(function () {
  if (window.__rpa_recorder_installed) return;
  window.__rpa_recorder_installed = true;

  var tokenKey = '__rpa_tab_token';
  var specialKeys = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  var getToken = function () { return sessionStorage.getItem(tokenKey); };

  var safeEscape = function (value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, '');
  };

  var selectorFor = function (el) {
    if (!el || !el.tagName) return null;
    var dataAttrs = ['data-testid', 'data-test', 'data-qa'];
    for (var i = 0; i < dataAttrs.length; i += 1) {
      var attr = dataAttrs[i];
      var val = el.getAttribute(attr);
      if (val) return '[' + attr + '="' + safeEscape(val) + '"]';
    }
    if (el.id) return '#' + safeEscape(el.id);
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 7) {
      var tag = node.tagName.toLowerCase();
      var part = tag;
      var classList = Array.from(node.classList || []).slice(0, 2).map(safeEscape);
      if (classList.length) {
        part += '.' + classList.join('.');
      }
      if (node.parentElement) {
        var siblings = Array.from(node.parentElement.children).filter(function (child) {
          return child.tagName === node.tagName;
        });
        if (siblings.length > 1) {
          var index = siblings.indexOf(node) + 1;
          part += ':nth-of-type(' + index + ')';
        }
      }
      parts.unshift(part);
      if (node.id) break;
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  var emit = function (payload) {
    var tabToken = getToken();
    if (!tabToken) return;
    window.__rpa_record({
      tabToken: tabToken,
      ts: Date.now(),
      url: location.href,
      ...payload
    });
  };

  var isPassword = function (el) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'password' || el.getAttribute('autocomplete') === 'current-password';
  };

  var getValue = function (el) {
    if (isPassword(el)) return '***';
    if ('value' in el) return el.value;
    return el.textContent || '';
  };

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({ type: 'click', selector: selector, targetHint: target.tagName.toLowerCase() });
  }, true);

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({ type: 'input', selector: selector, value: getValue(target) });
  }, true);

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({ type: 'change', selector: selector, value: getValue(target) });
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!specialKeys.has(event.key)) return;
    var target = event.target;
    var selector = target instanceof Element ? selectorFor(target) : null;
    emit({ type: 'keydown', selector: selector, key: event.key });
  }, true);

  var scrollTimer = null;
  var onScroll = function () {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(function () {
      scrollTimer = null;
      emit({ type: 'scroll' });
    }, 200);
  };
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
})();`;

export const installRecorder = async (
  page: Page,
  onEvent: (event: RecordedEvent) => void
) => {
  if (installedPages.has(page)) return;
  installedPages.add(page);

  try {
    await page.exposeBinding(bindingName, (source, event: RecordedEvent) => {
      console.log('[RPA:agent]', 'record event', event.type, event.url || event.selector || '');
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
