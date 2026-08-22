// ============================================================
// game/scenes/MainScene.js — Scène de démarrage (carte compagnon)
// ============================================================
// Rejoue les VRAIES animations de soin (nourrir/jouer/reposer) de chaque race —
// les mêmes fichiers mp4 déjà utilisés par l'ancien système (playActionAnimation
// dans app.js), simplement lus via l'objet Video natif de Phaser plutôt qu'une
// balise <video> HTML classique. Zéro nouvel asset à créer.
//
// Pourquoi via Phaser plutôt que directement en HTML (comme avant) : c'est ce qui
// permettra plus tard d'enrichir ces animations avec de vraies couches Phaser
// (particules, effets de lumière, transitions) sans rien changer côté app.js —
// le contrat (playCare(fieldName, src)) reste stable.
//
// TrainingScene.js / DungeonScene.js / BossScene.js suivront plus tard le même
// schéma général (une classe Phaser.Scene, enregistrée une fois dans bridge.js,
// activée/désactivée via sleep()/wake() plutôt que détruite/recréée).
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.1.0/dist/phaser.esm.min.js';

export default class MainScene extends Phaser.Scene {
  constructor(){
    super('MainScene');
    this._lastVideoDims = null;
  }

  create(){
    // Fond transparent : le portrait/l'ambiance de la carte compagnon reste le HTML/CSS
    // existant en dessous ; Phaser ne fait qu'occuper le premier plan pendant l'action.
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');

    // Un seul objet Video réutilisé pour toutes les animations de soin, quelle que soit
    // la race — on change juste sa source (loadURL) à chaque appel plutôt que d'en créer
    // un nouveau à chaque fois (évite l'accumulation d'éléments <video> DOM cachés).
    this._video = this.add.video(0, 0).setVisible(false);
    this._video.on('created', (video, width, height) => this._fitCover(width, height));
    this._video.on('complete', () => this._video.setVisible(false));

    // Recale le cadrage "cover" si la carte change de taille (rotation d'écran mobile,
    // redimensionnement de fenêtre desktop...).
    this.scale.on('resize', () => {
      if(this._lastVideoDims) this._fitCover(this._lastVideoDims.w, this._lastVideoDims.h);
    });
  }

  // Reproduit le comportement CSS "object-fit:cover" utilisé par l'ancien système vidéo :
  // remplit tout le cadre sans déformer l'image, quitte à rogner les bords qui dépassent.
  _fitCover(videoWidth, videoHeight){
    this._lastVideoDims = { w: videoWidth, h: videoHeight };
    const { width, height } = this.scale;
    this._video.setPosition(width / 2, height / 2);
    const scale = Math.max(width / videoWidth, height / videoHeight);
    this._video.setScale(scale);
  }

  /**
   * @param {string} fieldName - 'eatVideo' | 'playVideo' | 'sleepVideo' (conservé pour
   *   cohérence avec l'ancien système, mais pas exploité ici : seule `src` compte,
   *   déjà résolue par race côté app.js avant l'appel).
   * @param {string} src - chemin réel de la vidéo (ex. "media/braisien-eat.mp4").
   */
  playCare(fieldName, src){
    if(!src || !this._video) return;
    this._video.setVisible(true);
    this._video.loadURL(src, true); // noAudio:true -> autoplay possible sans interaction, comme l'ancien <video muted>
    this._video.play(false); // false = ne boucle pas (une seule lecture, comme avant)
  }

  /**
   * Interrompt immédiatement l'animation de soin en cours, si il y en a une. À appeler
   * dès que le canvas partagé quitte #creature-stage pour une autre zone (mini-jeu,
   * effet Trésor/Donjon/Boss...) — sinon cette scène continue de dessiner la vidéo (elle
   * reste RUNNING en permanence, voir bridge.js), qui "suit" alors le canvas dans son
   * nouveau conteneur au lieu de disparaître avec l'écran qu'elle animait.
   */
  stopCare(){
    if(!this._video) return;
    if(this._video.isPlaying()) this._video.stop();
    this._video.setVisible(false);
  }
}

