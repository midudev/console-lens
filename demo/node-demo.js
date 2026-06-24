// Demo app for Console Lens.
// Run via:  node --require ../out/agent/preload.js node-demo.js
// (or from the repo root:  npm run demo)

let counter = 0;

function add(a, b) {
  const result = a + b;
  console.log('add() ->', result); // inline value appears right here
  return result;
}

const user = { id: 1, name: 'Midu', roles: ['admin', 'dev'], meta: { active: true } };

console.log('Starting demo with user:', user);
console.info('This is an info message');
console.warn('This is a warning', { code: 'W001' });

// circular reference – must not crash serialization
const circular = { name: 'loop' };
circular.self = circular;
console.log('circular:', circular);

const id = setInterval(() => {
  counter += 1;
  add(counter, counter * 2);
  if (counter % 3 === 0) {
    console.debug('tick batch reached', counter);
  }
  if (counter >= 6) {
    console.error('Stopping demo after 6 ticks');
    clearInterval(id);
  }
}, 600);
