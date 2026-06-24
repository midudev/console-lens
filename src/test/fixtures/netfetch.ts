// Fixture: performs a single fetch, then stays alive briefly so the agent can
// read the response clone and ship the network message.
const url = process.env.CL_TEST_URL as string;

void (async () => {
  try {
    await fetch(url);
  } catch {
    /* ignore */
  }
})();

setTimeout(() => process.exit(0), 500);
