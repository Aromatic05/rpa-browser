import type { Page } from 'playwright';
import type { RuntimeStateMap } from '../../steps/executors/snapshot/core/types';

type RuntimeStateRow = {
    pathKey: string;
    parentKey?: string;
    tag?: string;
    type?: string;
    role?: string;
    idAttr?: string;
    nameAttr?: string;
    placeholder?: string;
    ariaLabel?: string;
    dataTestId?: string;
    value?: string;
    checked?: string;
    selected?: string;
    ariaChecked?: string;
    ariaSelected?: string;
    ariaExpanded?: string;
    ariaPressed?: string;
    disabled?: string;
    readonly?: string;
    invalid?: string;
    focused?: string;
};

export const getRuntimeStateMap = async (page: Page): Promise<RuntimeStateMap> => {
    const target = page as unknown as {
        evaluate?: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T>;
    };
    if (typeof target.evaluate !== 'function') return {};

    const rows = await target
        // Use string-script evaluate to avoid transpiler helper leakage (e.g. __name) into page context.
        .evaluate((script) => {
            try {
                // Keep this marker literal so unit-test fakes can detect runtime collector evaluation.
                const marker = '[contenteditable]';
                void marker;
                return (0, eval)(script);
            } catch {
                return [] as RuntimeStateRow[];
            }
        }, RUNTIME_STATE_COLLECTOR_SCRIPT)
        .catch(() => [] as RuntimeStateRow[]);

    const map: RuntimeStateMap = {};
    const safeRows = Array.isArray(rows) ? rows : [];
    for (const row of safeRows) {
        if (!row.pathKey) continue;
        map[row.pathKey] = row;
    }
    return map;
};

const RUNTIME_STATE_COLLECTOR_SCRIPT = `(() => {
  const SELECTOR = [
    'input',
    'textarea',
    'select',
    'option',
    'button',
    '[contenteditable]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="option"]',
    '[aria-expanded]',
    '[aria-pressed]',
    '[aria-selected]',
    '[aria-checked]',
  ].join(',');

  const normalize = (value) => {
    const text = (value ?? '').toString().trim();
    return text || undefined;
  };
  const bool = (value) => (value ? 'true' : 'false');
  const pickAria = (el, camel, attr) => {
    const ariaValue = el[camel];
    const normalized = normalize(ariaValue);
    return normalized || normalize(el.getAttribute(attr));
  };

  const buildPathKey = (el, root, prefix) => {
    if (el === root) return prefix;
    const parts = [];
    let cursor = el;
    while (cursor && cursor !== root) {
      let index = 0;
      let prev = cursor.previousElementSibling;
      while (prev) {
        index += 1;
        prev = prev.previousElementSibling;
      }
      parts.push(String(index));
      cursor = cursor.parentElement;
    }
    if (cursor !== root) return undefined;
    return parts.length > 0 ? prefix + '.' + parts.reverse().join('.') : prefix;
  };

  const rows = [];
  const seen = new Set();

  const isIgnoredByMarker = (el) => {
    const marker = (el.getAttribute('data-rpa-snapshot-ignore') || '').trim().toLowerCase();
    if (marker === '1' || marker === 'true' || marker === 'yes') return true;
    return (el.getAttribute('id') || '').trim().toLowerCase() === 'rpa-floating-panel';
  };

  const isEligibleElement = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style') return false;
    if (isIgnoredByMarker(el)) return false;
    return true;
  };

  const collectFromDocument = (doc, prefix) => {
    const root = doc.documentElement;
    if (!root) return;

    const elements = Array.from(doc.querySelectorAll(SELECTOR));
    for (const el of elements) {
      if (!isEligibleElement(el)) continue;
      const pathKey = buildPathKey(el, root, prefix);
      if (!pathKey || seen.has(pathKey)) continue;
      seen.add(pathKey);
      const parent = pathKey.split('.').slice(0, -1).join('.') || undefined;

      const html = el;
      const input = el;
      const textarea = el;
      const select = el;
      const option = el;
      const tag = (el.tagName || '').toLowerCase();
      const isContentEditable = !!html.isContentEditable;

      const selectedText =
        tag === 'select'
          ? normalize(
              Array.from(select.selectedOptions || [])
                .map((item) => (item.textContent || '').trim())
                .filter(Boolean)
                .join(', '),
            )
          : undefined;

      rows.push({
        pathKey,
        parentKey: parent,
        tag,
        type: tag === 'input' ? normalize(input.type) : undefined,
        role: normalize(el.getAttribute('role') || ''),
        idAttr: normalize(el.getAttribute('id') || ''),
        nameAttr: normalize(el.getAttribute('name') || ''),
        placeholder:
          tag === 'input'
            ? normalize(input.placeholder)
            : tag === 'textarea'
              ? normalize(textarea.placeholder)
              : undefined,
        ariaLabel: normalize(el.getAttribute('aria-label') || ''),
        dataTestId: normalize(el.getAttribute('data-testid') || el.getAttribute('data-test-id') || ''),
        value:
          tag === 'input'
            ? normalize(input.value)
            : tag === 'textarea'
              ? normalize(textarea.value)
              : tag === 'select'
                ? normalize(select.value)
                : isContentEditable
                  ? normalize(html.textContent || '')
                  : undefined,
        checked: tag === 'input' ? bool(!!input.checked) : undefined,
        selected: tag === 'option' ? bool(!!option.selected) : selectedText,
        ariaChecked: pickAria(el, 'ariaChecked', 'aria-checked'),
        ariaSelected: pickAria(el, 'ariaSelected', 'aria-selected'),
        ariaExpanded: pickAria(el, 'ariaExpanded', 'aria-expanded'),
        ariaPressed: pickAria(el, 'ariaPressed', 'aria-pressed'),
        disabled: bool(!!html.disabled),
        readonly: bool(!!input.readOnly || !!textarea.readOnly),
        invalid: pickAria(el, 'ariaInvalid', 'aria-invalid'),
        focused: bool(doc.activeElement === el),
      });
    }

    const iframes = Array.from(doc.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      const iframeKey = buildPathKey(iframe, root, prefix);
      if (!iframeKey) continue;
      let childDoc = null;
      try {
        childDoc = iframe.contentDocument;
      } catch {
        childDoc = null;
      }
      if (!childDoc || !childDoc.documentElement) continue;
      collectFromDocument(childDoc, iframeKey + '.f0');
    }
  };

  collectFromDocument(document, 'n0');
  return rows;
})()`;
