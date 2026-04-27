/**
 * 统一日志入口：确保扩展内日志格式一致，并可集中开关。
 *
 * 使用方式：
 *   const log = createLogger('sw');
 *   log.info('message', payload);
 *
 * 运行时按需启用：
 *   chrome.storage.local.set({ rpaLogLevel: 'debug' });
 */

import { LOG_PREFIX } from './constants.js';

export type LoggerScope = 'sw' | 'panel' | 'content' | 'ui';
export type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'silent';

export type Logger = {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warning: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

const LEVEL_WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warning: 30,
    error: 40,
    silent: 99,
};

let initialized = false;
let runtimeLevel: LogLevel = 'warning';
type LoggerGlobal = typeof globalThis & { __RPA_LOG_LEVEL?: unknown };

const normalizeLevel = (value: unknown): LogLevel | null => {
    if (typeof value !== 'string') {return null;}
    const level = value.trim().toLowerCase();
    if (level === 'warn') {return 'warning';}
    if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error' || level === 'silent') {
        return level;
    }
    return null;
};

const resolveCurrentLevel = (): LogLevel => {
    const globalLevel = normalizeLevel((globalThis as LoggerGlobal).__RPA_LOG_LEVEL);
    return globalLevel ?? runtimeLevel;
};

const shouldLog = (level: Exclude<LogLevel, 'silent'>) =>
    LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[resolveCurrentLevel()];

const initRuntimeLevel = () => {
    if (initialized) {return;}
    initialized = true;
    if (typeof chrome === 'undefined') {return;}
    chrome.storage.local.get(['rpaLogLevel'], (values: Record<string, unknown>) => {
        const next = normalizeLevel(values.rpaLogLevel);
        if (next) {runtimeLevel = next;}
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') {return;}
        const next = normalizeLevel(changes.rpaLogLevel.newValue);
        if (next) {runtimeLevel = next;}
    });
};

export const createLogger = (scope: LoggerScope): Logger => {
    initRuntimeLevel();
    const prefix = `${LOG_PREFIX}[${scope}]`;
    return {
        debug: (...args: unknown[]) => {
            if (!shouldLog('debug')) {return;}
            console.warn(`${prefix}[debug]`, ...args);
        },
        info: (...args: unknown[]) => {
            if (!shouldLog('info')) {return;}
            console.warn(`${prefix}[info]`, ...args);
        },
        warning: (...args: unknown[]) => {
            if (!shouldLog('warning')) {return;}
            console.warn(prefix, ...args);
        },
        error: (...args: unknown[]) => {
            if (!shouldLog('error')) {return;}
            console.error(prefix, ...args);
        },
    };
};
