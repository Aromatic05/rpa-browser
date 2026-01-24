const startButton = document.getElementById('startRec') as HTMLButtonElement;
const stopButton = document.getElementById('stopRec') as HTMLButtonElement;
const showButton = document.getElementById('showRec') as HTMLButtonElement;
const clearButton = document.getElementById('clearRec') as HTMLButtonElement;
const replayButton = document.getElementById('replayRec') as HTMLButtonElement;
const stopReplayButton = document.getElementById('stopReplay') as HTMLButtonElement;
const outEl = document.getElementById('out') as HTMLPreElement;

const render = (response: unknown) => {
  outEl.textContent = JSON.stringify(response, null, 2);
};

const sendPanelCommand = (cmd: string, args?: Record<string, unknown>) => {
  chrome.runtime.sendMessage({ type: 'CMD', cmd, args }, (response: any) => {
    if (chrome.runtime.lastError) {
      render({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    render(response);
  });
};

startButton.addEventListener('click', () => sendPanelCommand('record.start'));
stopButton.addEventListener('click', () => sendPanelCommand('record.stop'));
showButton.addEventListener('click', () => sendPanelCommand('record.get'));
clearButton.addEventListener('click', () => sendPanelCommand('record.clear'));
replayButton.addEventListener('click', () => sendPanelCommand('record.replay'));
stopReplayButton.addEventListener('click', () => sendPanelCommand('record.stopReplay'));
