import type { Frame, Page } from 'playwright';
import type { ObservationSourceStatus, RuntimeStateRecord } from '../observation/contracts';

export type RuntimeStateMap = Record<string, RuntimeStateRecord | undefined>;

export type RuntimeStateCollectionResult = {
    records: RuntimeStateMap;
    status: ObservationSourceStatus;
    partialReasons: readonly string[];
    error?: string;
};

export const RUNTIME_STATE_ATTRIBUTE = 'data-rpa-state-id';

let runtimeEpochSequence = 0;

export const createRuntimeStateEpoch = (): string => {
    runtimeEpochSequence += 1;
    return `${Date.now().toString(36)}-${runtimeEpochSequence.toString(36)}`;
};

type EvaluateTarget = Pick<Page | Frame, 'evaluate'>;

type RuntimeCollectorPayload = {
    ok: boolean;
    rows: unknown[];
    partialReasons: string[];
    error?: string;
};

export const collectTaggedRuntimeStateCapture = async (
    target: EvaluateTarget,
    captureRunId: string,
): Promise<RuntimeStateCollectionResult> => {
    try {
        const payload = await target.evaluate(
            ({ script, runId }) => {
                try {
                    const collect = (0, eval)(script) as (value: string) => RuntimeCollectorPayload;
                    return collect(runId);
                } catch (error) {
                    return {
                        ok: false,
                        rows: [],
                        partialReasons: [],
                        error: error instanceof Error ? error.message : String(error),
                    } satisfies RuntimeCollectorPayload;
                }
            },
            {
                script: RUNTIME_STATE_COLLECTOR_SCRIPT,
                runId: captureRunId,
            },
        );
        if (!payload.ok) {
            return {
                records: {},
                status: 'unavailable',
                partialReasons: payload.partialReasons,
                error: payload.error ?? 'runtime collector failed',
            };
        }
        return {
            records: toRuntimeStateMap(payload.rows),
            status: payload.partialReasons.length > 0 ? 'partial' : 'complete',
            partialReasons: payload.partialReasons,
        };
    } catch (error) {
        return {
            records: {},
            status: 'unavailable',
            partialReasons: [],
            error: errorMessage(error),
        };
    }
};

export const collectTaggedRuntimeState = async (
    target: EvaluateTarget,
    captureRunId: string,
): Promise<RuntimeStateMap> => (await collectTaggedRuntimeStateCapture(target, captureRunId)).records;

export const cleanupTaggedRuntimeState = async (
    target: EvaluateTarget,
    captureRunId?: string,
): Promise<void> => {
    await target.evaluate(
        ({ script, runId }) => {
            const cleanup = (0, eval)(script) as (value?: string) => boolean;
            return cleanup(runId);
        },
        {
            script: RUNTIME_STATE_CLEANUP_SCRIPT,
            runId: captureRunId,
        },
    );
};

const toRuntimeStateMap = (rows: unknown): RuntimeStateMap => {
    const map: RuntimeStateMap = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') {continue;}
        const rowRecord = row as Record<string, unknown>;
        const stateId = stringValue(rowRecord.stateId);
        if (!stateId) {continue;}
        map[stateId] = {
            stateId,
            tag: stringValue(rowRecord.tag),
            type: stringValue(rowRecord.type),
            role: stringValue(rowRecord.role),
            value: stringValue(rowRecord.value),
            checked: stringValue(rowRecord.checked),
            selected: stringValue(rowRecord.selected),
            ariaChecked: stringValue(rowRecord.ariaChecked),
            ariaSelected: stringValue(rowRecord.ariaSelected),
            ariaExpanded: stringValue(rowRecord.ariaExpanded),
            ariaPressed: stringValue(rowRecord.ariaPressed),
            disabled: stringValue(rowRecord.disabled),
            readonly: stringValue(rowRecord.readonly),
            invalid: stringValue(rowRecord.invalid),
            focused: stringValue(rowRecord.focused),
            popupSelectedText: stringValue(rowRecord.popupSelectedText),
            ariaValueText: stringValue(rowRecord.ariaValueText),
            ariaLabelledBy: stringValue(rowRecord.ariaLabelledBy),
            ariaDescribedBy: stringValue(rowRecord.ariaDescribedBy),
            contentEditableText: stringValue(rowRecord.contentEditableText),
        };
    }
    return map;
};

const stringValue = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {return undefined;}
    const normalized = value.trim();
    return normalized || undefined;
};

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error ?? 'unknown error');

const RUNTIME_STATE_COLLECTOR_SCRIPT = `(runId) => {
  const STATE_ATTR = '${RUNTIME_STATE_ATTRIBUTE}';
  const STORE_KEY = Symbol.for('rpa.snapshot.runtime-state-store.v2');
  const SELECTOR = [
    'input', 'textarea', 'select', 'option', 'button', '[contenteditable]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
    '[role="combobox"]', '[role="listbox"]', '[role="option"]',
    '[aria-expanded]', '[aria-pressed]', '[aria-selected]', '[aria-checked]'
  ].join(',');

  const normalize = (value) => {
    const text = value == null ? '' : String(value).trim();
    return text || undefined;
  };
  const bool = (value) => value ? 'true' : 'false';
  const safeGetAttr = (element, name) => {
    try { return element.getAttribute(name); } catch { return null; }
  };
  const safeSetAttr = (element, name, value) => {
    try { element.setAttribute(name, value); return true; } catch { return false; }
  };
  const safeQuerySelectorAll = (root, selector, partialReasons) => {
    try { return Array.from(root.querySelectorAll(selector)); }
    catch (error) {
      partialReasons.push('query:' + (error && error.message ? error.message : String(error)));
      return [];
    }
  };
  const getStore = () => {
    let store = globalThis[STORE_KEY];
    if (!store || !(store.identities instanceof WeakMap) || !(store.runs instanceof Map)) {
      const random = Math.random().toString(36).slice(2);
      store = {
        prefix: 'rpa-state-' + Date.now().toString(36) + '-' + random,
        sequence: 0,
        identities: new WeakMap(),
        runs: new Map(),
      };
      Object.defineProperty(globalThis, STORE_KEY, {
        value: store,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
    return store;
  };
  const store = getStore();
  const restorations = [];
  const partialReasons = [];
  const rows = [];

  const stableIdentity = (element) => {
    let identity = store.identities.get(element);
    if (!identity) {
      store.sequence += 1;
      identity = store.prefix + '-' + store.sequence.toString(36);
      store.identities.set(element, identity);
    }
    return identity;
  };
  const tagForCapture = (element) => {
    const stateId = stableIdentity(element);
    const previousValue = safeGetAttr(element, STATE_ATTR);
    const hadAttribute = previousValue !== null;
    if (!safeSetAttr(element, STATE_ATTR, stateId)) {
      partialReasons.push('marker:set-failed');
      return undefined;
    }
    restorations.push({ element, stateId, hadAttribute, previousValue });
    return stateId;
  };
  const composedParent = (element) => {
    if (!element) return null;
    if (element.parentElement) return element.parentElement;
    try {
      const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
      return root && root.host && root.host.nodeType === 1 ? root.host : null;
    } catch { return null; }
  };
  const ignoredByMarker = (element) => {
    const marker = normalize(safeGetAttr(element, 'data-rpa-snapshot-ignore'));
    if (marker && ['1', 'true', 'yes'].includes(marker.toLowerCase())) return true;
    const panel = normalize(safeGetAttr(element, 'data-rpa-panel'));
    if (panel && ['1', 'true', 'yes'].includes(panel.toLowerCase())) return true;
    return (normalize(safeGetAttr(element, 'id')) || '').toLowerCase() === 'rpa-floating-panel';
  };
  const eligible = (element) => {
    const tag = (normalize(element && element.tagName) || '').toLowerCase();
    if (!tag || tag === 'script' || tag === 'style') return false;
    let cursor = element;
    while (cursor) {
      if (ignoredByMarker(cursor)) return false;
      cursor = composedParent(cursor);
    }
    return true;
  };
  const pickAria = (element, propertyName, attributeName) =>
    normalize(element[propertyName]) || normalize(safeGetAttr(element, attributeName));
  const joinSelectedText = (items) => {
    const tokens = [];
    for (const item of items) {
      const text = normalize(item && item.textContent);
      if (text) tokens.push(text);
    }
    return tokens.length > 0 ? tokens.join(', ') : undefined;
  };
  const readPopupSelectedText = (element, ownerDocument) => {
    const popupId = normalize(safeGetAttr(element, 'aria-controls') || safeGetAttr(element, 'aria-owns'));
    if (!popupId || !ownerDocument || typeof ownerDocument.getElementById !== 'function') return undefined;
    let popup;
    try { popup = ownerDocument.getElementById(popupId); }
    catch { popup = null; }
    if (!popup) return undefined;
    const selected = safeQuerySelectorAll(
      popup,
      '[aria-selected="true"], [aria-checked="true"]',
      partialReasons,
    );
    const texts = selected
      .map((item) => normalize(item.textContent || safeGetAttr(item, 'aria-label') || safeGetAttr(item, 'aria-valuetext')))
      .filter(Boolean);
    if (texts.length > 0) return texts.join(', ');
    return joinSelectedText(safeQuerySelectorAll(popup, 'option:checked', partialReasons));
  };

  const collectRoot = (root, ownerDocument) => {
    if (!root) return;
    const documentForRoot = ownerDocument || document;
    for (const element of safeQuerySelectorAll(root, SELECTOR, partialReasons)) {
      if (!element || element.nodeType !== 1 || !eligible(element)) continue;
      const stateId = tagForCapture(element);
      if (!stateId) continue;
      const tag = (normalize(element.tagName) || '').toLowerCase();
      const role = (normalize(safeGetAttr(element, 'role')) || '').toLowerCase() || undefined;
      const isContentEditable = !!element.isContentEditable;
      const isComboLike = role === 'combobox' || role === 'listbox';
      const selectedText = tag === 'select'
        ? joinSelectedText(Array.from(element.selectedOptions || []))
        : undefined;
      const ariaValueText = normalize(safeGetAttr(element, 'aria-valuetext'));
      const popupSelectedText = isComboLike
        ? readPopupSelectedText(element, documentForRoot)
        : undefined;
      const ownValue = normalize(safeGetAttr(element, 'value') || safeGetAttr(element, 'data-value'));
      const ownText = normalize(element.textContent);
      const comboValue = isComboLike
        ? (ariaValueText || popupSelectedText || ownValue || ownText)
        : undefined;
      const contentEditableText = isContentEditable ? normalize(element.textContent) : undefined;
      const optionSelected = tag === 'option' ? bool(!!element.selected) : undefined;
      const selectedState = optionSelected
        || selectedText
        || (isComboLike ? popupSelectedText || comboValue : undefined);

      rows.push({
        stateId,
        tag,
        type: tag === 'input' ? normalize(element.type) : undefined,
        role,
        value: tag === 'input' || tag === 'textarea' || tag === 'select'
          ? normalize(element.value)
          : isComboLike
            ? comboValue
            : isContentEditable
              ? contentEditableText
              : undefined,
        checked: tag === 'input' ? bool(!!element.checked) : undefined,
        selected: selectedState,
        ariaChecked: pickAria(element, 'ariaChecked', 'aria-checked'),
        ariaSelected: pickAria(element, 'ariaSelected', 'aria-selected'),
        ariaExpanded: pickAria(element, 'ariaExpanded', 'aria-expanded'),
        ariaPressed: pickAria(element, 'ariaPressed', 'aria-pressed'),
        disabled: bool(!!element.disabled),
        readonly: bool(!!element.readOnly),
        invalid: pickAria(element, 'ariaInvalid', 'aria-invalid'),
        focused: bool(documentForRoot.activeElement === element),
        popupSelectedText,
        ariaValueText,
        ariaLabelledBy: normalize(safeGetAttr(element, 'aria-labelledby')),
        ariaDescribedBy: normalize(safeGetAttr(element, 'aria-describedby')),
        contentEditableText,
      });
    }

    for (const iframe of safeQuerySelectorAll(root, 'iframe', partialReasons)) {
      if (!eligible(iframe)) continue;
      let childDocument;
      try { childDocument = iframe.contentDocument; }
      catch (error) {
        partialReasons.push('iframe:' + (error && error.message ? error.message : String(error)));
        childDocument = null;
      }
      if (!childDocument || !childDocument.documentElement) {
        partialReasons.push('iframe:unavailable');
        continue;
      }
      collectRoot(childDocument, childDocument);
    }

    for (const host of safeQuerySelectorAll(root, '*', partialReasons)) {
      if (!host || host.nodeType !== 1 || !eligible(host)) continue;
      let shadowRoot;
      try { shadowRoot = host.shadowRoot; }
      catch { shadowRoot = null; }
      if (shadowRoot) collectRoot(shadowRoot, documentForRoot);
    }
  };

  try {
    collectRoot(document, document);
    store.runs.set(runId, restorations);
    return { ok: true, rows, partialReasons };
  } catch (error) {
    store.runs.set(runId, restorations);
    return {
      ok: false,
      rows: [],
      partialReasons,
      error: error && error.message ? error.message : String(error),
    };
  }
}`;

const RUNTIME_STATE_CLEANUP_SCRIPT = `(runId) => {
  const STATE_ATTR = '${RUNTIME_STATE_ATTRIBUTE}';
  const STORE_KEY = Symbol.for('rpa.snapshot.runtime-state-store.v2');
  const store = globalThis[STORE_KEY];
  if (!store || !(store.runs instanceof Map)) return true;
  const restore = (id) => {
    const restorations = store.runs.get(id) || [];
    for (let index = restorations.length - 1; index >= 0; index -= 1) {
      const item = restorations[index];
      try {
        if (item.element.getAttribute(STATE_ATTR) !== item.stateId) continue;
        if (item.hadAttribute) {
          item.element.setAttribute(STATE_ATTR, item.previousValue == null ? '' : item.previousValue);
        } else {
          item.element.removeAttribute(STATE_ATTR);
        }
      } catch {}
    }
    store.runs.delete(id);
  };
  if (runId) {
    restore(runId);
  } else {
    for (const id of Array.from(store.runs.keys())) restore(id);
  }
  return true;
}`;
