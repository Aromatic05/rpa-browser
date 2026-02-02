/**
 * event_normalize：保留旧接口，迁移后不再在扩展侧生成 Step。
 */

import type { RecordedStep } from '../shared/types.js';
import type { RawEvent } from './event_capture.js';

export const normalizeEvent = (_event: RawEvent, _meta: { tabToken: string }): RecordedStep | null => null;
