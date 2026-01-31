const DEFAULT_MOCK_ORIGIN = 'http://localhost:4173';
const DEFAULT_MOCK_PATH = '/pages/start.html#beta';

export const getMockStartUrl = async (): Promise<string> => {
    const data = await chrome.storage.local.get('mockBaseUrl');
    const base = (data?.mockBaseUrl as string | undefined) || DEFAULT_MOCK_ORIGIN;
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalized}${DEFAULT_MOCK_PATH}`;
};
