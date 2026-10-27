// Service Worker para Visitas Medicas ERP - GammaFood
const CACHE_NAME = 'visitas-erp-v12';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

// Instalación: Precarga del Shell de la aplicación
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('Algunos recursos estáticos no pudieron precachearse:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activación: Limpieza de cachés antiguas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(k => {
          if (k !== CACHE_NAME) {
            console.log('Eliminando caché antigua de Service Worker:', k);
            return caches.delete(k);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Intercepción de peticiones (Fetch)
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // No interceptar peticiones no GET ni peticiones que no sean del mismo origen
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // No cachear llamadas a la API de uploads o endpoints dinámicos no estáticos
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return;
  }

  // Para navegación de páginas HTML: Network-first con fallback a caché
  if (req.mode === 'navigate' || req.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          // Si obtuvimos respuesta exitosa, actualizamos la caché
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          // Si estamos offline o falló la red, servir el shell en caché
          return caches.match(req).then(cached => cached || caches.match('/index.html'));
        })
    );
    return;
  }

  // Para otros activos estáticos (iconos, imágenes, scripts): Cache-first con fallback a red
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      });
    })
  );
});

// Soporte para Background Sync
self.addEventListener('sync', event => {
  if (event.tag === 'sync-visits') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'TRIGGER_SYNC' }));
      })
    );
  }
});

// Soporte para Notificaciones Web Push
self.addEventListener('push', event => {
  let data = {
    title: '🔔 Visitas Medicas ERP — Recordatorio',
    body: 'Tienes actividades agendadas pendientes.',
    data: { url: '/#agendar' }
  };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: data.data || { url: '/#agendar' },
    actions: [
      { action: 'open', title: '📅 Ir a Agendar' },
      { action: 'close', title: 'Cerrar' }
    ]
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, options),
      // Notificar a pestañas activas para que muestren la alerta interactiva en pantalla
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'PUSH_REMINDER', data }));
      })
    ])
  );
});

// Clic en la notificación del sistema
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'close') return;

  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/#agendar';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
