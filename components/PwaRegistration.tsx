"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void Promise.all([
        navigator.serviceWorker.getRegistrations().then((registrations) => (
          Promise.all(registrations.map((registration) => registration.unregister()))
        )),
        "caches" in window
          ? caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key.startsWith("pi-web-")).map((key) => caches.delete(key)),
          ))
          : Promise.resolve([]),
      ]).catch((error: unknown) => {
        console.warn("Failed to clean stale Pi Web service worker:", error);
      });
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the Pi Web service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
