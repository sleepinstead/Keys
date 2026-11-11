// Overwrites the clipboard after a copied password's time is up. Offscreen pages can't use the
// async clipboard, so this copies a single invisible character instead.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'keys:clear-clipboard') return;
  const box = document.getElementById('clip');
  box.value = '​';
  box.select();
  document.execCommand('copy');
});
