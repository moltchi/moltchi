// ============================================================
// game/scenes/TreasureScene.js — Effet visuel de la Chasse aux trésors
// ============================================================
// PAS un mini-jeu : aucune interaction du joueur, aucun onResult. L'appel serveur
// (performAction('treasure_dig')) a déjà eu lieu côté app.js AVANT que cette scène ne
// soit sollicitée — elle ne fait que rejouer un effet ponctuel (coffre qui s'ouvre +
// pluie de pièces) une fois le résultat connu. Voir Bridge.playTreasureEffect().
// ============================================================

import Phaser from 'https://cdn.jsdelivr.net/npm/phaser@4.1.0/dist/phaser.esm.min.js';

export default class TreasureScene extends Phaser.Scene {
  constructor(){
    super('TreasureScene');
  }

  create(){
    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
  }

  /**
   * Rejoue l'ouverture du coffre. Aucune valeur de retour attendue — effet purement
   * décoratif, l'appelant (app.js) a déjà tout le résultat réel du serveur en main.
   * @param {{ itemFound?: boolean }} [result] - si un objet a été trouvé, l'effet est
   *   un peu plus généreux (davantage de pièces + une étincelle dorée).
   */
  playDig(result){
    const { width, height } = this.scale;
    const cx = width / 2, cy = height / 2;
    const size = Math.min(width, height);

    const chest = this.add.text(cx, cy, '📦', { fontSize: Math.round(size * 0.65) + 'px' }).setOrigin(0.5).setScale(0.7);
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
      const sparkle = this.add.text(cx, cy - size * 0.18, '✦', { fontSize: '20px', color: '#ffce6e' }).setOrigin(0.5).setAlpha(0);
      this.tweens.add({ targets: sparkle, alpha: 1, y: '-=18', duration: 260, ease: 'Cubic.easeOut' });
      this.tweens.add({ targets: sparkle, alpha: 0, delay: 400, duration: 300, onComplete: () => sparkle.destroy() });
    }
  }

  _spawnCoin(cx, cy, size){
    const coin = this.add.text(cx, cy, '🪙', { fontSize: '15px' }).setOrigin(0.5);
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
