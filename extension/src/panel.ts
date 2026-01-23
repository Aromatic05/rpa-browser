const startButton = document.getElementById('startRec') as HTMLButtonElement;
const stopButton = document.getElementById('stopRec') as HTMLButtonElement;
const showButton = document.getElementById('showRec') as HTMLButtonElement;
const replayButton = document.getElementById('replayRec') as HTMLButtonElement;
const outEl = document.getElementById('out') as HTMLPreElement;

const render = (response: unknown) => {
  outEl.textContent = JSON.stringify(response, null, 2);
};

const sendPanelCommand = (type: string) => {
  chrome.runtime.sendMessage({ type }, (response) => {
    if (chrome.runtime.lastError) {
      render({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    render(response);
  });
};

startButton.addEventListener('click', () => sendPanelCommand('START_RECORDING'));
stopButton.addEventListener('click', () => sendPanelCommand('STOP_RECORDING'));
showButton.addEventListener('click', () => sendPanelCommand('GET_RECORDING'));
replayButton.addEventListener('click', () => sendPanelCommand('REPLAY_RECORDING'));
