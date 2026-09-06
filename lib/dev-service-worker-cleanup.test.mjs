import assert from "node:assert/strict";
import test from "node:test";
import { DEV_SERVICE_WORKER_CLEANUP_KEY, getDevServiceWorkerCleanupScript } from "./dev-service-worker-cleanup.ts";

test("development cleanup runs before hydration without module dependencies", () => {
  const script = getDevServiceWorkerCleanupScript();
  assert.match(script, /navigator\.serviceWorker\.getRegistrations\(\)/);
  assert.match(script, /registration\.unregister\(\)/);
  assert.match(script, /key\.indexOf\("pi-web-"\) === 0/);
  assert.match(script, /caches\.delete\(key\)/);
  assert.match(script, /location\.reload\(\)/);
  assert.match(script, new RegExp(DEV_SERVICE_WORKER_CLEANUP_KEY));
});

test("development cleanup only reloads when stale state existed", () => {
  const script = getDevServiceWorkerCleanupScript();
  assert.match(script, /navigator\.serviceWorker\.controller \|\| registrations\.length \|\| piWebCacheKeys\.length/);
  assert.match(script, /sessionStorage\.getItem/);
  assert.match(script, /sessionStorage\.setItem/);
});
