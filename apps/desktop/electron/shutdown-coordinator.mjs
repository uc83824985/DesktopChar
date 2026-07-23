export function createShutdownCoordinator(options) {
  let completed = false;
  let shutdownPromise;

  function request(reason) {
    if (completed) return shutdownPromise ?? Promise.resolve();
    if (!shutdownPromise) {
      // The visible desktop surface must disappear synchronously. Managed
      // Provider and MCP cleanup can take seconds and remains a background
      // shutdown concern after the user has received immediate feedback.
      options.hidePresentation(reason);
      shutdownPromise = (async () => {
        await options.closeResources(reason);
        completed = true;
        options.finish(reason);
      })().catch(error => {
        options.onError?.(error, reason);
        completed = true;
        options.finish(reason);
      });
    }
    return shutdownPromise;
  }

  function handleBeforeQuit(event) {
    if (completed) return;
    event.preventDefault();
    void request('before-quit');
  }

  return {
    request,
    handleBeforeQuit,
    get completed() { return completed; },
  };
}
