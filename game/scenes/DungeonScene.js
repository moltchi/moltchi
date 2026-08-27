// ============================================================
// game/scenes/DungeonScene.js — Donjons (Tour du Wyrm / Sanctuaire Corrompu / Noyau
// Primordial)
// ============================================================
// HUD complet GÉNÉRALISÉ aux 3 donjons (voir la conversation) : un seul jeu de méthodes
// (showDungeonHUD/stopDungeonHUD/preloadDungeonAssets) paramétré par un "dungeonKey"
// ('dungeon' | 'corrupt' | 'noyau') plutôt que 3 copies quasi identiques — seul le fond
// change réellement d'un donjon à l'autre (voir DUNGEON_BG), tout le reste (cadre, bouton,
// gemmes, panneau récompense+log) est strictement partagé.
//
// ⚠️ CONTRAINTE CANVAS PARTAGÉ : les 3 donjons vivent dans LE MÊME onglet/panneau HTML
// (#panel-dungeon), empilés en scroll — Tour, puis Sanctuaire, puis Noyau. Comme il n'y a
// qu'UN SEUL canvas Phaser partagé pour toute l'app, il ne peut afficher qu'UN SEUL de ces
// 3 HUD à la fois. app.js décide LEQUEL via un IntersectionObserver qui suit le scroll (voir
// activeDungeonSection dans app.js) — cette scène se contente d'afficher ce qu'on lui
// demande, dungeonKey par dungeonKey.
//
// ⚠️ MÊME PIÈGE QUE POUR LE BOSS, CORRIGÉ DÈS LE DÉPART : cette scène reste RUNNING en
// permanence et redessine tout ce qu'elle a créé à CHAQUE FRAME, peu importe où le canvas
// partagé se trouve. Tous les objets du HUD sont trackés dans this._uiObjects et détruits
// par stopDungeonHUD(), appelée par _moveCanvasTo() dès que le canvas quitte les 3
// conteneurs de donjon — sinon le HUD continuerait de s'afficher par-dessus n'importe quel
// autre écran (Créature, Boss...).
//
// Deux couches indépendantes, empilées via setDepth() :
//   0. HUD (fond, textes, bouton, panneau) — HUD_DEPTH
//   1. Effet de choc d'épées (playClimb), toujours au-dessus — EFFECT_DEPTH
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.esm.min.js';

const FONT_FAMILY = '"Press Start 2P", monospace';

// Fond d'arrière-plan : LE SEUL élément qui dépend vraiment du donjon (même philosophie que
// BOSS_ARENA_BG dans BossScene.js). Si un donjon n'a pas encore de fond dédié généré, rien
// ne s'affiche pour cette couche (pas de repli visuel, même politique que pour les boss).
const DUNGEON_BG = {
  dungeon: { key: 'dungeon_bg_dungeon', path: 'media/wyrmtower_arena.jpg' },
  corrupt: { key: 'dungeon_bg_corrupt', path: 'media/corrupt_sanctuary_arena.jpg' },
  noyau: { key: 'dungeon_bg_noyau', path: 'media/noyau_primordial_arena.jpg' },
};

// Chrome partagé par les 3 donjons — un seul jeu d'assets, pas de variante par donjon.
const BUTTON_KEY = 'dungeon_climb_button';
const BUTTON_PATH = 'media/dungeon_climb_button.png';
const INFO_PANEL_KEY = 'dungeon_info_panel';
const INFO_PANEL_PATH = 'media/dungeon_info_panel.png';
// Gemmes réutilisées TELLES QUELLES depuis le Boss (mêmes clés, même fichier) — Phaser
// partage le cache de textures entre toutes les scènes d'un même Game, donc si BossScene
// les a déjà chargées, aucun re-téléchargement ici.
const GEM_FULL_KEY = 'boss_gem_full';
const GEM_FULL_PATH = 'media/boss_gem_full.png';
const GEM_EMPTY_KEY = 'boss_gem_empty';
const GEM_EMPTY_PATH = 'media/boss_gem_empty.png';

const HUD_DEPTH = 0;
const EFFECT_DEPTH = 10;

export default class DungeonScene extends Phaser.Scene {
  constructor(){
    super('DungeonScene');
    this._uiBuilt = false;
    this._uiBuiltDungeonKey = null;
    this._uiBuiltWidth = null;
    this._uiBuiltHeight = null;
    this._uiObjects = [];
    this._pipImages = [];
    this._onClimbClick = null;
    this._assetsPromise = null; // chrome partagé (bouton/panneau/gemmes)
    this._bgPromises = {}; // dungeonKey -> Promise, cache anti-double-chargement du fond
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  /** Ajoute un GameObject à la liste de nettoyage (voir stopDungeonHUD()) et le renvoie tel quel. */
  _track(obj){ this._uiObjects.push(obj); return obj; }

  // ============================================================
  // HUD COMPLET — Tour du Wyrm / Sanctuaire Corrompu / Noyau Primordial
  // ============================================================
  /**
   * Affiche/actualise le HUD pour le donjon donné. Construit le chrome statique une seule
   * fois par (dungeonKey, taille) ; les appels suivants avec le MÊME dungeonKey ne font que
   * mettre à jour les valeurs. Reconstruit automatiquement si la taille du canvas change OU
   * si dungeonKey change (passage Tour -> Sanctuaire, etc.).
   * @param {'dungeon'|'corrupt'|'noyau'} dungeonKey
   * @param {{
   *   dungeonName: string, floorLabel: string, floorNum: number,
   *   powerLabel: string, yourPower: number, reqLabel: string, floorPower: number,
   *   attemptsText: string, attemptsUsed: number, attemptsMax: number,
   *   clearsText: string, climbLabel: string, climbDisabled: boolean,
   *   rewardText: string, log: string[],
   *   onClimb: () => void,
   * }} data
   */
  async showDungeonHUD(dungeonKey, data){
    const bg = DUNGEON_BG[dungeonKey];
    await Promise.all([
      this._ensureSharedAssetsLoaded(),
      bg ? this._ensureBgLoaded(dungeonKey) : Promise.resolve(),
    ]);
    if(!bg || !this.textures.exists(bg.key)) return; // fond manquant/échec, rien à afficher

    const { width, height } = this.scale;
    const sizeChanged = this._uiBuilt && (this._uiBuiltWidth !== width || this._uiBuiltHeight !== height);
    const dungeonChanged = this._uiBuilt && this._uiBuiltDungeonKey !== dungeonKey;
    if(sizeChanged || dungeonChanged) this._destroyStaticUI();

    if(!this._uiBuilt) this._buildStaticUI(dungeonKey);

    this._onClimbClick = typeof data.onClimb === 'function' ? data.onClimb : null;

    this._nameText.setText((data.dungeonName || '').toUpperCase());
    this._floorLabelText.setText(data.floorLabel || '');
    this._floorText.setText(String(data.floorNum));
    this._powerLabelText.setText(data.powerLabel || '');
    this._powerText.setText(`${data.yourPower.toLocaleString()}`);
    this._reqLabelText.setText(data.reqLabel || '');
    this._reqText.setText(`${data.floorPower.toLocaleString()}`);
    // Empilement du bas vers le haut : clearsText reste ancré au fond du cadre (fixe),
    // attemptsText se cale juste au-dessus selon sa hauteur réelle une fois posé (1 ou 2
    // lignes), puis les gemmes juste au-dessus d'attemptsText — plus de vide résiduel ni de
    // chevauchement, quel que soit le nombre de lignes de chaque texte.
    this._clearsText.setText(data.clearsText || '');
    this._attemptsText.setText(data.attemptsText || '');
    this._attemptsText.setY(this._clearsText.y - this._clearsText.height - 4);
    this._pipRowY = this._attemptsText.y - this._attemptsText.height - 10;
    this._updatePips(data.attemptsUsed, data.attemptsMax);
    this._updateClimbButton(data.climbLabel, data.climbDisabled);

    this._rewardText.setText(data.rewardText || '');
    const logLineCount = this._isMobileLike ? 1 : 3;
    const logLines = (data.log || []).slice(0, logLineCount);
    this._logText.setText(logLines.length ? logLines.join('\n') : '…');
  }

  _buildStaticUI(dungeonKey){
    const { width, height } = this.scale;
    this._uiBuiltDungeonKey = dungeonKey;
    this._uiBuiltWidth = width;
    this._uiBuiltHeight = height;

    const fp = (fraction, min, max) => Math.max(min, Math.min(max, Math.round(width * fraction)));
    const stroke = { stroke: '#120a20', strokeThickness: Math.max(2, Math.round(width * 0.0025)) };

    // Décor à SON PROPRE ratio (pas étiré sur toute la hauteur du canvas) : le panneau
    // récompense+log vient occuper l'espace restant en dessous.
    const bg = DUNGEON_BG[dungeonKey];
    const bgNative = this.textures.get(bg.key).getSourceImage();
    const bgDisplayH = width * (bgNative.height / bgNative.width);
    this._track(this.add.image(width / 2, bgDisplayH / 2, bg.key).setDisplaySize(width, bgDisplayH).setDepth(HUD_DEPTH));

    // --- Panneau récompense de l'étage + log de combat, sous le décor ---
    const panelNative = this.textures.get(INFO_PANEL_KEY).getSourceImage();
    const panelY = bgDisplayH + 8;
    const panelDisplayH = width * (panelNative.height / panelNative.width);
    this._track(this.add.image(width / 2, panelY, INFO_PANEL_KEY).setOrigin(0.5, 0).setDisplaySize(width, panelDisplayH).setDepth(HUD_DEPTH));

    const panelPadX = width * 0.035;
    // Mesuré précisément sur le fichier (colonne centrale) : la tête de dragon s'arrête à
    // ~27,7% de la hauteur du panneau — 28% laisse une petite marge de sécurité.
    const panelPadYTop = panelDisplayH * 0.28;
    const rewardSize = fp(0.011, 6, 9);
    const logSize = fp(0.012, 7, 10);
    // Même seuil que BossScene (MOBILE_BREAKPOINT), juste pour limiter le nombre de lignes
    // de log affichées sur petit écran (voir showDungeonHUD).
    this._isMobileLike = width < 520;

    // Log SEUL dans le panneau (voir la conversation) — la récompense/l'affinité (Noyau)
    // sont sorties en dessous, en texte simple, pour laisser le panneau dédié uniquement
    // au journal de combat.
    this._logText = this._track(this.add.text(width / 2, panelY + panelPadYTop, '', {
      fontFamily: FONT_FAMILY, fontSize: logSize + 'px', color: '#fff6e6', ...stroke,
      align: 'center', wordWrap: { width: width - panelPadX * 2 }, lineSpacing: 3,
    }).setOrigin(0.5, 0).setDepth(HUD_DEPTH + 0.2));

    // Texte de récompense (+ affinité pour le Noyau, fusionnée par app.js), en dessous du
    // panneau, texte simple sans cadre.
    this._rewardText = this._track(this.add.text(width / 2, panelY + panelDisplayH + 10, '', {
      fontFamily: FONT_FAMILY, fontSize: rewardSize + 'px', color: '#cfc3e8', ...stroke,
      align: 'center', wordWrap: { width: width - panelPadX * 2 }, lineSpacing: 3,
    }).setOrigin(0.5, 0).setDepth(HUD_DEPTH + 0.2));

    const floorLabelSize = fp(0.016, 8, 13);
    const floorNumSize = fp(0.048, 20, 36);
    const nameSize = fp(0.026, 12, 20);
    const powerLabelSize = fp(0.014, 7, 11);
    const powerValueSize = fp(0.024, 11, 18);
    const attemptsSize = fp(0.015, 7, 12);
    const climbLabelSize = fp(0.020, 9, 15);

    // --- Étage courant, en haut à gauche ---
    this._floorLabelText = this._track(this.add.text(16, 12, '', {
      fontFamily: FONT_FAMILY, fontSize: floorLabelSize + 'px', color: '#cfc3e8', ...stroke,
    }).setOrigin(0, 0).setDepth(HUD_DEPTH + 0.2));
    this._floorText = this._track(this.add.text(16, 12 + floorLabelSize + 4, '', {
      fontFamily: FONT_FAMILY, fontSize: floorNumSize + 'px', color: '#f4efe6', ...stroke,
    }).setOrigin(0, 0).setDepth(HUD_DEPTH + 0.2));

    // --- Nom du donjon, centré en haut, entre l'étage (gauche) et la puissance (droite) ---
    this._nameText = this._track(this.add.text(width / 2, 12, '', {
      fontFamily: FONT_FAMILY, fontSize: nameSize + 'px', color: '#f4efe6', ...stroke, align: 'center',
      wordWrap: { width: width * 0.42 }, lineSpacing: 2,
    }).setOrigin(0.5, 0).setDepth(HUD_DEPTH + 0.2));

    // --- Puissance vs défi de l'étage, en haut à droite ---
    const powerY = 14;
    this._powerLabelText = this._track(this.add.text(width - 16, powerY, '', {
      fontFamily: FONT_FAMILY, fontSize: powerLabelSize + 'px', color: '#ffce6e', ...stroke,
    }).setOrigin(1, 0).setDepth(HUD_DEPTH + 0.2));
    this._powerText = this._track(this.add.text(width - 16, powerY + powerLabelSize + 3, '', {
      fontFamily: FONT_FAMILY, fontSize: powerValueSize + 'px', color: '#ffce6e', ...stroke,
    }).setOrigin(1, 0).setDepth(HUD_DEPTH + 0.2));
    const reqY = powerY + powerLabelSize + powerValueSize + 12;
    this._reqLabelText = this._track(this.add.text(width - 16, reqY, '', {
      fontFamily: FONT_FAMILY, fontSize: powerLabelSize + 'px', color: '#e2793f', ...stroke,
    }).setOrigin(1, 0).setDepth(HUD_DEPTH + 0.2));
    this._reqText = this._track(this.add.text(width - 16, reqY + powerLabelSize + 3, '', {
      fontFamily: FONT_FAMILY, fontSize: powerValueSize + 'px', color: '#e2793f', ...stroke,
    }).setOrigin(1, 0).setDepth(HUD_DEPTH + 0.2));

    // --- Tentatives + réussites, bas gauche ---
    this._pipRowX = 16;
    // Ancrés PAR LE BAS (origin y=1) plutôt que par le haut : ils collent ainsi toujours au
    // bas du cadre, que le texte tienne sur 1 ou 2 lignes — les positions Y exactes sont
    // recalculées dynamiquement dans showDungeonHUD() une fois le contenu réel connu (voir
    // plus haut), ces valeurs de création ne sont que des points de départ provisoires.
    // ⚠️ Ancrés au bas du DÉCOR (bgDisplayH), PAS du canvas entier (height) — sinon ils
    // tombent dans la zone du panneau récompense+log, qui doit rester une zone séparée et
    // propre (voir la conversation).
    this._clearsText = this._track(this.add.text(16, bgDisplayH - 16, '', {
      fontFamily: FONT_FAMILY, fontSize: attemptsSize + 'px', color: '#cfc3e8', ...stroke,
      wordWrap: { width: width * 0.6 }, lineSpacing: 2,
    }).setOrigin(0, 1).setDepth(HUD_DEPTH + 0.2));
    this._attemptsText = this._track(this.add.text(16, bgDisplayH - 16, '', {
      fontFamily: FONT_FAMILY, fontSize: attemptsSize + 'px', color: '#f4efe6', ...stroke,
      wordWrap: { width: width * 0.6 }, lineSpacing: 2,
    }).setOrigin(0, 1).setDepth(HUD_DEPTH + 0.2));
    this._pipRowY = bgDisplayH - 16;
    this._pipSize = Math.max(11, Math.round(width * 0.022));

    // --- Bouton "Tenter l'étage", bas droite DU DÉCOR (même remarque que ci-dessus) ---
    const btnDisplayW = Math.min(220, width * 0.28);
    const btnNative = this.textures.get(BUTTON_KEY).getSourceImage();
    const btnScale = btnDisplayW / btnNative.width;
    const btnDisplayH = btnNative.height * btnScale;
    const btnX = width - btnDisplayW - 16;
    const btnY = bgDisplayH - btnDisplayH - 14;

    const btn = this._track(this.add.image(btnX, btnY, BUTTON_KEY).setOrigin(0).setScale(btnScale).setDepth(HUD_DEPTH + 0.2)
      .setInteractive({ useHandCursor: true }));
    // Texte du bouton en VRAI texte Phaser dynamique (pas gravé dans l'image, contrairement
    // au bouton Attack du Boss dont c'était la limite connue) — traduisible FR/EN sans
    // regénérer d'asset.
    this._climbLabelText = this._track(this.add.text(btnX + btnDisplayW / 2, btnY + btnDisplayH / 2, '', {
      fontFamily: FONT_FAMILY, fontSize: climbLabelSize + 'px', color: '#fff6e6', align: 'center',
      wordWrap: { width: btnDisplayW * 0.85 },
    }).setOrigin(0.5).setDepth(HUD_DEPTH + 0.3));
    this._climbBtn = btn;
    this._climbBtnScale = btnScale;

    btn.on('pointerover', () => { if(!btn.getData('disabled')) this.tweens.add({ targets: [btn, this._climbLabelText], scale: btnScale * 1.05, duration: 100 }); });
    btn.on('pointerout', () => { btn.clearTint(); this.tweens.add({ targets: [btn, this._climbLabelText], scale: btn.getData('disabled') ? 1 : btnScale, duration: 100 }); });
    btn.on('pointerdown', () => { if(!btn.getData('disabled')) { btn.setTint(0xaaaaaa); this.tweens.add({ targets: [btn, this._climbLabelText], scale: btnScale * 0.96, duration: 60 }); } });
    btn.on('pointerup', () => {
      if(btn.getData('disabled')) return;
      btn.clearTint();
      this.tweens.add({ targets: [btn, this._climbLabelText], scale: btnScale * 1.05, duration: 80 });
      if(this._onClimbClick) this._onClimbClick();
    });

    this._uiBuilt = true;
  }

  _updatePips(used, max){
    this._pipImages.forEach((img) => img.destroy());
    this._pipImages = [];
    const gemSize = this._pipSize || 14;
    let gx = this._pipRowX;
    for(let i = 0; i < max; i++){
      const key = i < used ? GEM_EMPTY_KEY : GEM_FULL_KEY;
      const img = this.add.image(gx, this._pipRowY, key).setDisplaySize(gemSize, gemSize).setOrigin(0, 0.5).setDepth(HUD_DEPTH + 0.2);
      this._pipImages.push(img);
      gx += gemSize + 5;
    }
  }

  _updateClimbButton(label, disabled){
    if(this._climbLabelText) this._climbLabelText.setText(label || '');
    if(this._climbBtn){
      this._climbBtn.setData('disabled', !!disabled);
      this._climbBtn.setAlpha(disabled ? 0.5 : 1);
      this._climbLabelText.setAlpha(disabled ? 0.5 : 1);
      if(disabled){ this._climbBtn.disableInteractive(); } else { this._climbBtn.setInteractive({ useHandCursor: true }); }
    }
  }

  /** Précharge le chrome partagé (bouton/panneau/gemmes) — indépendant du donjon. */
  preloadSharedAssets(){
    return this._ensureSharedAssetsLoaded();
  }

  /** Précharge le fond d'un donjon donné (sans rien afficher). */
  preloadDungeonBg(dungeonKey){
    if(!DUNGEON_BG[dungeonKey]) return Promise.resolve();
    return this._ensureBgLoaded(dungeonKey);
  }

  _ensureBgLoaded(dungeonKey){
    const bg = DUNGEON_BG[dungeonKey];
    if(!bg) return Promise.resolve();
    if(this.textures.exists(bg.key)) return Promise.resolve();
    if(this._bgPromises[dungeonKey]) return this._bgPromises[dungeonKey];

    this._bgPromises[dungeonKey] = new Promise((resolve) => {
      this.load.image(bg.key, bg.path);
      this.load.once(`filecomplete-image-${bg.key}`, resolve);
      this.load.once('loaderror', (file) => {
        if(file.key === bg.key){
          console.warn(`[Moltchi/Phaser] Fond de donjon introuvable pour "${dungeonKey}" (${bg.path}).`);
          resolve();
        }
      });
      this.load.start();
    });
    return this._bgPromises[dungeonKey];
  }

  _ensureSharedAssetsLoaded(){
    if(this._assetsPromise) return this._assetsPromise;

    const assets = [
      [BUTTON_KEY, BUTTON_PATH],
      [INFO_PANEL_KEY, INFO_PANEL_PATH],
      [GEM_FULL_KEY, GEM_FULL_PATH],
      [GEM_EMPTY_KEY, GEM_EMPTY_PATH],
    ];
    const toLoad = assets.filter(([key]) => !this.textures.exists(key));

    if(toLoad.length === 0){
      this._assetsPromise = Promise.resolve();
      return this._assetsPromise;
    }

    this._assetsPromise = new Promise((resolve) => {
      let remaining = toLoad.length;
      const done = () => { remaining -= 1; if(remaining <= 0) resolve(); };
      toLoad.forEach(([key, path]) => {
        this.load.image(key, path);
        this.load.once(`filecomplete-image-${key}`, done);
        this.load.once('loaderror', (file) => {
          if(file.key === key){
            console.warn(`[Moltchi/Phaser] Asset donjon introuvable : ${path}`);
            done();
          }
        });
      });
      this.load.start();
    });
    return this._assetsPromise;
  }

  /**
   * Coupe le HUD, quel que soit le donjon actuellement affiché. À appeler dès que le canvas
   * partagé quitte les 3 conteneurs de donjon — voir la note en tête de fichier.
   */
  stopDungeonHUD(){
    this._uiObjects.forEach((obj) => { if(obj && obj.destroy) obj.destroy(); });
    this._uiObjects = [];
    this._pipImages.forEach((img) => img.destroy());
    this._pipImages = [];
    this._floorLabelText = this._floorText = this._nameText = null;
    this._powerLabelText = this._powerText = null;
    this._reqLabelText = this._reqText = null;
    this._attemptsText = this._clearsText = null;
    this._climbBtn = this._climbLabelText = null;
    this._rewardText = this._logText = null;
    this._uiBuilt = false;
    this._uiBuiltDungeonKey = null;
  }

  _destroyStaticUI(){ this.stopDungeonHUD(); }

  // ============================================================
  // EFFET DE CHOC D'ÉPÉES — inchangé, sert toujours les 3 donjons. Se rejoue PAR-DESSUS le
  // HUD (EFFECT_DEPTH > HUD_DEPTH), sans l'interrompre.
  // ============================================================
  /**
   * Rejoue le choc d'épées puis la victoire/défaite. Effet purement décoratif.
   * @param {{ won: boolean }} result
   */
  playClimb(result){
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;
    const size = Math.min(width, height * 1.8); // la zone est large et basse, pas carrée

    const won = !!(result && result.won);
    const sword = this.add.text(cx, cy, '⚔️', { fontSize: Math.round(size * 0.4) + 'px' })
      .setOrigin(0.5).setRotation(-0.4).setAlpha(0.9).setDepth(EFFECT_DEPTH);

    this.tweens.add({
      targets: sword,
      rotation: 0.4,
      duration: 200,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this._flash(cx, cy, won ? 0xffce6e : 0x7a2b2b, size);
        this.cameras.main.shake(won ? 90 : 140, won ? 0.004 : 0.008);

        const label = this.add.text(cx, cy, won ? '✓' : '✗', {
          fontSize: Math.round(size * 0.22) + 'px', fontStyle: 'bold',
          color: won ? '#3ecf6e' : '#e26b6b',
        }).setOrigin(0.5).setAlpha(0).setScale(0.6).setDepth(EFFECT_DEPTH);
        this.tweens.add({ targets: label, alpha: 1, scale: 1, duration: 200, delay: 60, ease: 'Back.easeOut' });
        this.tweens.add({ targets: [sword], alpha: 0, delay: 220, duration: 220, onComplete: () => sword.destroy() });
        this.time.delayedCall(750, () => {
          this.tweens.add({ targets: label, alpha: 0, duration: 220, onComplete: () => label.destroy() });
        });
      },
    });
  }

  _flash(x, y, color, size){
    const circle = this.add.circle(x, y, size * 0.06, color, 0.85).setDepth(EFFECT_DEPTH);
    this.tweens.add({
      targets: circle,
      radius: size * 0.5,
      alpha: 0,
      duration: 400,
      ease: 'Cubic.easeOut',
      onComplete: () => circle.destroy(),
    });
  }
}
