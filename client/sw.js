const CACHE_NAME = 'my-cache-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/assets/branding.css',
        '/assets/logo.svg',
        '/assets/favicon-12x12.png',
        '/assets/favicon-32x32.png',
        '/assets/apple-touch-icon-180x180.png',
      ]);
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        }),
      );
    }),
  );
});

// Athugar hvort ný útgáfa sé til
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            // Update cache with fresh response
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          })
          .catch((error) => {
            console.error('Fetch failed:', error);
            // Return cached response as fallback
            return cachedResponse;
          });

        // Return cached response immediately if available, otherwise wait for network
        return cachedResponse || fetchPromise;
      });
    }),
  );
});
