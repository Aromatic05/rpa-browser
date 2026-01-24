import type { Page } from 'playwright';
import type { LocatorCandidate, ScopeHint } from '../runner/locator_candidates';
import { RECORDER_SOURCE } from './recorder_payload';

const installedPages = new WeakSet<Page>();
const bindingName = '__rpa_record';

export type RecordedEventType =
  | 'click'
  | 'input'
  | 'change'
  | 'check'
  | 'select'
  | 'date'
  | 'keydown'
  | 'navigate'
  | 'scroll'
  | 'paste'
  | 'copy';

export type RecordedEvent = {
  tabToken: string;
  ts: number;
  type: RecordedEventType;
  url?: string;
  selector?: string;
  locatorCandidates?: LocatorCandidate[];
  scopeHint?: ScopeHint;
  targetHint?: string;
  value?: string;
  label?: string;
  checked?: boolean;
  inputType?: string;
  key?: string;
  scrollX?: number;
  scrollY?: number;
  source?: 'click' | 'direct';
  pageUrl?: string | null;
};

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

  await page.addInitScript({ content: RECORDER_SOURCE });
  try {
    await page.evaluate(RECORDER_SOURCE);
  } catch {
    // ignore if page is not ready yet
  }
};
