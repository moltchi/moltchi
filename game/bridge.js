// ============================================================
// game/bridge.js — Point d'entrée UNIQUE entre app.js et Phaser
// ============================================================
// RÈGLE D'OR : app.js n'importe JAMAIS Phaser directement et ne touche JAMAIS
// aux scènes. Il appelle uniquement les fonctions exposées ici (Bridge.*).
// Ça permet de refaire toute l'architecture interne de Phaser plus tard
// (fusionner/scinder des scènes, changer de moteur de particules) sans jamais
// toucher à app.js.
//
// FALLBACK OBLIGATOIRE : tant que Phaser n'est pas chargé/prêt (ou si le
// chargement échoue pour n'importe quelle raison — CDN indisponible, erreur
// navigateur, etc.), chaque fonction Bridge.play*() retourne `false` et NE FAIT
// RIEN d'autre. C'est à l'appelant (app.js) de retomber sur son système
// d'animation existant dans ce cas — voir playCareAnimationWithFallback()
// dans app.js, qui ne supprime jamais playActionAnimation().
//
//   Phaser disponible ?
//          │
//       oui ─────→ animation Phaser (ce fichier retourne true)
//          │
//        non
//          ↓
//   fallback existant (ce fichier retourne false, ne touche à rien)
//
// CHARGEMENT PARESSEUX : Phaser + les scènes ne sont importés qu'au premier
// appel utile (déclenché par app.js dès que la carte créature s'affiche pour
// la première fois — voir preloadPhaser() appelé depuis renderCreature()),
// jamais au chargement initial de la page (écran d'accueil, choix du pseudo).
// ============================================================

const PHASER_CDN_URL = 'https://cdn.jsdelivr.net/npm/phaser@4.1.0/dist/phaser.esm.min.js';

let _loadingPromise = null;
let _game = null;
let _ready = false;

/** true seulement si Phaser est chargé ET la scène principale est prête à recevoir des appels. */
function isReady(){ return _ready; }

/**
 * Démarre (une seule fois) le chargement de Phaser + de la scène principale.
 * Ne bloque jamais l'appelant : à appeler "en tâche de fond", sans await côté app.js
 * si on ne veut pas attendre. Sûr à appeler plusieurs fois (idempotent).
 */
async function ensureLoaded(){
  if(_ready) return true;
  if(_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    try{
      const container = document.getElementById('creature-stage');
      if(!container){
        // Pas de conteneur DOM sur cette page/cet état : rien à faire, pas une erreur.
        return false;
      }

      const [PhaserModule, MainSceneModule] = await Promise.all([
        import(/* webpackIgnore: true */ PHASER_CDN_URL),
        import('./scenes/MainScene.js'),
      ]);
      const Phaser = PhaserModule.default || PhaserModule;
      const MainScene = MainSceneModule.default;

      const width = container.clientWidth || 300;
      const height = container.clientHeight || 300;

      _game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: 'creature-stage',
        transparent: true,
        width,
        height,
        banner: false,
        scene: [MainScene],
      });

      // Attend que MainScene ait bien fini son create() avant de se déclarer prête —
      // sinon un appel Bridge.playCareAnimation() trop précoce échouerait silencieusement.
      await new Promise((resolve) => {
        const scene = _game.scene.getScene('MainScene');
        if(scene && scene.sys.settings.status >= 5){ resolve(); return; }
        _game.events.once('ready', () => {
          const s = _game.scene.getScene('MainScene');
          if(s.sys.settings.status >= 5) resolve();
          else s.events.once('create', resolve);
        });
      });

      // Redimensionne le canvas si le conteneur change de taille (rotation d'écran,
      // redimensionnement de fenêtre desktop...).
      window.addEventListener('resize', () => {
        if(!_game) return;
        const c = document.getElementById('creature-stage');
        if(c) _game.scale.resize(c.clientWidth || width, c.clientHeight || height);
      });

      _ready = true;
      return true;
    } catch(e){
      // Erreur réseau, CDN bloqué, navigateur trop ancien, etc. : on ne casse RIEN,
      // on log juste pour le debug et on laisse _ready à false pour toujours (jusqu'au
      // prochain rechargement de page, qui retentera).
      console.warn('[Moltchi/Phaser] Chargement impossible, fallback sur l\'animation existante :', e);
      return false;
    }
  })();

  return _loadingPromise;
}

// ---------- API appelée depuis app.js ----------

/**
 * Joue l'animation de soin (nourrir/jouer/reposer) si Phaser est prêt — avec la
 * VRAIE vidéo de la race concernée (résolue côté app.js avant l'appel).
 * @param {string} fieldName - 'eatVideo' | 'playVideo' | 'sleepVideo' (conservé pour
 *   cohérence avec l'ancien système côté app.js).
 * @param {string} src - chemin réel de la vidéo à jouer (ex. "media/braisien-eat.mp4").
 * @returns {boolean} true si Phaser a pris en charge l'animation (l'appelant ne doit
 *   alors RIEN faire de plus) ; false s'il faut utiliser le fallback existant.
 */
function playCareAnimation(fieldName, src){
  if(!_ready || !_game || !src) return false;
  const scene = _game.scene.getScene('MainScene');
  if(!scene || typeof scene.playCare !== 'function') return false;
  scene.playCare(fieldName, src);
  return true;
}

export const Bridge = { isReady, ensureLoaded, playCareAnimation };
