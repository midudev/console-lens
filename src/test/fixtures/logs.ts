// Fixture executed as a child process by the agent integration test.
// Kept alive briefly so the agent's async TCP socket can connect and flush.
console.log('hello world', 123);
console.warn('careful', { code: 1 });
console.error('failure');

const circular: Record<string, unknown> = {};
circular.self = circular;
console.log('circular', circular);

setTimeout(() => process.exit(0), 400);
