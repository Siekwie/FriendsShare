// Loaded with --require into a server process that a test starts, so that it cannot reach the real
// GitHub, Google or Stripe whatever it tries.
globalThis.fetch = async (url) => {
  throw new Error(`no network in tests (${String(url).split('?')[0]})`);
};
