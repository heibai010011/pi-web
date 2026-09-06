export const DEV_SERVICE_WORKER_CLEANUP_KEY = "pi-web-dev-sw-cleanup-v1";

/**
 * Runs before Next's client modules in development. A production Pi Web service
 * worker from an earlier run may still control this origin and serve stale
 * `/_next/static` chunks even though development no longer registers one.
 *
 * Keep this snippet dependency-free: it must still run when stale chunks make
 * React hydration fail. The session marker prevents a reload loop while each
 * newly opened tab still gets a chance to repair its browser profile.
 */
export function getDevServiceWorkerCleanupScript(): string {
  return `(function(){
    try {
      if (!("serviceWorker" in navigator) || sessionStorage.getItem(${JSON.stringify(DEV_SERVICE_WORKER_CLEANUP_KEY)}) === "done") return;
      Promise.all([
        navigator.serviceWorker.getRegistrations(),
        "caches" in window ? caches.keys() : Promise.resolve([])
      ]).then(function(results){
        var registrations = results[0];
        var cacheKeys = results[1];
        var piWebCacheKeys = cacheKeys.filter(function(key){ return key.indexOf("pi-web-") === 0; });
        return Promise.all([
          Promise.all(registrations.map(function(registration){ return registration.unregister(); })),
          Promise.all(piWebCacheKeys.map(function(key){ return caches.delete(key); }))
        ]).then(function(){
          sessionStorage.setItem(${JSON.stringify(DEV_SERVICE_WORKER_CLEANUP_KEY)}, "done");
          if (navigator.serviceWorker.controller || registrations.length || piWebCacheKeys.length) location.reload();
        });
      }).catch(function(error){ console.warn("Failed to clean stale Pi Web service worker:", error); });
    } catch (error) {
      console.warn("Failed to start stale Pi Web service worker cleanup:", error);
    }
  })();`;
}
