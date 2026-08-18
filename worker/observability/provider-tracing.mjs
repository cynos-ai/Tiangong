export function createProviderTraceBridge() {
  let activeObserver;

  return {
    extension(pi) {
      pi.on("before_provider_request", () => {
        activeObserver?.providerRequestReady();
      });
      pi.on("after_provider_response", () => {
        activeObserver?.providerResponseReceived();
      });
    },
    bind(observer) {
      if (activeObserver) throw new Error("Provider trace bridge is already bound to a turn");
      activeObserver = observer;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (activeObserver === observer) activeObserver = undefined;
      };
    },
  };
}
