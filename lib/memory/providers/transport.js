// A zero-policy bridge for injected transports.  It exists so tests and local
// embedders can exercise the provider boundary without an HTTP adapter.
export function createProvider({ transport }) {
  return {
    recall: (...args) => transport?.recall?.(...args),
    remember: (...args) => transport?.remember?.(...args),
    capsule: (...args) => transport?.capsule?.(...args),
  };
}
