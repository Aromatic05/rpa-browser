const scrollBox = document.getElementById('scroll-box');
const loadMoreButton = document.getElementById('btn-load-more');
const copyButton = document.getElementById('btn-copy');
const copySource = document.getElementById('copy-source');
const copyStatus = document.getElementById('copy-status');
const btnAlert = document.getElementById('btn-alert');
const btnConfirm = document.getElementById('btn-confirm');
const btnPrompt = document.getElementById('btn-prompt');

const buildItems = (count, offset = 0) => {
  const fragment = document.createDocumentFragment();
  for (let i = 1; i <= count; i += 1) {
    const item = document.createElement('div');
    item.className = 'scroll-item';
    item.textContent = `Item ${offset + i}`;
    fragment.appendChild(item);
  }
  scrollBox.appendChild(fragment);
};

buildItems(200, 0);

let loaded = 200;
loadMoreButton.addEventListener('click', () => {
  buildItems(20, loaded);
  loaded += 20;
});

btnAlert.addEventListener('click', () => {
  alert('Alert dialog from sandbox');
});

btnConfirm.addEventListener('click', () => {
  const ok = confirm('Confirm dialog from sandbox');
  copyStatus.textContent = ok ? 'Confirm: OK' : 'Confirm: Cancel';
});

btnPrompt.addEventListener('click', () => {
  const value = prompt('Prompt dialog from sandbox', 'hello');
  copyStatus.textContent = value == null ? 'Prompt: cancelled' : `Prompt: ${value}`;
});

copyButton.addEventListener('click', async () => {
  const text = copySource.textContent || '';
  if (!navigator.clipboard) {
    copyStatus.textContent = 'Clipboard API unavailable';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = 'Copied!';
  } catch {
    copyStatus.textContent = 'Clipboard write failed';
  }
});
