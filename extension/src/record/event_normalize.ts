/**
 * event_normalize：历史遗留的事件转换器。
 *
 * 说明：
 * - 录制逻辑已迁移为“轻量捕获 + 回传 agent”。
 * - extension 不再负责把事件转为 Step。
 * - 此处保留空实现，避免旧调用方编译报错。
 */

import type { RecordedStep } from '../shared/types.js';
import type { RawEvent } from './event_capture.js';

export const normalizeEvent = (_event: RawEvent, _meta: { tabToken: string }): RecordedStep | null => {
    return null;
};
