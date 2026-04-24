import type { Page } from 'playwright';
import type { RuntimeStateMap } from '../../steps/executors/snapshot/core/types';

const STATE_ID_ATTR = 'data-rpa-state-id';

let runtimeEpochSequence = 0;

export const createRuntimeStateEpoch = (): string => {
  runtimeEpochSequence += 1;
  return `${Date.now().toString(36)}-${runtimeEpochSequence.toString(36)}`;
};

export const collectTaggedRuntimeState = async (page: Page, epoch: string): Promise<RuntimeStateMap> => {
    const target = page as unknown as {
        evaluate?: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T>;
    };
    if (typeof target.evaluate !== 'function') {return {};}

    const rows = await target
        // Use string-script evaluate to avoid transpiler helper leakage (e.g. __name) into page context.
        .evaluate(
            ({ script, runEpoch }) => {
                try {
                    // Keep this marker literal so unit-test fakes can detect runtime collector evaluation.
                    const marker = '[contenteditable]';
                    void marker;
                    (globalThis as { __RPA_RUNTIME_EPOCH__?: string }).__RPA_RUNTIME_EPOCH__ = runEpoch;
                    const output = (0, eval)(script) as unknown;
                    if (!Array.isArray(output)) {return [] as unknown[];}
                    const rows: unknown[] = [];
                    for (const item of output as unknown[]) {
                        if (item && typeof item === 'object') {rows.push(item);}
                    }
                    return rows;
                } catch {
                    return [] as unknown[];
                }
            },
            {
                script: RUNTIME_STATE_COLLECTOR_SCRIPT,
                runEpoch: epoch,
            },
        )
        .catch(() => [] as unknown[]);

  return toRuntimeStateMap(rows);
};

export const cleanupTaggedRuntimeState = async (page: Page): Promise<void> => {
  const target = page as unknown as {
    evaluate?: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T>;
  };
  if (typeof target.evaluate !== 'function') {return;}

  await target
    .evaluate((script) => {
            try {
                const result = (0, eval)(script) as unknown;
                return result === true;
            } catch {
        return false;
            }
    }, RUNTIME_STATE_CLEANUP_SCRIPT)
    .catch(() => undefined);
};

const toRuntimeStateMap = (rows: unknown): RuntimeStateMap => {
    const map: RuntimeStateMap = {};
    const safeRows = Array.isArray(rows) ? rows : [];
    for (const row of safeRows) {
        if (!row || typeof row !== 'object') {continue;}
        const rowRecord = row as Record<string, unknown>;
        const stateId = typeof rowRecord.stateId === 'string' ? rowRecord.stateId.trim() : '';
        if (!stateId) {continue;}
        map[stateId] = {
            stateId,
            tag: typeof rowRecord.tag === 'string' ? rowRecord.tag : undefined,
            type: typeof rowRecord.type === 'string' ? rowRecord.type : undefined,
            role: typeof rowRecord.role === 'string' ? rowRecord.role : undefined,
            value: typeof rowRecord.value === 'string' ? rowRecord.value : undefined,
            checked: typeof rowRecord.checked === 'string' ? rowRecord.checked : undefined,
            selected: typeof rowRecord.selected === 'string' ? rowRecord.selected : undefined,
            ariaChecked: typeof rowRecord.ariaChecked === 'string' ? rowRecord.ariaChecked : undefined,
            ariaSelected: typeof rowRecord.ariaSelected === 'string' ? rowRecord.ariaSelected : undefined,
            ariaExpanded: typeof rowRecord.ariaExpanded === 'string' ? rowRecord.ariaExpanded : undefined,
            ariaPressed: typeof rowRecord.ariaPressed === 'string' ? rowRecord.ariaPressed : undefined,
            disabled: typeof rowRecord.disabled === 'string' ? rowRecord.disabled : undefined,
            readonly: typeof rowRecord.readonly === 'string' ? rowRecord.readonly : undefined,
            invalid: typeof rowRecord.invalid === 'string' ? rowRecord.invalid : undefined,
            focused: typeof rowRecord.focused === 'string' ? rowRecord.focused : undefined,
            popupSelectedText: typeof rowRecord.popupSelectedText === 'string' ? rowRecord.popupSelectedText : undefined,
            ariaValueText: typeof rowRecord.ariaValueText === 'string' ? rowRecord.ariaValueText : undefined,
            ariaLabelledBy: typeof rowRecord.ariaLabelledBy === 'string' ? rowRecord.ariaLabelledBy : undefined,
            ariaDescribedBy: typeof rowRecord.ariaDescribedBy === 'string' ? rowRecord.ariaDescribedBy : undefined,
            contentEditableText: typeof rowRecord.contentEditableText === 'string' ? rowRecord.contentEditableText : undefined,
        };
    }
    return map;
};

const RUNTIME_STATE_COLLECTOR_SCRIPT = `(() => {
  const STATE_ATTR = '${STATE_ID_ATTR}';
  const epoch = (globalThis.__RPA_RUNTIME_EPOCH__ || '').toString().trim() || '0';
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
  const safeGetAttr = (el, name) => {
    try {
      return el.getAttribute(name);
    } catch {
      return null;
    }
  };
  const safeSetAttr = (el, name, value) => {
    try {
      el.setAttribute(name, value);
      return true;
    } catch {
      return false;
    }
  };
  const safeQuerySelectorAll = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  };
  const pickAria = (el, camel, attr) => {
    const ariaValue = el[camel];
    const normalized = normalize(ariaValue);
    return normalized || normalize(safeGetAttr(el, attr));
  };

  const rows = [];
  const getComposedParentElement = (el) => {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    try {
      const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
      if (root && root.host && root.host.nodeType === 1) {
        return root.host;
      }
    } catch {}
    return null;
  };

  const isIgnoredByMarker = (el) => {
    const marker = (safeGetAttr(el, 'data-rpa-snapshot-ignore') || '').trim().toLowerCase();
    if (marker === '1' || marker === 'true' || marker === 'yes') return true;
    const panel = (safeGetAttr(el, 'data-rpa-panel') || '').trim().toLowerCase();
    if (panel === '1' || panel === 'true' || panel === 'yes') return true;
    return (safeGetAttr(el, 'id') || '').trim().toLowerCase() === 'rpa-floating-panel';
  };

  const isIgnoredInAncestorChain = (el) => {
    let cursor = el;
    while (cursor) {
      if (isIgnoredByMarker(cursor)) return true;
      cursor = getComposedParentElement(cursor);
    }
    return false;
  };

  const isEligibleElement = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style') return false;
    if (isIgnoredInAncestorChain(el)) return false;
    return true;
  };

  const joinSelectedText = (items) => {
    const tokens = [];
    for (const item of items) {
      const text = normalize(item && item.textContent ? item.textContent : '');
      if (!text) continue;
      tokens.push(text);
    }
    return tokens.length > 0 ? tokens.join(', ') : undefined;
  };

  const readPopupSelectedText = (el, ownerDoc) => {
    const popupId = normalize(safeGetAttr(el, 'aria-controls') || safeGetAttr(el, 'aria-owns'));
    if (!popupId || !ownerDoc || typeof ownerDoc.getElementById !== 'function') return undefined;
    let popup = null;
    try {
      popup = ownerDoc.getElementById(popupId);
    } catch {
      popup = null;
    }
    if (!popup) return undefined;

    const selectedByAria = safeQuerySelectorAll(popup, '[aria-selected="true"], [aria-checked="true"]');
    const ariaTexts = selectedByAria
      .map((item) => normalize(item.textContent || safeGetAttr(item, 'aria-label') || safeGetAttr(item, 'aria-valuetext') || ''))
      .filter(Boolean);
    if (ariaTexts.length > 0) return ariaTexts.join(', ');

    const selectedOptionTexts = joinSelectedText(safeQuerySelectorAll(popup, 'option:checked'));
    if (selectedOptionTexts) return selectedOptionTexts;
    return undefined;
  };

  const collectFromRoot = (rootLike, ownerDoc, scope) => {
    if (!rootLike) return;
    const doc = ownerDoc || document;
    const candidates = safeQuerySelectorAll(rootLike, SELECTOR);
    let seq = 0;
    for (const maybeEl of candidates) {
      if (!maybeEl || maybeEl.nodeType !== 1) continue;
      const el = maybeEl;
      if (!isEligibleElement(el)) continue;

      seq += 1;
      const stateId = ['rpa-state', epoch, scope, String(seq)].join('-');
      if (!safeSetAttr(el, STATE_ATTR, stateId)) continue;

      const html = el;
      const input = el;
      const textarea = el;
      const select = el;
      const option = el;
      const tag = (el.tagName || '').toLowerCase();
      const isContentEditable = !!html.isContentEditable;

      const role = normalize(safeGetAttr(el, 'role') || '');

      const selectedText =
        tag === 'select'
          ? joinSelectedText(Array.from(select.selectedOptions || []))
          : undefined;

      const isComboLike = role === 'combobox' || role === 'listbox';
      const ariaValueText = normalize(safeGetAttr(el, 'aria-valuetext') || '');
      const popupSelectedText = isComboLike ? readPopupSelectedText(el, doc) : undefined;
      const ownValueAttr = normalize(safeGetAttr(el, 'value') || safeGetAttr(el, 'data-value') || '');
      const ownText = normalize(el.textContent || '');
      const comboValue = isComboLike ? (ariaValueText || popupSelectedText || ownValueAttr || ownText) : undefined;
      const optionSelected = tag === 'option' ? bool(!!option.selected) : undefined;
      const ariaSelected = pickAria(el, 'ariaSelected', 'aria-selected');
      const selectedState = optionSelected || selectedText || (isComboLike ? popupSelectedText || comboValue : undefined);
      const contentEditableText = isContentEditable ? normalize(html.textContent || '') : undefined;

      rows.push({
        stateId,
        tag,
        type: tag === 'input' ? normalize(input.type) : undefined,
        role,
        value:
          tag === 'input'
            ? normalize(input.value)
            : tag === 'textarea'
              ? normalize(textarea.value)
              : tag === 'select'
                ? normalize(select.value)
                : isComboLike
                  ? comboValue
                : isContentEditable
                  ? contentEditableText
                  : undefined,
        checked: tag === 'input' ? bool(!!input.checked) : undefined,
        selected: selectedState,
        ariaChecked: pickAria(el, 'ariaChecked', 'aria-checked'),
        ariaSelected,
        ariaExpanded: pickAria(el, 'ariaExpanded', 'aria-expanded'),
        ariaPressed: pickAria(el, 'ariaPressed', 'aria-pressed'),
        disabled: bool(!!html.disabled),
        readonly: bool(!!input.readOnly || !!textarea.readOnly),
        invalid: pickAria(el, 'ariaInvalid', 'aria-invalid'),
        focused: bool(doc.activeElement === el),
        popupSelectedText,
        ariaValueText,
        ariaLabelledBy: normalize(safeGetAttr(el, 'aria-labelledby') || ''),
        ariaDescribedBy: normalize(safeGetAttr(el, 'aria-describedby') || ''),
        contentEditableText,
      });
    }

    const iframes = safeQuerySelectorAll(rootLike, 'iframe');
    let iframeSeq = 0;
    for (const iframe of iframes) {
      if (!isEligibleElement(iframe)) continue;
      let childDoc = null;
      try {
        childDoc = iframe.contentDocument;
      } catch {
        childDoc = null;
      }
      if (!childDoc || !childDoc.documentElement) continue;
      iframeSeq += 1;
      collectFromRoot(childDoc, childDoc, scope + '-i' + iframeSeq);
    }

    const allElements = safeQuerySelectorAll(rootLike, '*');
    let shadowSeq = 0;
    for (const host of allElements) {
      if (!host || host.nodeType !== 1) continue;
      if (!isEligibleElement(host)) continue;
      const shadowRoot = host.shadowRoot;
      if (!shadowRoot) continue;
      shadowSeq += 1;
      collectFromRoot(shadowRoot, doc, scope + '-s' + shadowSeq);
    }
  };

  collectFromRoot(document, document, 'f0');
  return rows;
})()`;

const RUNTIME_STATE_CLEANUP_SCRIPT = `(() => {
  const STATE_ATTR = '${STATE_ID_ATTR}';
  const safeQuerySelectorAll = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  };

  const cleanupRoot = (rootLike) => {
    if (!rootLike) return;
    const tagged = safeQuerySelectorAll(rootLike, '[' + STATE_ATTR + ']');
    for (const el of tagged) {
      try {
        el.removeAttribute(STATE_ATTR);
      } catch {}
    }

    const iframes = safeQuerySelectorAll(rootLike, 'iframe');
    for (const iframe of iframes) {
      let childDoc = null;
      try {
        childDoc = iframe.contentDocument;
      } catch {
        childDoc = null;
      }
      if (!childDoc || !childDoc.documentElement) continue;
      cleanupRoot(childDoc);
    }

    const allElements = safeQuerySelectorAll(rootLike, '*');
    for (const host of allElements) {
      if (!host || host.nodeType !== 1) continue;
      if (!host.shadowRoot) continue;
      cleanupRoot(host.shadowRoot);
    }
  };

  cleanupRoot(document);
  return true;
})()`;
