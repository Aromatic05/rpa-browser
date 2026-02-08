/**
 * recorder_payload：注入到页面的录制脚本（纯字符串）。
 *
 * 说明：
 * - 该脚本运行在浏览器上下文，负责采集用户操作并通过绑定上报
 * - 仅收集可复现的动作与定位候选，不执行自动化
 * - 严格限制采样量与敏感信息（密码/长文本会被脱敏）
 */
export const RECORDER_SOURCE = String.raw`(function () {
  if (window.__rpa_recorder_installed) return;
  window.__rpa_recorder_installed = true;
  try { console.warn('[recorder] installed', location.href); } catch {}

  var tokenKey = '__rpa_tab_token';
  var specialKeys = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  var getToken = function () {
    try {
      var fromSession = sessionStorage.getItem(tokenKey);
      if (fromSession) return fromSession;
    } catch {}
    try {
      var fromWindow = window.__rpa_tab_token || window.__TAB_TOKEN__;
      if (fromWindow) return fromWindow;
    } catch {}
    try {
      if (window.top && window.top !== window) {
        var fromTop = window.top.sessionStorage && window.top.sessionStorage.getItem(tokenKey);
        if (fromTop) return fromTop;
        var fromTopWin = window.top.__rpa_tab_token || window.top.__TAB_TOKEN__;
        if (fromTopWin) return fromTopWin;
      }
    } catch {}
    try {
      if (window.parent && window.parent !== window) {
        var fromParent = window.parent.sessionStorage && window.parent.sessionStorage.getItem(tokenKey);
        if (fromParent) return fromParent;
        var fromParentWin = window.parent.__rpa_tab_token || window.parent.__TAB_TOKEN__;
        if (fromParentWin) return fromParentWin;
      }
    } catch {}
    return null;
  };

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

  var normalizeText = function (value) {
    return (value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  };

  var getRole = function (el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.getAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return null;
  };

  var getLabelText = function (el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return normalizeText(aria);
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ids = labelledBy.split(/\\s+/);
      var parts = ids.map(function (id) {
        var node = document.getElementById(id);
        return node ? normalizeText(node.innerText || node.textContent || '') : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    var id = el.getAttribute('id');
    if (id) {
      var label = document.querySelector('label[for="' + id + '"]');
      if (label) return normalizeText(label.innerText || label.textContent || '');
    }
    var wrapLabel = el.closest('label');
    if (wrapLabel) return normalizeText(wrapLabel.innerText || wrapLabel.textContent || '');
    return null;
  };

  var getTestId = function (el) {
    var node = el.closest('[data-testid],[data-test],[data-qa]');
    if (!node) return null;
    return node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-qa');
  };

  var getScopeHint = function (el) {
    if (el.closest('aside')) return 'aside';
    if (el.closest('header')) return 'header';
    if (el.closest('main')) return 'main';
    return null;
  };

  var getTextCandidate = function (el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'li' || tag === 'span') {
      return normalizeText(el.innerText || el.textContent || '');
    }
    return null;
  };

  var buildCandidates = function (el) {
    var candidates = [];
    var testId = getTestId(el);
    if (testId) {
      candidates.push({ kind: 'testid', testId: testId, note: 'data-testid' });
    }
    var role = getRole(el);
    var name = getLabelText(el) || normalizeText(el.innerText || el.textContent || '') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value');
    if (role && name) {
      candidates.push({ kind: 'role', role: role, name: normalizeText(String(name)), exact: true });
    }
    var labelText = getLabelText(el);
    if (labelText) {
      candidates.push({ kind: 'label', text: labelText, exact: true });
    }
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      candidates.push({ kind: 'placeholder', text: normalizeText(placeholder), exact: true });
    }
    var text = getTextCandidate(el);
    if (text) {
      candidates.push({ kind: 'text', text: text, exact: true });
    }
    var css = selectorFor(el);
    if (css) {
      candidates.push({ kind: 'css', selector: css });
    }
    return candidates;
  };

  var buildA11yHint = function (el) {
    var role = getRole(el);
    var name = getLabelText(el) || normalizeText(el.innerText || el.textContent || '') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('value');
    var text = name ? normalizeText(String(name)) : getTextCandidate(el);
    var hint = {};
    if (role) hint.role = role;
    if (name) hint.name = normalizeText(String(name));
    if (text) hint.text = normalizeText(String(text));
    return hint;
  };

  var emit = function (payload) {
    var tabToken = getToken();
    if (!tabToken) {
      try { console.warn('[recorder] missing tabToken', { url: location.href, payload: payload && payload.type }); } catch {}
      return;
    }
    window.__rpa_record({
      tabToken: tabToken,
      ts: Date.now(),
      url: location.href,
      ...payload
    });
  };

  var debugTarget = function (label, target, reason) {
    try {
      var info = {
        label: label,
        reason: reason,
        url: location.href,
        tag: target && target.tagName ? target.tagName.toLowerCase() : undefined,
        id: target && target.getAttribute ? target.getAttribute('id') : undefined,
        className: target && target.className ? String(target.className) : undefined,
        role: target && target.getAttribute ? target.getAttribute('role') : undefined,
        name: target ? (getLabelText(target) || normalizeText(target.innerText || target.textContent || '')) : undefined
      };
      console.warn('[recorder] click capture skipped', info);
    } catch {}
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

  var isCheckboxOrRadio = function (el) {
    if (!(el instanceof HTMLInputElement)) return false;
    var type = (el.type || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
  };

  var lastPointer = { ts: 0, target: null };
  var markPointer = function (target) {
    lastPointer.ts = Date.now();
    lastPointer.target = target || null;
  };
  var shouldSkipClick = function (target) {
    if (!target) return false;
    if (lastPointer.target !== target) return false;
    return Date.now() - lastPointer.ts < 350;
  };

  var inPanel = function (path) {
    if (!path) return false;
    for (var i = 0; i < path.length; i += 1) {
      var node = path[i];
      if (node && node.id === 'rpa-floating-panel') return true;
    }
    return false;
  };

  var handlePointerdown = function (event) {
    if (event.button !== 0) return;
    var path = event.composedPath ? event.composedPath() : null;
    var target = (path && path[0]) || event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!(target instanceof Element)) return;
    if (inPanel(path) || (target.closest && target.closest('#rpa-floating-panel'))) return;
    if (isCheckboxOrRadio(target) || target.closest('label input[type="checkbox"], label input[type="radio"]')) return;
    var selector = selectorFor(target);
    if (selector) {
      markPointer(target);
      emit({
        type: 'click',
        selector: selector,
        targetHint: target.tagName.toLowerCase(),
        a11yHint: buildA11yHint(target),
        locatorCandidates: buildCandidates(target),
        scopeHint: getScopeHint(target)
      });
      return;
    }
    var fallback = target.closest && target.closest('button, a, input, select, textarea, [role]');
    if (fallback) {
      var fallbackSelector = selectorFor(fallback);
      if (fallbackSelector) {
        markPointer(fallback);
        emit({
          type: 'click',
          selector: fallbackSelector,
          targetHint: fallback.tagName.toLowerCase(),
          a11yHint: buildA11yHint(fallback),
          locatorCandidates: buildCandidates(fallback),
          scopeHint: getScopeHint(fallback)
        });
        return;
      }
      var hintOnly = buildA11yHint(fallback);
      if (hintOnly && (hintOnly.role || hintOnly.name || hintOnly.text)) {
        markPointer(fallback);
        emit({
          type: 'click',
          targetHint: fallback.tagName.toLowerCase(),
          a11yHint: hintOnly,
          locatorCandidates: buildCandidates(fallback),
          scopeHint: getScopeHint(fallback)
        });
      } else {
        debugTarget('pointerdown', fallback, 'fallback selector missing');
      }
    }
  };
  document.addEventListener('pointerdown', handlePointerdown, true);
  window.addEventListener('pointerdown', handlePointerdown, true);

  var handleClick = function (event) {
    var path = event.composedPath ? event.composedPath() : null;
    var target = (path && path[0]) || event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!(target instanceof Element)) return;
    if (inPanel(path) || (target.closest && target.closest('#rpa-floating-panel'))) return;
    if (shouldSkipClick(target)) return;
    if (isCheckboxOrRadio(target) || target.closest('label input[type=\"checkbox\"], label input[type=\"radio\"]')) return;
    var selector = selectorFor(target);
    if (selector) {
      emit({
        type: 'click',
        selector: selector,
        targetHint: target.tagName.toLowerCase(),
        a11yHint: buildA11yHint(target),
        locatorCandidates: buildCandidates(target),
        scopeHint: getScopeHint(target)
      });
      return;
    }
    var fallback = target.closest && target.closest('button, a, input, select, textarea, [role]');
    if (!fallback) {
      debugTarget('click', target, 'no selector and no fallback');
      return;
    }
    var fallbackSelector = selectorFor(fallback);
    if (fallbackSelector) {
      emit({
        type: 'click',
        selector: fallbackSelector,
        targetHint: fallback.tagName.toLowerCase(),
        a11yHint: buildA11yHint(fallback),
        locatorCandidates: buildCandidates(fallback),
        scopeHint: getScopeHint(fallback)
      });
      return;
    }
    var hintOnly = buildA11yHint(fallback);
    if (hintOnly && (hintOnly.role || hintOnly.name || hintOnly.text)) {
      emit({
        type: 'click',
        targetHint: fallback.tagName.toLowerCase(),
        a11yHint: hintOnly,
        locatorCandidates: buildCandidates(fallback),
        scopeHint: getScopeHint(fallback)
      });
      return;
    }
    debugTarget('click', fallback, 'fallback selector missing');
  };
  document.addEventListener('click', handleClick, true);
  window.addEventListener('click', handleClick, true);

  document.addEventListener('input', function (event) {
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    if (isCheckboxOrRadio(target)) return;
    if (target instanceof HTMLSelectElement) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({
      type: 'input',
      selector: selector,
      value: getValue(target),
      a11yHint: buildA11yHint(target),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
  }, true);

  document.addEventListener('change', function (event) {
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    if (target instanceof HTMLInputElement) {
      var inputType = (target.type || '').toLowerCase();
      if (inputType === 'checkbox' || inputType === 'radio') {
        emit({
          type: 'check',
          selector: selector,
          checked: target.checked,
          inputType: inputType,
          a11yHint: buildA11yHint(target),
          locatorCandidates: buildCandidates(target),
          scopeHint: getScopeHint(target)
        });
        return;
      }
      if (inputType === 'date') {
        emit({
          type: 'date',
          selector: selector,
          value: target.value,
          a11yHint: buildA11yHint(target),
          locatorCandidates: buildCandidates(target),
          scopeHint: getScopeHint(target)
        });
        return;
      }
    }
    if (target instanceof HTMLSelectElement) {
      var option = target.selectedOptions && target.selectedOptions[0];
      emit({
        type: 'select',
        selector: selector,
        value: target.value,
        label: option ? option.label : '',
        a11yHint: buildA11yHint(target),
        locatorCandidates: buildCandidates(target),
        scopeHint: getScopeHint(target)
      });
      return;
    }
    emit({
      type: 'change',
      selector: selector,
      value: getValue(target),
      a11yHint: buildA11yHint(target),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!specialKeys.has(event.key)) return;
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (target && target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = target instanceof Element ? selectorFor(target) : null;
    emit({
      type: 'keydown',
      selector: selector,
      key: event.key,
      a11yHint: target instanceof Element ? buildA11yHint(target) : undefined,
      locatorCandidates: target instanceof Element ? buildCandidates(target) : undefined,
      scopeHint: target instanceof Element ? getScopeHint(target) : undefined
    });
  }, true);

  document.addEventListener('paste', function (event) {
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    if (isPassword(target)) return;
    emit({
      type: 'paste',
      selector: selector,
      value: getValue(target),
      a11yHint: buildA11yHint(target),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
  }, true);

  document.addEventListener('copy', function (event) {
    var target = (event.composedPath && event.composedPath()[0]) || event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({
      type: 'copy',
      selector: selector,
      a11yHint: buildA11yHint(target),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
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
