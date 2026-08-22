// ============================================================
// game/scenes/TrainingScene.js — Mini-jeux d'entraînement
// ============================================================
// Les 4 mini-jeux (Réflexe/Mémoire/Rythme/Invocation) suivent le même schéma :
// une paire de méthodes start*/stop* sur cette scène.
//
// RÈGLE D'OR (rappel) : cette scène ne fait JAMAIS d'appel serveur et ne décide
// JAMAIS d'un gain. Elle capte l'interaction du joueur (temps de réaction, case
// cliquée, score total de l'Invocation...) et la remonte telle quelle via
// `onResult` — c'est toujours app.js qui appelle performAction() et affiche le
// résultat réel renvoyé par le serveur. Voir *WithFallback() dans app.js pour le
// fallback DOM existant de chaque mini-jeu, jamais supprimé.
//
// Cette scène partage le même canvas Phaser que MainScene (voir bridge.js/
// _moveCanvasTo) mais les deux scènes restent actives en permanence (pas de
// sleep()/wake()) — chacune ne dessine que ce qu'elle affiche explicitement, et
// le nettoie explicitement après usage (voir les _cleanup*() de chaque jeu).
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.1.0/dist/phaser.esm.min.js';

// Couleurs reprises des variables CSS utilisées par les mêmes mini-jeux en DOM
// (voir style.css), pour un rendu cohérent entre les deux systèmes.
const COLOR_WAIT = 0x7a2b2b;    // --danger (zone Réflexe en attente)
const COLOR_GO = 0x3ecf6e;      // vert vif de .reflex-zone.go
const COLOR_STROKE = 0x4a2f74;  // --moss-700 (bordures)
const COLOR_PANEL = 0x241a3a;   // fond des tuiles/pistes/boutons, façon --moss-800/950
const COLOR_TEXT = 0xf4efe6;    // --ivory
const COLOR_TEXT_DIM = '#c9b8de'; // --ivory-dim
const COLOR_BLUE = 0x4e8aa8;    // --blue (Mémoire, thème Vent)
const COLOR_GREEN_EARTH = 0x5fbf9a; // thème Terre (Rythme)
const COLOR_GOLD = 0xe2a63f;    // --gold (zone dorée du Rythme)
const COLOR_VIOLET = 0xb06fe0;  // --violet (Invocation, thème Eau)
const COLOR_WRONG = 0x7a2b2b;   // --danger

export default class TrainingScene extends Phaser.Scene {
  constructor(){
    super('TrainingScene');
    this._resultCallback = null;
    this._reflexZone = null;   // { rect, label, comboText, emberEmitter }
    this._goTimeoutEvent = null;
    this._goTime = null;
    this._done = false;
    // Combo Réflexe : nombre de bons réflexes enchaînés SANS "trop tôt" entre-deux.
    // Vit sur l'instance de la scène (jamais détruite tant que la session dure), donc
    // persiste d'une partie à l'autre — remis à zéro uniquement sur un clic trop tôt.
    this._reflexCombo = 0;

    this._memoryZone = null;
    this._memoryResultCallback = null;
    this._memoryAbort = false;
    // Streak Mémoire : nombre de séquences complétées d'affilée SANS erreur.
    this._memoryStreak = 0;

    this._rhythmZone = null;
    this._rhythmResultCallback = null;
    // Streak Rythme : nombre de clics "excellents" (proches du centre) d'affilée.
    this._rhythmStreak = 0;

    this._arcaneZone = null;
    this._arcaneResultCallback = null;
    this._arcaneAbort = false;
    // Streak Invocation : nombre de bonnes runes trouvées d'affilée (toutes manches confondues).
    this._arcaneStreak = 0;
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
    this._generateParticleTextures();
  }

  // Génère une petite texture de particule (cercle plein blanc, teinté à la volée via
  // `tint` sur chaque émetteur) une seule fois — cette scène n'est jamais détruite
  // pendant la session, donc pas besoin de régénérer à chaque partie.
  _generateParticleTextures(){
    if(this.textures.exists('mg-spark')) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(8, 8, 8);
    g.generateTexture('mg-spark', 16, 16);
    g.destroy();
  }

  // ---------- Réflexe ----------

  /** @param {(result: {reactionMs?: number, tooEarly?: boolean}) => void} onResult */
  startReflex(onResult){
    this._cleanupReflex();
    this._resultCallback = onResult;
    this._goTime = null;
    this._done = false;

    const { width, height } = this.scale;
    const zoneW = width - 8, zoneH = height - 8;
    const rect = this.add.rectangle(width/2, height/2, zoneW, zoneH, COLOR_WAIT, 1)
      .setStrokeStyle(2, COLOR_STROKE)
      .setInteractive({ useHandCursor: true });
    // Icône + texte sur deux lignes, comme le ::before + le texte de .reflex-zone en DOM
    // (🔥 pendant l'attente, ⚡ une fois la zone verte) — pour un rendu cohérent entre les
    // deux systèmes (Phaser et fallback DOM).
    const label = this.add.text(width/2, height/2, '🔥\nAttends…', { fontSize: '16px', color: '#f4efe6', fontStyle: 'bold', align: 'center' })
      .setOrigin(0.5);

    // Petit badge de combo, affiché seulement à partir de 2 bons réflexes d'affilée —
    // pure ambiance, aucun impact sur le gain réel (calculé côté serveur).
    const comboText = this.add.text(width - 10, 8, this._reflexCombo >= 2 ? `Combo x${this._reflexCombo}` : '', {
      fontSize: '11px', color: '#ffce6e', fontStyle: 'bold',
    }).setOrigin(1, 0);

    // Braises qui montent doucement le long du bas de la zone pendant l'attente — pure
    // ambiance "forge", s'arrête dès que la zone passe au vert.
    const emberEmitter = this.add.particles(width/2, height/2 + zoneH/2 - 4, 'mg-spark', {
      x: { min: width/2 - zoneW/2 + 12, max: width/2 + zoneW/2 - 12 },
      lifespan: 850,
      speedY: { min: -55, max: -85 },
      speedX: { min: -10, max: 10 },
      scale: { start: 0.45, end: 0 },
      alpha: { start: 0.75, end: 0 },
      tint: 0xe8845a,
      frequency: 90,
    });

    this._reflexZone = { rect, label, comboText, emberEmitter };

    const delay = 800 + Math.random() * 2200;
    this._goTimeoutEvent = this.time.delayedCall(delay, () => {
      this._goTime = Date.now();
      rect.setFillStyle(COLOR_GO);
      label.setText('⚡\nCLIQUE !');
      emberEmitter.stop();
      this._flash(rect.x, rect.y, 0x3ecf6e);
      this._burstParticles(rect.x, rect.y, 0x3ecf6e, 16);
    });

    rect.on('pointerdown', () => this._onReflexClick());
  }

  _onReflexClick(){
    if(this._done || !this._reflexZone) return;
    const { rect, label, comboText, emberEmitter } = this._reflexZone;

    if(this._goTime === null){
      // Trop tôt : annule le passage au vert et remonte l'échec, comme la version DOM.
      this._done = true;
      if(this._goTimeoutEvent) this._goTimeoutEvent.remove();
      emberEmitter.stop();
      label.setText('Trop tôt !');
      this._shake(rect);
      this._burstParticles(rect.x, rect.y, 0x7a2b2b, 8);
      this._reflexCombo = 0;
      comboText.setText('');
      if(this._resultCallback) this._resultCallback({ tooEarly: true });
      return;
    }

    this._done = true;
    const reactionMs = Date.now() - this._goTime;
    const perfect = reactionMs < 220;
    this._reflexCombo++;
    comboText.setText(this._reflexCombo >= 2 ? `Combo x${this._reflexCombo}` : '');

    this._flash(rect.x, rect.y, perfect ? 0xffce6e : 0xE2A63F);
    this._burstParticles(rect.x, rect.y, perfect ? 0xffce6e : 0xE2A63F, perfect ? 22 : 14);
    if(perfect) this._showFlair(rect.x, rect.y - 30, '✦ PARFAIT !', '#ffce6e');
    if(this._resultCallback) this._resultCallback({ reactionMs });
  }

  stopReflex(){
    this._cleanupReflex();
  }

  _cleanupReflex(){
    if(this._goTimeoutEvent){ this._goTimeoutEvent.remove(); this._goTimeoutEvent = null; }
    if(this._reflexZone){
      this._reflexZone.rect.destroy();
      this._reflexZone.label.destroy();
      this._reflexZone.comboText.destroy();
      this._reflexZone.emberEmitter.destroy();
      this._reflexZone = null;
    }
    this._resultCallback = null;
    this._goTime = null;
    this._done = false;
  }

  // ---------- Mémoire ----------

  /** @param {(result: {success: boolean, playerIdx: number}) => void} onResult */
  startMemory(onResult){
    this._cleanupMemory();
    this._memoryResultCallback = onResult;
    this._memoryAbort = false;

    const { width, height } = this.scale;
    const gridN = 3, gap = 6;
    const labelH = 20;
    const available = Math.min(width, height - labelH) - 12;
    const cell = (available - (gridN - 1) * gap) / gridN;
    const totalSize = gridN * cell + (gridN - 1) * gap;
    const originX = width / 2 - totalSize / 2 + cell / 2;
    const originY = (height - labelH) / 2 - totalSize / 2 + cell / 2;

    const tiles = [];
    for(let i = 0; i < gridN * gridN; i++){
      const col = i % gridN, row = Math.floor(i / gridN);
      const x = originX + col * (cell + gap);
      const y = originY + row * (cell + gap);
      const tile = this.add.rectangle(x, y, cell, cell, COLOR_PANEL, 1)
        .setStrokeStyle(2, COLOR_STROKE)
        .setInteractive({ useHandCursor: true });
      tiles.push(tile);
    }
    const label = this.add.text(width / 2, height - 6, 'Regarde bien…', { fontSize: '12px', color: COLOR_TEXT_DIM })
      .setOrigin(0.5, 1);
    const comboText = this.add.text(width - 10, 8, this._memoryStreak >= 2 ? `Combo x${this._memoryStreak}` : '', {
      fontSize: '11px', color: '#ffce6e', fontStyle: 'bold',
    }).setOrigin(1, 0);
    this._memoryZone = { tiles, label, comboText };

    const seqLen = 4;
    const seq = Array.from({ length: seqLen }, () => Math.floor(Math.random() * 9));
    let playerIdx = 0, accepting = false;

    const wait = (ms) => new Promise((resolve) => this.time.delayedCall(ms, resolve));

    const playSequence = async () => {
      for(const idx of seq){
        if(this._memoryAbort) return;
        tiles[idx].setFillStyle(COLOR_BLUE);
        this._burstParticles(tiles[idx].x, tiles[idx].y, COLOR_BLUE, 5); // petite étincelle à chaque case de la démonstration
        await wait(450);
        if(this._memoryAbort) return;
        tiles[idx].setFillStyle(COLOR_PANEL);
        await wait(180);
      }
      if(this._memoryAbort) return;
      label.setText('À toi — reproduis la séquence');
      accepting = true;
    };

    tiles.forEach((tile, idx) => {
      tile.on('pointerdown', () => {
        if(!accepting || this._memoryAbort) return;
        if(idx === seq[playerIdx]){
          tile.setFillStyle(0x3ecf6e);
          this._burstParticles(tile.x, tile.y, 0x3ecf6e, 9);
          this.time.delayedCall(220, () => { if(!this._memoryAbort) tile.setFillStyle(COLOR_PANEL); });
          playerIdx++;
          if(playerIdx === seq.length){
            accepting = false;
            this._memoryStreak++;
            comboText.setText(this._memoryStreak >= 2 ? `Combo x${this._memoryStreak}` : '');
            this._showFlair(width / 2, height / 2, '✦ Séquence parfaite !', '#ffce6e');
            if(this._memoryResultCallback) this._memoryResultCallback({ success: true, playerIdx });
          }
        } else {
          tile.setFillStyle(COLOR_WRONG);
          this._burstParticles(tile.x, tile.y, COLOR_WRONG, 8);
          this.time.delayedCall(220, () => { if(!this._memoryAbort) tile.setFillStyle(COLOR_PANEL); });
          this._shake(tile);
          accepting = false;
          this._memoryStreak = 0;
          comboText.setText('');
          if(this._memoryResultCallback) this._memoryResultCallback({ success: false, playerIdx });
        }
      });
    });

    playSequence();
  }

  stopMemory(){ this._cleanupMemory(); }

  _cleanupMemory(){
    this._memoryAbort = true;
    if(this._memoryZone){
      this._memoryZone.tiles.forEach(t => t.destroy());
      this._memoryZone.label.destroy();
      this._memoryZone.comboText.destroy();
      this._memoryZone = null;
    }
    this._memoryResultCallback = null;
  }

  // ---------- Rythme ----------

  /** @param {(result: {distFromCenter: number}) => void} onResult */
  startRhythm(onResult){
    this._cleanupRhythm();
    this._rhythmResultCallback = onResult;

    const { width, height } = this.scale;
    const trackLeft = 12, trackRight = width - 12, trackWidth = trackRight - trackLeft;
    const trackY = height / 2 - 6;
    const trackH = 26;

    const track = this.add.rectangle((trackLeft + trackRight) / 2, trackY, trackWidth, trackH, COLOR_PANEL, 1)
      .setStrokeStyle(2, COLOR_STROKE)
      .setInteractive({ useHandCursor: true });
    const zoneW = trackWidth * 0.16;
    const zone = this.add.rectangle((trackLeft + trackRight) / 2, trackY, zoneW, trackH, COLOR_GOLD, 0.35);
    const marker = this.add.rectangle(trackLeft, trackY, 4, trackH + 10, COLOR_TEXT, 1);
    const label = this.add.text(width / 2, height - 6, 'Clique au bon moment…', { fontSize: '12px', color: COLOR_TEXT_DIM })
      .setOrigin(0.5, 1);
    const comboText = this.add.text(width - 10, 8, this._rhythmStreak >= 2 ? `Combo x${this._rhythmStreak}` : '', {
      fontSize: '11px', color: '#ffce6e', fontStyle: 'bold',
    }).setOrigin(1, 0);

    // Traînée lumineuse discrète derrière le marqueur en mouvement — ambiance seulement,
    // repositionnée à chaque tick pour suivre le marqueur.
    const trailEmitter = this.add.particles(marker.x, trackY, 'mg-spark', {
      lifespan: 240,
      scale: { start: 0.35, end: 0 },
      alpha: { start: 0.5, end: 0 },
      tint: COLOR_GOLD,
      frequency: 40,
    });

    this._rhythmZone = { track, zone, marker, label, comboText, trailEmitter, tickEvent: null };

    let pos = 0, dir = 1, done = false;
    const speed = 1.6;
    const tickEvent = this.time.addEvent({
      delay: 16, loop: true, callback: () => {
        pos += dir * speed;
        if(pos >= 100){ pos = 100; dir = -1; }
        if(pos <= 0){ pos = 0; dir = 1; }
        marker.x = trackLeft + (pos / 100) * trackWidth;
        trailEmitter.setPosition(marker.x, trackY);
      },
    });
    this._rhythmZone.tickEvent = tickEvent;

    track.on('pointerdown', () => {
      if(done) return;
      done = true;
      tickEvent.remove(false);
      trailEmitter.stop();
      const distFromCenter = Math.abs(pos - 50);
      const perfect = distFromCenter < 5;
      const great = distFromCenter < 15;
      const accentColor = great ? (perfect ? 0xffce6e : 0xffce6e) : 0x7a2b2b;
      this._flash(marker.x, trackY, accentColor);
      this._burstParticles(marker.x, trackY, great ? 0xffce6e : 0x7a2b2b, great ? (perfect ? 20 : 14) : 6);
      if(great){
        this._rhythmStreak++;
        comboText.setText(this._rhythmStreak >= 2 ? `Combo x${this._rhythmStreak}` : '');
        if(perfect) this._showFlair(marker.x, trackY - 20, '✦ PARFAIT !', '#ffce6e');
      } else {
        this._rhythmStreak = 0;
        comboText.setText('');
      }
      if(this._rhythmResultCallback) this._rhythmResultCallback({ distFromCenter });
    });
  }

  stopRhythm(){ this._cleanupRhythm(); }

  _cleanupRhythm(){
    if(this._rhythmZone){
      if(this._rhythmZone.tickEvent) this._rhythmZone.tickEvent.remove(false);
      this._rhythmZone.trailEmitter.destroy();
      this._rhythmZone.track.destroy();
      this._rhythmZone.zone.destroy();
      this._rhythmZone.marker.destroy();
      this._rhythmZone.label.destroy();
      this._rhythmZone.comboText.destroy();
      this._rhythmZone = null;
    }
    this._rhythmResultCallback = null;
  }

  // ---------- Invocation (Arcane) ----------
  // Contrairement aux 3 autres mini-jeux, l'Invocation gère ENTIÈREMENT ses 5 manches en
  // interne (comme la version DOM) — un seul appel serveur au tout final, avec le score
  // cumulé. onResult n'est donc appelé qu'une fois, à la toute fin.

  /** @param {(result: {totalScore: number}) => void} onResult */
  startArcane(onResult){
    this._cleanupArcane();
    this._arcaneResultCallback = onResult;
    this._arcaneAbort = false;

    const ARCANE_RUNES = ['᛭', 'ᚨ', 'ᛟ', 'ᚱ', 'ᛝ', 'ᛒ'];
    const ARCANE_ROUNDS = 5;
    const ARCANE_ROUND_TIME = 1800;

    const { width, height } = this.scale;
    const targetText = this.add.text(width / 2, 8, '?', { fontSize: '26px', color: '#f4efe6', fontStyle: 'bold' }).setOrigin(0.5, 0);
    const statusText = this.add.text(width / 2, height - 6, '', { fontSize: '12px', color: COLOR_TEXT_DIM }).setOrigin(0.5, 1);
    const comboText = this.add.text(width - 10, 8, this._arcaneStreak >= 2 ? `Combo x${this._arcaneStreak}` : '', {
      fontSize: '11px', color: '#ffce6e', fontStyle: 'bold',
    }).setOrigin(1, 0);
    const timerBarBg = this.add.rectangle(width / 2, 44, width - 24, 6, COLOR_PANEL, 1);
    const timerBarFill = this.add.rectangle(12, 44, width - 24, 6, COLOR_VIOLET, 1).setOrigin(0, 0.5);
    let buttons = [];
    this._arcaneZone = { targetText, statusText, comboText, timerBarBg, timerBarFill, buttons, tickEvent: null };

    let round = 0, totalScore = 0, roundActive = false, roundStart = 0, allCorrectThisRun = true;

    const clearButtons = () => {
      buttons.forEach(b => { b.rect.destroy(); b.label.destroy(); });
      buttons = [];
      this._arcaneZone.buttons = buttons;
    };

    const playRound = () => {
      if(this._arcaneAbort) return;
      round++;
      const target = ARCANE_RUNES[Math.floor(Math.random() * ARCANE_RUNES.length)];
      const choices = new Set([target]);
      while(choices.size < 4) choices.add(ARCANE_RUNES[Math.floor(Math.random() * ARCANE_RUNES.length)]);
      const shuffled = Array.from(choices).sort(() => Math.random() - 0.5);

      targetText.setText(target);
      statusText.setText(`Manche ${round} / ${ARCANE_ROUNDS}`);
      clearButtons();

      const btnGap = 8;
      const btnW = (width - 24 - 3 * btnGap) / 4;
      const btnH = Math.min(44, height - 68);
      const btnY = height - 20 - btnH / 2;
      shuffled.forEach((sym, i) => {
        const x = 12 + btnW / 2 + i * (btnW + btnGap);
        const rect = this.add.rectangle(x, btnY, btnW, btnH, COLOR_PANEL, 1)
          .setStrokeStyle(2, COLOR_STROKE)
          .setInteractive({ useHandCursor: true });
        const label = this.add.text(x, btnY, sym, { fontSize: '20px', color: '#f4efe6' }).setOrigin(0.5);
        rect.on('pointerdown', () => resolveRound(sym === target, x, btnY));
        buttons.push({ rect, label });
      });
      this._arcaneZone.buttons = buttons;

      roundActive = true;
      roundStart = Date.now();
    };

    const resolveRound = (correct, clickX, clickY) => {
      if(!roundActive || this._arcaneAbort) return;
      roundActive = false;
      const elapsed = Date.now() - roundStart;
      const bx = clickX !== undefined ? clickX : width / 2;
      const by = clickY !== undefined ? clickY : height / 2;
      if(correct){
        const speedBonus = Math.max(0, Math.round((ARCANE_ROUND_TIME - elapsed) / 100));
        totalScore += 3 + speedBonus;
        this._flash(width / 2, height / 2, 0xb06fe0);
        this._burstParticles(bx, by, 0xb06fe0, 12);
        this._arcaneStreak++;
        comboText.setText(this._arcaneStreak >= 2 ? `Combo x${this._arcaneStreak}` : '');
      } else {
        this._shake(targetText);
        this._burstParticles(bx, by, COLOR_WRONG, 8);
        allCorrectThisRun = false;
        this._arcaneStreak = 0;
        comboText.setText('');
      }
      this.time.delayedCall(250, () => {
        if(this._arcaneAbort) return;
        if(round < ARCANE_ROUNDS){
          playRound();
        } else {
          clearButtons();
          targetText.setText('✓');
          statusText.setText('Invocation terminée…');
          if(allCorrectThisRun) this._showFlair(width / 2, height / 2, '✦ Invocation parfaite !', '#ffce6e');
          if(this._arcaneResultCallback) this._arcaneResultCallback({ totalScore });
        }
      });
    };

    const tickEvent = this.time.addEvent({
      delay: 16, loop: true, callback: () => {
        if(!roundActive || this._arcaneAbort) return;
        const elapsed = Date.now() - roundStart;
        const pct = Math.max(0, 100 - (elapsed / ARCANE_ROUND_TIME) * 108);
        timerBarFill.width = (width - 24) * (pct / 100);
        if(elapsed >= ARCANE_ROUND_TIME) resolveRound(false);
      },
    });
    this._arcaneZone.tickEvent = tickEvent;

    playRound();
  }

  stopArcane(){ this._cleanupArcane(); }

  _cleanupArcane(){
    this._arcaneAbort = true;
    if(this._arcaneZone){
      if(this._arcaneZone.tickEvent) this._arcaneZone.tickEvent.remove(false);
      this._arcaneZone.buttons.forEach(b => { b.rect.destroy(); b.label.destroy(); });
      this._arcaneZone.targetText.destroy();
      this._arcaneZone.statusText.destroy();
      this._arcaneZone.comboText.destroy();
      this._arcaneZone.timerBarBg.destroy();
      this._arcaneZone.timerBarFill.destroy();
      this._arcaneZone = null;
    }
    this._arcaneResultCallback = null;
  }

  // ---------- API partagée ----------

  /** Affiche le texte de résultat renvoyé par le serveur, sur le mini-jeu actuellement actif. */
  showResult(text){
    if(this._reflexZone){ this._reflexZone.label.setText(text); return true; }
    if(this._memoryZone){ this._memoryZone.label.setText(text); return true; }
    if(this._rhythmZone){ this._rhythmZone.label.setText(text); return true; }
    if(this._arcaneZone){ this._arcaneZone.statusText.setText(text); return true; }
    return false;
  }

  /** Arrête et nettoie le mini-jeu actuellement en cours, quel qu'il soit. */
  stopAll(){
    this._cleanupReflex();
    this._cleanupMemory();
    this._cleanupRhythm();
    this._cleanupArcane();
  }

  // ---------- Effets partagés ----------

  _flash(x, y, color){
    const circle = this.add.circle(x, y, 8, color, 0.85);
    this.tweens.add({
      targets: circle,
      radius: 55,
      alpha: 0,
      duration: 380,
      ease: 'Cubic.easeOut',
      onComplete: () => circle.destroy(),
    });
  }

  _shake(target){
    const originalX = target.x;
    this.tweens.add({
      targets: target,
      x: { from: originalX - 6, to: originalX },
      duration: 60,
      yoyo: true,
      repeat: 3,
    });
  }

  // Explosion ponctuelle de particules (impact de clic, révélation "GO", etc.) — utilise
  // la texture générée une seule fois dans create(). Auto-nettoyée après sa durée de vie,
  // pas besoin de la suivre dans un _cleanup*().
  _burstParticles(x, y, tint, count = 14){
    const emitter = this.add.particles(x, y, 'mg-spark', {
      lifespan: 420,
      speed: { min: 60, max: 190 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 1, end: 0 },
      tint,
      emitting: false,
    });
    emitter.explode(count, x, y);
    this.time.delayedCall(500, () => emitter.destroy());
  }

  // Petit texte flottant qui monte puis s'efface (ex. "✦ PARFAIT !") — utilisé par les 4
  // mini-jeux pour signaler un résultat particulièrement réussi, avant même que le
  // serveur n'ait répondu.
  _showFlair(x, y, text, color){
    const flair = this.add.text(x, y, text, { fontSize: '13px', color, fontStyle: 'bold' }).setOrigin(0.5).setAlpha(0);
    this.tweens.add({ targets: flair, alpha: 1, y: y - 14, duration: 200 });
    this.tweens.add({ targets: flair, alpha: 0, delay: 500, duration: 250, onComplete: () => flair.destroy() });
  }
}
