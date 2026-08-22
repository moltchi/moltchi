// ============================================================
// game/scenes/BossScene.js — Effet visuel du Boss Mondial
// ============================================================
// PAS un mini-jeu : aucune interaction du joueur, aucun onResult. L'attaque a déjà été
// résolue côté serveur AVANT que cette scène ne soit sollicitée (voir l'appel à
// attack-boss dans app.js) — elle ne fait que rejouer un éclair d'impact une fois les
// dégâts connus. Voir Bridge.playBossEffect().
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.1.0/dist/phaser.esm.min.js';

export default class BossScene extends Phaser.Scene {
  constructor(){
    super('BossScene');
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  /**
   * Rejoue l'impact de l'attaque. Effet purement décoratif.
   * @param {{ crit?: boolean }} [result] - un critique déclenche un effet plus marqué.
   */
  playAttack(result){
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;
    const size = Math.min(width, height);
    const crit = !!(result && result.crit);

    const bolt = this.add.text(cx, cy, '⚡', {
      fontSize: Math.round(size * (crit ? 0.85 : 0.65)) + 'px',
      color: crit ? '#ffce6e' : '#f4efe6',
    }).setOrigin(0.5).setAlpha(0).setScale(0.5);

    this.tweens.add({
      targets: bolt,
      alpha: 1,
      scale: 1,
      duration: 120,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.cameras.main.shake(crit ? 180 : 120, crit ? 0.014 : 0.008);
        this.tweens.add({ targets: bolt, alpha: 0, duration: 260, delay: 120, onComplete: () => bolt.destroy() });
      },
    });

    if(crit){
      const label = this.add.text(cx, cy - size * 0.42, 'CRITIQUE !', { fontSize: '13px', color: '#ffce6e', fontStyle: 'bold' })
        .setOrigin(0.5).setAlpha(0);
      this.tweens.add({ targets: label, alpha: 1, y: '-=12', duration: 220, delay: 80 });
      this.tweens.add({ targets: label, alpha: 0, delay: 650, duration: 250, onComplete: () => label.destroy() });
    }
  }
}
