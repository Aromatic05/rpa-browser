/**
 * Content script 兼容入口：保持旧文件路径，内部转发到 entry/content。
 *
 * 说明：
 * - manifest 仍引用 content.js，避免破坏加载路径。
 * - 未来可直接改 manifest 指向 entry/content.js。
 */

import './entry/content.js';
