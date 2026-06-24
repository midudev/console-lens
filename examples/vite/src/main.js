// No Console Lens import needed: when you run with the agent (`npm run dev:lens`)
// the browser client is auto-injected into the served HTML.
const app = document.querySelector('#app');
app.innerHTML = `
  <h1>Vite + Console Lens</h1>
  <p>Open your editor — log values appear inline. Click the button:</p>
  <button id="btn">Clicked 0 times</button>
`;

let count = 0;

console.log('Vite app booted', { framework: 'vite', ts: Date.now() });

const btn = document.getElementById('btn');
btn.addEventListener('click', () => {
  count += 1;
  console.log('button clicked', count);
  btn.textContent = `Clicked ${count} times`;
});

setInterval(() => {
  console.info('heartbeat', { count });
}, 2000);
