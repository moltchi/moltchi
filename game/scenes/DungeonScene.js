// ============================================================
// game/scenes/DungeonScene.js — Effet visuel des Donjons
// ============================================================
// PAS un mini-jeu : aucune interaction du joueur, aucun onResult. L'appel serveur
// (performAction('dungeon_climb'/'dungeon_climb_corrupt'/'dungeon_climb_noyau')) a déjà
// eu lieu côté app.js AVANT que cette scène ne soit sollicitée — elle ne fait que rejouer
// un effet ponctuel (choc d'épées + victoire/défaite) une fois le résultat connu. Une
// seule scène pour les 3 variantes (Tour du Wyrm/Sanctuaire Corrompu/Noyau Primordial) :
// seul le conteneur DOM cible change (voir Bridge.playDungeonEffect(containerId, result)).
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.1.0/dist/phaser.esm.min.js';

export default class DungeonScene extends Phaser.Scene {
  constructor(){
    super('DungeonScene');
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

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
      .setOrigin(0.5).setRotation(-0.4).setAlpha(0.9);

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
        }).setOrigin(0.5).setAlpha(0).setScale(0.6);
        this.tweens.add({ targets: label, alpha: 1, scale: 1, duration: 200, delay: 60, ease: 'Back.easeOut' });
        this.tweens.add({ targets: [sword], alpha: 0, delay: 220, duration: 220, onComplete: () => sword.destroy() });
        this.time.delayedCall(750, () => {
          this.tweens.add({ targets: label, alpha: 0, duration: 220, onComplete: () => label.destroy() });
        });
      },
    });
  }

  _flash(x, y, color, size){
    const circle = this.add.circle(x, y, size * 0.06, color, 0.85);
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
