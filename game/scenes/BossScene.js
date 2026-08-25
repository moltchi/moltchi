// ============================================================
// game/scenes/BossScene.js — Effet visuel du Boss Mondial
// ============================================================
// PAS un mini-jeu : aucune interaction du joueur, aucun onResult. L'attaque a déjà été
// résolue côté serveur AVANT que cette scène ne soit sollicitée (voir l'appel à
// attack-boss dans app.js) — elle ne fait que rejouer les effets une fois les dégâts
// connus. Voir Bridge.playBossEffect() / Bridge.showBossIdle() / Bridge.showBossAttacked().
//
// Deux couches bien distinctes, indépendantes l'une de l'autre, empilées via setDepth()
// (jamais via l'ordre d'ajout — showAttacked()/showIdle() et playAttack() sont appelés l'un
// après l'autre côté app.js, mais l'un charge une texture déjà en cache (résolution
// synchrone) et l'autre non selon les cas : l'ORDRE D'AJOUT RÉEL à l'écran n'est donc PAS
// fiable, contrairement à setDepth() qui est déterministe quel que soit le timing) :
//   1. Le CORPS du boss (état), depth BODY_DEPTH : idle <-> attacked, un SWAP propre entre
//      deux sprites/animations différents (showIdle()/showAttacked() ci-dessous).
//      showAttacked() joue l'anim une seule fois puis revient automatiquement à idle.
//   2. L'EFFET DE COUP (overlay), depth SLASH_DEPTH (toujours au-dessus) : playAttack(),
//      le sprite de tranchant (media/attackboss_slash.png), qui se rejoue PAR-DESSUS la
//      couche 1 quelle que soit celle affichée en dessous (idle ou attacked), totalement
//      indépendant — se détruit tout seul une fois joué.
// Aucun visuel de secours (voir les conversations précédentes) : si un spritesheet échoue
// à charger, rien ne s'affiche pour cette couche-là — l'autre couche continue de
// fonctionner normalement (ex. le slash peut échouer sans empêcher idle/attacked, et
// inversement).
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.esm.min.js';

// Grille produite par ffmpeg, ex. pour le Golem en idle :
//   ffmpeg -i video.mov -vf "colorkey=0xFFFFFF:0.1:0.1,fps=12,scale=250:250,tile=11x11" -an golem_granit_idle.png
// (même principe pour golem_granit_attacked.png et pour attackboss_slash.png, ce dernier
// étant un effet UNIQUE partagé par tous les boss, pas par bossId). Seule la taille de case
// (250x250) est fixée en dur ci-dessous : le NOMBRE de frames n'est PAS supposé constant
// (chaque vidéo source peut durer différemment). Le nombre réel de frames est déduit après
// coup de la taille de l'image téléchargée (voir _ensureSpriteLoaded), jamais codé en dur.
const SPRITE_FRAME_SIZE = 250;
const SPRITE_FPS = 12;

// Même 4 ids que BOSS_LIST (app.js / attack-boss.ts) — fichiers attendus dans media/ :
//   media/<bossId>_idle.png
//   media/<bossId>_attacked.png
const KNOWN_BOSS_IDS = ['ver_cendres', 'kraken_brumes', 'golem_granit', 'spectre_bourrasques'];

// Effet de coup partagé par tous les boss (pas de variante par bossId) : media/attackboss_slash.png
const SLASH_TEXTURE_KEY = 'boss_attack_slash';
const SLASH_FILE_PATH = 'media/attackboss_slash.png';
// Taille du slash à l'affichage, en fraction du cadre (indépendant de la taille propre au
// sujet dans sa case, ajustable ici si trop petit/grand une fois testé à l'écran).
const SLASH_ZOOM = 0.95;
const SLASH_ZOOM_CRIT = 1.2;

// Profondeurs fixes (setDepth) plutôt que de compter sur l'ordre d'ajout — voir la note en
// tête de fichier. Le slash doit TOUJOURS rendre au-dessus du corps idle/attacked.
const BODY_DEPTH = 0;
const SLASH_DEPTH = 10;

export default class BossScene extends Phaser.Scene {
  constructor(){
    super('BossScene');
    this._loaded = new Set();    // clés de texture déjà en cache (texture+anim prêtes)
    this._loading = new Map();   // clés de texture -> Promise en cours (anti double-chargement)
    this._sprite = null;         // sprite de CORPS actuellement affiché (idle OU attacked)
    this._currentBossId = null;
    this._currentKind = null;    // 'idle' | 'attacked' | null
    this._slashSprite = null;    // sprite de SLASH actuellement en cours de lecture (overlay)
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  /**
   * Affiche (en le téléchargeant si besoin) l'animation idle en boucle du boss donné.
   * Chargement paresseux : un seul spritesheet en mémoire à la fois par boss réellement
   * consulté — cohérent avec le chargement paresseux de Phaser lui-même.
   * @param {string} bossId - un des ids de BOSS_LIST (ver_cendres, kraken_brumes, ...).
   */
  async showIdle(bossId){
    if(!KNOWN_BOSS_IDS.includes(bossId)) return;
    if(this._currentBossId === bossId && this._currentKind === 'idle' && this._sprite) return; // déjà affiché

    const textureKey = `boss_idle_${bossId}`;
    await this._ensureSpriteLoaded(textureKey, `media/${bossId}_idle.png`, { repeat: -1 });
    if(!this._loaded.has(textureKey)) return; // échec de chargement, voir _ensureSpriteLoaded()

    this._showBodySprite(textureKey, 'idle', bossId);
  }

  /**
   * Bascule vers l'animation "coup subi" du boss donné (jouée UNE fois), puis revient
   * automatiquement à l'idle une fois terminée — aucun appel supplémentaire requis côté
   * app.js. Le slash de playAttack() continue de se rejouer par-dessus, indépendamment.
   * Si le spritesheet attacked n'existe pas/échoue à charger : ne fait rien, l'idle en
   * cours (s'il y en a un affiché) reste tel quel — pas de swap sans média disponible.
   * @param {string} bossId - un des ids de BOSS_LIST (ver_cendres, kraken_brumes, ...).
   */
  async showAttacked(bossId){
    if(!KNOWN_BOSS_IDS.includes(bossId)) return;

    const textureKey = `boss_attacked_${bossId}`;
    await this._ensureSpriteLoaded(textureKey, `media/${bossId}_attacked.png`, { repeat: 0 });
    if(!this._loaded.has(textureKey)) return; // pas de sprite de coup dispo, on ne touche à rien

    const sprite = this._showBodySprite(textureKey, 'attacked', bossId);
    // Référence capturée : si entre-temps stopIdle()/un autre show*() a remplacé/détruit ce
    // sprite précis (double-clic rapide sur Attaquer, changement d'onglet...), on ne revient
    // PAS à l'idle à sa place — ce serait écraser un état plus récent.
    sprite.once('animationcomplete', () => {
      if(this._sprite === sprite) this.showIdle(bossId);
    });
  }

  /**
   * Précharge (sans rien afficher, sans toucher au canvas) le spritesheet idle et/ou
   * attacked d'un boss — juste le téléchargement + la définition de l'anim, via
   * _ensureSpriteLoaded(). Rend showIdle()/showAttacked() quasi instantanés au moment où
   * ils sont réellement sollicités. Sûr à appeler plusieurs fois (idempotent) ;
   * fire-and-forget, l'appelant n'a pas besoin d'attendre.
   * @param {string} bossId
   * @param {'idle'|'attacked'} [kind='idle']
   */
  preloadIdle(bossId, kind = 'idle'){
    if(!KNOWN_BOSS_IDS.includes(bossId)) return;
    if(kind === 'idle') this._ensureSpriteLoaded(`boss_idle_${bossId}`, `media/${bossId}_idle.png`, { repeat: -1 });
    else this._ensureSpriteLoaded(`boss_attacked_${bossId}`, `media/${bossId}_attacked.png`, { repeat: 0 });
  }

  /**
   * Précharge le sprite de slash partagé (media/attackboss_slash.png), sans rien afficher.
   * Fire-and-forget — voir preloadIdle() pour le même principe côté idle/attacked.
   */
  preloadSlash(){
    this._ensureSpriteLoaded(SLASH_TEXTURE_KEY, SLASH_FILE_PATH, { repeat: 0 });
  }

  /**
   * Coupe l'animation en cours (corps ET slash, peu importe l'état). À appeler dès que le
   * canvas partagé quitte #boss-portrait-wrap pour une autre zone — sinon cette scène
   * continue de dessiner ses sprites (elle reste RUNNING en permanence, voir bridge.js),
   * qui "suivraient" alors le canvas dans son nouveau conteneur au lieu de disparaître avec
   * l'écran qu'elle animait. Même raison d'être que MainScene.stopCare(). Ne décharge PAS
   * les spritesheets du cache (déjà téléchargés, autant les garder pour un retour rapide
   * sur l'onglet Boss).
   */
  stopIdle(){
    if(this._sprite){ this._sprite.destroy(); this._sprite = null; }
    if(this._slashSprite){ this._slashSprite.destroy(); this._slashSprite = null; }
    this._currentBossId = null;
    this._currentKind = null;
  }

  /** Crée/remplace le sprite de CORPS actuellement affiché (idle ou attacked). */
  _showBodySprite(textureKey, kind, bossId){
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;
    const targetSize = Math.min(width, height) * 0.92; // légère marge, cohérent avec object-fit:contain
    const scale = targetSize / SPRITE_FRAME_SIZE;

    if(this._sprite) this._sprite.destroy();
    this._sprite = this.add.sprite(cx, cy, textureKey).setOrigin(0.5).setScale(scale).setDepth(BODY_DEPTH);
    this._sprite.play(`${textureKey}_anim`);
    this._currentBossId = bossId;
    this._currentKind = kind;
    return this._sprite;
  }

  /**
   * Télécharge (une seule fois, avec cache + anti-double-chargement) un spritesheet et crée
   * son anim Phaser correspondante. `repeat:-1` boucle en continu (idle), `repeat:0` se joue
   * une seule fois (attacked, slash).
   * @param {string} textureKey - clé de cache unique (ex. 'boss_idle_golem_granit').
   * @param {string} filePath - chemin réel du fichier (ex. 'media/golem_granit_idle.png').
   * @param {{ repeat: number }} animConfig
   */
  _ensureSpriteLoaded(textureKey, filePath, animConfig){
    if(this._loaded.has(textureKey)) return Promise.resolve();
    if(this._loading.has(textureKey)) return this._loading.get(textureKey);

    const promise = new Promise((resolve) => {
      this.load.spritesheet(textureKey, filePath, {
        frameWidth: SPRITE_FRAME_SIZE,
        frameHeight: SPRITE_FRAME_SIZE,
      });
      this.load.once(`filecomplete-spritesheet-${textureKey}`, () => {
        if(!this.anims.exists(`${textureKey}_anim`)){
          // Nombre de frames déduit de la texture réellement chargée (frameTotal inclut la
          // frame de base '__BASE' ajoutée automatiquement par Phaser, d'où le -1) plutôt
          // que d'une constante fixe : chaque asset peut avoir une grille différente selon
          // la durée de sa vidéo source.
          const frameCount = this.textures.get(textureKey).frameTotal - 1;
          this.anims.create({
            key: `${textureKey}_anim`,
            frames: this.anims.generateFrameNumbers(textureKey, { start: 0, end: Math.max(0, frameCount - 1) }),
            frameRate: SPRITE_FPS,
            repeat: animConfig.repeat,
          });
        }
        this._loaded.add(textureKey);
        this._loading.delete(textureKey);
        resolve();
      });
      this.load.once('loaderror', (file) => {
        if(file.key === textureKey){
          console.warn(`[Moltchi/Phaser] Spritesheet introuvable : ${filePath}`);
          this._loading.delete(textureKey);
          resolve(); // ne bloque jamais l'appelant — voir les checks !_loaded.has() dans les appelants
        }
      });
      this.load.start();
    });
    this._loading.set(textureKey, promise);
    return promise;
  }

  /**
   * Rejoue l'impact de l'attaque : le sprite de tranchant (media/attackboss_slash.png),
   * PAR-DESSUS le sprite idle/attacked affiché en dessous (qui continue de jouer, non
   * interrompu — voir SLASH_DEPTH en tête de fichier). Se détruit tout seul une fois joué.
   * Si le spritesheet slash échoue à charger, le secouement de caméra / label CRITIQUE se
   * jouent quand même (indépendants), seul le sprite visuel manque.
   * @param {{ crit?: boolean }} [result] - un critique déclenche un effet plus marqué.
   */
  playAttack(result){
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;
    const size = Math.min(width, height);
    const crit = !!(result && result.crit);

    this.cameras.main.shake(crit ? 180 : 120, crit ? 0.014 : 0.008);

    if(crit){
      const label = this.add.text(cx, cy - size * 0.42, 'CRITIQUE !', { fontSize: '13px', color: '#ffce6e', fontStyle: 'bold' })
        .setOrigin(0.5).setAlpha(0).setDepth(SLASH_DEPTH + 1); // au-dessus même du slash
      this.tweens.add({ targets: label, alpha: 1, y: '-=12', duration: 220, delay: 80 });
      this.tweens.add({ targets: label, alpha: 0, delay: 650, duration: 250, onComplete: () => label.destroy() });
    }

    this._playSlash(crit);
  }

  async _playSlash(crit){
    await this._ensureSpriteLoaded(SLASH_TEXTURE_KEY, SLASH_FILE_PATH, { repeat: 0 });
    if(!this._loaded.has(SLASH_TEXTURE_KEY)) return; // échec de chargement, voir _ensureSpriteLoaded()

    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;
    const targetSize = Math.min(width, height) * (crit ? SLASH_ZOOM_CRIT : SLASH_ZOOM);
    const scale = targetSize / SPRITE_FRAME_SIZE;

    if(this._slashSprite) this._slashSprite.destroy();
    const sprite = this.add.sprite(cx, cy, SLASH_TEXTURE_KEY).setOrigin(0.5).setScale(scale).setDepth(SLASH_DEPTH);
    this._slashSprite = sprite;
    sprite.play(`${SLASH_TEXTURE_KEY}_anim`);
    sprite.once('animationcomplete', () => {
      if(this._slashSprite === sprite){ sprite.destroy(); this._slashSprite = null; }
    });
  }
}
