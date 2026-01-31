/**
 * 统一日志入口：确保扩展内日志格式一致，并可集中开关。
 *
 * 使用方式：
 *   const log = createLogger('sw');
 *   log('message', payload)
 */

import { LOG_PREFIX } from './constants.js';

export const createLogger = (scope: 'sw' | 'panel' | 'content' | 'ui') => {
    const prefix = `${LOG_PREFIX}[${scope}]`;
    return (...args: unknown[]) => console.log(prefix, ...args);
};
