// Fixture: throws an uncaught error shortly after start (so the agent's socket
// is connected and can flush the error before the process crashes).
function applyTax(): never {
  throw new Error('boom from fixture');
}

setTimeout(() => {
  applyTax();
}, 100);
