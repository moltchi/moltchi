// ============================================================
// PARTIE 1 — Monetag (pubs) : NE PAS TOUCHER, fourni tel quel par Monetag.
// Gère uniquement les notifications push publicitaires — n'intercepte jamais
// les requêtes réseau (fetch), donc aucun conflit possible avec la partie 2.
// ============================================================
self.options = {
    "domain": "3nbf4.com",
    "zoneId": 11452531
}
self.lary = ""
importScripts('https://3nbf4.com/act/files/service-worker.min.js?r=sw')

// ============================================================
// PARTIE 2 — Moltchi (PWA) : met en cache le shell statique du jeu (HTML/CSS/JS/
// icônes) pour permettre l'installation et un chargement plus rapide/hors-ligne.
// Ne met JAMAIS en cache les appels vers Supabase (créature, boss, chat...) — ces
// données doivent toujours être fraîches, jamais servies depuis le cache.
// ============================================================

const CACHE_NAME = 'moltchi-shell-v20';
// Incrémente CACHE_NAME (v1 -> v2 -> ...) à chaque fois que tu modifies cette liste
// ou que tu veux forcer tous les navigateurs à retélécharger le shell.
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './media/moltchi.png',
  './media/icon-192.png',
  './media/icon-512.png',
  './media/moonberry-tower.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter/cacher les requêtes vers Supabase (API + Edge Functions) ou
  // vers un domaine tiers (CDN Supabase-js, Monetag) — toujours en direct.
  if (url.origin !== self.location.origin) return;

  // Pour les fichiers du shell : cache d'abord (rapide), secours réseau si absent du cache.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
