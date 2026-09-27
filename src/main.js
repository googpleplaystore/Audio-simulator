// AudioSpace bootstrap.
import { App } from './ui/app.js';

function fatal(err) {
  console.error(err);
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML = '<h1>AudioSpace could not start</h1><p class="muted"></p><p class="dim">AudioSpace needs a modern browser with the Web Audio API, ES modules and IndexedDB (Chrome, Edge, Firefox or Safari).</p>';
  box.querySelector('.muted').textContent = String(err && err.message ? err.message : err);
  root.appendChild(box);
}

window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason));

const app = new App();
app
  .init(document.getElementById('app'))
  .then(() => document.documentElement.classList.add('ready'))
  .catch(fatal);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
