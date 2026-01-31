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

  var isCheckboxOrRadio = function (el) {
    if (!(el instanceof HTMLInputElement)) return false;
    var type = (el.type || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
  };

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    if (isCheckboxOrRadio(target) || target.closest('label input[type=\"checkbox\"], label input[type=\"radio\"]')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({
      type: 'click',
      selector: selector,
      targetHint: target.tagName.toLowerCase(),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
  }, true);

  document.addEventListener('input', function (event) {
    var target = event.target;
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
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
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
        emit({
          type: 'check',
          selector: selector,
          checked: target.checked,
          inputType: inputType,
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
        locatorCandidates: buildCandidates(target),
        scopeHint: getScopeHint(target)
      });
      return;
    }
    emit({
      type: 'change',
      selector: selector,
      value: getValue(target),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!specialKeys.has(event.key)) return;
    var target = event.target;
    if (target && target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = target instanceof Element ? selectorFor(target) : null;
    emit({
      type: 'keydown',
      selector: selector,
      key: event.key,
      locatorCandidates: target instanceof Element ? buildCandidates(target) : undefined,
      scopeHint: target instanceof Element ? getScopeHint(target) : undefined
    });
  }, true);

  document.addEventListener('paste', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    if (isPassword(target)) return;
    emit({
      type: 'paste',
      selector: selector,
      value: getValue(target),
      locatorCandidates: buildCandidates(target),
      scopeHint: getScopeHint(target)
    });
  }, true);

  document.addEventListener('copy', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest && target.closest('#rpa-floating-panel')) return;
    var selector = selectorFor(target);
    if (!selector) return;
    emit({
      type: 'copy',
      selector: selector,
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
