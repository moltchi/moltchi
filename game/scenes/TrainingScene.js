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
    this._reflexZone = null;   // { rect, label }
    this._goTimeoutEvent = null;
    this._goTime = null;
    this._done = false;

    this._memoryZone = null;
    this._memoryResultCallback = null;
    this._memoryAbort = false;

    this._rhythmZone = null;
    this._rhythmResultCallback = null;

    this._arcaneZone = null;
    this._arcaneResultCallback = null;
    this._arcaneAbort = false;
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  // ---------- Réflexe ----------

  /** @param {(result: {reactionMs?: number, tooEarly?: boolean}) => void} onResult */
  startReflex(onResult){
    this._cleanupReflex();
    this._resultCallback = onResult;
    this._goTime = null;
    this._done = false;

    const { width, height } = this.scale;
    const rect = this.add.rectangle(width/2, height/2, width - 8, height - 8, COLOR_WAIT, 1)
      .setStrokeStyle(2, COLOR_STROKE)
      .setInteractive({ useHandCursor: true });
    // Icône + texte sur deux lignes, comme le ::before + le texte de .reflex-zone en DOM
    // (🔥 pendant l'attente, ⚡ une fois la zone verte) — pour un rendu cohérent entre les
    // deux systèmes (Phaser et fallback DOM).
    const label = this.add.text(width/2, height/2, '🔥\nAttends…', { fontSize: '16px', color: '#f4efe6', fontStyle: 'bold', align: 'center' })
      .setOrigin(0.5);
    this._reflexZone = { rect, label };

    const delay = 800 + Math.random() * 2200;
    this._goTimeoutEvent = this.time.delayedCall(delay, () => {
      this._goTime = Date.now();
      rect.setFillStyle(COLOR_GO);
      label.setText('⚡\nCLIQUE !');
      this._flash(rect.x, rect.y, 0x3ecf6e);
    });

    rect.on('pointerdown', () => this._onReflexClick());
  }

  _onReflexClick(){
    if(this._done || !this._reflexZone) return;
    const { rect, label } = this._reflexZone;

    if(this._goTime === null){
      // Trop tôt : annule le passage au vert et remonte l'échec, comme la version DOM.
      this._done = true;
      if(this._goTimeoutEvent) this._goTimeoutEvent.remove();
      label.setText('Trop tôt !');
      this._shake(rect);
      if(this._resultCallback) this._resultCallback({ tooEarly: true });
      return;
    }

    this._done = true;
    const reactionMs = Date.now() - this._goTime;
    this._flash(rect.x, rect.y, 0xE2A63F);
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
    this._memoryZone = { tiles, label };

    const seqLen = 4;
    const seq = Array.from({ length: seqLen }, () => Math.floor(Math.random() * 9));
    let playerIdx = 0, accepting = false;

    const wait = (ms) => new Promise((resolve) => this.time.delayedCall(ms, resolve));

    const playSequence = async () => {
      for(const idx of seq){
        if(this._memoryAbort) return;
        tiles[idx].setFillStyle(COLOR_BLUE);
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
          this.time.delayedCall(220, () => { if(!this._memoryAbort) tile.setFillStyle(COLOR_PANEL); });
          playerIdx++;
          if(playerIdx === seq.length){
            accepting = false;
            if(this._memoryResultCallback) this._memoryResultCallback({ success: true, playerIdx });
          }
        } else {
          tile.setFillStyle(COLOR_WRONG);
          this.time.delayedCall(220, () => { if(!this._memoryAbort) tile.setFillStyle(COLOR_PANEL); });
          this._shake(tile);
          accepting = false;
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
    this._rhythmZone = { track, zone, marker, label, tickEvent: null };

    let pos = 0, dir = 1, done = false;
    const speed = 1.6;
    const tickEvent = this.time.addEvent({
      delay: 16, loop: true, callback: () => {
        pos += dir * speed;
        if(pos >= 100){ pos = 100; dir = -1; }
        if(pos <= 0){ pos = 0; dir = 1; }
        marker.x = trackLeft + (pos / 100) * trackWidth;
      },
    });
    this._rhythmZone.tickEvent = tickEvent;

    track.on('pointerdown', () => {
      if(done) return;
      done = true;
      tickEvent.remove(false);
      const distFromCenter = Math.abs(pos - 50);
      const accentColor = distFromCenter < 15 ? 0xffce6e : 0x7a2b2b;
      this._flash(marker.x, trackY, accentColor);
      if(this._rhythmResultCallback) this._rhythmResultCallback({ distFromCenter });
    });
  }

  stopRhythm(){ this._cleanupRhythm(); }

  _cleanupRhythm(){
    if(this._rhythmZone){
      if(this._rhythmZone.tickEvent) this._rhythmZone.tickEvent.remove(false);
      this._rhythmZone.track.destroy();
      this._rhythmZone.zone.destroy();
      this._rhythmZone.marker.destroy();
      this._rhythmZone.label.destroy();
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
    const timerBarBg = this.add.rectangle(width / 2, 44, width - 24, 6, COLOR_PANEL, 1);
    const timerBarFill = this.add.rectangle(12, 44, width - 24, 6, COLOR_VIOLET, 1).setOrigin(0, 0.5);
    let buttons = [];
    this._arcaneZone = { targetText, statusText, timerBarBg, timerBarFill, buttons, tickEvent: null };

    let round = 0, totalScore = 0, roundActive = false, roundStart = 0;

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
        rect.on('pointerdown', () => resolveRound(sym === target));
        buttons.push({ rect, label });
      });
      this._arcaneZone.buttons = buttons;

      roundActive = true;
      roundStart = Date.now();
    };

    const resolveRound = (correct) => {
      if(!roundActive || this._arcaneAbort) return;
      roundActive = false;
      const elapsed = Date.now() - roundStart;
      if(correct){
        const speedBonus = Math.max(0, Math.round((ARCANE_ROUND_TIME - elapsed) / 100));
        totalScore += 3 + speedBonus;
        this._flash(width / 2, height / 2, 0xb06fe0);
      } else if(this._arcaneZone){
        this._shake(targetText);
      }
      this.time.delayedCall(250, () => {
        if(this._arcaneAbort) return;
        if(round < ARCANE_ROUNDS){
          playRound();
        } else {
          clearButtons();
          targetText.setText('✓');
          statusText.setText('Invocation terminée…');
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
}
