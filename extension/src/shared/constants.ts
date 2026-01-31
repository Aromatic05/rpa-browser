/**
 * 常量与枚举集中定义。
 *
 * 说明：
 * - 不包含业务逻辑，只做“可配置项默认值”的归档。
 * - UI/服务层可从这里取默认值，避免散落字符串。
 */

export const LOG_PREFIX = '[rpa-ext]';
export const DEFAULT_MOCK_ORIGIN = 'http://localhost:4173';
export const DEFAULT_MOCK_PATH = '/pages/start.html#beta';

export const TAB_GROUP_COLORS = [
    'grey',
    'blue',
    'red',
    'yellow',
    'green',
    'pink',
    'purple',
    'cyan',
    'orange',
] as const;
