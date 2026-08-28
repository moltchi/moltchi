// ============================================================
// game/scenes/TreasureScene.js — Chasse aux trésors
// ============================================================
// Historique : scène PUREMENT décorative (juste l'ouverture du coffre + pluie de pièces
// rejouées après coup, voir Bridge.playTreasureEffect()).
//
// Depuis l'ajout du HUD complet (voir la conversation, même chantier que les Donjons) :
// affiche désormais aussi le décor, le solde Moltcoins, les points d'action (gemmes,
// réutilisées du Boss), le bouton "Fouiller" interactif et un panneau récompense+log — même
// architecture que DungeonScene.js, adaptée à un seul mode (pas besoin de dungeonKey ici,
// un seul décor).
//
// ⚠️ MÊME PIÈGE QUE POUR LE BOSS/LES DONJONS, CORRIGÉ DÈS LE DÉPART : cette scène reste
// RUNNING en permanence et redessine tout ce qu'elle a créé à CHAQUE FRAME, peu importe où le
// canvas partagé se trouve. Tous les objets du HUD sont trackés dans this._uiObjects et
// détruits par stopTreasureHUD(), appelée par _moveCanvasTo() dès que le canvas quitte
// #treasure-fx-stage.
//
// Deux couches indépendantes, empilées via setDepth() :
//   0. HUD (fond, textes, bouton, panneau) — HUD_DEPTH
//   1. Effet coffre + pièces (playDig), toujours au-dessus — EFFECT_DEPTH
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.esm.min.js';

const FONT_FAMILY = '"Press Start 2P", monospace';

const BG_KEY = 'treasure_bg';
const BG_PATH = 'media/treasure_arena.jpg';
// Chrome réutilisé TEL QUEL depuis les Donjons (mêmes clés, mêmes fichiers) — Phaser partage
// le cache de textures entre toutes les scènes d'un même Game, donc aucun re-téléchargement
// si DungeonScene les a déjà chargées. Cohérence visuelle "cadre doré pixel-art" avec le
// reste du jeu plutôt que générer un 3e jeu de chrome pour un seul mode.
const BUTTON_KEY = 'dungeon_climb_button';
const BUTTON_PATH = 'media/dungeon_climb_button.png';
const INFO_PANEL_KEY = 'dungeon_info_panel';
const INFO_PANEL_PATH = 'media/dungeon_info_panel.png';
const GEM_FULL_KEY = 'boss_gem_full';
const GEM_FULL_PATH = 'media/boss_gem_full.png';
const GEM_EMPTY_KEY = 'boss_gem_empty';
const GEM_EMPTY_PATH = 'media/boss_gem_empty.png';

const HUD_DEPTH = 0;
const EFFECT_DEPTH = 10;

export default class TreasureScene extends Phaser.Scene {
  constructor(){
    super('TreasureScene');
    this._uiBuilt = false;
    this._uiBuiltWidth = null;
    this._uiBuiltHeight = null;
    this._uiObjects = [];
    this._pipImages = [];
    this._onDigClick = null;
    this._assetsPromise = null;
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  _track(obj){ this._uiObjects.push(obj); return obj; }

  // ============================================================
  // HUD COMPLET
  // ============================================================
  /**
   * Affiche/actualise le HUD. Construit le chrome statique une seule fois au premier appel ;
   * les appels suivants ne font que mettre à jour les valeurs. Reconstruit automatiquement si
   * la taille du canvas change (resize fenêtre/rotation mobile).
   * @param {{
   *   moltcoinsLabel: string, moltcoins: number,
   *   apText: string, apUsed: number, apMax: number,
   *   digLabel: string, digDisabled: boolean,
   *   rewardText: string, log: string[],
   *   onDig: () => void,
   * }} data
   */
  async showTreasureHUD(data){
    await this._ensureAssetsLoaded();
    if(!this.textures.exists(BG_KEY)) return; // échec de chargement, rien à afficher

    const { width, height } = this.scale;
    const sizeChanged = this._uiBuilt && (this._uiBuiltWidth !== width || this._uiBuiltHeight !== height);
    if(sizeChanged) this._destroyStaticUI();

    if(!this._uiBuilt) this._buildStaticUI();

    this._onDigClick = typeof data.onDig === 'function' ? data.onDig : null;

    this._moltcoinsLabelText.setText(data.moltcoinsLabel || '');
    this._moltcoinsText.setText(`${data.moltcoins.toLocaleString()}`);

    this._apText.setText(data.apText || '');
    this._updatePips(data.apUsed, data.apMax);
    this._updateDigButton(data.digLabel, data.digDisabled);

    this._rewardText.setText(data.rewardText || '');
    const logLineCount = this._isMobileLike ? 2 : 3;
    const logLines = (data.log || []).slice(0, logLineCount);
    this._logText.setText(logLines.length ? logLines.join('\n') : '…');

    // Même filet de sécurité que pour les Donjons : si le texte de récompense prend plus de
    // place que prévu (écran étroit, texte long), on remonte la hauteur réellement
    // nécessaire pour qu'app.js puisse agrandir le conteneur plutôt que de couper le texte.
    if(typeof data.onContentHeight === 'function'){
      const neededHeight = Math.ceil(this._rewardText.y + this._rewardText.height + 14);
      data.onContentHeight(neededHeight);
    }
  }

  _buildStaticUI(){
    const { width, height } = this.scale;
    this._uiBuiltWidth = width;
    this._uiBuiltHeight = height;

    const fp = (fraction, min, max) => Math.max(min, Math.min(max, Math.round(width * fraction)));
    const stroke = { stroke: '#120a20', strokeThickness: Math.max(2, Math.round(width * 0.0025)) };
    this._isMobileLike = width < 520;

    // Décor à SON PROPRE ratio (pas étiré sur toute la hauteur du canvas) : le panneau
    // récompense+log vient occuper l'espace restant en dessous — même schéma que Donjons.
    const bgNative = this.textures.get(BG_KEY).getSourceImage();
    const bgDisplayH = width * (bgNative.height / bgNative.width);
    this._track(this.add.image(width / 2, bgDisplayH / 2, BG_KEY).setDisplaySize(width, bgDisplayH).setDepth(HUD_DEPTH));

    // --- Panneau récompense + log, sous le décor ---
    const panelNative = this.textures.get(INFO_PANEL_KEY).getSourceImage();
    const panelY = bgDisplayH + 8;
    const panelDisplayH = width * (panelNative.height / panelNative.width);
    this._track(this.add.image(width / 2, panelY, INFO_PANEL_KEY).setOrigin(0.5, 0).setDisplaySize(width, panelDisplayH).setDepth(HUD_DEPTH));

    const panelPadX = width * 0.035;
    const panelPadYTop = panelDisplayH * 0.35; // descendu légèrement pour un meilleur placement dans le cadre (voir la conversation)
    const rewardSize = fp(0.011, 6, 9);
    const logSize = fp(0.012, 7, 10);

    this._logText = this._track(this.add.text(width / 2, panelY + panelPadYTop, '', {
      fontFamily: FONT_FAMILY, fontSize: logSize + 'px', color: '#fff6e6', ...stroke,
      align: 'center', wordWrap: { width: width - panelPadX * 2 }, lineSpacing: 3,
    }).setOrigin(0.5, 0).setDepth(HUD_DEPTH + 0.2));

    this._rewardText = this._track(this.add.text(width / 2, panelY + panelDisplayH + 10, '', {
      fontFamily: FONT_FAMILY, fontSize: rewardSize + 'px', color: '#cfc3e8', ...stroke,
      align: 'center', wordWrap: { width: width - panelPadX * 2 }, lineSpacing: 3,
    }).setOrigin(0.5, 0).setDepth(HUD_DEPTH + 0.2));

    const labelSize = fp(0.016, 8, 13);
    const moltcoinsSize = fp(0.040, 18, 30);
    const apLabelSize = fp(0.015, 7, 12);
    const digLabelSize = fp(0.020, 9, 15);

    // --- Solde Moltcoins, en haut à gauche ---
    this._moltcoinsLabelText = this._track(this.add.text(16, 12, '', {
      fontFamily: FONT_FAMILY, fontSize: labelSize + 'px', color: '#cfc3e8', ...stroke,
    }).setOrigin(0, 0).setDepth(HUD_DEPTH + 0.2));
    this._moltcoinsText = this._track(this.add.text(16, 12 + labelSize + 4, '', {
      fontFamily: FONT_FAMILY, fontSize: moltcoinsSize + 'px', color: '#ffce6e', ...stroke,
    }).setOrigin(0, 0).setDepth(HUD_DEPTH + 0.2));

    // --- Points d'action (gemmes) + texte de régénération, bas gauche DU DÉCOR (pas du
    // canvas entier — sinon ça tombe dans la zone du panneau récompense+log en dessous) ---
    this._pipRowX = 16;
    this._apText = this._track(this.add.text(16, bgDisplayH - 16, '', {
      fontFamily: FONT_FAMILY, fontSize: apLabelSize + 'px', color: '#f4efe6', ...stroke,
      wordWrap: { width: width * 0.6 }, lineSpacing: 2,
    }).setOrigin(0, 1).setDepth(HUD_DEPTH + 0.2));
    this._pipRowY = bgDisplayH - 16 - this._apText.height - 10;
    this._pipSize = Math.max(11, Math.round(width * 0.022));

    // --- Bouton "Fouiller", bas droite DU DÉCOR ---
    const btnDisplayW = Math.min(220, width * 0.28);
    const btnNative = this.textures.get(BUTTON_KEY).getSourceImage();
    const btnScale = btnDisplayW / btnNative.width;
    const btnDisplayH = btnNative.height * btnScale;
    const btnX = width - btnDisplayW - 16;
    const btnY = bgDisplayH - btnDisplayH - 14;

    const btn = this._track(this.add.image(btnX, btnY, BUTTON_KEY).setOrigin(0).setScale(btnScale).setDepth(HUD_DEPTH + 0.2)
      .setInteractive({ useHandCursor: true }));
    // Texte du bouton en VRAI texte Phaser dynamique (pas gravé dans l'image) — traduisible
    // FR/EN sans regénérer d'asset, même leçon que pour les Donjons/le Boss.
    this._digLabelText = this._track(this.add.text(btnX + btnDisplayW / 2, btnY + btnDisplayH / 2, '', {
      fontFamily: FONT_FAMILY, fontSize: digLabelSize + 'px', color: '#fff6e6', align: 'center',
      wordWrap: { width: btnDisplayW * 0.85 },
    }).setOrigin(0.5).setDepth(HUD_DEPTH + 0.3));
    this._digBtn = btn;
    this._digBtnScale = btnScale;

    btn.on('pointerover', () => { if(!btn.getData('disabled')) this.tweens.add({ targets: [btn, this._digLabelText], scale: btnScale * 1.05, duration: 100 }); });
    btn.on('pointerout', () => { btn.clearTint(); this.tweens.add({ targets: [btn, this._digLabelText], scale: btn.getData('disabled') ? 1 : btnScale, duration: 100 }); });
    btn.on('pointerdown', () => { if(!btn.getData('disabled')) { btn.setTint(0xaaaaaa); this.tweens.add({ targets: [btn, this._digLabelText], scale: btnScale * 0.96, duration: 60 }); } });
    btn.on('pointerup', () => {
      if(btn.getData('disabled')) return;
      btn.clearTint();
      this.tweens.add({ targets: [btn, this._digLabelText], scale: btnScale * 1.05, duration: 80 });
      if(this._onDigClick) this._onDigClick();
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

  _updateDigButton(label, disabled){
    if(this._digLabelText) this._digLabelText.setText(label || '');
    if(this._digBtn){
      this._digBtn.setData('disabled', !!disabled);
      this._digBtn.setAlpha(disabled ? 0.5 : 1);
      this._digLabelText.setAlpha(disabled ? 0.5 : 1);
      if(disabled){ this._digBtn.disableInteractive(); } else { this._digBtn.setInteractive({ useHandCursor: true }); }
    }
  }

  preloadTreasureAssets(){
    return this._ensureAssetsLoaded();
  }

  _ensureAssetsLoaded(){
    if(this._assetsPromise) return this._assetsPromise;

    const assets = [
      [BG_KEY, BG_PATH],
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
            console.warn(`[Moltchi/Phaser] Asset Trésor introuvable : ${path}`);
            done();
          }
        });
      });
      this.load.start();
    });
    return this._assetsPromise;
  }

  /** Coupe le HUD. À appeler dès que le canvas partagé quitte #treasure-fx-stage. */
  stopTreasureHUD(){
    this._uiObjects.forEach((obj) => { if(obj && obj.destroy) obj.destroy(); });
    this._uiObjects = [];
    this._pipImages.forEach((img) => img.destroy());
    this._pipImages = [];
    this._moltcoinsLabelText = this._moltcoinsText = null;
    this._apText = null;
    this._digBtn = this._digLabelText = null;
    this._rewardText = this._logText = null;
    this._uiBuilt = false;
  }

  _destroyStaticUI(){ this.stopTreasureHUD(); }

  // ============================================================
  // EFFET COFFRE + PIÈCES — inchangé, se rejoue PAR-DESSUS le HUD (EFFECT_DEPTH > HUD_DEPTH).
  // ============================================================
  /**
   * Rejoue l'ouverture du coffre. Aucune valeur de retour attendue — effet purement
   * décoratif, l'appelant (app.js) a déjà tout le résultat réel du serveur en main.
   * @param {{ itemFound?: boolean }} [result] - si un objet a été trouvé, l'effet est un peu
   *   plus généreux (davantage de pièces + une étincelle dorée).
   */
  playDig(result){
    const { width, height } = this.scale;
    const cx = width / 2, cy = height * 0.32; // recentré sur le décor (pas le canvas entier, qui inclut maintenant le panneau du bas)
    const size = Math.min(width, height * 0.6);

    const chest = this.add.text(cx, cy, '📦', { fontSize: Math.round(size * 0.5) + 'px' }).setOrigin(0.5).setScale(0.7).setDepth(EFFECT_DEPTH);
    this.tweens.add({
      targets: chest,
      scale: 1.1,
      duration: 220,
      ease: 'Back.easeOut',
      yoyo: true,
      hold: 60,
      onComplete: () => {
        this.tweens.add({ targets: chest, alpha: 0, y: cy - 10, duration: 260, delay: 100, onComplete: () => chest.destroy() });
      },
    });

    const coinCount = (result && result.itemFound) ? 14 : 8;
    for(let i = 0; i < coinCount; i++){
      this.time.delayedCall(80 + Math.random() * 160, () => this._spawnCoin(cx, cy, size));
    }

    if(result && result.itemFound){
      const sparkle = this.add.text(cx, cy - size * 0.18, '✦', { fontSize: '20px', color: '#ffce6e' }).setOrigin(0.5).setAlpha(0).setDepth(EFFECT_DEPTH);
      this.tweens.add({ targets: sparkle, alpha: 1, y: '-=18', duration: 260, ease: 'Cubic.easeOut' });
      this.tweens.add({ targets: sparkle, alpha: 0, delay: 400, duration: 300, onComplete: () => sparkle.destroy() });
    }
  }

  _spawnCoin(cx, cy, size){
    const coin = this.add.text(cx, cy, '🪙', { fontSize: '15px' }).setOrigin(0.5).setDepth(EFFECT_DEPTH);
    const angle = Math.random() * Math.PI * 2;
    const dist = size * (0.25 + Math.random() * 0.3);
    this.tweens.add({
      targets: coin,
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist * 0.6 - size * 0.15,
      alpha: 0,
      duration: 550,
      ease: 'Cubic.easeOut',
      onComplete: () => coin.destroy(),
    });
  }
}
