export const START_PAGE_PATH = 'pages/start.html';

export const getStartPageUrl = () => chrome.runtime.getURL(START_PAGE_PATH);
