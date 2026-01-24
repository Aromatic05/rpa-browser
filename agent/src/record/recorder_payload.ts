export const RECORDER_SOURCE = String.raw`(function () {
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
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({ type: 'click', selector: selector, targetHint: target.tagName.toLowerCase() });
  }, true);

  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({ type: 'input', selector: selector, value: getValue(target) });
  }, true);

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    if (target instanceof HTMLInputElement) {
      var inputType = (target.type || '').toLowerCase();
      if (inputType === 'checkbox' || inputType === 'radio') {
        emit({ type: 'check', selector: selector, checked: target.checked, inputType: inputType });
        return;
      }
      if (inputType === 'date') {
        emit({ type: 'date', selector: selector, value: target.value });
        return;
      }
    }
    if (target instanceof HTMLSelectElement) {
      var option = target.selectedOptions && target.selectedOptions[0];
      emit({ type: 'select', selector: selector, value: target.value, label: option ? option.label : '' });
      return;
    }
    emit({ type: 'change', selector: selector, value: getValue(target) });
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!specialKeys.has(event.key)) return;
    var target = event.target;
    if (target && target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = target instanceof Element ? selectorFor(target) : null;
    emit({ type: 'keydown', selector: selector, key: event.key });
  }, true);

  document.addEventListener('paste', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    if (isPassword(target)) return;
    emit({ type: 'paste', selector: selector, value: getValue(target) });
  }, true);

  document.addEventListener('copy', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({ type: 'copy', selector: selector });
  }, true);

  var scrollTimer = null;
  var onScroll = function () {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(function () {
      scrollTimer = null;
      emit({ type: 'scroll', scrollX: window.scrollX, scrollY: window.scrollY });
    }, 200);
  };
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
})();`;
