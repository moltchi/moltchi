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

const PHASER_CDN_URL = 'https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.esm.min.js';

let _loadingPromise = null;
let _game = null;
let _ready = false;

/** true seulement si Phaser est chargé ET la scène principale est prête à recevoir des appels. */
function isReady(){ return _ready; }

/**
 * Démarre (une seule fois) le chargement de Phaser + de la scène principale.
 * Sûr à appeler plusieurs fois (idempotent) — les appels suivants renvoient la même
 * promesse déjà en cours/terminée.
 * @param {(pct:number, stage:string) => void} [onProgress] - optionnel, appelé à chaque
 *   étape franchie (utilisé par l'écran de chargement au lancement de l'appli). Le
 *   premier appelant (celui qui déclenche réellement le chargement) est le seul dont
 *   le callback est utilisé ; les appels suivants pendant que le chargement est déjà en
 *   cours reçoivent juste la promesse, sans progression détaillée.
 */
async function ensureLoaded(onProgress){
  const report = (pct, stage) => { if(typeof onProgress === 'function') onProgress(pct, stage); };

  if(_ready){ report(100, 'ready'); return true; }
  if(_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    try{
      report(5, 'init');
      const container = document.getElementById('creature-stage');
      if(!container){
        // Pas de conteneur DOM sur cette page/cet état : rien à faire, pas une erreur.
        report(100, 'no-container');
        return false;
      }

      report(15, 'downloading');
      const [PhaserModule, MainSceneModule, TrainingSceneModule, TreasureSceneModule, DungeonSceneModule, BossSceneModule] = await Promise.all([
        import(/* webpackIgnore: true */ PHASER_CDN_URL),
        import('./scenes/MainScene.js'),
        import('./scenes/TrainingScene.js'),
        import('./scenes/TreasureScene.js'),
        import('./scenes/DungeonScene.js'),
        import('./scenes/BossScene.js'),
      ]);
      report(55, 'engine-loaded');
      const Phaser = PhaserModule.default || PhaserModule;
      const MainScene = MainSceneModule.default;
      const TrainingScene = TrainingSceneModule.default;
      const TreasureScene = TreasureSceneModule.default;
      const DungeonScene = DungeonSceneModule.default;
      const BossScene = BossSceneModule.default;

      const width = container.clientWidth || 300;
      const height = container.clientHeight || 300;

      _game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: 'creature-stage',
        transparent: true,
        width,
        height,
        banner: false,
        // Seule MainScene est passée ici : quand plusieurs scènes sont listées dans
        // config.scene, Phaser ne démarre AUTOMATIQUEMENT que la première du tableau —
        // les suivantes sont simplement ajoutées au gestionnaire de scènes sans jamais
        // être lancées. TrainingScene ne devenait donc jamais RUNNING, d'où le timeout
        // systématique de waitRunning() ci-dessous. On ajoute nous-mêmes chaque scène
        // supplémentaire juste après avec autoStart:true (3e argument de scene.add())
        // pour la démarrer explicitement.
        scene: [MainScene],
      });
      report(70, 'game-created');
      _game.scene.add('TrainingScene', TrainingScene, true);
      _game.scene.add('TreasureScene', TreasureScene, true);
      _game.scene.add('DungeonScene', DungeonScene, true);
      _game.scene.add('BossScene', BossScene, true);

      // Attend que chaque scène ait bien fini son create() avant de continuer (sinon
      // scene.getScene(key).xxx() pourrait être appelé sur une scène pas encore
      // initialisée). On utilise scene.isActive() (API publique documentée : true
      // seulement quand une scène est RUNNING) plutôt qu'un numéro de statut interne
      // deviné — plus fiable, ne dépend d'aucun détail d'implémentation.
      async function waitRunning(key, timeoutMs = 5000){
        if(_game.scene.isActive(key)) return true;
        const start = Date.now();
        return new Promise((resolve) => {
          const check = () => {
            if(_game.scene.isActive(key)){ resolve(true); return; }
            if(Date.now() - start > timeoutMs){
              console.warn(`[Moltchi/Phaser] Timeout en attendant le démarrage de ${key}`);
              resolve(false);
              return;
            }
            setTimeout(check, 16); // ~1 frame à 60fps, simple et fiable, ne dépend d'aucun événement interne Phaser
          };
          check();
        });
      }
      const mainOk = await waitRunning('MainScene');
      report(84, 'main-scene-ready');
      const trainingOk = await waitRunning('TrainingScene');
      report(90, 'training-scene-ready');
      const treasureOk = await waitRunning('TreasureScene');
      const dungeonOk = await waitRunning('DungeonScene');
      const bossOk = await waitRunning('BossScene');
      report(96, 'fx-scenes-ready');
      if(!mainOk){ report(100, 'main-scene-failed'); return false; } // MainScene est indispensable (animations de soin) : sans elle, pas la peine de continuer
      if(!trainingOk){
        // Cas dégradé rare : MainScene fonctionne (soin OK) mais TrainingScene a mis trop
        // de temps à démarrer — on continue quand même, startReflexGame() échouera juste
        // proprement (scene introuvable/pas prête) et app.js retombera sur son fallback DOM.
        console.warn('[Moltchi/Phaser] TrainingScene indisponible, les mini-jeux utiliseront leur fallback DOM.');
      }
      if(!treasureOk) console.warn('[Moltchi/Phaser] TreasureScene indisponible, pas d\'effet visuel pour la Chasse aux trésors.');
      if(!dungeonOk) console.warn('[Moltchi/Phaser] DungeonScene indisponible, pas d\'effet visuel pour les Donjons.');
      if(!bossOk) console.warn('[Moltchi/Phaser] BossScene indisponible, pas d\'effet visuel pour le Boss Mondial.');
      // NB : toutes les scènes restent RUNNING en permanence, aucun sleep()/wake() — voir
      // la note au-dessus de _moveCanvasTo() plus bas pour l'explication complète.

      // Redimensionne le canvas si le conteneur change de taille (rotation d'écran,
      // redimensionnement de fenêtre desktop...). Se base sur le conteneur ACTUELLEMENT
      // parent du canvas (creature-stage ou training-stage selon le contexte du moment).
      window.addEventListener('resize', () => {
        if(!_game || !_game.canvas) return;
        const c = _game.canvas.parentElement;
        if(c) _game.scale.resize(c.clientWidth || width, c.clientHeight || height);
      });

      _ready = true;
      report(100, 'ready');
      return true;
    } catch(e){
      // Erreur réseau, CDN bloqué, navigateur trop ancien, etc. : on ne casse RIEN,
      // on log juste pour le debug et on laisse _ready à false pour toujours (jusqu'au
      // prochain rechargement de page, qui retentera).
      console.warn('[Moltchi/Phaser] Chargement impossible, fallback sur l\'animation existante :', e);
      report(100, 'error');
      return false;
    }
  })();

  return _loadingPromise;
}

// Un seul canvas Phaser pour toute l'application (plus léger sur mobile qu'un canvas par
// zone) : on le déplace physiquement dans le DOM selon la zone active, plutôt que de créer
// plusieurs instances Phaser.Game. Le canvas est un simple élément DOM, le déplacer ne
// détruit ni son contexte WebGL/Canvas2D ni l'état de la scène qui y dessine.
//
// TOUTES LES SCÈNES RESTENT ACTIVES EN PERMANENCE (pas de sleep()/wake()) : plus simple et
// plus robuste que d'endormir/réveiller les scènes à chaque changement d'écran (ça a été
// la source de plusieurs bugs — "Cannot sleep non-running Scene", timeout au chargement).
// Ce n'est normalement pas un problème visuel : chaque scène ne dessine QUE ce qu'elle a
// explicitement affiché, et le nettoie explicitement après usage — TrainingScene détruit
// sa zone de jeu après chaque partie, les scènes d'effets (Trésor/Donjon/Boss) détruisent
// leurs objets dès la fin de leur tween. SEULE EXCEPTION : MainScene, dont la vidéo de
// soin peut être encore en cours de lecture quand on quitte #creature-stage (le joueur
// enchaîne une autre action avant la fin de l'animation) — sans interruption explicite,
// elle continuerait de dessiner cette vidéo, qui "suivrait" alors le canvas dans son
// nouveau conteneur au lieu de disparaître avec l'écran qu'elle animait. D'où le
// stopCare() ci-dessous, à chaque fois qu'on quitte #creature-stage.
function _moveCanvasTo(containerId){
  if(!_game || !_game.canvas) return false;
  const container = document.getElementById(containerId);
  if(!container) return false;
  if(containerId !== 'creature-stage'){
    const mainScene = _game.scene.getScene('MainScene');
    if(mainScene && typeof mainScene.stopCare === 'function') mainScene.stopCare();
  }
  container.appendChild(_game.canvas);
  _game.scale.resize(container.clientWidth || 300, container.clientHeight || 300);
  return true;
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
  // Recale le canvas sur la vraie taille de #creature-stage avant de jouer l'animation :
  // le tout premier Phaser.Game a pu être créé alors que ce conteneur était encore
  // display:none (préchargement dès init(), avant même l'écran de connexion), auquel cas
  // sa taille avait été devinée à 300x300 par défaut. Comme pour startReflexGame(), on
  // s'assure ici que le redimensionnement se base sur la taille réelle, maintenant que
  // la carte créature est forcément affichée (on a une créature à animer).
  _moveCanvasTo('creature-stage');
  scene.playCare(fieldName, src);
  return true;
}

/**
 * Démarre un mini-jeu d'entraînement (Réflexe/Mémoire/Rythme/Invocation) si Phaser est
 * prêt. Facteur commun aux 4 : affiche #training-stage, y déplace/redimensionne le
 * canvas partagé, puis délègue à la méthode `sceneMethod` de TrainingScene. Phaser ne
 * fait QUE remonter l'interaction brute du joueur via `onResult` — c'est toujours app.js
 * qui appelle ensuite le serveur (performAction) et affiche le résultat réel.
 * @param {string} sceneMethod - 'startReflex' | 'startMemory' | 'startRhythm' | 'startArcane'
 * @param {(result: object) => void} onResult
 * @returns {boolean} true si Phaser gère le mini-jeu ; false → fallback DOM existant.
 */
function _startTrainingMinigame(sceneMethod, onResult){
  if(!_ready || !_game) return false;
  const scene = _game.scene.getScene('TrainingScene');
  if(!scene || typeof scene[sceneMethod] !== 'function') return false;
  // IMPORTANT : on affiche #training-stage AVANT de déplacer/redimensionner le canvas
  // dessus. _moveCanvasTo() lit container.clientWidth/clientHeight pour redimensionner —
  // si le conteneur est encore display:none à ce moment-là, ces valeurs valent 0 et on
  // retombe sur le carré 300x300 par défaut, complètement différent de la vraie zone
  // (large et basse, ~130px de haut sur toute la largeur de la carte). Résultat : rendu
  // écrasé/étiré une fois affiché. Inverser l'ordre garantit que clientWidth/Height
  // reflètent la vraie taille de la zone au moment du redimensionnement.
  document.getElementById('training-stage').style.display = 'block';
  if(!_moveCanvasTo('training-stage')) return false;
  scene[sceneMethod](onResult);
  return true;
}

/** @param {(result: {reactionMs?: number, tooEarly?: boolean}) => void} onResult */
function startReflexGame(onResult){ return _startTrainingMinigame('startReflex', onResult); }

/** @param {(result: {success: boolean, playerIdx: number}) => void} onResult */
function startMemoryGame(onResult){ return _startTrainingMinigame('startMemory', onResult); }

/** @param {(result: {distFromCenter: number}) => void} onResult */
function startRhythmGame(onResult){ return _startTrainingMinigame('startRhythm', onResult); }

/** @param {(result: {totalScore: number}) => void} onResult - appelé une seule fois, à la fin des 5 manches. */
function startArcaneGame(onResult){ return _startTrainingMinigame('startArcane', onResult); }

/** Affiche un texte de résultat dans la scène (ex. "142ms — +14 Critique"), si Phaser gère le mini-jeu en cours. */
function showTrainingResult(text){
  if(!_ready || !_game) return false;
  const scene = _game.scene.getScene('TrainingScene');
  if(!scene || typeof scene.showResult !== 'function') return false;
  scene.showResult(text);
  return true;
}

/** À appeler quand le joueur quitte l'écran du mini-jeu (change d'onglet, relance une partie...). */
function stopTrainingGame(){
  if(!_game) return;
  const scene = _game.scene.getScene('TrainingScene');
  if(scene && typeof scene.stopAll === 'function') scene.stopAll(); // détruit le mini-jeu en cours, quel qu'il soit — plus rien à dessiner
  const stage = document.getElementById('training-stage');
  if(stage) stage.style.display = 'none';
  if(_ready) _moveCanvasTo('creature-stage');
}

/**
 * Joue un effet visuel ponctuel (Chasse aux trésors/Donjons/Boss Mondial) si Phaser est
 * prêt. Contrairement aux mini-jeux d'entraînement, ces scènes ne remontent RIEN à
 * app.js : l'appel serveur a déjà eu lieu et le résultat réel est déjà connu AVANT que
 * cette fonction ne soit appelée — l'effet est purement décoratif, en aucun cas critique.
 * @param {string} containerId - id du conteneur DOM cible (ex. 'boss-fx-stage')
 * @param {string} sceneKey - clé de la scène Phaser (ex. 'BossScene')
 * @param {string} sceneMethod - méthode à appeler sur cette scène (ex. 'playAttack')
 * @param {object} [payload] - transmis tel quel à la méthode de la scène
 * @returns {boolean} true si l'effet a été joué ; false s'il n'y a simplement rien à
 *   faire côté appelant (pas de fallback nécessaire, contrairement aux mini-jeux — ces
 *   effets sont un bonus visuel, jamais une fonctionnalité).
 */
function _playFxEffect(containerId, sceneKey, sceneMethod, payload){
  if(!_ready || !_game) return false;
  const scene = _game.scene.getScene(sceneKey);
  if(!scene || typeof scene[sceneMethod] !== 'function') return false;
  if(!_moveCanvasTo(containerId)) return false;
  scene[sceneMethod](payload);
  return true;
}

/** @param {{ itemFound?: boolean }} [result] */
function playTreasureEffect(result){ return _playFxEffect('treasure-fx-stage', 'TreasureScene', 'playDig', result); }

/**
 * @param {string} containerId - une des 3 variantes : 'dungeon-fx-stage' (Tour du Wyrm),
 *   'corrupt-fx-stage' (Sanctuaire Corrompu), 'noyau-fx-stage' (Noyau Primordial).
 * @param {{ won: boolean }} result
 */
function playDungeonEffect(containerId, result){ return _playFxEffect(containerId, 'DungeonScene', 'playClimb', result); }

/** @param {{ crit?: boolean }} [result] */
function playBossEffect(result){ return _playFxEffect('boss-fx-stage', 'BossScene', 'playAttack', result); }

export const Bridge = {
  isReady, ensureLoaded, playCareAnimation,
  startReflexGame, startMemoryGame, startRhythmGame, startArcaneGame,
  showTrainingResult, stopTrainingGame,
  playTreasureEffect, playDungeonEffect, playBossEffect,
};
