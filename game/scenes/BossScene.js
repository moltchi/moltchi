// ============================================================
// game/scenes/BossScene.js — Interface complète du Boss Mondial
// ============================================================
// Historique : cette scène était PUREMENT décorative (idle + effet de coup par-dessus une
// UI HTML classique pour le nom/PV/log/bouton). Depuis l'intégration de la nouvelle
// interface façon RPG, elle affiche DÉSORMAIS l'écran de combat COMPLET — nom, affinités,
// barre de vie, minuteur, tentatives restantes, log (desktop uniquement, voir plus bas), et
// le bouton Attaquer lui-même (interactif, cliquable).
//
// Ce changement déroge délibérément à la règle historique "BossScene = pas d'interaction
// joueur" (qui reste vraie pour Treasure/Dungeon/le reste) : le combat de Boss est
// maintenant un vrai mini-jeu d'interface, comme TrainingScene. La logique de jeu elle-même
// reste 100% côté serveur (attack-boss.ts) — Bridge.showBossBattleUI() ne fait qu'AFFICHER
// des données déjà calculées et transmet le clic sur Attaquer à un callback fourni par
// app.js (qui fait le vrai appel réseau).
//
// ⚠️ PIÈGE ARCHITECTURAL CORRIGÉ ICI (voir la conversation) : cette scène reste RUNNING en
// permanence (comme toutes les autres, voir bridge.js) et redessine donc TOUT ce qu'elle a
// créé À CHAQUE FRAME, peu importe où le canvas partagé se trouve physiquement dans le DOM.
// L'UI statique (fond, cadre HP, textes, bouton, log) était construite UNE FOIS puis jamais
// nettoyée en quittant l'onglet Boss — elle continuait donc de s'afficher par-dessus
// #creature-stage une fois le canvas déplacé là-bas. TOUS les objets de l'UI sont
// désormais trackés dans this._uiObjects et détruits par stopIdle() (voir plus bas),
// exactement comme le corps du boss (sprite idle/attacked) l'était déjà.
//
// Toujours en un seul canvas partagé (voir bridge.js) : #boss-portrait-wrap dans index.html
// occupe toute la carte de combat.
//
// Couches empilées via setDepth(), dans cet ordre croissant :
//   0. Fond d'arène + UI statique (assets réels)
//   1. Sprite du boss (idle/attacked, spritesheets par bossId)
//   2. Effet de coup (slash), toujours au-dessus de tout le reste
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.2.1/dist/phaser.esm.min.js';

// ---------- Sprites idle/attacked/slash du boss ----------
const SPRITE_FRAME_SIZE = 250;
const SPRITE_FPS = 12;
const KNOWN_BOSS_IDS = ['ver_cendres', 'kraken_brumes', 'golem_granit', 'spectre_bourrasques'];
const SLASH_TEXTURE_KEY = 'boss_attack_slash';
const SLASH_FILE_PATH = 'media/attackboss_slash.png';
const SLASH_ZOOM = 0.95;
const SLASH_ZOOM_CRIT = 1.2;

const BODY_DEPTH = 1;
const SLASH_DEPTH = 2;
const UI_DEPTH = 0;

// ---------- Interface de combat (assets réels) ----------
// Fond d'arène : DÉPEND DU BOSS de la semaine désormais (auparavant un seul fond partagé,
// voir la conversation). Un fichier par bossId ; si un boss n'a pas encore de fond dédié,
// rien ne s'affiche pour cette couche (pas de repli visuel, même philosophie que le reste).
const BOSS_ARENA_BG = {
  ver_cendres: { key: 'arena_ver_cendres', path: 'media/ver_arena.jpg' },
  kraken_brumes: { key: 'arena_kraken_brumes', path: 'media/kraken_arena.png' },
  golem_granit: { key: 'arena_golem_granit', path: 'media/golem_arena.jpg' },
  spectre_bourrasques: { key: 'arena_spectre_bourrasques', path: 'media/spectre_arena.jpg' },
};
const HP_FRAME_KEY = 'boss_hp_frame';
const LOG_PANEL_KEY = 'boss_log_panel';
const BUTTON_KEY = 'boss_attack_button';
const GEM_FULL_KEY = 'boss_gem_full';
const GEM_EMPTY_KEY = 'boss_gem_empty';

// Coordonnées du rail intérieur de boss_hp_frame.png, mesurées précisément sur le fichier
// source (982x222) par balayage pixel.
const HP_FRAME_NATIVE_W = 982, HP_FRAME_NATIVE_H = 222;
const HP_TRACK_X1 = 96, HP_TRACK_X2 = 885;
const HP_TRACK_Y1 = 79, HP_TRACK_Y2 = 142;

const FONT_FAMILY = '"Press Start 2P", monospace';

// Icône représentant l'élément d'un boss/une affinité — utilisée pour l'icône de faiblesse
// compacte en mise en page mobile (voir _buildMobileUI). Reprend les mêmes emojis que le
// reste du jeu (BOSS_LIST/ELEMENT_LABEL côté app.js).
const ELEMENT_ICON = { feu: '🔥', eau: '💧', terre: '🪨', vent: '💨' };

export default class BossScene extends Phaser.Scene {
  constructor(){
    super('BossScene');
    // --- corps du boss (idle/attacked) ---
    this._loaded = new Set();
    this._loading = new Map();
    this._sprite = null;
    this._bodyVignette = null;
    this._currentBossId = null;
    this._currentKind = null;
    this._slashSprite = null;
    // --- UI de combat ---
    this._uiBuilt = false;
    this._uiBuiltBossId = null;
    this._uiIsMobile = false;
    this._arenaBgPromises = {}; // bossId -> Promise, cache anti-double-chargement du fond
    this._uiObjects = []; // TOUS les GameObjects de l'UI statique — détruits par stopIdle()
    this._hpFillImage = null;
    this._hpFillCurrentRatio = 0;
    this._pipImages = [];
    this._onAttackClick = null;
    // Même jeton de génération que TreasureScene.js/DungeonScene.js (voir la conversation)
    // — annule un appel showBattleUI() devenu obsolète plutôt que de laisser un rendu
    // périmé écraser le bon.
    this._renderGen = 0;
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  // ============================================================
  // INTERFACE DE COMBAT COMPLÈTE
  // ============================================================
  /**
   * Affiche/actualise le HUD de combat pour le boss donné. Construit le chrome statique une
   * seule fois au premier appel ; les appels suivants ne font que mettre à jour les valeurs.
   * NE touche PAS au corps du boss (idle/attacked) — piloté séparément par app.js.
   * @param {{
   *   bossId: string, name: string, affinities: string,
   *   weaknessElement?: 'feu'|'eau'|'terre'|'vent', hp: number, maxHp: number,
   *   timerText: string, attemptsText: string, attemptsUsed: number, attemptsMax: number,
   *   attackDisabled: boolean, attackLabel: string, log: string[], onAttack: () => void,
   * }} data
   */
  async showBattleUI(data){
    const myGen = ++this._renderGen;
    const arenaBg = BOSS_ARENA_BG[data.bossId];
    // Le fond dépend du boss : on l'attend AVANT de construire l'UI (sinon _buildStaticUI
    // dessinerait sur une texture pas encore prête). Pas de repli si le fond échoue/manque
    // (boss sans fond dédié pour l'instant) — même philosophie que le reste, voir plus bas.
    await Promise.all([
      this._ensureBattleUIAssetsLoaded(),
      arenaBg ? this._ensureArenaBgLoaded(data.bossId) : Promise.resolve(),
    ]);
    if(myGen !== this._renderGen) return; // un appel plus récent a démarré entre-temps, on abandonne celui-ci

    const { width, height } = this.scale;
    // Redimensionnement dynamique (fenêtre desktop redimensionnée, rotation mobile...) OU
    // changement de boss (reset hebdomadaire, ou juste navigation entre boss) : la mise en
    // page/le fond construits précédemment ne sont plus valables — reconstruction complète
    // plutôt qu'une simple mise à jour des valeurs.
    const sizeChanged = this._uiBuilt && (this._uiBuiltWidth !== width || this._uiBuiltHeight !== height);
    const bossChanged = this._uiBuilt && this._uiBuiltBossId !== data.bossId;
    if(sizeChanged || bossChanged) this._destroyStaticUI();

    if(!this._uiBuilt) this._buildStaticUI(data.bossId);

    this._onAttackClick = typeof data.onAttack === 'function' ? data.onAttack : null;

    this._nameText.setText((data.name || '').toUpperCase());
    if(this._affinitiesText) this._affinitiesText.setText(data.affinities || '');
    if(this._weaknessIconText) this._weaknessIconText.setText(ELEMENT_ICON[data.weaknessElement] || '');
    this._timerText.setText(data.timerText || '');
    this.setHp(data.hp, data.maxHp, { animate: false });
    this._updateAttempts(data.attemptsText, data.attemptsUsed, data.attemptsMax);
    if(this._logText) this._updateLog(data.log);
    this._updateAttackButton(data.attackLabel, data.attackDisabled);

    // Le corps du boss (idle/attacked) ne se recharge pas (spritesheet déjà en cache), mais
    // doit être repositionné/redimensionné sur la nouvelle zone d'arène.
    if((sizeChanged || bossChanged) && this._currentBossId){
      const key = `boss_${this._currentKind}_${this._currentBossId}`;
      this._showBodySprite(key, this._currentKind, this._currentBossId);
    }
  }

  _buildStaticUI(bossId){
    const { width, height } = this.scale;
    // Sous ce seuil (en unités canvas, ~= px CSS), l'agencement desktop n'a plus assez de
    // place. Doit rester cohérent avec le @media (max-width: 560px) de style.css
    // (.boss-fight-log-mobile) — pas besoin d'être pixel-exact, juste du même ordre.
    const MOBILE_BREAKPOINT = 520;
    this._uiIsMobile = width < MOBILE_BREAKPOINT;
    this._uiBuiltWidth = width;
    this._uiBuiltHeight = height;
    this._uiBuiltBossId = bossId;

    const fp = (fraction, min, max) => Math.max(min, Math.min(max, Math.round(width * fraction)));
    const stroke = { stroke: '#120a20', strokeThickness: Math.max(2, Math.round(width * 0.003)) };

    const arenaBg = BOSS_ARENA_BG[bossId];
    if(arenaBg && this.textures.exists(arenaBg.key)){
      this._track(this.add.image(width / 2, height / 2, arenaBg.key).setDisplaySize(width, height).setDepth(UI_DEPTH));
    } // sinon : rien, pas de repli (boss sans fond dédié pour l'instant)

    if(this._uiIsMobile) this._buildMobileUI(width, height, fp, stroke);
    else this._buildDesktopUI(width, height, fp, stroke);

    this._uiBuilt = true;
  }

  /** Ajoute un GameObject à la liste de nettoyage (voir stopIdle()) et le renvoie tel quel. */
  _track(obj){ this._uiObjects.push(obj); return obj; }

  // ------------------------------------------------------------------
  // DESKTOP : nom+affinités en haut-droite, cadre HP en haut-gauche, log bas-gauche,
  // bouton bas-droite — assez de place à l'horizontale pour tout en incrustation.
  // ------------------------------------------------------------------
  _buildDesktopUI(width, height, fp, stroke){
    const nameSize = fp(0.024, 11, 20);
    const affinitiesSize = fp(0.014, 7, 13);
    const timerSize = fp(0.016, 8, 14);
    const hpTextSize = fp(0.015, 8, 15);
    const attemptsSize = fp(0.016, 8, 14);
    const logSize = fp(0.013, 7, 12);

    // --- Cadre HP bar, haut gauche ---
    const hpDisplayW = Math.min(460, width * 0.44);
    const hpScale = hpDisplayW / HP_FRAME_NATIVE_W;
    const hpX = 20, hpY = 16;
    this._track(this.add.image(hpX, hpY, HP_FRAME_KEY).setOrigin(0).setScale(hpScale).setDepth(UI_DEPTH + 0.2));

    this._hpTrackX = hpX + HP_TRACK_X1 * hpScale;
    this._hpTrackY = hpY + HP_TRACK_Y1 * hpScale;
    this._hpTrackW = (HP_TRACK_X2 - HP_TRACK_X1) * hpScale;
    this._hpTrackH = (HP_TRACK_Y2 - HP_TRACK_Y1) * hpScale;
    this._buildHpTrackFillObjects(hpTextSize, stroke);

    // --- Nom + affinités, haut droite (le minuteur se place désormais au-dessus du bouton
    // Attaquer, bas droite — voir plus bas — il se faisait auparavant recouvrir par le
    // bouton en étant logé dans le même coin bas-droite, voir la conversation) ---
    const nameY = 14;
    const affinitiesY = nameY + nameSize * 1.5;
    this._nameText = this._track(this.add.text(width - 16, nameY, '', {
      fontFamily: FONT_FAMILY, fontSize: nameSize + 'px', color: '#f4efe6', ...stroke,
    }).setOrigin(1, 0).setDepth(UI_DEPTH + 0.2));
    this._affinitiesText = this._track(this.add.text(width - 16, affinitiesY, '', {
      fontFamily: FONT_FAMILY, fontSize: affinitiesSize + 'px', color: '#e8dff5', ...stroke,
      align: 'right', wordWrap: { width: width * 0.5 }, lineSpacing: 4,
    }).setOrigin(1, 0).setDepth(UI_DEPTH + 0.2));

    // --- Gemmes + texte de tentatives, sous la barre de vie ---
    this._pipRowX = hpX + 4;
    this._pipRowY = hpY + HP_FRAME_NATIVE_H * hpScale + Math.max(16, attemptsSize * 1.3);
    this._pipSize = 18;
    this._attemptsText = this._track(this.add.text(0, this._pipRowY, '', {
      fontFamily: FONT_FAMILY, fontSize: attemptsSize + 'px', color: '#f4efe6', ...stroke,
    }).setOrigin(0, 0.5).setDepth(UI_DEPTH + 0.2));

    // --- Panneau de log, bas gauche ---
    const logNative = this.textures.get(LOG_PANEL_KEY).getSourceImage();
    const logDisplayW = width * 0.4;
    const logScale = logDisplayW / logNative.width;
    const logX = 20, logY = height - logNative.height * logScale - 16;
    this._track(this.add.image(logX, logY, LOG_PANEL_KEY).setOrigin(0).setScale(logScale).setDepth(UI_DEPTH + 0.2));
    this._logText = this._track(this.add.text(logX + 14, logY + 10, '', {
      fontFamily: FONT_FAMILY, fontSize: logSize + 'px', color: '#fff6e6', lineSpacing: Math.round(logSize * 0.6),
      wordWrap: { width: logDisplayW - 60 },
    }).setDepth(UI_DEPTH + 0.3));

    // --- Bouton Attaquer, bas droite ---
    const btnDisplayW = Math.min(200, width * 0.18);
    const btnNative = this.textures.get(BUTTON_KEY).getSourceImage();
    const btnDisplayH = btnNative.height * (btnDisplayW / btnNative.width);
    const btnX = width - btnDisplayW - 20;
    const btnY = height - btnDisplayH - 20;

    // Minuteur juste au-dessus du bouton (pas dans le même coin bas-droite que lui — voir
    // la note plus haut, il se faisait recouvrir).
    this._timerText = this._track(this.add.text(btnX + btnDisplayW, btnY - 6, '', {
      fontFamily: FONT_FAMILY, fontSize: timerSize + 'px', color: '#f4efe6', ...stroke,
    }).setOrigin(1, 1).setDepth(UI_DEPTH + 0.2));

    this._buildAttackButtonObject(btnX, btnY, btnDisplayW, false, height);

    this._arenaCenterY = height * 0.5;
    this._arenaMaxSize = Math.min(width, height) * 0.42;
  }

  // ------------------------------------------------------------------
  // MOBILE : grille reprise du schéma fourni par l'utilisateur (voir la conversation).
  // ------------------------------------------------------------------
  // Grille reprise du schéma fourni par l'utilisateur (voir la conversation), mesurée au
  // pixel sur l'image (détection des contours verts) plutôt qu'estimée à l'œil :
  //   - colonne nom : x 0→0.20W, y 0→0.49H (gauche, haute)
  //   - rangée haute (HP bar + icône faiblesse) : y 0.02H→0.22H, à droite de la colonne nom
  //   - boss centré dans le reste, y 0.22H→0.73H
  //   - rangée basse : y 0.73H→0.98H → logs (0→0.40W) | bouton (0.40W→0.73W) | tentatives (0.73W→W)
  _buildMobileUI(width, height, fp, stroke){
    const nameSize = fp(0.026, 7, 10);
    const timerSize = fp(0.020, 6, 8);
    const hpTextSize = fp(0.020, 6, 8);
    const attemptsSize = fp(0.020, 6, 8);
    const logSize = fp(0.020, 6, 8);
    const weaknessIconSize = fp(0.065, 16, 24);

    const nameColW = width * 0.20;
    const nameColH = height * 0.49;
    const topRowY0 = height * 0.02, topRowY1 = height * 0.22;
    const bottomRowY0 = height * 0.73, bottomRowY1 = height * 0.98;

    // --- Colonne nom, gauche haute ---
    this._nameText = this._track(this.add.text(6, height * 0.03, '', {
      fontFamily: FONT_FAMILY, fontSize: nameSize + 'px', color: '#f4efe6', ...stroke,
      align: 'left', wordWrap: { width: nameColW - 10 }, lineSpacing: 2,
    }).setOrigin(0, 0).setDepth(UI_DEPTH + 0.2));

    // --- Rangée haute : barre de vie (centre-droite) + icône faiblesse (droite) ---
    const iconColW = width * 0.20;
    const hpDisplayW = (width - iconColW - 8) - (nameColW + 8);
    const hpScale = hpDisplayW / HP_FRAME_NATIVE_W;
    const hpDisplayH = HP_FRAME_NATIVE_H * hpScale;
    const hpX = nameColW + 8;
    const hpY = topRowY0 + (topRowY1 - topRowY0 - hpDisplayH) / 2;
    this._track(this.add.image(hpX, hpY, HP_FRAME_KEY).setOrigin(0).setScale(hpScale).setDepth(UI_DEPTH + 0.2));
    this._hpTrackX = hpX + HP_TRACK_X1 * hpScale;
    this._hpTrackY = hpY + HP_TRACK_Y1 * hpScale;
    this._hpTrackW = (HP_TRACK_X2 - HP_TRACK_X1) * hpScale;
    this._hpTrackH = (HP_TRACK_Y2 - HP_TRACK_Y1) * hpScale;
    this._buildHpTrackFillObjects(hpTextSize, stroke);

    this._timerText = this._track(this.add.text(hpX + hpDisplayW, hpY + hpDisplayH + 2, '', {
      fontFamily: FONT_FAMILY, fontSize: timerSize + 'px', color: '#cfc3e8', ...stroke,
    }).setOrigin(1, 0).setDepth(UI_DEPTH + 0.2));

    this._weaknessIconText = this._track(this.add.text(width - 8, (topRowY0 + topRowY1) / 2, '', {
      fontSize: weaknessIconSize + 'px',
    }).setOrigin(1, 0.5).setDepth(UI_DEPTH + 0.2));
    this._affinitiesText = null; // pas de texte d'affinités en mobile, juste l'icône

    // --- Boss centré dans le reste de l'espace (entre rangée haute et rangée basse) ---
    this._arenaCenterY = (topRowY1 + bottomRowY0) / 2;
    this._arenaMaxSize = Math.max(40, Math.min(width - nameColW, bottomRowY0 - topRowY1) * 0.85);

    // --- Rangée basse : logs (gauche, texte SEUL, sans image de cadre — voir la
    // conversation) | bouton (centre, à sa place d'origine) | tentatives+gemmes (droite) ---
    const logColW = width * 0.40;
    const btnColX0 = logColW, btnColX1 = width * 0.73;
    const attemptsColX0 = width * 0.73;

    // Texte du log seul, SANS boss_log_panel.png derrière (juste le contour/l'image de
    // cadre retiré, pas le texte lui-même).
    const logDisplayW = logColW - 12;
    const logX = 8, logY = bottomRowY0;
    this._logText = this._track(this.add.text(logX, logY, '', {
      fontFamily: FONT_FAMILY, fontSize: logSize + 'px', color: '#fff6e6', ...stroke,
      lineSpacing: Math.round(logSize * 0.4), wordWrap: { width: logDisplayW },
    }).setDepth(UI_DEPTH + 0.3));

    // Bouton Attaquer, centré dans sa colonne, jamais coupé (hauteur bornée à la rangée basse).
    const btnColW = btnColX1 - btnColX0;
    const btnDisplayW = btnColW - 8;
    const btnMaxH = bottomRowY1 - bottomRowY0;
    this._buildAttackButtonObject(btnColX0 + 4, bottomRowY0, btnDisplayW, false, height, btnMaxH);

    // Gemmes + tentatives, colonne droite de la rangée basse.
    this._pipRowX = attemptsColX0;
    this._pipRowY = bottomRowY0 + 10;
    this._pipSize = Math.max(11, Math.round(width * 0.026));
    this._attemptsText = this._track(this.add.text(attemptsColX0, this._pipRowY + this._pipSize + 6, '', {
      fontFamily: FONT_FAMILY, fontSize: attemptsSize + 'px', color: '#f4efe6', ...stroke,
      wordWrap: { width: width - attemptsColX0 - 8 }, lineSpacing: 2,
    }).setOrigin(0, 0).setDepth(UI_DEPTH + 0.2));
  }

  /** Fond noir du rail + image de remplissage dynamique + texte PV — factorisé desktop/mobile. */
  _buildHpTrackFillObjects(hpTextSize, stroke){
    const trackBg = this._track(this.add.graphics().setDepth(UI_DEPTH + 0.1));
    trackBg.fillStyle(0x0a0a0c, 1);
    trackBg.fillRect(this._hpTrackX, this._hpTrackY, this._hpTrackW, this._hpTrackH);

    this._hpFillImage = this._track(this.add.image(this._hpTrackX, this._hpTrackY, null).setOrigin(0).setDepth(UI_DEPTH + 0.15));
    this._hpText = this._track(this.add.text(this._hpTrackX + this._hpTrackW / 2, this._hpTrackY + this._hpTrackH / 2, '', {
      fontFamily: FONT_FAMILY, fontSize: hpTextSize + 'px', color: '#fff6e6', ...stroke,
    }).setOrigin(0.5).setDepth(UI_DEPTH + 0.3));
  }

  /**
   * Bouton Attaquer — factorisé desktop/mobile.
   * @param {number} x
   * @param {number|null} y - position Y exacte ; si null, ancré par le BAS du canvas (desktop).
   * @param {number} displayW
   * @param {number} labelSize
   * @param {boolean} anchorBottom
   * @param {number} canvasHeight
   * @param {number} [maxH] - hauteur d'affichage max autorisée (mobile) : le bouton est
   *   RÉDUIT si besoin pour ne jamais dépasser cette limite (corrige le bouton coupé
   *   observé sur mobile — voir la conversation).
   */
  _buildAttackButtonObject(x, y, displayW, anchorBottom, canvasHeight, maxH){
    const btnNative = this.textures.get(BUTTON_KEY).getSourceImage();
    let btnScale = displayW / btnNative.width;
    if(maxH != null){
      const naturalH = btnNative.height * btnScale;
      if(naturalH > maxH) btnScale = maxH / btnNative.height; // priorité à ne jamais dépasser la place dispo, quitte à réduire la largeur effective
    }
    const btnDisplayH = btnNative.height * btnScale;
    const btnDisplayW = btnNative.width * btnScale;
    const btnX = anchorBottom ? x : x + (displayW - btnDisplayW) / 2; // centré si plus étroit que l'espace alloué (cas maxH)
    const btnY = anchorBottom ? canvasHeight - btnDisplayH - 20 : y;

    // Pas de texte superposé : le mot "ATTACK" est déjà dessiné DANS l'image
    // (boss_attack_button.png, généré ainsi dès le départ) — un texte Phaser par-dessus
    // créait un doublon visible (deux rendus du même mot, polices différentes, jamais
    // parfaitement alignés). Seul le libellé localisé (FR/EN) reçu via
    // _updateAttackButton() n'est donc plus affiché — limite connue : le bouton reste en
    // anglais "ATTACK" même en français, l'image elle-même n'étant pas traduite.
    const btn = this._track(this.add.image(btnX, btnY, BUTTON_KEY).setOrigin(0).setScale(btnScale).setDepth(UI_DEPTH + 0.2)
      .setInteractive({ useHandCursor: true }));
    this._attackBtn = btn;
    this._attackBtnBaseScale = btnScale;

    btn.on('pointerover', () => { if(!btn.getData('disabled')) this.tweens.add({ targets: btn, scale: btnScale * 1.05, duration: 100 }); });
    btn.on('pointerout', () => { btn.clearTint(); this.tweens.add({ targets: btn, scale: btn.getData('disabled') ? 1 : btnScale, duration: 100 }); });
    btn.on('pointerdown', () => { if(!btn.getData('disabled')) { btn.setTint(0xaaaaaa); this.tweens.add({ targets: btn, scale: btnScale * 0.96, duration: 60 }); } });
    btn.on('pointerup', () => {
      if(btn.getData('disabled')) return;
      btn.clearTint();
      this.tweens.add({ targets: btn, scale: btnScale * 1.05, duration: 80 });
      if(this._onAttackClick) this._onAttackClick();
    });
  }

  /**
   * Met à jour la barre de vie affichée. Publique.
   * @param {number} hp @param {number} maxHp @param {{ animate?: boolean }} [opts]
   */
  setHp(hp, maxHp, opts = {}){
    if(!this._uiBuilt) return;
    const animate = opts.animate !== false;
    const targetRatio = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 0;

    const applyRatio = (ratio) => {
      const w = Math.max(1, Math.round(this._hpTrackW * ratio));
      const h = Math.max(1, Math.round(this._hpTrackH));
      const key = 'hp_fill_dynamic';
      if(this.textures.exists(key)) this.textures.remove(key);
      const tex = this.textures.createCanvas(key, w, h);
      const ctx = tex.getContext();
      const color = ratio > 0.5 ? this._lerpColor(0xd9c23f, 0x6fd18c, (ratio - 0.5) * 2)
                  : ratio > 0.2 ? this._lerpColor(0xd25b5b, 0xd9c23f, (ratio - 0.2) / 0.3)
                  : this._lerpColor(0x7a2020, 0xd25b5b, ratio / 0.2);
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(0, 0, w, Math.max(1, Math.round(h * 0.25)));
      tex.refresh();
      this._hpFillImage.setTexture(key);
    };

    if(animate){
      this.tweens.addCounter({
        from: this._hpFillCurrentRatio, to: targetRatio, duration: 450, ease: 'Cubic.easeOut',
        onUpdate: (tw) => applyRatio(tw.getValue()),
      });
    } else {
      applyRatio(targetRatio);
    }
    this._hpFillCurrentRatio = targetRatio;
    this._hpText.setText(`${Math.max(0, Math.round(hp)).toLocaleString()} / ${Math.round(maxHp).toLocaleString()}  ${Math.round(targetRatio * 100)}%`);
  }

  _lerpColor(a, b, t){
    t = Phaser.Math.Clamp(t, 0, 1);
    const ar=(a>>16)&0xff, ag=(a>>8)&0xff, ab=a&0xff, br=(b>>16)&0xff, bg=(b>>8)&0xff, bb=b&0xff;
    return (Math.round(ar+(br-ar)*t)<<16) | (Math.round(ag+(bg-ag)*t)<<8) | Math.round(ab+(bb-ab)*t);
  }

  _updateAttempts(text, used, max){
    this._attemptsText.setText(text || '');
    this._pipImages.forEach((img) => img.destroy());
    this._pipImages = [];
    const gemSize = this._pipSize || 18;
    let gx = this._pipRowX;
    for(let i = 0; i < max; i++){
      const key = i < used ? GEM_EMPTY_KEY : GEM_FULL_KEY;
      const img = this.add.image(gx, this._pipRowY, key).setDisplaySize(gemSize, gemSize).setOrigin(0, 0.5).setDepth(UI_DEPTH + 0.2);
      this._pipImages.push(img);
      gx += gemSize + 5;
    }
    // Desktop : le texte suit les gemmes horizontalement. Mobile : le texte est fixé SOUS
    // les gemmes (colonne étroite, voir _buildMobileUI) — ne pas le redéplacer ici.
    if(!this._uiIsMobile) this._attemptsText.setX(gx + 4);
  }

  _updateLog(lines){
    const count = this._uiIsMobile ? 1 : 3;
    const visible = (lines || []).slice(0, count);
    this._logText.setText(visible.length ? visible.join('\n') : '…');
  }

  _updateAttackButton(label, disabled){
    // `label` n'est plus utilisé pour un texte superposé (voir _buildAttackButtonObject) —
    // gardé dans la signature pour ne pas casser les appelants existants (renderBoss()).
    if(this._attackBtn){
      this._attackBtn.setData('disabled', !!disabled);
      this._attackBtn.setAlpha(disabled ? 0.5 : 1);
      if(disabled){ this._attackBtn.disableInteractive(); } else { this._attackBtn.setInteractive({ useHandCursor: true }); }
    }
  }

  // ============================================================
  // CORPS DU BOSS : idle / attacked
  // ============================================================
  async showIdle(bossId){
    if(!KNOWN_BOSS_IDS.includes(bossId)) return;
    if(this._currentBossId === bossId && this._currentKind === 'idle' && this._sprite) return;

    const textureKey = `boss_idle_${bossId}`;
    await this._ensureSpriteLoaded(textureKey, `media/${bossId}_idle.png`, { repeat: -1 });
    if(!this._loaded.has(textureKey)) return;

    this._showBodySprite(textureKey, 'idle', bossId);
  }

  async showAttacked(bossId){
    if(!KNOWN_BOSS_IDS.includes(bossId)) return;

    const textureKey = `boss_attacked_${bossId}`;
    await this._ensureSpriteLoaded(textureKey, `media/${bossId}_attacked.png`, { repeat: 0 });
    if(!this._loaded.has(textureKey)) return;

    const sprite = this._showBodySprite(textureKey, 'attacked', bossId);
    sprite.once('animationcomplete', () => {
      if(this._sprite === sprite) this.showIdle(bossId);
    });
  }

  /**
   * Précharge le spritesheet idle/attacked d'un boss. Renvoie la Promise de chargement —
   * les appels "fire-and-forget" existants (préchargement en tâche de fond, voir app.js)
   * l'ignorent simplement ; l'écran de chargement bloquant peut désormais l'attendre pour
   * que l'onglet Boss soit instantané dès le premier clic (voir la conversation).
   */
  preloadIdle(bossId, kind = 'idle'){
    if(!KNOWN_BOSS_IDS.includes(bossId)) return Promise.resolve();
    if(kind === 'idle') return this._ensureSpriteLoaded(`boss_idle_${bossId}`, `media/${bossId}_idle.png`, { repeat: -1 });
    return this._ensureSpriteLoaded(`boss_attacked_${bossId}`, `media/${bossId}_attacked.png`, { repeat: 0 });
  }

  preloadSlash(){
    return this._ensureSpriteLoaded(SLASH_TEXTURE_KEY, SLASH_FILE_PATH, { repeat: 0 });
  }

  preloadBattleUIAssets(){
    return this._ensureBattleUIAssetsLoaded();
  }

  /** Précharge le fond d'arène du boss donné (sans rien afficher). Fire-and-forget. */
  preloadArenaBg(bossId){
    if(!BOSS_ARENA_BG[bossId]) return Promise.resolve();
    return this._ensureArenaBgLoaded(bossId);
  }

  /**
   * Télécharge (une fois, avec cache + anti-double-chargement par bossId) le fond
   * d'arène d'un boss. Séparé de _ensureBattleUIAssetsLoaded() car — contrairement au
   * cadre HP/log/bouton/gemmes, communs à tous les boss — le fond DÉPEND du boss (voir
   * BOSS_ARENA_BG en tête de fichier).
   */
  _ensureArenaBgLoaded(bossId){
    const arenaBg = BOSS_ARENA_BG[bossId];
    if(!arenaBg) return Promise.resolve();
    if(this.textures.exists(arenaBg.key)) return Promise.resolve();
    if(this._arenaBgPromises[bossId]) return this._arenaBgPromises[bossId];

    this._arenaBgPromises[bossId] = new Promise((resolve) => {
      this.load.image(arenaBg.key, arenaBg.path);
      this.load.once(`filecomplete-image-${arenaBg.key}`, resolve);
      this.load.once('loaderror', (file) => {
        if(file.key === arenaBg.key){
          console.warn(`[Moltchi/Phaser] Fond d'arène introuvable pour "${bossId}" (${arenaBg.path}).`);
          resolve();
        }
      });
      this.load.start();
    });
    return this._arenaBgPromises[bossId];
  }

  _ensureBattleUIAssetsLoaded(){
    if(this._battleUIAssetsPromise) return this._battleUIAssetsPromise;

    const assets = [
      [HP_FRAME_KEY, 'media/boss_hp_frame.png'],
      [LOG_PANEL_KEY, 'media/boss_log_panel.png'],
      [BUTTON_KEY, 'media/boss_attack_button.png'],
      [GEM_FULL_KEY, 'media/boss_gem_full.png'],
      [GEM_EMPTY_KEY, 'media/boss_gem_empty.png'],
    ];
    const toLoad = assets.filter(([key]) => !this.textures.exists(key));

    if(toLoad.length === 0){
      this._battleUIAssetsPromise = Promise.resolve();
      return this._battleUIAssetsPromise;
    }

    this._battleUIAssetsPromise = new Promise((resolve) => {
      let remaining = toLoad.length;
      const done = () => { remaining -= 1; if(remaining <= 0) resolve(); };
      toLoad.forEach(([key, path]) => {
        this.load.image(key, path);
        this.load.once(`filecomplete-image-${key}`, done);
        this.load.once('loaderror', (file) => {
          if(file.key === key){
            console.warn(`[Moltchi/Phaser] Asset UI combat introuvable : ${path}`);
            done();
          }
        });
      });
      this.load.start();
    });
    return this._battleUIAssetsPromise;
  }

  /**
   * Coupe TOUT ce que cette scène a affiché — corps du boss (idle/attacked/slash) ET
   * l'UI statique complète (fond, cadre HP, textes, bouton, log). À appeler dès que le
   * canvas partagé quitte #boss-portrait-wrap pour une autre zone — voir la note en tête de
   * fichier sur le bug corrigé ici (l'UI restait affichée par-dessus #creature-stage).
   * this._uiBuilt repasse à false : showBattleUI() reconstruit tout proprement au retour
   * sur l'onglet Boss (coût négligeable, quelques objets texte/image).
   */
  stopIdle(){
    if(this._sprite){ this._sprite.destroy(); this._sprite = null; }
    if(this._bodyVignette){ this._bodyVignette.destroy(); this._bodyVignette = null; }
    if(this._slashSprite){ this._slashSprite.destroy(); this._slashSprite = null; }
    this._currentBossId = null;
    this._currentKind = null;
    this._destroyStaticUI();
  }

  /** Détruit tous les objets de l'UI statique (voir this._uiObjects) sans toucher au corps
   * du boss (idle/attacked) ni au slash — utilisée par stopIdle() (départ complet de
   * l'onglet Boss) ET par showBattleUI() lors d'un redimensionnement détecté (voir plus
   * haut) où seule l'UI doit être reconstruite, pas forcément le corps. */
  _destroyStaticUI(){
    this._uiObjects.forEach((obj) => { if(obj && obj.destroy) obj.destroy(); });
    this._uiObjects = [];
    this._pipImages.forEach((img) => img.destroy());
    this._pipImages = [];
    this._nameText = this._affinitiesText = this._weaknessIconText = this._timerText = null;
    this._hpText = this._hpFillImage = this._attemptsText = this._logText = null;
    this._attackBtn = null;
    this._uiBuilt = false;
    this._uiBuiltBossId = null;
  }

  /**
   * Halo sombre derrière le corps du boss (cercles concentriques d'alpha décroissant, qui
   * simulent un dégradé radial — Phaser Graphics n'a pas de fillStyle en dégradé natif).
   * Objectif : garantir un minimum de contraste peu importe le décor d'arène en dessous —
   * repéré sur le Spectre des Bourrasques (teintes bleu-cyan très proches du décor
   * spectre_arena.jpg, le rendant presque invisible), mais générique pour tout futur boss
   * dont les couleurs se rapprocheraient trop de son propre décor. Voir la conversation.
   */
  _ensureBodyVignette(cx, cy, size){
    if(this._bodyVignette) this._bodyVignette.destroy();
    const g = this.add.graphics().setDepth(BODY_DEPTH - 0.1);
    const rings = 8;
    for(let i = 0; i < rings; i++){
      const t = i / (rings - 1); // 0 = centre, 1 = bord extérieur du halo
      const r = size * 0.30 * (0.35 + t * 0.75);
      const alpha = 0.32 * (1 - t);
      g.fillStyle(0x0a0e08, alpha);
      g.fillCircle(cx, cy, r);
    }
    this._bodyVignette = g;
  }

  _showBodySprite(textureKey, kind, bossId){
    const { width } = this.scale;
    const cx = width / 2;
    const cy = this._arenaCenterY != null ? this._arenaCenterY : this.scale.height * 0.5;
    const targetSize = this._arenaMaxSize || Math.min(width, this.scale.height) * 0.42;
    const scale = targetSize / SPRITE_FRAME_SIZE;

    this._ensureBodyVignette(cx, cy, targetSize);

    if(this._sprite) this._sprite.destroy();
    this._sprite = this.add.sprite(cx, cy, textureKey).setOrigin(0.5).setScale(scale).setDepth(BODY_DEPTH);
    this._sprite.play(`${textureKey}_anim`);
    this._currentBossId = bossId;
    this._currentKind = kind;

    this.tweens.killTweensOf(this._sprite);
    this.tweens.add({ targets: this._sprite, y: cy - 8, duration: 1400, ease: 'Sine.easeInOut', yoyo: true, repeat: -1 });

    return this._sprite;
  }

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
          resolve();
        }
      });
      this.load.start();
    });
    this._loading.set(textureKey, promise);
    return promise;
  }

  // ============================================================
  // EFFET DE COUP (slash)
  // ============================================================
  playAttack(result){
    const { width } = this.scale;
    const cx = width / 2, cy = this._arenaCenterY != null ? this._arenaCenterY : this.scale.height * 0.5;
    const arenaSize = this._arenaMaxSize || Math.min(width, this.scale.height) * 0.42;
    const crit = !!(result && result.crit);

    this.cameras.main.shake(crit ? 180 : 120, crit ? 0.014 : 0.008);

    if(crit){
      const label = this.add.text(cx, cy - arenaSize * 0.7, 'CRITIQUE !', {
        fontFamily: FONT_FAMILY, fontSize: '10px', color: '#ffce6e',
      }).setOrigin(0.5).setAlpha(0).setDepth(SLASH_DEPTH + 1);
      this.tweens.add({ targets: label, alpha: 1, y: '-=12', duration: 220, delay: 80 });
      this.tweens.add({ targets: label, alpha: 0, delay: 650, duration: 250, onComplete: () => label.destroy() });
    }

    this._playSlash(crit);
  }

  async _playSlash(crit){
    await this._ensureSpriteLoaded(SLASH_TEXTURE_KEY, SLASH_FILE_PATH, { repeat: 0 });
    if(!this._loaded.has(SLASH_TEXTURE_KEY)) return;

    const { width } = this.scale;
    const cx = width / 2, cy = this._arenaCenterY != null ? this._arenaCenterY : this.scale.height * 0.5;
    const arenaSize = this._arenaMaxSize || Math.min(width, this.scale.height) * 0.42;
    const targetSize = arenaSize * (crit ? SLASH_ZOOM_CRIT : SLASH_ZOOM);
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
