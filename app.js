// ============================================================
// ============ STOCKAGE & PORTÉE JOUEUR ============
// Shim window.storage (relayé vers Supabase) + calcul de l'ID/portée
// du joueur courant. Tout le reste du fichier appelle window.storage.
// ============================================================
// ---------- Storage shim (window.storage backé par Supabase) ----------
// Reproduit exactement l'API window.storage (get/set/delete/list, shared true/false)
// utilisée dans tout le reste du jeu, pour ne rien changer à la logique existante.

const SUPABASE_URL = 'https://oouqtclsffybeloulvph.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mcwpuEnzvQslp2V13uKAIA_4xZR9RFd';

const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Appelle la passerelle serveur unique (perform-action) pour toute action de jeu déjà migrée
// (Entraînement pour l'instant). Le serveur revalide/borne tout, recalcule le résultat avec
// les vraies formules, sauvegarde, et renvoie la créature à jour + le résultat de l'action.
async function performAction(action, payload){
  const res = await fetch(`${SUPABASE_URL}/functions/v1/perform-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
    body: JSON.stringify({ scope: _getPlayerScope(), action, payload })
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || 'action refusée par le serveur');
  return data;
}

// Identité anonyme du joueur, générée une fois et conservée dans ce navigateur.
function _getPlayerScope(){
  let id = localStorage.getItem('moltchi_player_scope');
  if(!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : 'p_' + Math.random().toString(36).slice(2) + Date.now());
    localStorage.setItem('moltchi_player_scope', id);
  }
  return id;
}

window.storage = {
  async get(key, shared=false){
    const scope = shared ? 'shared' : _getPlayerScope();
    const { data, error } = await _sb.from('kv_store').select('value').eq('scope', scope).eq('key', key).maybeSingle();
    if(error) throw error;
    if(!data) throw new Error('not found');
    // Si la valeur stockée est une chaîne brute (ex: pseudo), on la renvoie telle quelle.
    // Si c'est un objet/tableau/nombre (ex: créature en JSON), on la re-sérialise,
    // car le reste du jeu fait systématiquement JSON.parse(r.value) pour ces clés-là.
    const raw = typeof data.value === 'string' ? data.value : JSON.stringify(data.value);
    return { key, value: raw, shared };
  },
  async set(key, value, shared=false){
    const scope = shared ? 'shared' : _getPlayerScope();
    let parsed;
    try{ parsed = JSON.parse(value); } catch(e){ parsed = value; } // chaîne brute (ex: pseudo) si ce n'est pas du JSON valide
    const { error } = await _sb.from('kv_store').upsert({ scope, key, value: parsed, updated_at: new Date().toISOString() }, { onConflict: 'scope,key' });
    if(error) throw error;
    return { key, value, shared };
  },
  async delete(key, shared=false){
    const scope = shared ? 'shared' : _getPlayerScope();
    const { error } = await _sb.from('kv_store').delete().eq('scope', scope).eq('key', key);
    if(error) throw error;
    return { key, deleted: true, shared };
  },
  async list(prefix='', shared=false){
    const scope = shared ? 'shared' : _getPlayerScope();
    const { data, error } = await _sb.from('kv_store').select('key').eq('scope', scope).like('key', prefix + '%');
    if(error) throw error;
    return { keys: (data||[]).map(r=>r.key), prefix, shared };
  }
};

const $ = id => document.getElementById(id);


// ============================================================
// ============ TRADUCTION / I18N ============
// Dictionnaire FR/EN, application des textes dans le DOM, boutons
// de bascule de langue. Le français est la langue par défaut.
//
// ⚠️ RAPPEL : tout texte ajouté ou modifié doit être fait en FR ET en EN.
// - Texte statique (HTML) : data-i18n="cle" sur l'élément + clé correspondante
//   ajoutée dans I18N_EN ci-dessous.
// - Texte dynamique (généré en JS dans une fonction render*) : pas de
//   data-i18n possible, il faut brancher soi-même sur `currentLang === 'en'`.
// Voir l'explication complète en tout début de fichier (avant <html>).
// ============================================================
// ---------- Traduction (FR par défaut, EN en option) ----------
// Principe : le HTML reste écrit en français nativement. On capture le texte
// français d'origine de chaque élément marqué [data-i18n] au premier passage
// (dataset.frOriginal), puis on bascule vers le dictionnaire anglais ou on
// restaure l'original selon la langue choisie. Les fonctions de rendu dynamique
// (donjons, boss, coffres...) consultent `currentLang` directement pour générer
// leurs textes dans la bonne langue dès leur création.
let currentLang = 'fr';

const I18N_EN = {
  // Barre d'onglets
  tab_creature: 'My Creature',
  tab_play: 'Play',
  tab_quests: '✨ Quests',
  tab_training: 'Training',
  tab_treasure: 'Treasure Hunt',
  tab_dungeon: 'Dungeons',
  tab_boss: 'World Boss',
  tab_rewards: 'Rewards',
  tab_battlepass: 'Season Pass',
  tab_chests: 'Chests',
  tab_shop: 'Shop',
  tab_codexgroup: 'Codex',
  tab_codex: 'Compendium',
  tab_lore: 'Lore',
  tab_howto: 'How to Play?',
  tab_logout: '🚪 Log out',

  // Titres de section
  h2_welcome: 'Welcome to Moltchi',
  h2_gamemodes: 'Game modes',
  h2_wellbeing_stats: 'Wellbeing stats',
  h2_combat_stats: 'Combat stats',
  h2_boss_weekly_ranking: '🐉 World Boss weekly ranking',
  h2_choose_moltchi: 'Choose your Moltchi',
  h2_backpack: 'Backpack',
  h2_recovery_code: '🔑 Recovery code',
  h2_danger_zone: 'Danger zone',
  h2_training: 'Active training',
  h2_wyrm_tower: 'Wyrm Tower',
  h2_corrupt_locked: '🔒 Corrupt Sanctuary',
  h2_corrupt: 'Corrupt Sanctuary',
  h2_pending_rewards: '🎁 Last week\'s rewards',
  h2_contributors: 'Contributors ranking',
  h2_codex_title: 'Compendium',
  h2_daily_quests: 'Daily quests',
  h2_weekly_quests: 'Weekly quests',
  h2_reward_tiers: 'Reward tiers',
  h2_chests: '🎁 Chests',
  h2_shop: '🏪 Shop',
  h2_treasure_hunt: 'Treasure hunt',
  h2_lore_title: '✦ The Moltyx — bestiary legend',
  h2_lore_goal: 'The goal: collect them all',

  // Boutons principaux
  btn_feed: 'Feed',
  btn_play: 'Play',
  btn_sleep: 'Sleep',
  btn_attack: '⚔️ Attack',
  btn_climb: '⚔️ Try the floor',
  btn_climb_corrupt: '☠️ Try the floor',
  btn_claim_boss_rewards: 'Claim everything',

  // Intro et pseudo
  p_welcome_intro: 'An old-school pocket-pet RPG: hatch your creature, train it, explore dungeons and join forces with every other player to take down a shared World Boss. Collect rare items, including the coveted unique Moltyx.',
  p_restore_hint: 'Already have a Moltchi on another device? Restore your progress before continuing.',

  // Modes de jeu
  p_mode_creature: '🥚 <strong>Creature</strong> — feed, play with and let your Moltchi sleep. The better cared for it is, the stronger it fights.',
  p_mode_training: '🎮 <strong>Training</strong> — 4 quick minigames to build up its combat stats.',
  p_mode_dungeon: '🏰 <strong>Dungeon</strong> — climb the floors one by one, earn XP and items.',
  p_mode_treasure: '🗺️ <strong>Treasure Hunt</strong> — dig for Moltcoins 🪙 and, with a bit of luck, a rare item.',
  p_mode_boss: '🐉 <strong>World Boss</strong> — a giant boss to fight together, everyone at their own pace.',

  // Formules et tableaux (joueurs avancés)
  summary_formulas: 'Formuls and details (for advanced players)',
  th_stat: 'Stat',
  th_role: 'Role',
  th_combat_impact: 'Combat impact',
  th_gained_via: 'Gained via',
  th_boss_impact: 'World Boss impact',
  th_dungeon_impact: 'Dungeon impact',
  td_hunger: 'Hunger',
  td_hunger_desc: 'Drops over time <strong>and with every training session</strong> (-3), restored by feeding',
  td_wellbeing_desc: 'The average of the 3 forms <strong>Wellbeing</strong> (0-100%), which multiplies your Boss damage and your Dungeon Power. A neglected Moltchi hits and takes much less — but never dies.',
  td_joy: 'Joy',
  td_joy_desc: 'Drops over time <strong>and with every Dungeon attempt</strong> (-4), restored by playing',
  td_energy: 'Energy',
  td_energy_desc: 'Drops while playing <strong>and with every World Boss attack</strong> (-6), restored by sleeping',
  td_minigame_reflex: 'Reflex minigame',
  td_minigame_memory: 'Memory minigame',
  td_minigame_rhythm: 'Rhythm minigame',
  td_minigame_arcane: 'Arcane minigame',
  td_crit_boss: 'Increases damage against the Boss',
  td_speed_boss: 'Increases damage against the Boss',
  td_stamina_boss: 'Increases damage against the Boss',
  td_magic_boss: 'Increases damage against the Boss',
  td_increases_power: 'Increases Power',
  p_formulas_simplified: 'Simplified formulas:',
  p_formula_boss_damage: '<strong>Boss Damage</strong> = (Crit (Fire) + Magic (Water) + Endurance (Earth) + Speed (Wind)) × Wellbeing — same principle as Dungeon Power. The final result varies slightly on each attack (±15%) to keep things suspenseful.',
  p_formula_dungeon_power: '<strong>Dungeon Power</strong> = (Level + Crit (Fire) + Speed (Wind) + Endurance (Earth) + Magic (Water)) × Wellbeing. Each Dungeon floor requires more Power (roughly +5% per floor — same principle for both the Wyrm Tower and the Corrupt Sanctuary, which restarts from the Tower\'s floor-100 challenge level, with much stronger items to compensate for the new scale).',
  p_daily_actions_summary: '5 care actions per day (Feed/Play/Sleep combined) · 8 training attempts per day total, to spend however you like.',
  p_boss_ranking_reset: 'The ranking resets every week. Your rank at reset time determines your reward.',
  p_worldshard_chance: 'The chance to obtain the World Shard only applies if the Boss was defeated at least once during the week.',

  // Divers
  p_no_inspiration: 'No inspiration? Let luck choose for you.',
  p_recovery_code_hint: 'Already have a Moltchi on another device? Restore your progress before continuing.',
  p_abandon_warning: 'Abandoning your Moltchi deletes it <strong>permanently</strong>: level, stats, inventory, species, everything resets to zero. You\'ll start over with a species choice, just like on first launch. Your username and the World Boss are not affected.',
  p_boss_reset_weekly: 'Resets every week. Rewards based on rank at reset time.',
  p_quests_reset_daily: 'Reset every day at midnight UTC (same slot as the World Boss). Points earned feed the Season Pass.',
  p_quests_reset_weekly: 'Reset every Monday at midnight UTC (same slot as the World Boss). Points earned feed the Season Pass.',
  p_chests_intro: 'Open up to <strong>3 chests per day</strong> by watching a short ad. Each chest grants Moltcoins 🪙, with a chance of a consumable candy or even a very rare Moltyx.',
  p_chests_reset: 'Reset every day',
  p_shop_intro: 'A different legendary item from each dungeon, on sale this week only — one purchase per player per week, for each.',
  p_shop_reset: 'Refreshes every week',
  h2_shop_premium: '✦ Shard of the Negotiator',
  p_shop_premium_desc: 'An exclusive Moltyx, purchasable once per account. Once equipped, it lowers the Moltcoin price of all Shop items by <strong>-25%</strong>.',
  p_shop_premium_soon: 'Real-money purchase — coming soon.',
  btn_shop_premium_buy: 'Buy (coming soon)',
  p_treasure_intro: 'Spend <strong>action points</strong> to dig and collect <strong>Moltcoins</strong> 🪙, Moltchi\'s currency. Very rare digs can also reveal a Compendium item.',
  p_lore_1: '"Before the Moltchi hatched, before even the Wyrm Tower, the world was but a single heart of moss, ivory and amber. When that heart shattered, its shards scattered — into the deepest corners of the Tower, into the ashes of the World Boss, beneath the ground dug up by treasure hunters. Today they are called the Moltyx."',
  p_lore_2: 'Each Moltyx is a unique fragment of that original heart — only one copy of each can ever exist per player, and each carries its own powerful, permanent ability. Unlike ordinary Compendium items, a Moltyx is never replaced: once found, it\'s yours forever.',
  p_lore_3: 'Moltchi\'s true achievement isn\'t climbing the most floors or beating the World Boss — it\'s <strong>finding every Moltyx scattered across the world</strong>, one by one, wherever they hide: in Treasure Hunt digs, at the top of the Wyrm Tower, or perhaps elsewhere still. The Compendium tracks the ones you\'ve already gathered, and the ones still missing.',
  p_lore_4: 'New Moltyx and new sources will appear as the game keeps developing.',
  p_codex_intro: 'The Compendium lists every known Moltchi item — common, rare, epic, legendary — as well as the unique Moltyx.',
  footer_rights: 'All rights reserved.',
  footer_terms: 'Terms of Service & Sale',
};

async function loadLanguage(){
  try{ const r = await window.storage.get('language', false); return r.value; }
  catch(e){ return 'fr'; }
}
async function saveLanguage(lang){ try{ await performAction('set_language', { lang }); }catch(e){console.error(e);} }

function applyLanguage(lang){
  currentLang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if(el.dataset.frOriginal === undefined) el.dataset.frOriginal = el.innerHTML;
    if(lang === 'en' && I18N_EN[key] !== undefined){
      el.innerHTML = I18N_EN[key];
    } else {
      el.innerHTML = el.dataset.frOriginal;
    }
  });
  document.documentElement.lang = lang;
  $('lang-btn-fr').style.background = lang === 'fr' ? 'var(--gold)' : 'transparent';
  $('lang-btn-fr').style.color = lang === 'fr' ? 'var(--moss-950)' : 'var(--ivory-dim)';
  $('lang-btn-en').style.background = lang === 'en' ? 'var(--gold)' : 'transparent';
  $('lang-btn-en').style.color = lang === 'en' ? 'var(--moss-950)' : 'var(--ivory-dim)';
  // Redéclenche le rendu des panneaux dynamiques pour qu'ils se régénèrent dans la
  // nouvelle langue (les textes générés en JS consultent `currentLang` eux-mêmes).
  if(typeof creature !== 'undefined' && creature) renderCreature(creature);
}

// ============================================================
// ============ CGU (Conditions Générales d'Utilisation) ============
// Contenu bilingue, injecté dans la modale à l'ouverture selon currentLang.
// Reste synchronisé avec l'état réel du jeu : pas de compte email/mot de passe
// (juste un code de récupération), Moltcoins sans valeur monétaire actuelle,
// publicités Monetag pour les Coffres, chat communautaire modéré, jeu en
// développement continu (contenu et équilibrage peuvent changer).
// ============================================================
const TERMS_CONTENT_FR = `
  <h2>Conditions Générales d'Utilisation</h2>
  <p class="terms-updated">Dernière mise à jour : 2026</p>

  <h3>1. Objet</h3>
  <p>Moltchi est un jeu web gratuit d'élevage de créature (RPG façon jeu de poche), avec un Boss Mondial partagé entre tous les joueurs. Il est actuellement développé et maintenu par un développeur indépendant. En jouant à Moltchi, tu acceptes les présentes conditions.</p>

  <h3>2. Accès et compte</h3>
  <p>Aucune inscription par e-mail ou mot de passe n'est requise. Ta progression est associée à un identifiant technique généré automatiquement sur ton appareil, récupérable via un <strong>code de récupération</strong> personnel que tu dois conserver toi-même. La perte de ce code peut entraîner la perte définitive de ta progression — le jeu ne peut pas la retrouver à ta place.</p>

  <h3>3. Contenu du jeu et monnaies virtuelles</h3>
  <p>Les Moltcoins 🪙, objets, Moltyx et autres éléments obtenus en jeu n'ont <strong>aucune valeur monétaire réelle</strong>, ne sont ni échangeables ni remboursables, et n'existent que dans le cadre du jeu. Le jeu reste gratuit à l'accès et à la progression. Un achat réel optionnel est proposé : le déblocage de la voie Premium du Pass Saisonnier (2,99 €, paiement unique, taxes comprises), traité par notre prestataire de paiement Stripe. Cet achat donne accès à des récompenses supplémentaires du Pass Saisonnier ; il n'est jamais nécessaire pour jouer ou progresser dans le jeu de base. Voir les Conditions Générales de Vente ci-dessous pour le détail de cet achat (prix, paiement, livraison, droit de rétractation).</p>

  <h3>4. Publicité</h3>
  <p>Certaines fonctionnalités (comme les Coffres quotidiens) sont financées par des publicités tierces (réseau Monetag). En les utilisant, tu acceptes l'affichage de ces publicités, régies par les politiques de confidentialité de ces prestataires tiers.</p>

  <h3>5. Communauté et tchat</h3>
  <p>Le tchat mondial est un espace partagé entre tous les joueurs. Les messages contraires à la loi, injurieux, discriminatoires ou nuisibles peuvent être filtrés ou supprimés. Un comportement abusif répété peut entraîner une restriction d'accès à cette fonctionnalité.</p>

  <h3>6. Évolution du jeu</h3>
  <p>Moltchi est en développement continu. Les fonctionnalités, l'équilibrage des stats et formules, les taux de récompense, et le contenu du jeu peuvent être modifiés, ajoutés ou retirés à tout moment, sans préavis, y compris si cela affecte une progression déjà en cours.</p>

  <h3>7. Disponibilité du service</h3>
  <p>Le jeu est fourni "en l'état", sans garantie de disponibilité continue. Des interruptions, maintenances ou pertes de données peuvent survenir. Le développeur s'efforce d'en limiter la fréquence et l'impact, sans garantie absolue.</p>

  <h3>8. Propriété intellectuelle</h3>
  <p>L'ensemble des éléments du jeu (noms, univers, mécaniques, textes, visuels) est la propriété de son développeur, sauf mention contraire. Toute reproduction ou exploitation commerciale non autorisée est interdite.</p>

  <h3>9. Âge et responsabilité</h3>
  <p>Ce jeu s'adresse à un public général. Si tu es mineur, assure-toi d'avoir l'accord d'un parent ou tuteur pour jouer, notamment concernant l'affichage de publicités tierces.</p>

  <h3>10. Modification des CGU</h3>
  <p>Ces conditions peuvent être mises à jour à mesure que le jeu évolue. La poursuite de l'utilisation du jeu après une mise à jour vaut acceptation des nouvelles conditions.</p>

  <h3>11. Contact</h3>
  <p>Pour toute question relative à ces conditions, écris à <strong>dyggietv@gmail.com</strong>.</p>

  <h2>Conditions Générales de Vente</h2>
  <p class="terms-updated">Applicables à l'achat optionnel du Pass Saisonnier (voie Premium)</p>

  <h3>1. Objet</h3>
  <p>Les présentes conditions régissent l'achat, en euros, du déblocage de la voie Premium du Pass Saisonnier au sein du jeu Moltchi. Elles complètent les Conditions Générales d'Utilisation ci-dessus et s'appliquent spécifiquement à cet achat réel.</p>

  <h3>2. Prix</h3>
  <p>Le prix affiché (2,99 €) est le montant total et définitif payé, toutes taxes comprises, quel que soit le pays de résidence de l'acheteur. Aucun frais supplémentaire ne sera demandé après le paiement pour ce même déblocage.</p>

  <h3>3. Modalités de paiement</h3>
  <p>Le paiement est traité par notre prestataire tiers <strong>Stripe</strong>, qui gère de façon sécurisée les informations de carte bancaire — ces informations ne sont à aucun moment transmises ou stockées par Moltchi. Le paiement est exigible immédiatement à la validation de la commande.</p>

  <h3>4. Livraison</h3>
  <p>Le déblocage de la voie Premium est un contenu numérique livré immédiatement et automatiquement dès la confirmation du paiement par Stripe, sans délai d'expédition physique.</p>

  <h3>5. Droit de rétractation</h3>
  <p>Conformément à la réglementation applicable à la fourniture de contenu numérique non fourni sur un support matériel, tu reconnais qu'en demandant l'exécution immédiate de la livraison dès le paiement, tu renonces expressément à ton droit de rétractation de 14 jours habituellement applicable aux achats à distance.</p>

  <h3>6. Absence de remboursement</h3>
  <p>Sauf disposition légale impérative contraire, ou dysfonctionnement technique avéré empêchant la livraison du contenu acheté, cet achat n'est pas remboursable une fois le déblocage effectué.</p>

  <h3>7. Réclamations et service client</h3>
  <p>Pour toute question, réclamation, ou problème lié à un paiement, écris à <strong>dyggietv@gmail.com</strong> en précisant la date approximative de la transaction.</p>

  <h3>8. Droit applicable</h3>
  <p>Les présentes CGV sont soumises au droit français. En cas de litige, une solution amiable sera recherchée en priorité via l'adresse de contact ci-dessus avant toute autre démarche.</p>
`;

const TERMS_CONTENT_EN = `
  <h2>Terms of Service</h2>
  <p class="terms-updated">Last updated: 2026</p>

  <h3>1. Purpose</h3>
  <p>Moltchi is a free web-based pocket-pet RPG, featuring a World Boss shared by all players. It is currently developed and maintained by an independent developer. By playing Moltchi, you agree to these terms.</p>

  <h3>2. Access and account</h3>
  <p>No email or password registration is required. Your progress is tied to a technical identifier automatically generated on your device, recoverable via a personal <strong>recovery code</strong> that you must keep yourself. Losing this code may result in permanent loss of your progress — the game cannot retrieve it on your behalf.</p>

  <h3>3. Game content and virtual currencies</h3>
  <p>Moltcoins 🪙, items, Moltyx, and other in-game elements have <strong>no real monetary value</strong>, are not exchangeable or refundable, and only exist within the game. The game remains free to access and play. An optional real-money purchase is available: unlocking the Season Pass Premium track (2.99 €, one-time payment, tax included), processed by our payment provider Stripe. This purchase grants access to additional Season Pass rewards; it is never required to play or progress in the base game. See the Terms of Sale below for details on this purchase (price, payment, delivery, right of withdrawal).</p>

  <h3>4. Advertising</h3>
  <p>Some features (such as daily Chests) are funded by third-party advertising (Monetag network). By using them, you accept the display of these ads, governed by the privacy policies of these third-party providers.</p>

  <h3>5. Community and chat</h3>
  <p>The global chat is a space shared by all players. Messages that are unlawful, abusive, discriminatory, or harmful may be filtered or removed. Repeated abusive behavior may result in restricted access to this feature.</p>

  <h3>6. Game evolution</h3>
  <p>Moltchi is under continuous development. Features, stat/formula balancing, reward rates, and game content may be changed, added, or removed at any time, without notice, including when this affects progress already in place.</p>

  <h3>7. Service availability</h3>
  <p>The game is provided "as is", without any guarantee of continuous availability. Interruptions, maintenance, or data loss may occur. The developer strives to limit their frequency and impact, without absolute guarantee.</p>

  <h3>8. Intellectual property</h3>
  <p>All game elements (names, universe, mechanics, text, visuals) are the property of its developer, unless stated otherwise. Any unauthorized reproduction or commercial use is prohibited.</p>

  <h3>9. Age and responsibility</h3>
  <p>This game is intended for a general audience. If you are a minor, make sure you have the consent of a parent or guardian to play, particularly regarding the display of third-party advertising.</p>

  <h3>10. Changes to these Terms</h3>
  <p>These terms may be updated as the game evolves. Continued use of the game after an update constitutes acceptance of the new terms.</p>

  <h3>11. Contact</h3>
  <p>For any questions regarding these terms, email <strong>dyggietv@gmail.com</strong>.</p>

  <h2>Terms of Sale</h2>
  <p class="terms-updated">Applicable to the optional Season Pass (Premium track) purchase</p>

  <h3>1. Purpose</h3>
  <p>These terms govern the purchase, in euros, of the Season Pass Premium track unlock within the Moltchi game. They supplement the Terms of Service above and apply specifically to this real-money purchase.</p>

  <h3>2. Price</h3>
  <p>The displayed price (2.99 €) is the total and final amount paid, tax included, regardless of the buyer's country of residence. No additional fee will be requested after payment for this same unlock.</p>

  <h3>3. Payment terms</h3>
  <p>Payment is processed by our third-party provider <strong>Stripe</strong>, which securely handles card information — this information is never transmitted to or stored by Moltchi. Payment is due immediately upon order confirmation.</p>

  <h3>4. Delivery</h3>
  <p>The Premium track unlock is digital content delivered immediately and automatically upon payment confirmation by Stripe, with no physical shipping delay.</p>

  <h3>5. Right of withdrawal</h3>
  <p>In accordance with regulations applicable to the supply of digital content not provided on a physical medium, you acknowledge that by requesting immediate delivery upon payment, you expressly waive your usual 14-day right of withdrawal normally applicable to distance purchases.</p>

  <h3>6. No refunds</h3>
  <p>Unless otherwise required by mandatory law, or in the event of a proven technical malfunction preventing delivery of the purchased content, this purchase is non-refundable once the unlock has been granted.</p>

  <h3>7. Complaints and customer support</h3>
  <p>For any question, complaint, or payment-related issue, email <strong>dyggietv@gmail.com</strong>, indicating the approximate date of the transaction.</p>

  <h3>8. Governing law</h3>
  <p>These Terms of Sale are governed by French law. In the event of a dispute, an amicable solution will be sought first via the contact address above before any other action.</p>
`;

function openTermsModal(){
  $('terms-modal-content').innerHTML = currentLang === 'en' ? TERMS_CONTENT_EN : TERMS_CONTENT_FR;
  $('terms-modal-overlay').style.display = 'flex';
}
function closeTermsModal(){
  $('terms-modal-overlay').style.display = 'none';
}


$('lang-btn-fr').onclick = async () => { await saveLanguage('fr'); applyLanguage('fr'); };
$('lang-btn-en').onclick = async () => { await saveLanguage('en'); applyLanguage('en'); };

$('btn-open-terms').onclick = openTermsModal;
$('btn-close-terms').onclick = closeTermsModal;
$('terms-modal-overlay').onclick = (e) => { if(e.target.id === 'terms-modal-overlay') closeTermsModal(); };

// ---------- Musique d'ambiance (vrai fichier audio, "Moonberry Tower") ----------
// Stratégie de lecture automatique : on tente de démarrer le son directement au
// chargement. La plupart des navigateurs bloquent l'autoplay avec son tant que le
// visiteur n'a pas interagi avec la page ; dans ce cas, on écoute le tout premier
// geste utilisateur (clic, touche, tap) n'importe où sur la page pour démarrer la
// musique à ce moment-là — un seul écouteur, retiré après le premier déclenchement.
const bgMusic = $('bg-music');
bgMusic.volume = 0.5;
let musicPreferenceOff = false; // true seulement si le joueur a explicitement coupé le son

function updateMusicButton(){
  $('music-toggle-btn').textContent = (!bgMusic.paused && !musicPreferenceOff) ? '🔊' : '🔇';
}

// ---------- Secours unique "premier geste utilisateur" (musique + vidéos de portrait) ----------
// Un seul jeu d'écouteurs document, posé une fois pour toutes, plutôt qu'un nouveau
// jeu à chaque rendu (ce qui empilait des dizaines d'écouteurs concurrents au fil
// des actions et perturbait le déclenchement propre de la musique).
const pendingVideoRetries = new Set();
let firstInteractionListenerActive = false;

function retryOnFirstInteraction(){
  if(firstInteractionListenerActive) return;
  firstInteractionListenerActive = true;
  const handler = () => {
    if(!musicPreferenceOff) bgMusic.play().then(updateMusicButton).catch(()=>{});
    pendingVideoRetries.forEach(vid => { if(vid.isConnected) vid.play().catch(()=>{}); });
    pendingVideoRetries.clear();
    document.removeEventListener('click', handler);
    document.removeEventListener('keydown', handler);
    document.removeEventListener('touchstart', handler);
    firstInteractionListenerActive = false;
  };
  document.addEventListener('click', handler);
  document.addEventListener('keydown', handler);
  document.addEventListener('touchstart', handler);
}

function tryAutoplay(){
  if(musicPreferenceOff) return;
  const p = bgMusic.play();
  if(p && p.catch){
    p.then(() => updateMusicButton()).catch(() => retryOnFirstInteraction());
  }
}

// Lance une vidéo de portrait (créature), avec secours si le navigateur la bloque —
// notamment certaines versions d'iOS qui retardent .play() sur une vidéo <muted>
// tant que le mode silencieux (interrupteur physique) est actif. On l'ajoute à la
// file d'attente partagée plutôt que de poser ses propres écouteurs.
// Cache des vidéos préchargées (par src), pour qu'elles soient déjà en mémoire
// tampon au moment où on en a besoin (ex: l'animation "manger" au clic sur
// Nourrir) plutôt que de les découvrir/télécharger pile à cet instant.
const _preloadedVideoSrcs = new Set();
function preloadVideo(src){
  if(!src || _preloadedVideoSrcs.has(src)) return;
  _preloadedVideoSrcs.add(src);
  const v = document.createElement('video');
  v.src = src; v.preload = 'auto'; v.muted = true; v.playsInline = true;
  v.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
  document.body.appendChild(v);
  v.load();
}
// Fallback icône (emoji) si une vidéo/image de portrait ne charge pas — appelé
// depuis l'attribut onerror inline des <video>/<img> injectés dynamiquement.
function sigilFallbackIcon(el, icon){
  const sigil = document.getElementById('sigil');
  if(!sigil) return;
  sigil.innerHTML = ''; sigil.textContent = icon; delete sigil.dataset.mediaKey;
}
const SIGIL_FADE_MS = 220;
// Remplace le contenu du portrait (#sigil) avec un fondu enchaîné plutôt qu'une
// coupure nette. Évite AUSSI de recréer inutilement la même vidéo à chaque appel
// de renderCreature() (qui tourne après quasi chaque action du joueur) — sans ce
// garde-fou, la vidéo idle repartait de l'image 0 en permanence, même quand rien
// n'avait changé visuellement.
function setSigilContent(mediaKey, html, onReady){
  const sigil = $('sigil');
  if(!sigil) return;
  if(sigil.dataset.mediaKey === mediaKey){
    if(onReady) onReady(sigil.querySelector('video'));
    return; // déjà affiché à l'identique : on ne touche à rien
  }
  sigil.dataset.mediaKey = mediaKey;
  const layer = document.createElement('div');
  layer.className = 'sigil-layer';
  layer.innerHTML = html;
  sigil.appendChild(layer);
  const oldLayers = Array.from(sigil.children).filter(el => el !== layer);
  void layer.offsetWidth; // force le reflow avant de déclencher la transition CSS d'opacité
  layer.classList.add('sigil-layer-active');
  if(onReady) onReady(layer.querySelector('video'));
  setTimeout(() => { oldLayers.forEach(el => el.remove()); }, SIGIL_FADE_MS + 60);
}
function playVideoWithFallback(videoEl){
  if(!videoEl) return;
  const p = videoEl.play();
  if(p && p.catch){
    p.catch(() => {
      pendingVideoRetries.add(videoEl);
      retryOnFirstInteraction();
    });
  }
}

async function toggleMusic(){
  if(bgMusic.paused){
    musicPreferenceOff = false;
    if(bgMusic.volume === 0){
      bgMusic.volume = 0.5;
      $('music-volume').value = '50';
      try{ await window.storage.set('music_volume', '0.5', false); }catch(e){}
    }
    try{ await bgMusic.play(); }catch(e){}
  } else {
    musicPreferenceOff = true;
    bgMusic.pause();
  }
  updateMusicButton();
  try{ await window.storage.set('music_on', String(!musicPreferenceOff), false); }catch(e){}
}
$('music-toggle-btn').onclick = toggleMusic;

$('music-volume').addEventListener('input', async (e) => {
  const vol = Math.max(0, Math.min(100, parseInt(e.target.value, 10))) / 100;
  bgMusic.volume = vol;
  if(vol === 0 && !musicPreferenceOff){
    musicPreferenceOff = true;
    bgMusic.pause();
  } else if(vol > 0 && musicPreferenceOff){
    musicPreferenceOff = false;
    try{ await bgMusic.play(); }catch(err){}
  }
  updateMusicButton();
  try{
    await window.storage.set('music_on', String(!musicPreferenceOff), false);
    await window.storage.set('music_volume', String(vol), false);
  }catch(err){}
});

(async () => {
  try{
    const r = await window.storage.get('music_on', false);
    musicPreferenceOff = (r.value === 'false');
  }catch(e){
    musicPreferenceOff = false; // par défaut : musique activée
  }
  try{
    const rv = await window.storage.get('music_volume', false);
    const vol = Math.max(0, Math.min(1, parseFloat(rv.value)));
    if(!isNaN(vol)){ bgMusic.volume = vol; $('music-volume').value = String(Math.round(vol * 100)); }
  }catch(e){
    // pas de préférence enregistrée : on garde le volume par défaut (0.5) et le curseur à 50
  }
  updateMusicButton();
  tryAutoplay();
})();



document.querySelectorAll('.tab').forEach(tab=>{
  tab.onclick = () => {
    if(tab.classList.contains('locked')) return;
    stopMinigameAmbience();
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-parent').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
    const dropdown = tab.closest('.tab-dropdown');
    if(dropdown){
      const group = dropdown.closest('.tab-group');
      const parent = group.querySelector('.tab-parent');
      if(parent) parent.classList.add('active');
      group.classList.remove('open');
      dropdown.style.transform = '';
    }
  };
});

// Clic sur l'image du titre : retour à l'onglet "Ma créature" (réutilise la même logique
// que les onglets, en simulant un clic sur celui de "creature" plutôt qu'en la dupliquant).
const titleImg = $('game-title-img');
if(titleImg){
  titleImg.onclick = () => {
    if($('main-app').style.display === 'none') return; // pas encore connecté : rien à faire
    const creatureTab = document.querySelector('.tab[data-tab="creature"]');
    if(creatureTab) creatureTab.click();
  };
}

document.querySelectorAll('.tab-parent').forEach(parent=>{
  parent.onclick = (e) => {
    e.stopPropagation();
    const group = parent.closest('.tab-group');
    const wasOpen = group.classList.contains('open');
    document.querySelectorAll('.tab-group').forEach(g=>{
      g.classList.remove('open');
      const dd = g.querySelector('.tab-dropdown');
      if(dd) dd.style.transform = '';
    });
    if(!wasOpen){
      group.classList.add('open');
      const dropdown = group.querySelector('.tab-dropdown');
      requestAnimationFrame(() => {
        const rect = dropdown.getBoundingClientRect();
        const margin = 8;
        let shift = 0;
        if(rect.left < margin) shift = margin - rect.left;
        else if(rect.right > window.innerWidth - margin) shift = (window.innerWidth - margin) - rect.right;
        if(shift !== 0) dropdown.style.transform = `translateX(calc(-50% + ${shift}px))`;
      });
    }
  };
});


// ============================================================
// ============ NAVIGATION (onglets, menus déroulants) ============
// Ouverture/fermeture des menus déroulants, activation de l'onglet
// cliqué, verrouillage de certains onglets tant qu'aucune créature
// n'est éclose (voir LOCKED_WITHOUT_CREATURE juste en dessous).
// ============================================================
document.addEventListener('click', (e) => {
  if(!e.target.closest('.tab-group')){
    document.querySelectorAll('.tab-group').forEach(g=>{
      g.classList.remove('open');
      const dd = g.querySelector('.tab-dropdown');
      if(dd) dd.style.transform = '';
    });
  }
  if(!e.target.closest('#companion-corner-icon')){
    const icon = document.getElementById('companion-corner-icon');
    if(icon) icon.classList.remove('tooltip-open');
  }
});

// Tant qu'aucun Moltchi n'est actif (œuf jamais choisi, ou abandonné), seuls
// "Comment jouer ?" et "Créature" restent accessibles.
const LOCKED_WITHOUT_CREATURE = ['training','dungeon','boss','codex','treasure','battlepass','quests','chests','shop'];
function updateTabAccess(c){
  const hasCreature = !!(c && c.stage > 0);
  document.querySelectorAll('.tab').forEach(tab=>{
    const locked = !hasCreature && LOCKED_WITHOUT_CREATURE.includes(tab.dataset.tab);
    tab.classList.toggle('locked', locked);
  });
  const activeTab = document.querySelector('.tab.active');
  if(activeTab && activeTab.classList.contains('locked')){
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-parent').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    document.querySelector('.tab[data-tab="creature"]').classList.add('active');
    $('panel-creature').classList.add('active');
  }
}

async function getUsername(){
  try{ const r = await window.storage.get('username', false); return r.value; }
  catch(e){ return null; }
}
async function setUsername(name){
  const data = await performAction('set_username', { name });
  return data.username;
}

// Déconnexion : n'efface RIEN côté serveur, retire seulement l'identifiant local
// (moltchi_player_scope) de ce navigateur. La progression reste intacte et
// récupérable via le code de récupération (qui est cet identifiant lui-même).
$('btn-logout').onclick = () => {
  const msg = currentLang === 'en'
    ? 'Log out of this device? Your progress is NOT deleted — you can get back to it anytime with your recovery code (find it in the Danger Zone before logging out if you haven\'t saved it yet). Continue?'
    : 'Se déconnecter de cet appareil ? Ta progression n\'est PAS supprimée — tu pourras la retrouver à tout moment avec ton code de récupération (à copier dans la Zone dangereuse avant de te déconnecter si tu ne l\'as pas encore fait). Continuer ?';
  if(!confirm(msg)) return;
  localStorage.removeItem('moltchi_player_scope');
  location.reload();
};

const SIGILS = {Braisien:'🔥',Ptimousse:'🛡️',Luminel:'💨',Epineombre:'🌑'};

// ============================================================
// ============ DONNÉES DE BASE : CRÉATURE & OBJETS ============
// Sigils par stade, noms tirés au sort, bases d'objets (ITEM_DB
// normal, CORRUPT_ITEM_DB du donjon corrompu, UNIQUE_ITEM_DB des
// Moltyx), et helpers pour retrouver/afficher un objet par ID.
// ============================================================
const STAGE_SIGILS = ['🥚','🐣','🦎','🐉'];
const NAMES = ['Ember','Moss','Thistle','Bramble','Sable','Torgo'];
const RARITY_LABEL = {common:'Commun',rare:'Rare',epic:'Épique',legendary:'Légendaire',unique:'Moltyx (Unique)'};
const RARITY_LABEL_EN = {common:'Common',rare:'Rare',epic:'Epic',legendary:'Legendary',unique:'Moltyx (Unique)'};
// Prix de revente au marchand — les Moltyx (unique) ne se vendent pas, ce sont des objets de collection.
const SELL_PRICE = {common:15, rare:40, epic:100, legendary:250};
function getItemDef(defId, rarity){
  if(rarity === 'unique') return UNIQUE_ITEM_DB.find(d=>d.id===defId);
  return ITEM_DB.find(d=>d.id===defId) || CORRUPT_ITEM_DB.find(d=>d.id===defId);
}
// item : instance en inventaire (avec defId). Retombe sur le nom stocké si la définition est introuvable (objets legacy).
function itemDisplayName(item){
  const def = getItemDef(item.defId, item.rarity);
  if(!def) return item.name;
  return currentLang === 'en' ? (def.name_en || def.name) : def.name;
}

// Base fixe des objets du jeu — aucun nom d'objet n'est généré aléatoirement.
// Un butin tiré en jeu est toujours une instance de l'une de ces 16 entrées.
const ITEM_DB = [
  {id:'griffe_ambre',       name:'Griffe d\'Ambre',            name_en:'Amber Claw',              rarity:'common',    stat:'crit',    value:20,  minFloor:1},
  {id:'ecaille_moussue',    name:'Écaille Moussue',            name_en:'Mossy Scale',             rarity:'common',    stat:'stamina', value:20,  minFloor:1},
  {id:'anneau_de_ronce',    name:'Anneau de Ronce',            name_en:'Bramble Ring',            rarity:'common',    stat:'dodge',   value:20,  minFloor:1},
  {id:'orbe_vacillant',     name:'Orbe Vacillant',             name_en:'Flickering Orb',          rarity:'common',    stat:'magic',   value:20,  minFloor:1},
  {id:'croc_dember',        name:'Croc d\'Ember',              name_en:'Ember Fang',              rarity:'rare',      stat:'crit',    value:55, minFloor:5},
  {id:'carapace_de_mousse', name:'Carapace de Mousse',         name_en:'Mossy Carapace',          rarity:'rare',      stat:'stamina', value:55, minFloor:5},
  {id:'talisman_ombreux',   name:'Talisman Ombreux',           name_en:'Shadow Talisman',         rarity:'rare',      stat:'dodge',   value:55, minFloor:5},
  {id:'sceau_arcane',       name:'Sceau Arcane',               name_en:'Arcane Seal',             rarity:'rare',      stat:'magic',   value:55, minFloor:5},
  {id:'griffe_du_wyrm',     name:'Griffe du Wyrm',             name_en:'Wyrm\'s Claw',            rarity:'epic',      stat:'crit',    value:150, minFloor:15},
  {id:'plaque_antique',     name:'Plaque d\'Endurance Antique',name_en:'Ancient Endurance Plate', rarity:'epic',      stat:'stamina', value:150, minFloor:15},
  {id:'voile_derobade',     name:'Voile de Dérobade',          name_en:'Veil of Evasion',         rarity:'epic',      stat:'dodge',   value:150, minFloor:15},
  {id:'coeur_arcanique',    name:'Cœur Arcanique',             name_en:'Arcane Heart',            rarity:'epic',      stat:'magic',   value:150, minFloor:15},
  {id:'couronne_cendres',   name:'Couronne de Cendres',        name_en:'Crown of Ashes',          rarity:'legendary', stat:'crit',    value:500, minFloor:30},
  {id:'coeur_de_pierre',    name:'Cœur de Pierre Ancien',      name_en:'Ancient Stone Heart',     rarity:'legendary', stat:'stamina', value:500, minFloor:30},
  {id:'ombre_eternelle',    name:'Ombre Éternelle',            name_en:'Eternal Shadow',          rarity:'legendary', stat:'dodge',   value:500, minFloor:30},
  {id:'oeil_du_wyrm',       name:'Œil du Wyrm',                name_en:'Eye of the Wyrm',         rarity:'legendary', stat:'magic',   value:500, minFloor:30},
  {id:'sceptre_wyrm_ancien',name:'Sceptre du Wyrm Ancien',      name_en:'Scepter of the Ancient Wyrm', rarity:'legendary', stat:'crit', value:375, stat2:'magic', value2:125, minFloor:30},
];

// Objets exclusifs au Sanctuaire Corrompu (second donjon, débloqué à l'étage 100+).
// Certains portent une double-stat (un bonus principal + un bonus secondaire plus faible).
// Ces objets ne tombent JAMAIS dans la Tour du Wyrm, et les objets d'ITEM_DB ne tombent
// jamais dans le Sanctuaire — deux pools de butin strictement séparés.
// Valeurs supérieures aux objets de la Tour du Wyrm afin de représenter le contenu
// post-étage 100, mais avec une progression maîtrisée pour éviter une explosion
// trop rapide des statistiques.
// Valeurs recalculées selon une nouvelle échelle :
// ITEM_DB (Wyrm) × ~7 à ×10 selon la rareté,
// avec ajout d'une double-stat représentant environ 30% de la statistique principale.
// Les ratios stat principale/stat secondaire restent conservés.

const CORRUPT_ITEM_DB = [
  {id:'crocs_jumeaux',      name:'Crocs Jumeaux',              name_en:'Twin Fangs',           rarity:'common',    stat:'crit',    value:180,  stat2:'dodge',   value2:60,  minFloor:1},
  {id:'racine_gangrenee',   name:'Racine Gangrenée',            name_en:'Gangrenous Root',      rarity:'common',    stat:'stamina', value:200,  minFloor:1},
  {id:'lentille_trouble',   name:'Lentille Trouble',            name_en:'Clouded Lens',         rarity:'common',    stat:'magic',   value:180,  stat2:'crit',    value2:60,  minFloor:1},
  {id:'griffe_binaire',     name:'Griffe Binaire',              name_en:'Binary Claw',          rarity:'rare',      stat:'crit',    value:400, stat2:'stamina', value2:130,  minFloor:1},
  {id:'carapace_suintante', name:'Carapace Suintante',          name_en:'Oozing Carapace',      rarity:'rare',      stat:'stamina', value:450, minFloor:1},
  {id:'sceau_fracture',     name:'Sceau Fracturé',              name_en:'Fractured Seal',       rarity:'rare',      stat:'magic',   value:400, stat2:'dodge',   value2:130,  minFloor:1},
  {id:'croc_du_corrupteur', name:'Croc du Corrupteur',          name_en:'Corruptor\'s Fang',    rarity:'epic',      stat:'crit',    value:900, stat2:'magic',   value2:300, minFloor:1},
  {id:'plaque_infestee',    name:'Plaque Infestée',             name_en:'Infested Plate',       rarity:'epic',      stat:'stamina', value:1000, stat2:'dodge',   value2:300, minFloor:1},
  {id:'voile_du_neant',     name:'Voile du Néant',              name_en:'Veil of the Void',     rarity:'epic',      stat:'dodge',   value:900, stat2:'crit',    value2:300, minFloor:1},
  {id:'couronne_fletrie',   name:'Couronne Flétrie',            name_en:'Withered Crown',       rarity:'legendary', stat:'crit',    value:2000, stat2:'magic',   value2:650, minFloor:1},
  {id:'coeur_corrompu',     name:'Cœur Corrompu',               name_en:'Corrupted Heart',      rarity:'legendary', stat:'stamina', value:2000, stat2:'dodge',   value2:650, minFloor:1},
  {id:'oeil_du_neant',      name:'Œil du Néant',                name_en:'Eye of the Void',      rarity:'legendary', stat:'magic',   value:2000, stat2:'crit',    value2:650, minFloor:1},
  {id:'couronne_du_vide',   name:'Couronne du Vide',            name_en:'Crown of the Void',    rarity:'legendary', stat:'dodge',   value:2000, minFloor:1},
  {id:'griffe_corrompue',   name:'Griffe Corrompue',            name_en:'Corrupted Claw',       rarity:'legendary', stat:'crit',    value:2000, stat2:'dodge',   value2:650, minFloor:1},
];

// Moltyx — objets UNIQUES, au-delà du légendaire. Un seul exemplaire par joueur,
// bonus puissant et permanent, s'équipent tous en plus des 5 objets normaux.
// Chaque Moltyx a un effet spécial propre (pas un simple bonus de stat).
const UNIQUE_ITEM_DB = [
  {id:'eclat_du_tresor', name:'Eclat du Trésor', name_en:'Shard of Treasure', rarity:'unique',
   description:'+25% de Moltcoins gagnés à chaque fouille', description_en:'+25% Moltcoins earned per search', source:'treasure',
   special:{type:'treasureCoinsPct', amount:25}},
  {id:'eclat_de_ascension', name:'Eclat de l\'Ascension', name_en:'Shard of Ascension', rarity:'unique',
   description:'+20% d\'XP gagnée dans tous les Donjons et -15% de Puissance requise pour passer les étages', description_en:'+20% XP earned in all Dungeons and -15% Power required to clear floors', source:'dungeon',
   special:{type:'dungeonXPPct', amount:20, type2:'dungeonReqReductionPct', amount2:15}},
  {id:'eclat_du_monde', name:'Eclat du Monde', name_en:'Shard of the World', rarity:'unique',
   description:'+20% de dégâts infligés au Boss Mondial.', description_en:'+20% damage dealt to the World Boss.', source:'boss',
   special:{type:'bossDamagePct', amount:20}},
  {id:'eclat_de_cupidite', name:'Eclat de la Cupidité', name_en:'Shard of Greed', rarity:'unique',
   description:'+1 point d\'action maximum en permanence pour la Chasse aux trésors (6 au lieu de 5).', description_en:'+1 permanent max action point for Treasure Hunting (6 instead of 5).', source:'chests',
   special:{type:'treasureApBonus', amount:1}},
  {id:'eclat_de_puissance', name:'Eclat de Puissance', name_en:'Shard of Power', rarity:'unique',
   description:'+25% sur le gain de stat à chaque entraînement réussi (arrondi au supérieur).', description_en:'+25% on the stat gained per successful training session (rounded up).', source:'training',
   special:{type:'statPct', amount:25}},
  {id:'eclat_du_negociateur', name:'Eclat du Négociateur', name_en:'Shard of the Negotiator', rarity:'unique',
   description:'-25% sur le prix Moltcoins des objets de la Boutique.', description_en:'-25% off Moltcoin prices in the Shop.', source:'shop_real_money',
   special:{type:'shopDiscountPct', amount:25}},
];

// image: nom de fichier PNG à placer à côté de index.html (ou chemin complet).
// video: optionnel — nom de fichier MP4 (idéalement sans son, court, en boucle
// fluide) à placer à côté de index.html. S'il est présent, il remplace `image`
// partout (portrait principal ET carte de sélection de race) ; `image` reste
// utile comme référence/fallback si tu veux un jour repasser en statique.
// stage3Video / stage3Image : artwork dédié au stade 3 (Adolescent, niveau 15+).
// Laissés à `null` pour l'instant → tant qu'ils ne sont pas renseignés, le jeu
// retombe automatiquement sur `video`/`image` (l'artwork actuel), donc AUCUN
// changement visuel tant que tu n'as pas fourni de nouveaux fichiers. Il suffira
// de renseigner stage3Video (ou stage3Image) plus tard pour activer le changement
// d'apparence à l'Adolescent, sans toucher au reste du code.
const SPECIES = {
  Braisien: { name:'Braisien', icon:'🔥', video:'media/braisien.mp4', eatVideo:'media/braisien-eat.mp4', playVideo:'media/braisien-play.mp4', sleepVideo:'media/braisien-sleep.mp4', stage3Video:null, stage3Image:null, passiveStat:'crit', passiveLabel:'+20% de gain en Critique (Feu)', passiveLabel_en:'+20% Crit (Fire) gained from training',
    talent:'Instinct féroce — +8% de dégâts infligés au Boss Mondial', talent_en:'Feral Instinct — +8% damage dealt to the World Boss' },
  Ptimousse: { name:'Ptimousse', icon:'🛡️', video:'media/ptimousse.mp4', image:'media/Ptimousse.png', eatVideo:'media/ptimousse-eat.mp4', playVideo:'media/ptimousse-play.mp4',sleepVideo:'media/ptimousse-sleep.mp4', stage3Video:null, stage3Image:null, passiveStat:'stamina', passiveLabel:'+20% de gain en Endurance (Terre)', passiveLabel_en:'+20% Endurance (Earth) gained from training',
    talent:'Carapace — le Bien-être se dégrade 30% plus lentement', talent_en:'Carapace — Wellbeing decays 30% slower' },
  Luminel: { name:'Luminel', icon:'💨', video:'media/luminel.mp4', image:'media/Luminel.png', eatVideo:'media/luminel-eat.mp4', playVideo:'media/luminel-play.mp4', sleepVideo:'media/luminel-sleep.mp4', stage3Video:null, stage3Image:null, passiveStat:'magic', passiveLabel:'+20% de gain en Magie (Eau)', passiveLabel_en:'+20% Magic (Water) gained from training',
    talent:'Souffle d\'aile — 1 attaque supplémentaire contre le Boss Mondial chaque jour', talent_en:'Wingbeat — 1 extra attack against the World Boss every day' },
  Epineombre: { name:'Epineombre', icon:'🌑', video:'media/epineombre.mp4',eatVideo:'media/epineombre-eat.mp4',playVideo:'media/epineombre-play.mp4', sleepVideo:'media/epineombre-sleep.mp4', stage3Video:null, stage3Image:null, passiveStat:'dodge', passiveLabel:'+20% de gain en Vitesse (Vent)', passiveLabel_en:'+20% Speed (Wind) gained from training',
    talent:'Regard voilé — 1 tentative de Donjon supplémentaire chaque jour', talent_en:'Veiled Gaze — 1 extra Dungeon attempt every day' }
};

// Résout le média (vidéo/image) à afficher pour le portrait selon le STADE de la
// créature. Pour l'instant seul le stade 3 (Adolescent) peut avoir un artwork
// dédié (stage3Video/stage3Image) ; s'il n'est pas renseigné, on retombe sur le
// média de base — donc rien ne change tant qu'aucun artwork stade 3 n'a été fourni.
// Facile à étendre plus tard (stage2Video, stage4Video...) sur le même principe.
function getSpeciesMedia(spDef, stage){
  if(!spDef) return {video:null, image:null};
  if(stage >= 3 && (spDef.stage3Video || spDef.stage3Image)){
    return {video: spDef.stage3Video || null, image: spDef.stage3Image || null};
  }
  return {video: spDef.video || null, image: spDef.image || null};
}
// Joue une animation ponctuelle (pas en boucle) sur le portrait — ex: l'animation
// "mange" du Braisien quand on appuie sur Nourrir. Si la race n'a pas d'animation
// dédiée pour cette action (fieldName), ne fait rien (retombe silencieusement sur
// le portrait normal déjà affiché par le dernier renderCreature()). Utilise le
// même système de fondu enchaîné (setSigilContent) que le portrait normal, pour
// qu'il n'y ait pas de coupure ni à l'entrée ni à la sortie de l'animation — et
// la vidéo est déjà préchargée (voir preloadVideo dans renderCreature) donc elle
// démarre instantanément au clic, sans temps de chargement perceptible.
function playActionAnimation(c, fieldName){
  const spDef = SPECIES[c.species];
  const src = spDef && spDef[fieldName];
  if(!src) return;
  preloadVideo(src); // filet de sécurité si jamais le préchargement n'a pas encore eu lieu
  const html = `<video src="${src}" autoplay muted playsinline style="width:100%;height:100%;object-fit:cover;object-position:center 30%;display:block;" onerror="sigilFallbackIcon(this, '${SIGILS[c.species] || STAGE_SIGILS[c.stage]}')"></video>`;
  setSigilContent('action:'+src, html, (vid) => {
    if(!vid) return;
    playVideoWithFallback(vid);
    vid.onended = () => { renderCreature(c); }; // fondu retour vers le portrait normal (idle/stade) via le même mécanisme
  });
}


// ============================================================
// ============ CRÉATURE : ÉTAT PAR DÉFAUT & PERSISTANCE ============
// Structure de données complète d'un Moltchi (defaultCreature),
// PA de trésor, fusion des sauvegardes anciennes (mergeDefaults),
// chargement/sauvegarde, et dégradation des stats de bien-être
// selon le temps réel écoulé (decayForElapsed).
// ============================================================
function defaultCreature(){
  return {
    species: null, name: null, stage: 0, level: 1, xp: 0,
    hunger: 80, joy: 80, energy: 80,
    crit: 0, dodge: 0, stamina: 0, magic: 0, // clés internes conservées pour compat sauvegardes ; noms affichés désormais : crit=Force(Terre), dodge=Vitesse(Vent), stamina=Endurance(Eau), magic=Intelligence(Feu)
    lastTick: Date.now(),
    attacksToday: 0, lastAttackDay: null, contributed: 0,
    trainCounts: {reflex:0, memory:0, rhythm:0, arcane:0}, trainDay: null,
    dungeonFloor: 1, dungeonAttempts: 0, dungeonClears: 0, dungeonDay: null, dungeonFreeRerollUsed: false,
    corruptUnlocked: false, corruptFloor: 1, corruptAttempts: 0, corruptClears: 0, corruptDay: null,
    careDay: null, careUsed: 0,
    chestsDay: null, chestsOpened: 0,
    inventory: [],
    consumables: {},
    moltcoins: 0, treasureAP: 5, treasureAPLastTick: Date.now(), treasureHistory: []
  };
}
const TREASURE_BASE_MAX_AP = 5;
function maxTreasureAP(c){ return TREASURE_BASE_MAX_AP + (equippedSpecialBonus(c).treasureApBonus || 0); }
const TREASURE_AP_REGEN_MS = 60*60*1000; // 1 point par heure
function regenTreasureAP(c){
  const cap = maxTreasureAP(c);
  if(c.treasureAP === undefined) c.treasureAP = cap;
  if(c.treasureAP > cap) c.treasureAP = cap;
  if(c.treasureAPLastTick === undefined) c.treasureAPLastTick = Date.now();
  if(c.treasureAP >= cap){ c.treasureAPLastTick = Date.now(); return; }
  const elapsed = Date.now() - c.treasureAPLastTick;
  const gained = Math.floor(elapsed / TREASURE_AP_REGEN_MS);
  if(gained > 0){
    c.treasureAP = Math.min(cap, c.treasureAP + gained);
    c.treasureAPLastTick += gained * TREASURE_AP_REGEN_MS;
    if(c.treasureAP >= cap) c.treasureAPLastTick = Date.now();
  }
}

function mergeDefaults(c){
  const d = defaultCreature();
  for(const k in d){ if(c[k] === undefined) c[k] = d[k]; }
  if(!c.trainCounts) c.trainCounts = {reflex:0,memory:0,rhythm:0,arcane:0};
  if(c.trainCounts.arcane === undefined) c.trainCounts.arcane = 0;
  return c;
}
async function loadCreature(){
  try{ const r = await window.storage.get('creature', false); return mergeDefaults(JSON.parse(r.value)); }
  catch(e){ return defaultCreature(); } // pas de sauvegarde ici : on évite de créer une ligne en base pour un joueur qui n'a pas encore choisi/éclos son Moltchi (ou qui va restaurer un autre code)
}



// Tous les resets (quotidien ET hebdomadaire) sont désormais alignés sur le même
// créneau UTC que le Boss Mondial (cohérent entre tous les joueurs, quel que soit
// leur fuseau horaire, et avec le serveur qui valide les attaques du Boss).

// ============================================================
// ============ UTILITAIRES DATE / SEMAINE ============
// Clés de jour (todayKey) et de semaine ISO (weekKey) utilisées
// partout pour réinitialiser les compteurs quotidiens/hebdo.
// ============================================================
function todayKey(){ return new Date().toISOString().slice(0,10); }
function mondayStartOf(d){
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay(); // 0=dimanche ... 6=samedi
  const diff = (day === 0 ? -6 : 1 - day); // décalage vers le lundi de cette semaine
  utc.setUTCDate(utc.getUTCDate() + diff);
  return utc;
}
function weekKey(){
  const monday = mondayStartOf(new Date());
  return monday.getUTCFullYear() + '-' + String(monday.getUTCMonth()+1).padStart(2,'0') + '-' + String(monday.getUTCDate()).padStart(2,'0');
}


// ============================================================
// ============ PASS SAISONNIER & QUÊTES ============
// Quêtes quotidiennes/hebdo (BP_DAILY_QUESTS/BP_WEEKLY_QUESTS),
// bonbons consommables (CONSUMABLE_DB), paliers de récompenses
// (BATTLEPASS_TIERS), calcul de saison calendaire (2 mois fixes,
// currentSeasonInfo), progression et rendu du panneau Pass.
// ============================================================
// ---------- Pass Saisonnier ----------
const BP_DAILY_QUESTS = [
  {id:'care',     label:'Soigne ton Moltchi 3 fois (nourrir / jouer / reposer)', label_en:'Care for your Moltchi 3 times (feed / play / rest)',      target:3,  points:15},
  {id:'train',    label:'Réalise 3 entraînements',                              label_en:'Complete 3 training sessions',                            target:3,  points:15},
  {id:'dungeon',  label:'Tente 2 étages du Donjon',                             label_en:'Attempt 2 Dungeon floors',                                target:2,  points:20},
  {id:'boss',     label:'Attaque le Boss Mondial 1 fois',                       label_en:'Attack the World Boss 1 time',                            target:1,  points:15},
  {id:'treasure', label:'Fais 1 fouille de trésor',                            label_en:'Do 1 treasure search',                                    target:1,  points:10},
];
const BP_WEEKLY_QUESTS = [
  {id:'care',     label:'Soigne ton Moltchi 15 fois',        label_en:'Care for your Moltchi 15 times',    target:15, points:60},
  {id:'train',    label:'Réalise 20 entraînements',          label_en:'Complete 20 training sessions',     target:20, points:60},
  {id:'dungeon',  label:'Tente 20 étages du Donjon',         label_en:'Attempt 20 Dungeon floors',         target:20, points:80},
  {id:'boss',     label:'Attaque le Boss Mondial 10 fois',   label_en:'Attack the World Boss 10 times',    target:10, points:80},
  {id:'treasure', label:'Fais 50 fouilles de trésor',        label_en:'Do 50 treasure searches',           target:50, points:50},
];
// 20 paliers — récompense gratuite ET récompense premium à chaque palier.
// Les objets référencent la base ITEM_DB existante (aucun objet n'est inventé à la volée).
// Bonbons consommables — récupérables via le Pass Premium, utilisables depuis le Sac à dos.
// Chaque bonbon restaure une quantité de tentatives/PA du jour même (plafonnée aux maximums existants).
const CONSUMABLE_DB = [
  {id:'candy_dungeon',  name:'Bonbon des Marcheurs', name_en:'Walker\'s Candy', icon:'🍬', key:'dungeon',  restore:3, desc:'Restaure 3 tentatives de Donjon', desc_en:'Restores 3 Dungeon attempts'},
  {id:'candy_boss',     name:'Bonbon Rugissant',     name_en:'Roaring Candy',  icon:'🍭', key:'boss',     restore:2, desc:'Restaure 2 attaques contre le Boss Mondial', desc_en:'Restores 2 attacks against the World Boss'},
  {id:'candy_treasure', name:'Bonbon Doré',          name_en:'Golden Candy',  icon:'🍯', key:'treasure', restore:3, desc:'Restaure 3 Points d\'Action de fouille', desc_en:'Restores 3 Treasure Hunt Action Points'},
  {id:'candy_training', name:'Bonbon Vif',           name_en:'Quick Candy',   icon:'🍥', key:'training', restore:4, desc:'Restaure 4 essais d\'entraînement', desc_en:'Restores 4 training attempts'},
];
function consumeCandy(c, defId){
  const def = CONSUMABLE_DB.find(x=>x.id===defId);
  if(!def) return false;
  if(!c.consumables || !c.consumables[defId] || c.consumables[defId] <= 0) return false;
  c.consumables[defId] -= 1;
  if(def.key === 'dungeon'){
    if(c.dungeonDay !== todayKey()){ c.dungeonDay = todayKey(); c.dungeonAttempts = 0; }
    c.dungeonAttempts = Math.max(0, c.dungeonAttempts - def.restore);
  } else if(def.key === 'boss'){
    if(c.lastAttackDay !== todayKey()){ c.lastAttackDay = todayKey(); c.attacksToday = 0; }
    c.attacksToday = Math.max(0, c.attacksToday - def.restore);
  } else if(def.key === 'treasure'){
    c.treasureAP = Math.min(maxTreasureAP(c), (c.treasureAP||0) + def.restore);
  } else if(def.key === 'training'){
    if(c.trainDay !== todayKey()){ c.trainDay = todayKey(); c.trainCounts = {reflex:0,memory:0,rhythm:0,arcane:0}; }
    let remain = def.restore;
    const games = ['reflex','memory','rhythm','arcane'];
    while(remain > 0){
      const gk = games.reduce((a,b)=> (c.trainCounts[b]||0) > (c.trainCounts[a]||0) ? b : a);
      if((c.trainCounts[gk]||0) <= 0) break;
      c.trainCounts[gk] -= 1; remain -= 1;
    }
  }
  return true;
}

// Montants Moltcoins calibrés sur BP_PREMIUM_COST_MOLTCOINS (voir calcul dans le chat) :
// somme des gains gratuits = 375 (1/4 du prix), somme des gains premium = 750 (2/4 du prix),
// total = 1125 (3/4 du prix) — le pass ne se rembourse jamais entièrement en Moltcoins.
// Les paliers premium qui donnaient un équipement donnent désormais des bonbons consommables
// (quantités croissantes au fil des paliers, réparties entre les 4 types).
const BATTLEPASS_TIERS = [
  {tier:1,  xp:100,  free:{type:'coins',amount:15},                  premium:{type:'coins',amount:35}},
  {tier:2,  xp:220,  free:{type:'coins',amount:15},                  premium:{type:'consumable',consumableId:'candy_dungeon',qty:2}},
  {tier:3,  xp:360,  free:null,                                     premium:{type:'coins',amount:40}},
  {tier:4,  xp:520,  free:{type:'coins',amount:15},                  premium:{type:'consumable',consumableId:'candy_boss',qty:2}},
  {tier:5,  xp:700,  free:null,                                     premium:{type:'coins',amount:50}},
  {tier:6,  xp:900,  free:{type:'coins',amount:20},                  premium:{type:'consumable',consumableId:'candy_treasure',qty:2}},
  {tier:7,  xp:1120, free:{type:'coins',amount:20},                  premium:{type:'consumable',consumableId:'candy_training',qty:2}},
  {tier:8,  xp:1360, free:null,                                     premium:{type:'coins',amount:60}},
  {tier:9,  xp:1620, free:{type:'coins',amount:25},                  premium:{type:'consumable',consumableId:'candy_dungeon',qty:4}},
  {tier:10, xp:1900, free:null,                                     premium:{type:'coins',amount:75}},
  {tier:11, xp:2200, free:{type:'coins',amount:25},                  premium:{type:'consumable',consumableId:'candy_boss',qty:4}},
  {tier:12, xp:2520, free:{type:'coins',amount:25},                  premium:{type:'consumable',consumableId:'candy_treasure',qty:4}},
  {tier:13, xp:2860, free:null,                                     premium:{type:'coins',amount:85}},
  {tier:14, xp:3220, free:{type:'coins',amount:30},                  premium:{type:'coins',amount:100}},
  {tier:15, xp:3600, free:null,                                     premium:{type:'consumable',consumableId:'candy_training',qty:4}},
  {tier:16, xp:4000, free:{type:'coins',amount:35},                  premium:{type:'consumable',consumableId:'candy_dungeon',qty:6}},
  {tier:17, xp:4420, free:{type:'coins',amount:35},                  premium:{type:'consumable',consumableId:'candy_boss',qty:6}},
  {tier:18, xp:4860, free:null,                                     premium:{type:'consumable',consumableId:'candy_training',qty:6}},
  {tier:19, xp:5320, free:{type:'coins',amount:45},                  premium:{type:'consumable',consumableId:'candy_treasure',qty:6}},
  {tier:20, xp:5800, free:{type:'coins',amount:70},                  premium:{type:'coins',amount:190}},
];
// Prix calculé pour ne pas être trivialement accessible : voir calcul dans le chat
// (~125-190 Moltcoins/jour pour un joueur engagé qui vide sa barre de PA 2-3x/jour,
// ~60 Moltcoins/jour pour un joueur casual à 1 visite/jour) → 1500 = ~24 jours en casual, ~8-12 jours en engagé.
const BP_PREMIUM_COST_MOLTCOINS = 3000;


const BP_SEASON_LABELS = ['Janv-Fév','Mars-Avril','Mai-Juin','Juil-Août','Sept-Oct','Nov-Déc'];
// Saison calée sur le calendrier mondial : blocs fixes de 2 mois (Janv-Fév, Mars-Avril, ...),
// identique pour tout le monde au même moment, quel que soit le jour où chacun a commencé à jouer.
function currentSeasonInfo(){
  const now = new Date();
  const year = now.getFullYear();
  const blockIndex = Math.floor(now.getMonth()/2); // 0 à 5
  const startMonth = blockIndex*2;
  const seasonStart = new Date(year, startMonth, 1, 0,0,0,0).getTime();
  const seasonEnd = new Date(year, startMonth+2, 1, 0,0,0,0).getTime();
  return { seasonKey: `${year}-${blockIndex}`, label: `${BP_SEASON_LABELS[blockIndex]} ${year}`, seasonStart, seasonEnd };
}
function defaultBattlepass(){
  const info = currentSeasonInfo();
  return { seasonKey: info.seasonKey,
    xp:0, premiumUnlocked:false, claimedFree:[], claimedPremium:[],
    dailyDay:null, dailyProgress:{}, dailyCompleted:[],
    weekKey:null, weeklyProgress:{}, weeklyCompleted:[] };
}
function ensureBattlepass(c){
  if(!c.battlepass) c.battlepass = defaultBattlepass();
  const info = currentSeasonInfo();
  // Nouveau bloc calendaire de 2 mois détecté (Janv-Fév → Mars-Avril, etc.) : nouvelle saison pour tout le monde —
  // le Pass Premium ne se reporte pas d'une saison à l'autre (comme la plupart des battle pass).
  if(c.battlepass.seasonKey !== info.seasonKey){
    c.battlepass = defaultBattlepass();
  }
  const bp = c.battlepass;
  if(bp.dailyDay !== todayKey()){ bp.dailyDay = todayKey(); bp.dailyProgress = {}; bp.dailyCompleted = []; }
  if(bp.weekKey !== weekKey()){ bp.weekKey = weekKey(); bp.weeklyProgress = {}; bp.weeklyCompleted = []; }
  return bp;
}
// Appelée depuis les actions du jeu (soin, entraînement, donjon, boss, trésor) pour faire progresser les quêtes.
function bpTrack(c, key, amount=1){
  const bp = ensureBattlepass(c);
  bp.dailyProgress[key] = (bp.dailyProgress[key]||0) + amount;
  bp.weeklyProgress[key] = (bp.weeklyProgress[key]||0) + amount;
  const dq = BP_DAILY_QUESTS.find(q=>q.id===key);
  if(dq && !bp.dailyCompleted.includes(key) && bp.dailyProgress[key] >= dq.target){
    bp.dailyCompleted.push(key); bp.xp += dq.points;
  }
  const wq = BP_WEEKLY_QUESTS.find(q=>q.id===key);
  if(wq && !bp.weeklyCompleted.includes(key) && bp.weeklyProgress[key] >= wq.target){
    bp.weeklyCompleted.push(key); bp.xp += wq.points;
  }
}
function bpCurrentTier(xp){
  let tier = 0;
  for(const t of BATTLEPASS_TIERS){ if(xp >= t.xp) tier = t.tier; else break; }
  return tier;
}
function bpGrantReward(c, reward){
  if(reward.type === 'coins'){ c.moltcoins = (c.moltcoins||0) + reward.amount; return `+${reward.amount} Moltcoins 🪙`; }
  if(reward.type === 'consumable'){
    const def = CONSUMABLE_DB.find(x=>x.id===reward.consumableId);
    if(!def) return '';
    if(!c.consumables) c.consumables = {};
    c.consumables[def.id] = (c.consumables[def.id]||0) + (reward.qty||1);
    return `${reward.qty||1}× ${def.icon} ${currentLang==='en' ? (def.name_en||def.name) : def.name}`;
  }
  const def = ITEM_DB.find(i=>i.id===reward.itemId);
  if(!def) return '';
  const uid = 'item_' + Date.now() + '_' + Math.floor(Math.random()*10000);
  c.inventory.push({id:uid, defId:def.id, name:def.name, rarity:def.rarity, stat:def.stat, value:def.value, equipped:false});
  const rLabel = currentLang==='en' ? RARITY_LABEL_EN : RARITY_LABEL;
  return `${currentLang==='en' ? (def.name_en||def.name) : def.name} (${rLabel[def.rarity]})`;
}
// Pastille rouge Pass Saisonnier : vrai si au moins une récompense de palier
// atteint reste à réclamer. Extrait en fonction réutilisable pour que le
// panneau Coffres puisse aussi en tenir compte dans la pastille "Récompenses".
function battlepassHasClaimable(c){
  const bp = ensureBattlepass(c);
  return BATTLEPASS_TIERS.some(t => {
    if(bp.xp < t.xp) return false;
    const freeClaimable = t.free && !bp.claimedFree.includes(t.tier);
    const premiumClaimable = t.premium && bp.premiumUnlocked && !bp.claimedPremium.includes(t.tier);
    return freeClaimable || premiumClaimable;
  });
}
function renderBattlepass(c){
  if(c.stage === 0) return;
  const bp = ensureBattlepass(c);
  const seasonWord = currentLang === 'en' ? 'Season Pass' : 'Pass Saisonnier';
  $('bp-season-title').textContent = `🎟️ ${seasonWord} — ${currentSeasonInfo().label}`;
  const msLeft = Math.max(0, currentSeasonInfo().seasonEnd - Date.now());
  const daysLeft = Math.ceil(msLeft / (24*60*60*1000));
  $('bp-season-countdown').textContent = currentLang === 'en'
    ? `Ends in ${daysLeft} day${daysLeft>1?'s':''}`
    : `Se termine dans ${daysLeft} jour${daysLeft>1?'s':''}`;
  const tierNow = bpCurrentTier(bp.xp);
  const maxTier = BATTLEPASS_TIERS[BATTLEPASS_TIERS.length-1].tier;
  $('bp-tier-num').textContent = tierNow;
  $('bp-tier-max').textContent = maxTier;
  const tierWord = $('bp-tier-current-label');
  if(tierWord) tierWord.textContent = currentLang === 'en' ? 'Tier' : 'Palier';
  const prevThreshold = tierNow === 0 ? 0 : BATTLEPASS_TIERS[tierNow-1].xp;
  const nextTierDef = BATTLEPASS_TIERS[tierNow];
  const nextThreshold = nextTierDef ? nextTierDef.xp : prevThreshold;
  const span = Math.max(1, nextThreshold - prevThreshold);
  const pct = nextTierDef ? Math.min(100, Math.round(((bp.xp - prevThreshold)/span)*100)) : 100;
  $('bp-xp-bar').style.width = pct + '%';
  $('bp-xp-text').textContent = nextTierDef
    ? `${bp.xp} / ${nextThreshold} pts`
    : (currentLang === 'en' ? `${bp.xp} pts — max tier reached` : `${bp.xp} pts — palier maximum atteint`);

  // Pastille rouge si au moins une récompense de palier atteint reste à réclamer
  const hasClaimable = battlepassHasClaimable(c);
  const dotHTML = '<span class="notif-dot"></span>';
  const battlepassLabel = currentLang === 'en' ? (I18N_EN.tab_battlepass || 'Season Pass') : 'Pass Saisonnier';
  $('battlepass-tab').innerHTML = battlepassLabel + (hasClaimable ? dotHTML : '');
  // Note : la pastille du menu parent "Récompenses" est gérée par renderChestsPanel
  // (appelé juste après), qui combine ce statut avec celui des Coffres.

  const actions = $('bp-premium-actions');
  if(bp.premiumUnlocked){
    $('bp-premium-sub').textContent = currentLang === 'en'
      ? 'Premium track unlocked — enjoy all its rewards at every tier.'
      : 'Voie Premium débloquée — profite de toutes ses récompenses à chaque palier.';
    actions.innerHTML = `<span style="color:#4ea88a;font-family:var(--font-mono);font-size:12px;">✓ ${currentLang==='en'?'Unlocked':'Débloqué'}</span>`;
  } else {
    $('bp-premium-sub').textContent = '';
    actions.innerHTML = `<button id="btn-bp-buy-money">💳 ${currentLang==='en'?'Unlock for':'Débloquer pour'} 2,99 €</button>`;
    $('btn-bp-buy-money').onclick = async () => {
      const btn = $('btn-bp-buy-money');
      btn.disabled = true;
      try{
        const res = await fetch(`${SUPABASE_URL}/functions/v1/create-checkout-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
          body: JSON.stringify({ scope: _getPlayerScope() })
        });
        const data = await res.json();
        if(!res.ok || !data.url){ btn.disabled = false; return; }
        window.location.href = data.url; // redirige vers la page de paiement Stripe
      } catch(e){ console.error(e); btn.disabled = false; }
    };
  }

  // Quêtes
  function renderQuestList(listEl, quests, progress, completed){
    listEl.innerHTML = '';
    const doneLabel = currentLang === 'en' ? 'Completed' : 'Terminée';
    quests.forEach(q=>{
      const done = completed.includes(q.id);
      const cur = Math.min(q.target, progress[q.id]||0);
      const label = currentLang === 'en' ? (q.label_en || q.label) : q.label;
      const li = document.createElement('li');
      li.innerHTML = `<div class="bp-quest-row"><span class="bp-quest-label${done?' bp-quest-done':''}">${done?'✓ ':''}${label}</span><span class="bp-quest-pts">${done?doneLabel:`${cur}/${q.target}`} · +${q.points} pts</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round((cur/q.target)*100)}%;background:${done?'#4ea88a':'var(--gold)'};"></div></div>`;
      listEl.appendChild(li);
    });
  }
  renderQuestList($('bp-daily-list'), BP_DAILY_QUESTS, bp.dailyProgress, bp.dailyCompleted);
  renderQuestList($('bp-weekly-list'), BP_WEEKLY_QUESTS, bp.weeklyProgress, bp.weeklyCompleted);

  // Temps restant avant reset — aligné sur UTC (même créneau que le Boss Mondial)
  function formatTimeLeft(ms){
    const h = Math.floor(ms/3600000);
    const m = Math.floor((ms%3600000)/60000);
    return `${h}h ${String(m).padStart(2,'0')}min avant reset`;
  }
  const now = new Date();
  const nextMidnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1, 0,0,0,0));
  const dailyTimerEl = $('daily-quests-timer');
  if(dailyTimerEl) dailyTimerEl.textContent = formatTimeLeft(nextMidnightUTC - now);
  const nextMonday = new Date(mondayStartOf(now).getTime() + 7*24*60*60*1000);
  const weeklyTimerEl = $('weekly-quests-timer');
  if(weeklyTimerEl) weeklyTimerEl.textContent = formatTimeLeft(nextMonday - now);

  // Paliers
  const tierList = $('bp-tier-list');
  tierList.innerHTML = '';
  BATTLEPASS_TIERS.forEach(t=>{
    const reached = bp.xp >= t.xp;
    const row = document.createElement('div');
    row.className = 'bp-tier-row' + (reached ? ' tier-reached' : '');
    row.innerHTML = `<div class="bp-tier-num-badge">${t.tier}</div>
      ${bpRewardHTML(c, bp, t, 'free', reached)}
      ${bpRewardHTML(c, bp, t, 'premium', reached)}`;
    tierList.appendChild(row);
  });
  tierList.querySelectorAll('button[data-claim]').forEach(btn=>{
    btn.onclick = async () => {
      const [track, tierNum] = btn.dataset.claim.split(':');
      const tDef = BATTLEPASS_TIERS.find(x=>String(x.tier)===tierNum);
      if(!tDef) return;
      let data;
      try{ data = await performAction('bp_claim_tier', { track, tier: tDef.tier }); }
      catch(e){ console.error(e); return; }
      creature = mergeDefaults(data.creature);
      const r = data.reward;
      let reward = '';
      if(r.type === 'coins') reward = `+${r.amount} Moltcoins 🪙`;
      else if(r.type === 'consumable'){
        const def = CONSUMABLE_DB.find(d=>d.id===r.consumableId);
        reward = `${r.qty}× ${def?def.icon:''} ${currentLang==='en'?(def?.name_en||def?.name):def?.name}`;
      } else if(r.type === 'item'){
        const rLabel = currentLang==='en' ? RARITY_LABEL_EN : RARITY_LABEL;
        reward = `${r.itemName} (${rLabel[r.itemRarity]})`;
      }
      const trackLabel = currentLang === 'en' ? (track === 'free' ? 'Free' : 'Premium') : (track === 'free' ? 'Gratuit' : 'Premium');
      const passWord = currentLang === 'en' ? 'Season Pass' : 'Pass Saisonnier';
      const tierWord = currentLang === 'en' ? 'tier' : 'palier';
      log(`${passWord} — ${tierWord} ${tDef.tier} (${trackLabel}) : ${reward}`, 'good');
      renderCreature(creature);
    };
  });
}
function bpRewardHTML(c, bp, t, track, reached){
  const reward = t[track];
  const trackLabel = currentLang === 'en'
    ? (track === 'free' ? 'Free' : '✦ Premium')
    : (track === 'free' ? 'Gratuit' : '✦ Premium');
  if(!reward){
    const noReward = currentLang === 'en' ? 'No reward' : 'Aucune récompense';
    return `<div class="bp-reward locked" style="--item-accent:var(--moss-700);opacity:0.35;">
      <span class="bp-reward-track">${trackLabel}</span>
      <span class="bp-reward-icon">—</span>
      <span style="color:var(--ivory-dim);">${noReward}</span>
    </div>`;
  }
  const claimed = (track === 'free' ? bp.claimedFree : bp.claimedPremium).includes(t.tier);
  const lockedByPremium = track === 'premium' && !bp.premiumUnlocked;
  let icon, accent, label;
  if(reward.type === 'coins'){
    icon = '🪙'; accent = 'var(--gold)'; label = `${reward.amount} Moltcoins`;
  } else if(reward.type === 'consumable'){
    const cdef = CONSUMABLE_DB.find(x=>x.id===reward.consumableId);
    icon = cdef ? cdef.icon : '❔'; accent = 'var(--ember-bright)';
    label = `${reward.qty||1}× ${cdef ? (currentLang==='en' ? (cdef.name_en||cdef.name) : cdef.name) : '???'}`;
  } else {
    const idef = ITEM_DB.find(i=>i.id===reward.itemId);
    icon = STAT_ICON[idef?.stat] || '❔'; accent = STAT_ACCENT[idef?.stat] || 'var(--moss-700)';
    label = (idef ? (currentLang==='en' ? (idef.name_en||idef.name) : idef.name) : null) || '???';
  }
  let action;
  if(claimed) action = `<span class="claimed-tag">✓ ${currentLang==='en'?'Received':'Reçu'}</span>`;
  else if(!reached) action = `<span class="claimed-tag" style="color:var(--ivory-dim);">${currentLang==='en'?'Locked':'Verrouillé'}</span>`;
  else if(lockedByPremium) action = `<span class="claimed-tag" style="color:var(--ivory-dim);">${currentLang==='en'?'Premium required':'Premium requis'}</span>`;
  else action = `<button data-claim="${track}:${t.tier}">${currentLang==='en'?'Claim':'Réclamer'}</button>`;
  return `<div class="bp-reward${(!reached || lockedByPremium) && !claimed ? ' locked' : ''}" style="--item-accent:${accent};">
    <span class="bp-reward-track">${trackLabel}</span>
    <span class="bp-reward-icon">${icon}</span>
    <span>${label}</span>
    ${action}
  </div>`;
}

const CARE_MAX = 5;

// ============================================================
// ============ SOIN DU MOLTCHI (nourrir/jouer/reposer) ============
// ============================================================
function careAttemptsLeft(c){ return c.careDay === todayKey() ? Math.max(0, CARE_MAX - c.careUsed) : CARE_MAX; }


// ============================================================
// ============ ÉQUIPEMENT, PUISSANCE & COMBAT ============
// Bonus des objets équipés (stats + effets spéciaux Moltyx),
// calcul des dégâts et de la Puissance totale du Moltchi.
// ============================================================
// IMPORTANT : relit les stats en direct depuis ITEM_DB/CORRUPT_ITEM_DB via
// defId (getItemDef), pas les valeurs figées au moment du drop — un
// rééquilibrage dans ITEM_DB s'applique donc tout de suite aux objets déjà
// en inventaire. Repli sur item.stat/item.value pour les vieux objets
// "legacy" sans defId (voir patch legacy plus bas dans ce fichier).
function equippedBonus(c){
  const bonus = {crit:0, dodge:0, stamina:0, magic:0};
  (c.inventory||[]).forEach(item=>{
    if(!item.equipped || item.rarity === 'unique') return;
    const def = item.defId ? getItemDef(item.defId, item.rarity) : null;
    const stat = def ? def.stat : item.stat;
    const value = def ? def.value : item.value;
    const stat2 = def ? def.stat2 : item.stat2;
    const value2 = def ? def.value2 : item.value2;
    if(stat) bonus[stat] = (bonus[stat]||0) + value;
    if(stat2) bonus[stat2] = (bonus[stat2]||0) + value2;
  });
  return bonus;
}
// Bonus des Moltyx équipés (effets spéciaux, pas des stats de combat classiques).
function equippedSpecialBonus(c){
  const bonus = {};
  (c.inventory||[]).forEach(item=>{
    if(item.equipped && item.rarity === 'unique' && item.special){
      const t = item.special.type;
      bonus[t] = (bonus[t]||0) + item.special.amount;
      if(item.special.type2){
        const t2 = item.special.type2;
        bonus[t2] = (bonus[t2]||0) + item.special.amount2;
      }
    }
  });
  return bonus;
}
function statsToDamage(c, boss){
  if(c.stage === 0) return 0;
  const eq = equippedBonus(c);
  const special = equippedSpecialBonus(c);
  const wellbeing = (c.hunger + c.joy + c.energy) / 3;
  let stats = { crit: c.crit + eq.crit, stamina: c.stamina + eq.stamina, magic: c.magic + eq.magic, dodge: c.dodge + eq.dodge };
  if(boss) stats = applyBossAffinities(stats, boss);
  // Même principe que la Puissance Donjon : somme des 4 stats équipées (affinités boss
  // appliquées ci-dessus) × facteur de Bien-être.
  const wellbeingFactor = 0.5 + (wellbeing/100)*0.6;
  let dmg = (stats.crit + stats.magic + stats.stamina + stats.dodge) * wellbeingFactor;
  if(c.species === 'Braisien') dmg *= 1.08;
  if(special.bossDamagePct) dmg *= 1 + special.bossDamagePct/100;
  // Une part d'aléatoire sur le résultat final (+/-15%) pour garder du suspense
  dmg *= 0.85 + Math.random() * 0.3;
  return Math.round(dmg);
}
// Dégâts moyens attendus par attaque contre le Boss Mondial, à partir des stats
// actuelles — même formule que statsToDamage mais sans le tirage aléatoire final,
// pour un affichage stable dans l'onglet Créature. `boss` (état courant, avec ses
// affinités élémentaires) est optionnel : sans lui, l'estimation ignore juste la
// faiblesse/résistance du boss du moment (ex: avant que le Boss ait été chargé).
function estimatedDamage(c, boss){
  if(c.stage === 0) return 0;
  const eq = equippedBonus(c);
  const special = equippedSpecialBonus(c);
  const wellbeing = (c.hunger + c.joy + c.energy) / 3;
  let stats = { crit: c.crit + eq.crit, stamina: c.stamina + eq.stamina, magic: c.magic + eq.magic, dodge: c.dodge + eq.dodge };
  if(boss) stats = applyBossAffinities(stats, boss);
  const wellbeingFactor = 0.5 + (wellbeing/100)*0.6;
  let dmg = (stats.crit + stats.magic + stats.stamina + stats.dodge) * wellbeingFactor;
  if(c.species === 'Braisien') dmg *= 1.08;
  if(special.bossDamagePct) dmg *= 1 + special.bossDamagePct/100;
  return Math.round(dmg);
}
function totalPower(c){
  const eq = equippedBonus(c);
  const wellbeing = (c.hunger + c.joy + c.energy) / 3;
  const raw = (c.level * 12) + (c.crit+eq.crit) + (c.dodge+eq.dodge) + (c.stamina+eq.stamina) + (c.magic+eq.magic);
  return Math.round(raw * (0.5 + wellbeing/100*0.6));
}

// ============================================================
// ============ DONJON (normal + corrompu) ============
// Difficulté par étage, plafonds quotidiens d'essais/réussites,
// XP et loot par étage (normal ET version corrompue débloquée
// après CORRUPT_UNLOCK_FLOOR), objets uniques du Donjon.
// NB : maxBossAttacks (Boss Mondial) est ici par proximité de code
// historique, mais logiquement il appartient à la section Boss plus bas.
// ============================================================
function floorRequirement(floor){ return Math.round(50 * Math.pow(1.05, floor - 1)); }
function maxBossAttacks(c){ return c.species === 'Luminel' ? 4 : 3; }
function maxDungeonAttempts(c){ return c.species === 'Epineombre' ? 6 : 5; } // plafond d'ÉCHECS/jour
function maxDungeonClears(c){ return c.species === 'Epineombre' ? 11 : 10; } // plafond de RÉUSSITES/jour

// --- Sanctuaire Corrompu — second donjon, verrouillé jusqu'à l'étage 100 de la Tour du Wyrm + achat ---
const CORRUPT_UNLOCK_FLOOR = 100;
const CORRUPT_UNLOCK_COST = 2000; // en Moltcoins
function corruptUnlockEligible(c){ return c.dungeonFloor >= CORRUPT_UNLOCK_FLOOR; }
// --- Principe de chaînage des donjons (à respecter pour tout futur donjon supplémentaire) ---
// Chaque nouveau donjon reprend narrativement la difficulté de l'étage 100 du précédent
// (donjon.floor(1) == précédent.floor(100)), et utilise un taux de croissance par étage
// ÉGAL OU SUPÉRIEUR à celui du donjon précédent — le joueur qui l'atteint est déjà bien
// plus fort (des mois de progression cumulée), un contenu post-game plus exigeant est donc
// cohérent, pas un problème. Attention cependant à ne pas enchaîner indéfiniment des hausses
// trop agressives d'un donjon à l'autre : vérifier par simulation (jours réels pour un profil
// assidu/régulier/casual) que le temps total cumulé reste de l'ordre de quelques mois à un an,
// pas des années, avant de valider le taux d'un nouveau donjon.
// Taux utilisés : Tour du Wyrm = 5%/étage, Sanctuaire Corrompu = 5%/étage (même principe).
// PRINCIPE À SUIVRE POUR TOUT FUTUR DONJON (n) :
// 1. req_n(1) = req_(n-1)(100) — l'étage 1 du nouveau donjon reprend exactement le niveau
//    de difficulté de l'étage 100 du précédent (pas de saut arbitraire).
// 2. Même taux de croissance par étage que le tout premier donjon (5%) — pas de taux "spécial"
//    par donjon : la difficulté progressive doit rester le même principe partout.
// 3. Mêmes plafonds quotidiens d'échecs/réussites que le Wyrm (5 échecs / 10 réussites,
//    6/11 pour Épineombre) — ne PAS les gonfler pour "rattraper" un déséquilibre : voir point 4.
// 4. Les valeurs des objets du nouveau donjon doivent être recalculées en multipliant les
//    valeurs équivalentes du donjon précédent par le facteur d'échelle = req_n(1) / req_(n-1)(1).
//    C'est CE facteur (et non le taux de croissance ni les plafonds quotidiens) qui doit
//    absorber le changement d'échelle, pour que le rythme de progression (objets/étage vs
//    puissance requise) reste comparable au donjon précédent.
// Exemple appliqué au Sanctuaire Corrompu : req_wyrm(1)=50, req_corrompu(1)=req_wyrm(100)=6262,
// facteur d'échelle = 6262/50 ≈ ×125 → les valeurs d'objets d'ITEM_DB (20/55/130/280) sont
// multipliées par ~125 dans CORRUPT_ITEM_DB (voir plus haut) plutôt que d'inventer une autre échelle.
function corruptFloorRequirement(floor){ return Math.round(floorRequirement(CORRUPT_UNLOCK_FLOOR) * Math.pow(1.05, floor - 1)); }
function maxCorruptAttempts(c){ return c.species === 'Epineombre' ? 6 : 5; } // plafond d'ÉCHECS/jour — identique au Wyrm, par principe (voir note ci-dessus)
function maxCorruptClears(c){ return c.species === 'Epineombre' ? 11 : 10; } // plafond de RÉUSSITES/jour — identique au Wyrm
function corruptXP(floor){ return 30 + floor * 2; }
function isCorruptLootFloor(floor){ return floor % 5 === 0; }

function grantXP(c, amount){
  c.xp += amount;
  while(c.xp >= c.level * 50){
    c.xp -= c.level * 50;
    c.level += 1;
    if(c.level >= 5 && c.stage < 2) c.stage = 2;
    if(c.level >= 15 && c.stage < 3) c.stage = 3; // Adolescent — seuil choisi selon l'économie d'XP (~jour 13 en jeu assidu)
    c.hunger = 100; c.joy = 100; c.energy = 100;
  }
}
// Note : les valeurs de stats des objets viennent directement d'ITEM_DB / CORRUPT_ITEM_DB
// (20/55/130/280 selon rareté), pas d'une table générique — RARITY_VALUE a été retirée
// car elle n'était plus utilisée nulle part dans le code.
const EQUIP_STATS = ['crit','dodge','stamina','magic'];
// ============================================================
// RÉFÉRENCE DU MAPPING STATS ↔ ÉLÉMENTS (seule source de vérité, ne pas dupliquer ailleurs) :
//   c.crit    = Critique (Feu)
//   c.dodge   = Vitesse (Vent)
//   c.stamina = Endurance (Terre)
//   c.magic   = Magie (Eau)
// Les clés internes (crit/dodge/stamina/magic) restent inchangées pour la compatibilité
// des sauvegardes existantes — seuls les noms AFFICHÉS ont changé. Si un jour ce mapping
// doit changer, ne modifier QUE STAT_LABEL / STAT_LABEL_EN ci-dessous : tout le reste de
// l'affichage (fiche créature, mini-jeux, tooltips d'objets, bonus d'espèce) en dépend.
// ============================================================
const STAT_LABEL = {crit:'Critique (Feu)', dodge:'Vitesse (Vent)', stamina:'Endurance (Terre)', magic:'Magie (Eau)'};
const STAT_LABEL_EN = {crit:'Crit (Fire)', dodge:'Speed (Wind)', stamina:'Endurance (Earth)', magic:'Magic (Water)'};
const STAT_ICON = {crit:'🔥', dodge:'💨', stamina:'🪨', magic:'💧'};
const STAT_ACCENT = {crit:'var(--ember-bright)', dodge:'var(--blue)', stamina:'#5fbf9a', magic:'var(--violet)'};

// XP gagnée en vainquant un étage donné du Donjon — formule explicite, affichée dans l'UI.
function dungeonXP(floor){ return 15 + floor; }
// Un objet ne tombe que tous les 5 étages (5, 10, 15…).
function isLootFloor(floor){ return floor % 5 === 0; }

// ============================================================
// ============ ENTRAÎNEMENT : APPLICATION DES GAINS ============
// Petite fonction utilisée par les 4 mini-jeux d'entraînement
// (rendus beaucoup plus bas dans le fichier, section MINI-JEUX).
// ============================================================
const BOSS_MAX_HP = 50000;
const BOSS_CYCLE_MS = 7*24*60*60*1000;

// Rotation des 4 Boss Mondiaux élémentaires. Cycle classique Feu → Vent → Terre → Eau → Feu :
// chaque boss est faible contre l'élément qui le précède dans ce cycle (+20% dégâts subis)
// et résistant à celui qu'il bat (-10% dégâts subis). ELEMENT_TO_STAT relie chaque élément
// à la stat de combat correspondante (voir le bloc de référence STAT_LABEL plus haut).
const ELEMENT_TO_STAT = { feu:'crit', vent:'dodge', terre:'stamina', eau:'magic' };
const ELEMENT_LABEL = { terre:'Terre', vent:'Vent', eau:'Eau', feu:'Feu' };
const ELEMENT_LABEL_EN = { terre:'Earth', vent:'Wind', eau:'Water', feu:'Fire' };
const BOSS_LIST = [
  { id:'ver_cendres',         name:'Le Ver-des-Cendres',         element:'feu',   weakness:'eau',  resistance:'vent',  image:'media/verdescendres.png', fallbackIcon:'🐉' },
  { id:'kraken_brumes',       name:'Le Kraken des Brumes',       element:'eau',   weakness:'terre', resistance:'feu',  image:'media/kraken.png',        fallbackIcon:'🐙' },
  { id:'golem_granit',        name:'Le Golem de Granit',         element:'terre', weakness:'vent',  resistance:'eau',  image:'media/golem.png',         fallbackIcon:'🗿' },
  { id:'spectre_bourrasques', name:'Le Spectre des Bourrasques', element:'vent',  weakness:'feu',   resistance:'terre',image:'media/spectre.png',       fallbackIcon:'👻' },
];
function bossDef(boss){ return BOSS_LIST.find(b => b.id === boss?.bossId) || BOSS_LIST[0]; }
// Applique la faiblesse (+20%) et la résistance (-10%) élémentaires du boss courant aux 4
// stats combinées (créature + équipement), avant de les sommer dans statsToDamage.
function applyBossAffinities(stats, boss){
  const def = bossDef(boss);
  const weakStat = ELEMENT_TO_STAT[def.weakness];
  const resistStat = ELEMENT_TO_STAT[def.resistance];
  const out = { ...stats };
  if(weakStat) out[weakStat] *= 1.2;
  if(resistStat) out[resistStat] *= 0.9;
  return out;
}


// ============================================================
// ============ BOSS MONDIAL ============
// État par défaut du boss partagé, chargement/sauvegarde,
// classement des contributeurs, récompenses en attente,
// paliers de classement (BOSS_RANK_TIERS) et reset hebdomadaire.
// ============================================================
function defaultBoss(){
  const randomBossId = BOSS_LIST[Math.floor(Math.random()*BOSS_LIST.length)].id;
  return { hp: BOSS_MAX_HP, maxHp: BOSS_MAX_HP, bossId: randomBossId, cycleStart: mondayStartOf(new Date()).getTime(), kills:0,
    defeatedThisCycle:false, cycleId:1, rewardsProcessedForCycleId:0 };
}
async function loadBoss(){
  try{
    const r = await window.storage.get('worldboss', true);
    const b = JSON.parse(r.value);
    // Compat : anciennes sauvegardes sans les nouveaux champs.
    if(b.cycleId === undefined) b.cycleId = 1;
    if(b.rewardsProcessedForCycleId === undefined) b.rewardsProcessedForCycleId = 0;
    if(b.defeatedThisCycle === undefined) b.defeatedThisCycle = false;
    if(b.bossId === undefined) b.bossId = BOSS_LIST[Math.floor(Math.random()*BOSS_LIST.length)].id;
    // Compat : anciens cycles non ancrés sur le lundi 00:00 (avant ce correctif).
    // On les recale sur le lundi de la semaine où le cycle a démarré, sans perdre
    // de progrès sur le cycle en cours ni forcer un reset immédiat.
    const anchoredMonday = mondayStartOf(new Date(b.cycleStart)).getTime();
    if(b.cycleStart !== anchoredMonday) b.cycleStart = anchoredMonday;
    return b;
  }
  catch(e){ return defaultBoss(); } // le Boss réel est créé côté serveur (service_role) au premier attack-boss
}
async function loadLeaderboard(){ try{ const r = await window.storage.get('leaderboard', true); return JSON.parse(r.value); }catch(e){ return {}; } }
async function loadBossRewardsPending(){ try{ const r = await window.storage.get('boss_rewards_pending', true); return JSON.parse(r.value); }catch(e){ return {}; } }

// Paliers de récompense hebdomadaire selon le rang au classement au moment du reset.
// La chance d'obtenir le Moltyx du Boss n'est appliquée que si le Boss a été vaincu
// au moins une fois pendant la semaine (boss.defeatedThisCycle === true).
const BOSS_RANK_TIERS = [
  {min:1,   max:1,        xp:400, moltcoins:600, moltyxChance:0.06    },
  {min:2,   max:10,       xp:200, moltcoins:300, moltyxChance:0.02667 },
  {min:11,  max:100,      xp:80,  moltcoins:100, moltyxChance:0.00889 },
  {min:101, max:Infinity, xp:30,  moltcoins:30,  moltyxChance:0.00296 },
];
function bossTierForRank(rank){
  return BOSS_RANK_TIERS.find(t => rank >= t.min && rank <= t.max) || BOSS_RANK_TIERS[BOSS_RANK_TIERS.length-1];
}
function bossTierLabel(rank){
  if(rank === 1) return '#1';
  if(rank <= 10) return '#2-10';
  if(rank <= 100) return '#11-100';
  return '#101+';
}

// Le reset hebdomadaire du cycle (calcul des récompenses par rang, remise à zéro du Boss
// et du classement) NE SE FAIT PLUS ICI : il est entièrement recalculé côté serveur dans
// la Edge Function supabase/functions/attack-boss/index.ts (avec la clé service_role, qui
// contourne les RLS bloquant désormais l'écriture directe du client sur les données
// partagées). Une ancienne version cliente équivalente (processWeeklyBossResetIfNeeded,
// + saveBoss/saveLeaderboard/saveBossRewardsPending) a été retirée le 30/07/2026 car
// devenue totalement redondante et non fonctionnelle (RLS bloque ces écritures côté
// client) — si un doute survient à nouveau sur "où se fait le reset", c'est là, dans
// attack-boss.ts, et nulle part ailleurs.


// ============================================================
// ============ TCHAT MONDIAL ============
// Filtre de mots interdits, purge par ancienneté (TTL 24h),
// écriture anti-collision (retry si écrasé par un autre joueur),
// rendu et cooldown d'envoi.
// ============================================================
// ---------- Tchat mondial (prototype) ----------
// Stockage partagé (comme le Boss Mondial) : une liste des N derniers messages, tronquée à chaque envoi.
const CHAT_MAX_MESSAGES = 50;
const CHAT_COOLDOWN_MS = 4000; // 1 message toutes les 4s par joueur — abaissé de 10s grâce à l'écriture sécurisée ci-dessous.
const CHAT_MAX_LENGTH = 200;
const CHAT_MESSAGE_TTL_MS = 24*60*60*1000; // les messages expirent après 24h, même si le cap de 50 n'est jamais atteint.
// Liste volontairement basique — un vrai filtre serveur sera nécessaire lors de la migration.
const CHAT_BANNED_WORDS = ['con','connard','connasse','pute','salope','merde','encule','enculee','pd','pede','negre','batard','fdp','nique','niquer','tarlouze','shit','fuck','bitch','asshole','nigger','faggot','whore','slut','cunt'];
function stripAccents(s){ return s.normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function containsBannedWord(text){
  const norm = stripAccents(text.toLowerCase());
  const words = norm.split(/[^a-z]+/).filter(Boolean);
  return words.some(w => CHAT_BANNED_WORDS.includes(w));
}
function pruneOldChatMessages(msgs){
  const cutoff = Date.now() - CHAT_MESSAGE_TTL_MS;
  return msgs.filter(m => (m.ts || 0) >= cutoff);
}
// loadChat purge toujours les messages trop vieux avant de les renvoyer, donc l'affichage
// ne montre jamais un message expiré — même si le stockage lui-même n'a pas encore été réécrit.
async function loadChat(){ try{ const r = await window.storage.get('chat:messages', true); return pruneOldChatMessages(JSON.parse(r.value) || []); }catch(e){ return []; } }
async function getLastChatSent(){ try{ const r = await window.storage.get('chat_last_sent', false); return parseInt(r.value) || 0; }catch(e){ return 0; } }

// Le stockage partagé Artifacts est "dernière écriture gagne" : si deux joueurs envoient un message
// presque en même temps, celui qui sauvegarde en second peut écraser le message du premier sans erreur.
// Cette fonction envoie le message, PUIS relit la liste pour vérifier qu'il est toujours là ; s'il a été
// écrasé par une écriture concurrente, elle réessaie automatiquement (avec un léger délai aléatoire pour
// éviter que deux tentatives concurrentes ne se percutent à nouveau).

function renderChat(msgs){
  const el = $('chat-log');
  if(!el) return;
  el.innerHTML = '';
  msgs.slice().reverse().forEach(m=>{
    const div = document.createElement('div');
    const author = document.createElement('strong');
    author.style.color = 'var(--gold)';
    author.textContent = (m.author || '???') + ' ';
    const time = document.createElement('span');
    time.style.cssText = 'opacity:0.5;font-size:10px;';
    time.textContent = new Date(m.ts).toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
    div.appendChild(author);
    div.appendChild(time);
    div.appendChild(document.createElement('br'));
    div.appendChild(document.createTextNode(m.text || ''));
    el.appendChild(div);
  });
}

let chatLastSentLocal = 0;
let chatSending = false;
function updateChatCooldownUI(){
  const btn = $('btn-chat-send');
  const txt = $('chat-cooldown-text');
  if(!btn || !txt) return;
  const remaining = CHAT_COOLDOWN_MS - (Date.now() - chatLastSentLocal);
  if(remaining > 0){
    btn.disabled = true;
    txt.textContent = `Prochain message possible dans ${Math.ceil(remaining/1000)}s.`;
  } else {
    btn.disabled = false;
    txt.textContent = '';
  }
}
async function sendChatMessage(){
  const input = $('chat-input');
  const errEl = $('chat-error');
  if(!input) return;
  const text = input.value.trim();
  errEl.style.display = 'none';
  if(!text) return;
  if(text.length > CHAT_MAX_LENGTH){
    errEl.textContent = `Message trop long (max ${CHAT_MAX_LENGTH} caractères).`;
    errEl.style.display = 'block';
    return;
  }
  if(containsBannedWord(text)){
    errEl.textContent = 'Message bloqué : merci de rester respectueux envers les autres joueurs.';
    errEl.style.display = 'block';
    return;
  }
  if(Date.now() - chatLastSentLocal < CHAT_COOLDOWN_MS){
    updateChatCooldownUI();
    return;
  }
  if(chatSending) return;
  chatSending = true;
  try{
    const res = await fetch('https://oouqtclsffybeloulvph.supabase.co/functions/v1/send-chat-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ scope: myId, playerScope: _getPlayerScope(), text })
    });
    const data = await res.json();
    if(!res.ok){
      errEl.textContent = data.error === 'cooldown actif'
        ? 'Merci d\'attendre un peu avant de renvoyer un message.'
        : 'Le chat est très actif, ton message n\'a pas pu être envoyé — réessaie.';
      errEl.style.display = 'block';
      return;
    }
    chatLastSentLocal = Date.now();
    input.value = '';
    renderChat(pruneOldChatMessages(data.messages).slice(-CHAT_MAX_MESSAGES));
    updateChatCooldownUI();
  } catch(e){
    errEl.textContent = 'Connexion au serveur impossible — réessaie.';
    errEl.style.display = 'block';
  } finally {
    chatSending = false;
  }
}


// ============================================================
// ============ SÉLECTION DE RACE (choix initial) ============
// ============================================================
function renderSpeciesSelect(){
  const grid = $('species-grid');
  grid.innerHTML = '';
  Object.entries(SPECIES).forEach(([key,sp])=>{
    const card = document.createElement('div');
    card.className = 'species-card';
    const iconHtml = sp.video
      ? `<video class="portrait" src="${sp.video}" autoplay loop muted playsinline onerror="this.outerHTML='<div class=&quot;icon&quot;>${sp.icon}</div>';"></video>`
      : sp.image
      ? `<img class="portrait" src="${sp.image}" alt="${sp.name}" onerror="this.outerHTML='<div class=&quot;icon&quot;>${sp.icon}</div>';">`
      : `<div class="icon">${sp.icon}</div>`;
    const passiveLabel = currentLang === 'en' ? (sp.passiveLabel_en || sp.passiveLabel) : sp.passiveLabel;
    const talent = currentLang === 'en' ? (sp.talent_en || sp.talent) : sp.talent;
    const chooseLabel = currentLang === 'en' ? 'Choose' : 'Choisir';
    card.innerHTML = `${iconHtml}<div class="name">${sp.name}</div><div class="passive">${passiveLabel}</div><div class="talent">${talent}</div><button class="primary" data-species="${key}">${chooseLabel}</button>`;
    grid.appendChild(card);
    // L'attribut autoplay seul n'est pas fiable pour une vidéo insérée via innerHTML
    // sur mobile (surtout iOS Safari) : on force explicitement la lecture en JS.
    const vid = card.querySelector('video');
    playVideoWithFallback(vid);
  });
  grid.querySelectorAll('button').forEach(btn=>{
    btn.onclick = async () => { await pickSpecies(btn.dataset.species); };
  });
  const surpriseBtn = $('btn-surprise-species');
  if(surpriseBtn){
    surpriseBtn.onclick = async () => {
      const keys = Object.keys(SPECIES);
      const pick = keys[Math.floor(Math.random()*keys.length)];
      await pickSpecies(pick);
    };
  }
}

async function pickSpecies(key){
  try{
    const data = await performAction('hatch', { species: key });
    creature = mergeDefaults(data.creature);
    renderCreature(creature);
    log(`${creature.name} le ${SPECIES[creature.species].name} a éclos !`);
  } catch(e){ log('Erreur — réessaie plus tard.', 'hit'); console.error(e); }
}


// ============================================================
// ============ RENDU PRINCIPAL DE LA CRÉATURE ============
// Grosse fonction : met à jour toute la carte Moltchi (portrait,
// stats, bien-être, boutons de soin, inventaire, sac à dos...).
// Appelée après quasiment chaque action du jeu.
// ============================================================
function renderCreature(c){
  updateTabAccess(c);
  renderBattlepass(c);
  if(c.stage === 0){
    $('species-select-card').style.display = 'block';
    $('creature-card').style.display = 'none';
    $('danger-zone-card').style.display = 'none'; $('recovery-card').style.display = 'none';
    $('inventory-card').style.display = 'none';
    renderSpeciesSelect();
    renderTrainingPanel(c);
    renderDungeonPanel(c);
    renderCorruptPanel(c);
    renderTreasurePanel(c);
    renderChestsPanel(c);
    renderShopPanel(c);
    return;
  }
  $('species-select-card').style.display = 'none';
  $('creature-card').style.display = 'block';
  $('danger-zone-card').style.display = 'block'; $('recovery-card').style.display = 'block';
  $('inventory-card').style.display = 'block';
  $('backpack-moltcoin-balance').textContent = (c.moltcoins || 0).toLocaleString();

  const spDef = SPECIES[c.species];
  $('creature-card').className = 'card companion-card' + (c.species ? ` sp-${c.species}` : '');
  $('companion-corner-emoji').textContent = spDef ? spDef.icon : '';
  const tooltipEl = $('species-tooltip');
  tooltipEl.innerHTML = '';
  if(spDef){
    const passive = currentLang === 'en' ? spDef.passiveLabel_en : spDef.passiveLabel;
    const talent = currentLang === 'en' ? spDef.talent_en : spDef.talent;
    const nameEl = document.createElement('div'); nameEl.className = 'species-tooltip-name'; nameEl.textContent = spDef.name;
    const passiveEl = document.createElement('div'); passiveEl.textContent = passive;
    const talentEl = document.createElement('div'); talentEl.textContent = talent;
    tooltipEl.append(nameEl, passiveEl, talentEl);
  }
  // Tap pour ouvrir/fermer sur mobile (le survol CSS suffit déjà pour la souris sur PC).
  // On (re)attache le handler à chaque rendu car l'icône peut être recréée/vidée entre-temps.
  const cornerIconEl = $('companion-corner-icon');
  cornerIconEl.onclick = (e) => {
    e.stopPropagation();
    cornerIconEl.classList.toggle('tooltip-open');
  };
  const media = getSpeciesMedia(spDef, c.stage);
  if(spDef && spDef.eatVideo) preloadVideo(spDef.eatVideo); // précharge dès qu'on sait que cette race a une animation dédiée
  if(spDef && spDef.playVideo) preloadVideo(spDef.playVideo);
  if(spDef && spDef.sleepVideo) preloadVideo(spDef.sleepVideo);
  if(media.video){
    const html = `<video src="${media.video}" autoplay loop muted playsinline style="width:100%;height:100%;object-fit:cover;object-position:center 30%;display:block;" onerror="sigilFallbackIcon(this, '${SIGILS[c.species] || STAGE_SIGILS[c.stage]}')"></video>`;
    setSigilContent('video:'+media.video, html, (vid) => playVideoWithFallback(vid));
  } else if(media.image){
    const html = `<img src="${media.image}" alt="${spDef.name}" style="width:100%;height:100%;object-fit:cover;object-position:center 30%;display:block;" onerror="sigilFallbackIcon(this, '${SIGILS[c.species] || STAGE_SIGILS[c.stage]}')">`;
    setSigilContent('image:'+media.image, html);
  } else {
    $('sigil').textContent = SIGILS[c.species] || STAGE_SIGILS[c.stage];
    delete $('sigil').dataset.mediaKey;
  }
  $('creature-name').textContent = c.name || 'Sans nom';
  const spName = SPECIES[c.species] ? SPECIES[c.species].name : '';
  $('level-pill').textContent = currentLang === 'en' ? `LVL ${c.level}` : `NIV. ${c.level}`;
  $('creature-meta').textContent = `${['','Nouveau-né','Juvénile','Adolescent'][c.stage]} · ${spName}`;
  const xpNeeded = c.level * 50;
  $('xp-val').textContent = `${Math.round(c.xp)}/${xpNeeded}`;
  const xpPct = Math.min(1, c.xp / xpNeeded);
  $('xp-fill').style.width = (xpPct * 100) + '%';
  $('hunger-val').textContent = Math.round(c.hunger);
  $('joy-val').textContent = Math.round(c.joy);
  $('energy-val').textContent = Math.round(c.energy);
  $('hunger-bar').style.width = c.hunger + '%';
  $('joy-bar').style.width = c.joy + '%';
  $('energy-bar').style.width = c.energy + '%';
  $('wellbeing-val').textContent = Math.round((c.hunger + c.joy + c.energy) / 3) + '%';
  $('crit-val').textContent = Math.round(c.crit);
  $('dodge-val').textContent = Math.round(c.dodge);
  $('stamina-val').textContent = Math.round(c.stamina);
  $('magic-val').textContent = Math.round(c.magic);
  $('est-damage-val').textContent = estimatedDamage(c, boss).toLocaleString();

  const careLeft = careAttemptsLeft(c);
  $('care-attempts-text').textContent = careLeft > 0 ? `${careLeft} action${careLeft>1?'s':''} de soin restante${careLeft>1?'s':''} aujourd'hui` : `Plus d'action de soin aujourd'hui — reviens demain`;
  const carePipRow = $('care-pip-row'); carePipRow.innerHTML = '';
  const careUsedToday = c.careDay === todayKey() ? c.careUsed : 0;
  for(let i=0;i<CARE_MAX;i++){ const pip = document.createElement('div'); pip.className = 'pip ' + (i < careUsedToday ? 'used' : 'available'); carePipRow.appendChild(pip); }
  $('btn-feed').disabled = careLeft === 0;
  $('btn-play').disabled = careLeft === 0;
  $('btn-sleep').disabled = careLeft === 0;

  const attemptsMax = maxBossAttacks(c);
  const attemptsLeft = c.lastAttackDay === todayKey() ? Math.max(0, attemptsMax - c.attacksToday) : attemptsMax;
  $('attempts-text').textContent = attemptsLeft > 0 ? `${attemptsLeft} attaque${attemptsLeft>1?'s':''} restante${attemptsLeft>1?'s':''} aujourd'hui` : `Reviens demain pour attaquer à nouveau`;
  $('btn-attack').disabled = attemptsLeft === 0;
  const pipRow = $('pip-row'); pipRow.innerHTML = '';
  const used = c.lastAttackDay === todayKey() ? c.attacksToday : 0;
  for(let i=0;i<attemptsMax;i++){ const pip = document.createElement('div'); pip.className = 'pip ' + (i < used ? 'used' : 'available'); pipRow.appendChild(pip); }

  const MAX_EQUIP = 5;

  const consumSection = $('consumables-section');
  const consumList = $('consumables-list');
  const ownedCandies = CONSUMABLE_DB.filter(def => (c.consumables?.[def.id]||0) > 0);
  if(ownedCandies.length === 0){ consumSection.style.display = 'none'; }
  else {
    consumSection.style.display = 'block';
    consumList.innerHTML = '';
    ownedCandies.forEach(def=>{
      const qty = c.consumables[def.id];
      const li = document.createElement('li');
      li.className = 'item-row';
      li.style.flexWrap = 'wrap';
      li.style.setProperty('--item-accent', 'var(--ember-bright)');
      li.innerHTML = `<span class="item-icon">${def.icon}</span>
        <span class="item-info"><span class="item-name">${currentLang==='en'?(def.name_en||def.name):def.name} <span style="color:var(--ivory-dim);">×${qty}</span></span><span class="item-desc">${currentLang==='en'?(def.desc_en||def.desc):def.desc}</span></span>
        <button data-candy="${def.id}" style="font-size:11px;padding:5px 9px;">${currentLang==='en'?'Consume':'Consommer'}</button>`;
      consumList.appendChild(li);
    });
    consumList.querySelectorAll('button[data-candy]').forEach(btn=>{
      btn.onclick = async () => {
        try{
          const data = await performAction('consume_candy', { candyId: btn.dataset.candy });
          creature = mergeDefaults(data.creature);
          renderCreature(creature);
        } catch(e){ console.error(e); }
      };
    });
  }

  const invList = $('inventory-list');
  if(c.inventory.length === 0){ invList.innerHTML = `<li>${currentLang==='en' ? 'No items yet.' : 'Aucun objet pour l\'instant.'}</li>`; }
  else {
    invList.innerHTML = '';
    const equippedCount = c.inventory.filter(i=>i.equipped && i.rarity !== 'unique').length;
    c.inventory.slice().reverse().forEach(item=>{
      if(item.stat === undefined && item.rarity !== 'unique' && !item.defId){ item.stat='crit'; item.value=6; item.equipped=false; item.id='legacy_'+Math.random(); }
      const li = document.createElement('li');
      li.className = 'item-row' + (item.equipped ? ' equipped' : '');
      li.style.flexWrap = 'wrap';
      const isUnique = item.rarity === 'unique';
      const canEquip = isUnique || item.equipped || equippedCount < MAX_EQUIP;
      const statLabel = currentLang === 'en' ? STAT_LABEL_EN : STAT_LABEL;
      const rarityLabel = currentLang === 'en' ? RARITY_LABEL_EN : RARITY_LABEL;
      // Relit toujours la déf à jour d'ITEM_DB via defId pour l'affichage des stats,
      // pour que les rééquilibrages soient visibles immédiatement sur les objets existants.
      const liveDef = item.defId ? getItemDef(item.defId, item.rarity) : null;
      const dStat = liveDef ? liveDef.stat : item.stat;
      const dValue = liveDef ? liveDef.value : item.value;
      const dStat2 = liveDef ? liveDef.stat2 : item.stat2;
      const dValue2 = liveDef ? liveDef.value2 : item.value2;
      const desc = isUnique ? (item.special ? `${UNIQUE_ITEM_DB.find(u=>u.id===item.defId)?.description || ''}` : '') : `+${dValue} ${statLabel[dStat]}${dStat2 ? ` / +${dValue2} ${statLabel[dStat2]}` : ''}`;
      const icon = isUnique ? '✦' : (STAT_ICON[dStat] || '❔');
      const accent = isUnique ? 'var(--ember-bright)' : STAT_ACCENT[dStat];
      li.style.setProperty('--item-accent', accent);
      const btnLabel = item.equipped
        ? (currentLang === 'en' ? '✓ Equipped' : '✓ Équipé')
        : (currentLang === 'en' ? 'Equip' : 'Équiper');
      const sellPrice = SELL_PRICE[item.rarity];
      const sellLabel = currentLang === 'en' ? `Sell (+${sellPrice} 🪙)` : `Vendre (+${sellPrice} 🪙)`;
      const sellBtn = sellPrice ? `<button data-sell="${item.id}" style="font-size:11px;padding:5px 9px;">${sellLabel}</button>` : '';
      li.innerHTML = `<span class="item-icon">${icon}</span>
        <span class="item-info"><span class="item-name">${itemDisplayName(item)} <span class="rarity-${item.rarity}">(${rarityLabel[item.rarity]})</span></span><span class="item-desc">${desc}</span></span>
        <button data-item="${item.id}" style="font-size:11px;padding:5px 9px;${item.equipped?'border-color:var(--gold);':''}" ${canEquip?'':'disabled'}>${btnLabel}</button>${sellBtn}`;
      invList.appendChild(li);
    });
    invList.querySelectorAll('button[data-sell]').forEach(btn=>{
      btn.onclick = async () => {
        const id = btn.dataset.sell;
        const item = c.inventory.find(i=>i.id === id);
        if(!item) return;
        const price = SELL_PRICE[item.rarity];
        if(!price) return;
        const confirmMsg = currentLang === 'en'
          ? `Sell ${itemDisplayName(item)} for ${price} Moltcoins?`
          : `Vendre ${itemDisplayName(item)} contre ${price} Moltcoins ?`;
        if(!confirm(confirmMsg)) return;
        try{
          const data = await performAction('sell_item', { itemId: id });
          creature = mergeDefaults(data.creature);
          renderCreature(creature);
        } catch(e){ console.error(e); }
      };
    });
    invList.querySelectorAll('button[data-item]').forEach(btn=>{
      btn.onclick = async () => {
        const id = btn.dataset.item;
        try{
          const data = await performAction('equip_toggle', { itemId: id });
          creature = mergeDefaults(data.creature);
          renderCreature(creature);
        } catch(e){ alert(e.message); console.error(e); }
      };
    });
  }

  const autoEquipBtn = $('btn-auto-equip');
  if(autoEquipBtn){
    autoEquipBtn.disabled = c.inventory.length === 0;
    autoEquipBtn.onclick = async () => {
      try{
        const data = await performAction('auto_equip', {});
        creature = mergeDefaults(data.creature);
        renderCreature(creature);
      } catch(e){ console.error(e); }
    };
  }
  const eq = equippedBonus(c);
  const parts = EQUIP_STATS.filter(s=>eq[s] > 0).map(s=>`+${eq[s]} ${STAT_LABEL[s]}`);
  const uniqueEquippedCount = c.inventory.filter(i=>i.equipped && i.rarity==='unique').length;
  const uniqueSummary = uniqueEquippedCount > 0 ? ` · ${uniqueEquippedCount} Moltyx actif${uniqueEquippedCount>1?'s':''}` : '';
  $('equip-bonus-summary').textContent = (parts.length
    ? `Bonus d'équipement actif (${c.inventory.filter(i=>i.equipped && i.rarity!=='unique').length}/${MAX_EQUIP}) : ${parts.join(' · ')}`
    : '') + uniqueSummary;
  renderTrainingPanel(c);
  renderDungeonPanel(c);
  renderCorruptPanel(c);
  renderTreasurePanel(c);
  renderChestsPanel(c);
  renderShopPanel(c);
}


// ============================================================
// ============ DÉTECTION AD-BLOCKER ============
// ============================================================
// ---------- Détection de bloqueur de publicités ----------
// Technique "bait element" : on insère un élément dont les classes/attributs sont
// génériquement ciblés par les filtres cosmétiques de quasi tous les bloqueurs de
// pub (uBlock Origin, AdBlock Plus, Brave Shields, AdGuard...). S'il est masqué ou
// retiré du DOM après un court délai, un bloqueur est actif. Fonctionne entièrement
// côté client, sans dépendre du domaine publicitaire réel ni d'un SDK avec callback.
// Signal 1 : élément-piège avec des noms de classe typiques des publicités, vérifie s'il est
// masqué/réduit à zéro par un filtre cosmétique (ce que font AdBlock/uBlock classiquement).
function detectAdBlockerBait1(){
  return new Promise((resolve) => {
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner ad-placement adsbygoogle textAd banner-ad ad-unit pub_300x250';
    bait.setAttribute('aria-hidden', 'true');
    bait.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:300px;height:250px;pointer-events:none;';
    document.body.appendChild(bait);
    setTimeout(() => {
      const hidden = bait.offsetParent === null
        || bait.offsetHeight === 0
        || bait.offsetWidth === 0
        || getComputedStyle(bait).display === 'none'
        || getComputedStyle(bait).visibility === 'hidden';
      bait.remove();
      resolve(hidden);
    }, 150);
  });
}
// Signal 2 : second élément-piège, signature différente du premier (noms de classes +
// structure imbriquée différente), pour couvrir les listes de filtres qui ne ciblent pas
// exactement les mêmes motifs que le signal 1 — sans dépendre d'un domaine tiers (une requête
// réseau vers un domaine externe risquerait de déclencher un faux positif via la protection
// anti-pistage native de certains navigateurs, indépendamment de tout vrai bloqueur de pub).
function detectAdBlockerBait2(){
  return new Promise((resolve) => {
    const outer = document.createElement('div');
    outer.id = 'ad-container';
    outer.className = 'google-ad-container sponsor sponsored-content';
    outer.style.cssText = 'position:absolute;top:-9999px;left:-9999px;pointer-events:none;';
    const inner = document.createElement('div');
    inner.className = 'ad slot-ad ad-slot advertisement';
    inner.style.cssText = 'width:280px;height:200px;';
    outer.appendChild(inner);
    document.body.appendChild(outer);
    setTimeout(() => {
      const hidden = outer.offsetParent === null
        || inner.offsetHeight === 0
        || inner.offsetWidth === 0
        || getComputedStyle(inner).display === 'none'
        || getComputedStyle(outer).display === 'none';
      outer.remove();
      resolve(hidden);
    }, 150);
  });
}
// Combine les deux signaux : un seul suffit à considérer qu'un bloqueur de pub est actif,
// pour limiter les faux négatifs propres à chaque technique prise isolément.
async function detectAdBlocker(){
  const [hidden1, hidden2] = await Promise.all([detectAdBlockerBait1(), detectAdBlockerBait2()]);
  return hidden1 || hidden2;
}


// ============================================================
// ============ BOUTIQUE HEBDOMADAIRE ============
// ============================================================
// Sélection 100% déterministe à partir de weekKey() — mêmes objets affichés
// que côté serveur, sans stockage ni tâche planifiée (voir perform-action.ts).
const SHOP_TOWER_COST = 1000;
const SHOP_CORRUPT_COST = 2500;
function hashStringToInt(s){
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function weeklyShopPick(dungeonId){
  const pool = (dungeonId === 'wyrm' ? ITEM_DB : CORRUPT_ITEM_DB).filter(i => i.rarity === 'legendary');
  const seed = hashStringToInt(weekKey() + ':' + dungeonId);
  return pool[seed % pool.length];
}
function shopPurchasedThisWeek(c, dungeonId){
  if(!c.shopPurchases || c.shopPurchases.weekKey !== weekKey()) return false;
  return !!c.shopPurchases[dungeonId];
}
function statLine(def){
  const labels = currentLang === 'en' ? STAT_LABEL_EN : STAT_LABEL;
  const parts = [`+${def.value} ${labels[def.stat]}`];
  if(def.stat2) parts.push(`+${def.value2} ${labels[def.stat2]}`);
  return parts.join(' · ');
}
function renderShopPanel(c){
  if(c.stage === 0) return;
  const container = $('shop-items'); container.innerHTML = '';

  const discountPct = equippedSpecialBonus(c).shopDiscountPct || 0;
  const applyDiscount = (cost) => Math.round(cost * (1 - discountPct/100));

  const entries = [
    { id:'wyrm', label: currentLang==='en' ? 'Wyrm Tower' : 'Tour du Wyrm', cost: applyDiscount(SHOP_TOWER_COST), baseCost: SHOP_TOWER_COST, locked: false },
    { id:'corrupt', label: currentLang==='en' ? 'Corrupted Sanctuary' : 'Sanctuaire Corrompu', cost: applyDiscount(SHOP_CORRUPT_COST), baseCost: SHOP_CORRUPT_COST, locked: !c.corruptUnlocked },
  ];

  entries.forEach(entry => {
    const def = weeklyShopPick(entry.id);
    const bought = shopPurchasedThisWeek(c, entry.id);
    const canAfford = (c.moltcoins||0) >= entry.cost;
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'flex:1;min-width:220px;text-align:center;';
    const lockedMsg = currentLang==='en'
      ? 'Unlock the Corrupted Sanctuary first (reach floor 100 of the Tower).'
      : 'Débloque d\'abord le Sanctuaire Corrompu (atteins l\'étage 100 de la Tour).';
    const priceLabel = discountPct > 0
      ? `<span style="text-decoration:line-through;opacity:0.55;">🪙 ${entry.baseCost}</span> 🪙 ${entry.cost} Moltcoins`
      : `🪙 ${entry.cost} Moltcoins`;
    card.innerHTML = `
      <p style="font-size:11px;color:var(--ivory-dim);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 4px;">${entry.label}</p>
      <p style="font-weight:700;color:var(--gold);margin:0 0 6px;">✨ ${def.name}</p>
      <p style="font-size:12px;color:var(--ivory-dim);margin:0 0 10px;">${statLine(def)}</p>
      ${entry.locked
        ? `<p style="font-size:12px;color:var(--danger);">${lockedMsg}</p>`
        : bought
          ? `<button disabled>${currentLang==='en'?'Already bought this week':'Déjà acheté cette semaine'}</button>`
          : `<button ${canAfford?'':'disabled'} data-shop-buy="${entry.id}">${priceLabel}</button>`
      }`;
    container.appendChild(card);
  });

  container.querySelectorAll('[data-shop-buy]').forEach(btn => {
    btn.onclick = async () => {
      const which = btn.dataset.shopBuy;
      btn.disabled = true;
      try{
        const data = await performAction('shop_buy', { which });
        creature = mergeDefaults(data.creature);
        renderCreature(creature);
        const logEl = $('shop-log');
        const line = document.createElement('div');
        line.textContent = (currentLang==='en' ? 'Purchased: ' : 'Acheté : ') + data.itemName;
        logEl.prepend(line);
        while(logEl.children.length > 10) logEl.removeChild(logEl.lastChild);
      } catch(e){
        console.error(e);
        btn.disabled = false;
      }
    };
  });
}

// ============================================================
// ============ COFFRES QUOTIDIENS (récompense pub) ============
// ============================================================
// ---------- Coffres quotidiens (récompensés par publicité Monetag, format Direct Link) ----------
const CHESTS_MAX_PER_DAY = 3;
const MONETAG_DIRECT_LINK = 'https://omg10.com/4/11452580';
const CHEST_WATCH_SECONDS = 15;
let chestClaimReady = false;
let chestPendingIndex = null;

function chestsRemainingToday(c){
  return c.chestsDay === todayKey() ? Math.max(0, CHESTS_MAX_PER_DAY - c.chestsOpened) : CHESTS_MAX_PER_DAY;
}
function renderChestsPanel(c){
  if(c.stage === 0) return;
  const opened = c.chestsDay === todayKey() ? c.chestsOpened : 0;
  const remaining = CHESTS_MAX_PER_DAY - opened;
  $('chests-remaining-text').textContent = remaining > 0
    ? (currentLang === 'en'
        ? `${remaining} chest${remaining>1?'s':''} available today`
        : `${remaining} coffre${remaining>1?'s':''} disponible${remaining>1?'s':''} aujourd'hui`)
    : (currentLang === 'en'
        ? "No more chests today — come back tomorrow (midnight UTC)."
        : "Plus de coffre aujourd'hui — reviens demain (minuit UTC).");
  const row = $('chest-row'); row.innerHTML = '';
  for(let i=0;i<CHESTS_MAX_PER_DAY;i++){
    const btn = document.createElement('button');
    const isOpened = i < opened;
    btn.className = 'chest-icon' + (isOpened ? ' chest-opened' : '');
    btn.textContent = isOpened ? '📭' : '🎁';
    btn.disabled = isOpened || chestPendingIndex !== null;
    btn.onclick = () => startChestAd(i);
    row.appendChild(btn);
  }
  $('btn-chest-claim').onclick = claimChestReward;

  // Pastille rouge sur l'onglet Coffres : allumée tant qu'il reste au moins un
  // coffre disponible aujourd'hui (même logique que le Pass Saisonnier), pas
  // seulement quand les 3 sont encore intacts.
  const dotHTML = '<span class="notif-dot"></span>';
  const chestsHaveAvailable = remaining > 0;
  const chestsLabel = currentLang === 'en' ? (I18N_EN.tab_chests || 'Chests') : 'Coffres';
  $('chests-tab').innerHTML = chestsLabel + (chestsHaveAvailable ? dotHTML : '');

  // Pastille combinée sur le menu parent "Récompenses" : allumée si le Pass
  // Saisonnier a une récompense à réclamer OU s'il reste au moins un coffre disponible.
  const rewardsLabel = currentLang === 'en' ? (I18N_EN.tab_rewards || 'Rewards') : 'Récompenses';
  const rewardsHasNotif = chestsHaveAvailable || battlepassHasClaimable(c);
  $('rewards-parent').innerHTML = rewardsLabel + ' <span class="caret">▾</span>' + (rewardsHasNotif ? dotHTML : '');
}

async function startChestAd(index){
  if(chestsRemainingToday(creature) <= 0) return;

  // CRITIQUE : le clic sur le lien Monetag doit se produire de façon synchrone, en tout
  // premier, avant le moindre `await`. Les navigateurs n'autorisent une navigation _blank
  // non bloquée que pendant la fenêtre d'activation utilisateur du clic ; le moindre await
  // avant (même detectAdBlocker, qui ne prend que ~150ms) fait expirer cette fenêtre et la
  // navigation est alors bloquée silencieusement — sans erreur JS visible, et sans que
  // Monetag ne voie jamais l'impression, même si la zone est correctement configurée et
  // active de leur côté.
  // On utilise un vrai <a target="_blank"> cliqué programmatiquement plutôt que
  // window.open() : certains réseaux publicitaires (dont potentiellement Monetag selon la
  // configuration de la zone) détectent l'impression via une vraie navigation de type lien
  // cliqué (référent, cookie posé au chargement de la destination, etc.), ce qui n'est pas
  // garanti identique avec window.open() selon leur méthode de tracking exacte. Un <a>
  // cliqué programmatiquement produit un événement de navigation indiscernable d'un clic
  // humain sur un lien HTML classique.
  const adLink = document.createElement('a');
  adLink.href = MONETAG_DIRECT_LINK;
  adLink.target = '_blank';
  adLink.rel = 'noopener';
  document.body.appendChild(adLink);
  adLink.click();
  adLink.remove();

  const blocked = await detectAdBlocker();
  $('chest-adblock-warning').style.display = blocked ? 'block' : 'none';
  if(blocked) return; // pas de pub visible = pas de coffre, pour éviter l'abus

  chestPendingIndex = index;
  renderChestsPanel(creature);
  const statusEl = $('chest-watch-status');
  const claimBtn = $('btn-chest-claim');
  $('chest-watch-row').style.display = 'block';
  claimBtn.style.display = 'none';
  claimBtn.disabled = false; // évite qu'il reste grisé d'un précédent coffre déjà réclamé

  // Le lien Monetag a déjà été ouvert tout en haut de cette fonction (voir le commentaire
  // ci-dessus) — le minuteur ci-dessous ne sert qu'à donner un temps de lecture minimal avant
  // de pouvoir réclamer la récompense.

  let secondsLeft = CHEST_WATCH_SECONDS;
  statusEl.textContent = currentLang==='en' ? `Watch the ad… (${secondsLeft}s)` : `Regarde la publicité… (${secondsLeft}s)`;
  const tick = setInterval(() => {
    secondsLeft -= 1;
    if(secondsLeft <= 0){
      clearInterval(tick);
      statusEl.textContent = 'Publicité terminée !';
      claimBtn.style.display = 'inline-block';
      chestClaimReady = true;
    } else {
      statusEl.textContent = currentLang==='en' ? `Watch the ad… (${secondsLeft}s)` : `Regarde la publicité… (${secondsLeft}s)`;
    }
  }, 1000);
}

async function claimChestReward(){
  if(!chestClaimReady || chestPendingIndex === null) return;
  chestClaimReady = false;
  const btn = $('btn-chest-claim');
  btn.disabled = true;

  let data;
  try{
    data = await performAction('chest_claim', {});
  } catch(e){
    console.error(e);
    $('chest-watch-row').style.display = 'none';
    chestPendingIndex = null;
    return;
  }
  creature = mergeDefaults(data.creature);

  let msg = currentLang === 'en' ? `Chest opened: +${data.coins} Moltcoins 🪙` : `Coffre ouvert : +${data.coins} Moltcoins 🪙`;

  if(data.candy){
    const def = CONSUMABLE_DB.find(d => d.id === data.candy.id);
    if(def){
      msg += currentLang === 'en'
        ? ` · ${def.icon} ${def.name_en||def.name} obtained!`
        : ` · ${def.icon} ${def.name} obtenu !`;
    }
  }

  if(data.uniqueFound){
    const def = UNIQUE_ITEM_DB.find(u => u.id === data.uniqueFound.defId);
    if(def){
      msg += currentLang === 'en'
        ? ` · ✦ ${def.name_en||def.name} obtained!`
        : ` · ✦ ${def.name} obtenu !`;
    }
  }

  $('chest-watch-row').style.display = 'none';
  chestPendingIndex = null;
  renderCreature(creature);
  const logEl = $('chest-log');
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.prepend(line);
  while(logEl.children.length > 10) logEl.removeChild(logEl.lastChild);
}


// ============================================================
// ============ RENDU BOSS MONDIAL & CLASSEMENT ============
// ============================================================
function renderBoss(boss){
  const def = bossDef(boss);
  const elLabel = currentLang === 'en' ? ELEMENT_LABEL_EN : ELEMENT_LABEL;
  $('boss-name').textContent = def.name + (boss.kills > 0 ? (currentLang==='en' ? ` (defeated ${boss.kills}x)` : ` (vaincu ${boss.kills}x)`) : '');
  $('boss-affinities').textContent = currentLang==='en'
    ? `Weak against ${elLabel[def.weakness]} (+20% damage taken) · Resists ${elLabel[def.resistance]} (-10% damage taken)`
    : `Faible contre ${elLabel[def.weakness]} (+20% dégâts subis) · Résiste à ${elLabel[def.resistance]} (-10% dégâts subis)`;
  const portraitImg = $('boss-portrait');
  const portraitFallback = $('boss-portrait-fallback');
  portraitFallback.textContent = def.fallbackIcon || '🐉';
  if(def.image){
    portraitImg.src = def.image;
    portraitImg.onerror = () => { portraitImg.style.display = 'none'; portraitFallback.style.display = 'block'; };
    portraitImg.onload = () => { portraitImg.style.display = 'block'; portraitFallback.style.display = 'none'; };
    portraitImg.style.display = 'block'; portraitFallback.style.display = 'none';
  } else {
    portraitImg.style.display = 'none'; portraitFallback.style.display = 'block';
  }
  const pct = Math.max(0, Math.round((boss.hp / boss.maxHp) * 100));
  $('boss-fill').style.width = pct + '%';
  $('boss-pct').textContent = pct + '%';
  $('boss-hp-text').textContent = `${Math.max(0,Math.round(boss.hp)).toLocaleString()} / ${boss.maxHp.toLocaleString()} PV`;
  const nextMonday = boss.cycleStart + 7*24*60*60*1000;
  const daysLeft = Math.max(0, Math.ceil((nextMonday - Date.now())/(1000*60*60*24)));
  $('boss-timer').textContent = daysLeft > 0 ? `${daysLeft}j restants` : 'cycle terminé';
}
function renderLeaderboard(lb, myId){
  const entries = Object.entries(lb).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const ul = $('leaderboard'); ul.innerHTML = '';
  if(entries.length === 0){ ul.innerHTML = currentLang==='en' ? '<li>No one has attacked the Boss yet.</li>' : '<li>Personne n\'a encore attaqué le Boss.</li>'; return; }
  entries.forEach(([id,dmg],i)=>{
    const li = document.createElement('li');
    li.className = id === myId ? 'you' : '';
    const left = document.createElement('span');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${i+1}`;
    left.appendChild(rank);
    left.appendChild(document.createTextNode(id === myId ? id + (currentLang==='en' ? ' (you)' : ' (toi)') : id));
    const right = document.createElement('span');
    right.textContent = currentLang==='en' ? `${dmg.toLocaleString()} damage` : `${dmg.toLocaleString()} dégâts`;
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });
}

// ============================================================
// ============ LOGS & RÉCOMPENSES BOSS EN ATTENTE ============
// ============================================================
function log(msg, cls){ const el = $('log'); const div = document.createElement('div'); if(cls) div.className = cls; div.textContent = msg; el.prepend(div); }
function dungeonLog(msg, cls, elId){ const el = $(elId || 'dungeon-log'); const div = document.createElement('div'); if(cls) div.className = cls; div.textContent = msg; el.prepend(div); }

// Affiche les récompenses hebdomadaires du Boss Mondial en attente pour ce joueur
// (calculées lors du dernier reset de cycle) et permet de toutes les réclamer d'un coup.
async function renderPendingBossRewards(){
  const pending = await loadBossRewardsPending();
  const mine = pending[myId] || [];
  const card = $('boss-rewards-pending-card');
  if(mine.length === 0){ card.style.display = 'none'; return; }
  card.style.display = 'block';
  const list = $('boss-rewards-pending-list');
  list.innerHTML = '';
  let totalXP=0, totalCoins=0;
  mine.forEach(r=>{
    totalXP += r.xp; totalCoins += r.moltcoins;
    const li = document.createElement('li');
    const chanceTxt = r.moltyxChance > 0
      ? `${(r.moltyxChance*100).toFixed(2).replace(/\.?0+$/,'')}% Moltyx`
      : (r.bossDefeated ? '0% Moltyx' : (currentLang==='en' ? 'Boss not defeated — no Moltyx' : 'Boss non vaincu — pas de Moltyx'));
    const rankWord = currentLang==='en' ? 'Rank' : 'Rang';
    const dmgWord = currentLang==='en' ? 'damage' : 'dégâts';
    li.innerHTML = `<span>${rankWord} ${bossTierLabel(r.rank)} <span style="color:var(--ivory-dim);">(${r.damage.toLocaleString()} ${dmgWord})</span></span><span>+${r.xp} XP · 🪙${r.moltcoins} · ${chanceTxt}</span>`;
    list.appendChild(li);
  });
  $('btn-claim-boss-rewards').onclick = async () => {
    const btn = $('btn-claim-boss-rewards');
    btn.disabled = true;
    try{
      const res = await fetch('https://oouqtclsffybeloulvph.supabase.co/functions/v1/claim-boss-rewards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ scope: _getPlayerScope() })
      });
      const data = await res.json();
      if(!res.ok){ log(currentLang==='en' ? 'Could not claim rewards right now.' : 'Impossible de réclamer les récompenses pour le moment.', 'hit'); return; }
      creature = mergeDefaults(data.creature);
      card.style.display = 'none';
      renderCreature(creature);
      log(currentLang==='en'
        ? `Weekly rewards claimed: +${data.totalXP} XP, +${data.totalCoins} Moltcoins.${data.moltyxWon ? ' ✦ Eclat du Monde obtained!' : ''}`
        : `Récompenses hebdomadaires réclamées : +${data.totalXP} XP, +${data.totalCoins} Moltcoins.${data.moltyxWon ? ' ✦ Eclat du Monde obtenu !' : ''}`, 'good');
    } catch(e){
      log(currentLang==='en' ? 'Could not connect to the server — try again.' : 'Connexion au serveur impossible — réessaie.', 'hit');
    } finally {
      btn.disabled = false;
    }
  };
}

const GLOBAL_TRAIN_ATTEMPTS = 8; // essais d'entraînement totaux par jour, à répartir librement entre les 4 mini-jeux


// ============================================================
// ============ ENTRAÎNEMENT : MINI-JEUX ============
// Panneau d'entraînement + les 4 mini-jeux (réflexe, mémoire, rythme, arcane) — le résultat
// est calculé et sauvegardé côté serveur via performAction (Edge Function perform-action),
// plus de calcul/écriture direct côté client.
// ============================================================
function renderTrainingPanel(c){
  const globalLeft = trainAttemptsLeft(c);
  const detail = c.trainDay === todayKey()
    ? ` (Réflexe: ${c.trainCounts.reflex||0} · Mémoire: ${c.trainCounts.memory||0} · Rythme: ${c.trainCounts.rhythm||0} · Arcane: ${c.trainCounts.arcane||0})`
    : '';
  $('training-attempts').textContent = currentLang === 'en'
    ? (globalLeft > 0
        ? `${globalLeft} training attempt${globalLeft>1?'s':''} left today — spend them however you like across the minigames${detail}`
        : `No training attempts left today — come back tomorrow${detail}`)
    : (globalLeft > 0
        ? `${globalLeft} essai${globalLeft>1?'s':''} d'entraînement restant${globalLeft>1?'s':''} aujourd'hui — à répartir comme tu veux entre les mini-jeux${detail}`
        : `Plus d'essai d'entraînement aujourd'hui — reviens demain${detail}`);
  const noCreature = c.stage === 0;
  const locked = noCreature || globalLeft === 0;
  $('btn-start-reflex').disabled = locked;
  $('btn-start-memory').disabled = locked;
  $('btn-start-rhythm').disabled = locked;
  $('btn-start-arcane').disabled = locked;
}
function trainAttemptsLeft(c){ const used = c.trainDay === todayKey() ? Object.values(c.trainCounts).reduce((a,b)=>a+b,0) : 0; return Math.max(0, GLOBAL_TRAIN_ATTEMPTS - used); }

// Pose le décor thématique (Feu/Vent/Terre/Eau) sur le conteneur #minigame-area selon le
// mini-jeu lancé — cf. les classes mg-theme-* et leurs animations dans style.css — et lance
// une pluie de particules ambiantes continue tant que le mini-jeu reste ouvert (immersion).
const MG_THEMES = ['mg-theme-fire', 'mg-theme-wind', 'mg-theme-earth', 'mg-theme-water'];
const MG_AMBIENT_CONFIG = {
  fire:  { emojis:['🔥','✨','🔥'], count:1, interval:260 },
  wind:  { emojis:['💨'],           count:1, interval:340 },
  earth: { emojis:['🍃','🌿'],      count:1, interval:420 },
  water: { emojis:['💧'],           count:1, interval:300 },
};
let mgAmbientInterval = null;
function stopMinigameAmbience(){
  if(mgAmbientInterval){ clearInterval(mgAmbientInterval); mgAmbientInterval = null; }
}
function spawnAmbientParticle(area, theme){
  const cfg = MG_AMBIENT_CONFIG[theme];
  if(!cfg) return;
  const p = document.createElement('div');
  p.className = 'mg-ambient-particle';
  p.textContent = cfg.emojis[Math.floor(Math.random()*cfg.emojis.length)];
  p.style.fontSize = (11 + Math.random()*9) + 'px';
  const dur = (2.4 + Math.random()*1.8);
  p.style.setProperty('--dur', dur + 's');
  if(theme === 'fire'){ // braises qui montent depuis le bas
    p.style.left = (6 + Math.random()*88) + '%'; p.style.top = '96%';
    p.style.setProperty('--dx', (Math.random()*50-25) + 'px');
    p.style.setProperty('--dy', -(120 + Math.random()*90) + 'px');
    p.style.setProperty('--rot', (Math.random()*20-10) + 'deg');
  } else if(theme === 'wind'){ // rafales qui traversent horizontalement
    p.style.left = '-4%'; p.style.top = (8 + Math.random()*80) + '%';
    p.style.setProperty('--dx', (220 + Math.random()*90) + 'px');
    p.style.setProperty('--dy', (Math.random()*24-12) + 'px');
    p.style.setProperty('--rot', (Math.random()*10-5) + 'deg');
  } else if(theme === 'earth'){ // feuilles qui tombent lentement en se balançant
    p.style.left = (6 + Math.random()*88) + '%'; p.style.top = '-6%';
    p.style.setProperty('--dx', (Math.random()*70-35) + 'px');
    p.style.setProperty('--dy', (110 + Math.random()*70) + 'px');
    p.style.setProperty('--rot', (140 + Math.random()*100) + 'deg');
  } else if(theme === 'water'){ // gouttes qui tombent depuis le haut
    p.style.left = (6 + Math.random()*88) + '%'; p.style.top = '-6%';
    p.style.setProperty('--dx', (Math.random()*20-10) + 'px');
    p.style.setProperty('--dy', (130 + Math.random()*70) + 'px');
    p.style.setProperty('--rot', '0deg');
  }
  area.appendChild(p);
  setTimeout(() => p.remove(), dur*1000 + 100);
}
function startMinigameAmbience(theme){
  stopMinigameAmbience();
  const cfg = MG_AMBIENT_CONFIG[theme];
  const area = $('minigame-area');
  if(!cfg || !area) return;
  mgAmbientInterval = setInterval(() => {
    if(!area || area.offsetParent === null){ stopMinigameAmbience(); return; } // panneau caché : on arrête proprement
    for(let i=0;i<cfg.count;i++) spawnAmbientParticle(area, theme);
  }, cfg.interval);
}
function setMinigameTheme(theme){
  const area = $('minigame-area');
  if(!area) return;
  area.classList.remove(...MG_THEMES);
  if(theme){ area.classList.add('mg-theme-' + theme); startMinigameAmbience(theme); }
  else stopMinigameAmbience();
}

// Décompte visible de 3s partagé par les 4 mini-jeux d'entraînement, avant que la vraie
// mécanique (réflexe, mémoire, rythme, arcane) ne démarre — laisse le temps de se préparer.
function runMinigameCountdown(onDone){
  let n = 3;
  $('minigame-content').innerHTML = `<div class="minigame-countdown" id="minigame-countdown">${n}</div>`;
  const interval = setInterval(()=>{
    n--;
    const el = $('minigame-countdown');
    if(n > 0){
      if(el) el.textContent = n;
    } else {
      clearInterval(interval);
      onDone();
    }
  }, 1000);
}
// ============================================================
// ============ MINI-JEUX — EFFETS VISUELS PARTAGÉS ============
// Petits helpers réutilisés par les 4 mini-jeux pour donner du relief visuel
// (particules élémentaires, flash d'impact, secousse) sans dupliquer de code.
// container doit être position:relative (ou position:absolute déjà) pour que
// les particules/flashs se positionnent correctement par-dessus.
// ============================================================
function spawnParticleBurst(container, x, y, color, count=10){
  if(!container) return;
  for(let i=0;i<count;i++){
    const p = document.createElement('div');
    p.className = 'mg-particle';
    const angle = Math.random()*Math.PI*2;
    const dist = 26 + Math.random()*38;
    p.style.left = x+'px'; p.style.top = y+'px';
    p.style.background = color;
    p.style.boxShadow = `0 0 6px 2px ${color}`;
    p.style.setProperty('--px', Math.cos(angle)*dist+'px');
    p.style.setProperty('--py', Math.sin(angle)*dist+'px');
    container.appendChild(p);
    setTimeout(()=>p.remove(), 600);
  }
}
function spawnImpactFlash(container, x, y, color){
  if(!container) return;
  const f = document.createElement('div');
  f.className = 'mg-impact';
  f.style.left = x+'px'; f.style.top = y+'px';
  f.style.background = `radial-gradient(circle, ${color}, transparent 70%)`;
  container.appendChild(f);
  setTimeout(()=>f.remove(), 460);
}
function shakeElement(el){
  if(!el) return;
  el.classList.remove('mg-shake'); void el.offsetWidth; // force le reflow pour rejouer l'animation même en rafale
  el.classList.add('mg-shake');
}
// Position (x,y) d'un événement de clic, relative au conteneur (pour placer particules/flash au bon endroit).
function eventPosInEl(evt, el){
  const rect = el.getBoundingClientRect();
  const clientX = evt.clientX ?? (evt.touches && evt.touches[0] && evt.touches[0].clientX) ?? rect.width/2;
  const clientY = evt.clientY ?? (evt.touches && evt.touches[0] && evt.touches[0].clientY) ?? rect.height/2;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function startReflex(c){
  $('minigame-area').style.display = 'block';
  setMinigameTheme('fire');
  $('minigame-title').textContent = currentLang==='en' ? '⚡ Reflex — click as soon as the zone turns green' : '⚡ Réflexe — clique dès que la zone devient verte';
  const statLabel = currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL;
  runMinigameCountdown(() => {
  $('minigame-content').innerHTML = `<div class="reflex-zone wait" id="reflex-zone">${currentLang==='en' ? 'Wait…' : 'Attends…'}</div>`;
  const zone = $('reflex-zone');
  let goTime = null, timeout = null, done = false;
  const delay = 800 + Math.random()*2200;
  timeout = setTimeout(()=>{
    goTime = Date.now(); zone.classList.remove('wait'); zone.classList.add('go'); zone.textContent = currentLang==='en' ? 'CLICK!' : 'CLIQUE !';
    spawnImpactFlash(zone, zone.clientWidth/2, zone.clientHeight/2, '#3ecf6e');
  }, delay);
  zone.onclick = async (evt) => {
    if(done) return;
    const {x, y} = eventPosInEl(evt, zone);
    if(goTime === null){
      done = true; clearTimeout(timeout);
      zone.textContent = currentLang==='en' ? 'Too early! Try again.' : 'Trop tôt ! Réessaie.'; zone.classList.remove('go');
      shakeElement(zone);
      spawnParticleBurst(zone, x, y, 'var(--ivory-dim)', 6);
      try{
        const data = await performAction('train_reflex', { tooEarly: true });
        creature = mergeDefaults(data.creature);
        renderCreature(creature);
      } catch(e){ zone.textContent = currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'; console.error(e); }
      return;
    }
    done = true;
    const reactionMs = Date.now() - goTime;
    spawnParticleBurst(zone, x, y, 'var(--ember-bright)', 14);
    spawnImpactFlash(zone, x, y, 'var(--ember-bright)');
    try{
      const data = await performAction('train_reflex', { reactionMs });
      creature = mergeDefaults(data.creature);
      let msg = `${reactionMs}ms — +${data.gain} ${statLabel.crit}`;
      if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
      zone.textContent = msg; zone.classList.remove('go'); zone.classList.add('mg-fly-up');
      renderCreature(creature);
    } catch(e){
      zone.textContent = currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'; zone.classList.remove('go');
      console.error(e);
    }
  };
  });
}
function startMemory(c){
  $('minigame-area').style.display = 'block';
  setMinigameTheme('wind');
  $('minigame-title').textContent = currentLang==='en' ? '🧩 Memory — reproduce the sequence' : '🧩 Mémoire — reproduis la séquence';
  const statLabel = currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL;
  runMinigameCountdown(() => {
  $('minigame-content').innerHTML = `<div class="memory-grid" id="memory-grid"></div><div style="font-family:var(--font-mono);font-size:12px;color:var(--ivory-dim);margin-top:8px;" id="memory-status">${currentLang==='en' ? 'Watch closely…' : 'Regarde bien…'}</div>`;
  const grid = $('memory-grid');
  const tiles = [];
  for(let i=0;i<9;i++){ const t = document.createElement('div'); t.className='memory-tile'; t.dataset.i=i; grid.appendChild(t); tiles.push(t); }
  const seqLen = 4;
  const seq = Array.from({length:seqLen}, ()=>Math.floor(Math.random()*9));
  let playerIdx = 0, accepting = false;
  async function playSequence(){
    for(const idx of seq){
      tiles[idx].classList.add('lit');
      await new Promise(r=>setTimeout(r,450));
      tiles[idx].classList.remove('lit');
      await new Promise(r=>setTimeout(r,180));
    }
    $('memory-status').textContent = currentLang==='en' ? 'Your turn — reproduce the sequence' : 'À toi — reproduis la séquence';
    accepting = true;
  }
  tiles.forEach(t=>{
    t.onclick = async () => {
      if(!accepting) return;
      const idx = parseInt(t.dataset.i);
      if(idx === seq[playerIdx]){
        t.classList.add('correct'); setTimeout(()=>t.classList.remove('correct'),300);
        spawnParticleBurst(t, t.clientWidth/2, t.clientHeight/2, 'var(--blue)', 8);
        playerIdx++;
        if(playerIdx === seq.length){
          accepting = false;
          try{
            const data = await performAction('train_memory', { success: true, playerIdx });
            creature = mergeDefaults(data.creature);
            let msg = currentLang==='en' ? `Perfect! +${data.gain} ${statLabel.dodge}` : `Parfait ! +${data.gain} ${statLabel.dodge}`;
            if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
            $('memory-status').textContent = msg;
            $('memory-status').classList.add('mg-fly-up');
            renderCreature(creature);
          } catch(e){ $('memory-status').textContent = currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'; console.error(e); }
        }
      } else {
        t.classList.add('wrong'); setTimeout(()=>t.classList.remove('wrong'),300);
        shakeElement(grid);
        spawnParticleBurst(t, t.clientWidth/2, t.clientHeight/2, 'var(--danger)', 8);
        accepting = false;
        try{
          const data = await performAction('train_memory', { success: false, playerIdx });
          creature = mergeDefaults(data.creature);
          let msg = currentLang==='en'
            ? `Missed at step ${playerIdx+1} — +${data.gain} ${statLabel.dodge} anyway`
            : `Raté à l'étape ${playerIdx+1} — +${data.gain} ${statLabel.dodge} quand même`;
          if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
          $('memory-status').textContent = msg;
          renderCreature(creature);
        } catch(e){ $('memory-status').textContent = currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'; console.error(e); }
      }
    };
  });
  playSequence();
  });
}
function genericBar(c, opts){
  // opts: {label, statusEl id via minigame-content already set, stat, extraClass}
  const track = $('rhythm-track');
  const marker = $('rhythm-marker');
  let pos = 0, dir = 1, raf, done = false;
  const speed = 1.6;
  function animate(){
    pos += dir*speed;
    if(pos >= 100){ pos = 100; dir = -1; }
    if(pos <= 0){ pos = 0; dir = 1; }
    marker.style.left = pos + '%';
    raf = requestAnimationFrame(animate);
  }
  animate();
  track.onclick = async (evt) => {
    if(done) return;
    done = true; cancelAnimationFrame(raf);
    const distFromCenter = Math.abs(pos - 50);
    const {x, y} = eventPosInEl(evt, track);
    const accent = opts.stat === 'magic' ? 'var(--violet)' : 'var(--gold-bright)';
    if(distFromCenter < 15){
      spawnImpactFlash(track, x, y, accent);
      spawnParticleBurst(track, x, y, accent, 12);
    } else {
      shakeElement(track);
      spawnParticleBurst(track, x, y, 'var(--ivory-dim)', 5);
    }
    try{
      const data = await performAction('train_rhythm', { distFromCenter });
      creature = mergeDefaults(data.creature);
      let msg = `+${data.gain} ${opts.label}`;
      if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
      $('rhythm-status').textContent = msg;
      $('rhythm-status').classList.add('mg-fly-up');
      renderCreature(creature);
    } catch(e){ $('rhythm-status').textContent = currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'; console.error(e); }
  };
}
function startRhythm(c){
  $('minigame-area').style.display = 'block';
  setMinigameTheme('earth');
  $('minigame-title').textContent = currentLang==='en' ? '🎵 Rhythm — click when the cursor is in the golden zone' : '🎵 Rythme — clique quand le curseur est dans la zone dorée';
  runMinigameCountdown(() => {
  $('minigame-content').innerHTML = `<div class="rhythm-track" id="rhythm-track"><div class="rhythm-zone"></div><div class="rhythm-marker" id="rhythm-marker" style="left:0%"></div></div><div style="font-family:var(--font-mono);font-size:12px;color:var(--ivory-dim);" id="rhythm-status">${currentLang==='en' ? 'Click at the right moment…' : 'Clique au bon moment…'}</div>`;
  genericBar(c, {stat:'stamina', game:'rhythm', label:(currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL).stamina});
  });
}
const ARCANE_RUNES = ['᛭','ᚨ','ᛟ','ᚱ','ᛝ','ᛒ'];
const ARCANE_ROUNDS = 5;
const ARCANE_ROUND_TIME = 1800; // ms

function startArcane(c){
  $('minigame-area').style.display = 'block';
  setMinigameTheme('water');
  $('minigame-title').textContent = currentLang==='en' ? '🔮 Invocation — click the rune matching the one shown, before the timer runs out' : '🔮 Invocation — clique la rune identique à celle affichée, avant la fin du sablier';
  let round = 0, totalScore = 0, roundActive = false, timerRaf, roundStart;

  function playRound(){
    round++;
    const target = ARCANE_RUNES[Math.floor(Math.random()*ARCANE_RUNES.length)];
    const choices = new Set([target]);
    while(choices.size < 4) choices.add(ARCANE_RUNES[Math.floor(Math.random()*ARCANE_RUNES.length)]);
    const shuffled = Array.from(choices).sort(()=>Math.random()-0.5);

    $('arcane-target').textContent = target;
    $('arcane-status').textContent = currentLang==='en' ? `Round ${round} / ${ARCANE_ROUNDS}` : `Manche ${round} / ${ARCANE_ROUNDS}`;
    const grid = $('rune-grid');
    grid.innerHTML = '';
    shuffled.forEach(sym=>{
      const btn = document.createElement('button');
      btn.className = 'rune-btn';
      btn.textContent = sym;
      btn.onclick = () => resolveRound(sym === target);
      grid.appendChild(btn);
    });

    roundActive = true;
    roundStart = Date.now();
    const timerBar = $('arcane-timer');
    const targetEl = $('arcane-target');
    function tick(){
      if(!roundActive) return;
      const elapsed = Date.now() - roundStart;
      const pct = Math.max(0, 100 - (elapsed / ARCANE_ROUND_TIME) * 108);
      timerBar.style.width = pct + '%';
      targetEl.style.setProperty('--arcane-pct', Math.max(0, pct));
      if(elapsed >= ARCANE_ROUND_TIME){ resolveRound(false); return; }
      timerRaf = requestAnimationFrame(tick);
    }
    tick();
  }

  async function resolveRound(correct){
    if(!roundActive) return;
    roundActive = false;
    cancelAnimationFrame(timerRaf);
    const elapsed = Date.now() - roundStart;
    const grid = $('rune-grid');
    if(correct){
      const speedBonus = Math.max(0, Math.round((ARCANE_ROUND_TIME - elapsed) / 100));
      totalScore += 3 + speedBonus;
      grid.style.opacity = '0.5';
      spawnParticleBurst(grid, grid.clientWidth/2, grid.clientHeight/2, 'var(--violet)', 10);
      spawnParticleBurst(grid, grid.clientWidth/2, grid.clientHeight/2, 'var(--gold-bright)', 6);
    } else {
      shakeElement(grid);
    }
    await new Promise(r=>setTimeout(r, 250));
    if(round < ARCANE_ROUNDS){
      $('rune-grid').style.opacity = '1';
      playRound();
    } else {
      try{
        const data = await performAction('train_arcane', { totalScore });
        creature = mergeDefaults(data.creature);
        const magicLabel = (currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL).magic;
        const uniqueMsg = data.uniqueFound
          ? (currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`)
          : '';
        $('minigame-content').innerHTML = currentLang==='en'
          ? `<div style="font-family:var(--font-mono);font-size:13px;color:var(--ivory-dim);text-align:center;padding:20px 0;">Invocation complete — <span style="color:var(--violet);">+${data.gain} ${magicLabel}</span>${uniqueMsg}</div>`
          : `<div style="font-family:var(--font-mono);font-size:13px;color:var(--ivory-dim);text-align:center;padding:20px 0;">Invocation terminée — <span style="color:var(--violet);">+${data.gain} ${magicLabel}</span>${uniqueMsg}</div>`;
        renderCreature(creature);
      } catch(e){
        $('minigame-content').innerHTML = currentLang==='en'
          ? `<div style="font-family:var(--font-mono);font-size:13px;color:var(--danger);text-align:center;padding:20px 0;">Error — try again later.</div>`
          : `<div style="font-family:var(--font-mono);font-size:13px;color:var(--danger);text-align:center;padding:20px 0;">Erreur — réessaie plus tard.</div>`;
        console.error(e);
      }
    }
  }
  runMinigameCountdown(() => {
    $('minigame-content').innerHTML = `
      <div class="arcane-target" id="arcane-target">?</div>
      <div class="bar-track" style="margin:10px 0;"><div class="bar-fill" id="arcane-timer" style="width:100%;background:var(--violet);"></div></div>
      <div class="rune-grid" id="rune-grid"></div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--ivory-dim);margin-top:8px;" id="arcane-status">${currentLang==='en' ? `Round 1 / ${ARCANE_ROUNDS}` : `Manche 1 / ${ARCANE_ROUNDS}`}</div>
    `;
    playRound();
  });
}


// ============================================================
// ============ RENDU DONJON (normal + corrompu) ============
// ============================================================
function renderDungeonPanel(c){
  $('floor-num').textContent = c.dungeonFloor;
  $('your-power').textContent = totalPower(c);
  $('floor-power').textContent = floorRequirement(c.dungeonFloor);
  const attemptsLeft = c.dungeonDay === todayKey() ? Math.max(0, maxDungeonAttempts(c) - c.dungeonAttempts) : maxDungeonAttempts(c);
  const clearsLeft = c.dungeonDay === todayKey() ? Math.max(0, maxDungeonClears(c) - c.dungeonClears) : maxDungeonClears(c);
  if(currentLang === 'en'){
    $('dungeon-attempts-text').textContent = attemptsLeft > 0 ? `${attemptsLeft} failure${attemptsLeft>1?'s':''} allowed today` : "No more failures allowed today";
    $('dungeon-clears-text').textContent = clearsLeft > 0 ? `${clearsLeft} floor${clearsLeft>1?'s':''} climbable today` : "Daily floor cap reached";
  } else {
    $('dungeon-attempts-text').textContent = attemptsLeft > 0 ? `${attemptsLeft} échec${attemptsLeft>1?'s':''} autorisé${attemptsLeft>1?'s':''} aujourd'hui` : "Plus d'échecs autorisés aujourd'hui";
    $('dungeon-clears-text').textContent = clearsLeft > 0 ? `${clearsLeft} étage${clearsLeft>1?'s':''} franchissable${clearsLeft>1?'s':''} aujourd'hui` : "Plafond d'étages du jour atteint";
  }
  $('btn-climb').disabled = c.stage === 0 || attemptsLeft === 0 || clearsLeft === 0;
  const pipRow = $('dungeon-pip-row'); pipRow.innerHTML = '';
  const used = c.dungeonDay === todayKey() ? c.dungeonAttempts : 0;
  for(let i=0;i<maxDungeonAttempts(c);i++){ const pip = document.createElement('div'); pip.className = 'pip ' + (i < used ? 'used' : 'available'); pipRow.appendChild(pip); }

  const xpReward = dungeonXP(c.dungeonFloor);
  const xpFailReward = Math.max(1, Math.round(xpReward * 0.25));
  const rewardEl = $('dungeon-reward-info');
  if(currentLang === 'en'){
    if(isLootFloor(c.dungeonFloor)){
      rewardEl.textContent = `This floor's reward: +${xpReward} XP + 1 item (loot floor). A win costs no failure. Loss: +${xpFailReward} XP anyway.`;
    } else {
      const next = c.dungeonFloor - (c.dungeonFloor % 5) + 5;
      rewardEl.textContent = `This floor's reward: +${xpReward} XP. Next item at floor ${next}. A win costs no failure. Loss: +${xpFailReward} XP anyway.`;
    }
  } else {
    if(isLootFloor(c.dungeonFloor)){
      rewardEl.textContent = `Récompense de cet étage : +${xpReward} XP + 1 objet (palier de butin). Une victoire ne consomme aucun échec. Défaite : +${xpFailReward} XP quand même.`;
    } else {
      const next = c.dungeonFloor - (c.dungeonFloor % 5) + 5;
      rewardEl.textContent = `Récompense de cet étage : +${xpReward} XP. Prochain objet à l'étage ${next}. Une victoire ne consomme aucun échec. Défaite : +${xpFailReward} XP quand même.`;
    }
  }
  renderCodex(c);
}

function renderCorruptPanel(c){
  const eligible = corruptUnlockEligible(c);
  const lockedCard = $('corrupt-locked-card');
  const playCard = $('corrupt-play-card');

  if(!c.corruptUnlocked){
    lockedCard.style.display = 'block';
    playCard.style.display = 'none';
    const reqEl = $('corrupt-req-text');
    const btn = $('btn-unlock-corrupt');
    if(!eligible){
      reqEl.innerHTML = currentLang==='en'
        ? `Missing requirement: reach floor <strong>${CORRUPT_UNLOCK_FLOOR}</strong> of the Wyrm Tower (currently floor ${c.dungeonFloor}).`
        : `Condition manquante : atteindre l'étage <strong>${CORRUPT_UNLOCK_FLOOR}</strong> de la Tour du Wyrm (actuellement étage ${c.dungeonFloor}).`;
      reqEl.style.color = 'var(--ember-bright)';
      btn.disabled = true;
    } else if((c.moltcoins||0) < CORRUPT_UNLOCK_COST){
      reqEl.innerHTML = currentLang==='en'
        ? `Floor ${CORRUPT_UNLOCK_FLOOR} reached ✓ — you're missing Moltcoins (${c.moltcoins||0} / ${CORRUPT_UNLOCK_COST}).`
        : `Étage ${CORRUPT_UNLOCK_FLOOR} atteint ✓ — il te manque des Moltcoins (${c.moltcoins||0} / ${CORRUPT_UNLOCK_COST}).`;
      reqEl.style.color = 'var(--ivory-dim)';
      btn.disabled = true;
    } else {
      reqEl.innerHTML = currentLang==='en'
        ? `Floor ${CORRUPT_UNLOCK_FLOOR} reached ✓ — the passage can be opened.`
        : `Étage ${CORRUPT_UNLOCK_FLOOR} atteint ✓ — le passage peut être ouvert.`;
      reqEl.style.color = '#4ea88a';
      btn.disabled = false;
    }
    return;
  }

  lockedCard.style.display = 'none';
  playCard.style.display = 'block';

  $('corrupt-floor-num').textContent = c.corruptFloor;
  $('corrupt-your-power').textContent = totalPower(c);
  $('corrupt-floor-power').textContent = corruptFloorRequirement(c.corruptFloor);
  const attemptsLeft = c.corruptDay === todayKey() ? Math.max(0, maxCorruptAttempts(c) - c.corruptAttempts) : maxCorruptAttempts(c);
  const clearsLeft = c.corruptDay === todayKey() ? Math.max(0, maxCorruptClears(c) - c.corruptClears) : maxCorruptClears(c);
  if(currentLang === 'en'){
    $('corrupt-attempts-text').textContent = attemptsLeft > 0 ? `${attemptsLeft} failure${attemptsLeft>1?'s':''} allowed today` : "No more failures allowed today";
    $('corrupt-clears-text').textContent = clearsLeft > 0 ? `${clearsLeft} floor${clearsLeft>1?'s':''} climbable today` : "Daily floor cap reached";
  } else {
    $('corrupt-attempts-text').textContent = attemptsLeft > 0 ? `${attemptsLeft} échec${attemptsLeft>1?'s':''} autorisé${attemptsLeft>1?'s':''} aujourd'hui` : "Plus d'échecs autorisés aujourd'hui";
    $('corrupt-clears-text').textContent = clearsLeft > 0 ? `${clearsLeft} étage${clearsLeft>1?'s':''} franchissable${clearsLeft>1?'s':''} aujourd'hui` : "Plafond d'étages du jour atteint";
  }
  $('btn-climb-corrupt').disabled = c.stage === 0 || attemptsLeft === 0 || clearsLeft === 0;
  const pipRow = $('corrupt-pip-row'); pipRow.innerHTML = '';
  const used = c.corruptDay === todayKey() ? c.corruptAttempts : 0;
  for(let i=0;i<maxCorruptAttempts(c);i++){ const pip = document.createElement('div'); pip.className = 'pip ' + (i < used ? 'used' : 'available'); pipRow.appendChild(pip); }

  const xpReward = corruptXP(c.corruptFloor);
  const xpFailReward = Math.max(1, Math.round(xpReward * 0.25));
  const rewardEl = $('corrupt-reward-info');
  if(currentLang === 'en'){
    if(isCorruptLootFloor(c.corruptFloor)){
      rewardEl.textContent = `This floor's reward: +${xpReward} XP + 1 Sanctuary-exclusive item. Loss: +${xpFailReward} XP anyway.`;
    } else {
      const next = c.corruptFloor - (c.corruptFloor % 5) + 5;
      rewardEl.textContent = `This floor's reward: +${xpReward} XP. Next item at floor ${next}. Loss: +${xpFailReward} XP anyway.`;
    }
  } else {
    if(isCorruptLootFloor(c.corruptFloor)){
      rewardEl.textContent = `Récompense de cet étage : +${xpReward} XP + 1 objet exclusif au Sanctuaire. Défaite : +${xpFailReward} XP quand même.`;
    } else {
      const next = c.corruptFloor - (c.corruptFloor % 5) + 5;
      rewardEl.textContent = `Récompense de cet étage : +${xpReward} XP. Prochain objet à l'étage ${next}. Défaite : +${xpFailReward} XP quand même.`;
    }
  }
}


// ============================================================
// ============ CHASSE AU TRÉSOR ============
// ============================================================
function formatMinutes(ms){
  const totalMin = Math.max(0, Math.ceil(ms/60000));
  const h = Math.floor(totalMin/60), m = totalMin%60;
  return h > 0 ? `${h}h${m.toString().padStart(2,'0')}` : `${m}min`;
}
function renderTreasurePanel(c){
  if(c.stage === 0) return;
  regenTreasureAP(c);
  const cap = maxTreasureAP(c);
  $('moltcoin-balance').textContent = c.moltcoins || 0;
  const pipRow = $('treasure-pip-row'); pipRow.innerHTML = '';
  for(let i=0;i<cap;i++){ const pip = document.createElement('div'); pip.className = 'pip ' + (i < c.treasureAP ? 'available' : 'used'); pipRow.appendChild(pip); }
  const rechargeEl = $('treasure-recharge-text');
  if(c.treasureAP >= cap){
    rechargeEl.textContent = "Points d'action au maximum.";
  } else {
    const msUntilNext = TREASURE_AP_REGEN_MS - (Date.now() - c.treasureAPLastTick);
    rechargeEl.textContent = `Prochain point d'action dans ${formatMinutes(msUntilNext)} (1 par heure).`;
  }
  $('btn-dig').disabled = c.treasureAP <= 0;

  // Pastille rouge sur l'onglet Chasse aux trésors : allumée tant qu'il reste au moins
  // un point d'action disponible (même logique que les Coffres/Récompenses).
  const dotHTML = '<span class="notif-dot"></span>';
  const treasureHasAP = c.treasureAP > 0;
  const treasureLabel = currentLang === 'en' ? (I18N_EN.tab_treasure || 'Treasure Hunt') : 'Chasse aux trésors';
  $('treasure-tab').innerHTML = treasureLabel + (treasureHasAP ? dotHTML : '');

  // Pastille sur le menu parent "Jouer" : allumée dans ce cas précis (PA de trésor
  // disponibles) — à combiner ici avec d'autres conditions si le menu Jouer en gagne
  // d'autres plus tard.
  const playLabel = currentLang === 'en' ? (I18N_EN.tab_play || 'Play') : 'Jouer';
  $('play-parent').innerHTML = playLabel + ' <span class="caret">▾</span>' + (treasureHasAP ? dotHTML : '');

  const logEl = $('treasure-log');
  const history = c.treasureHistory || [];
  logEl.innerHTML = '';
  const recent = history.slice(-10);
  for(let i = recent.length - 1; i >= 0; i--){
    const h = recent[i];
    const dateStr = new Date(h.ts).toLocaleString('fr-FR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
    let msg = `${dateStr} — +${h.coins} Moltcoins 🪙`;
    if(h.itemName){ msg += ` — objet trouvé : ${h.itemName} (${RARITY_LABEL[h.itemRarity]})`; }
    const div = document.createElement('div');
    if(h.itemName) div.className = 'good';
    div.textContent = msg;
    logEl.appendChild(div);
  }
}


// ============================================================
// ============ CODEX / RECUEIL ============
// ============================================================
function renderCodex(c){
  const owned = new Set((c && c.inventory ? c.inventory : []).map(i => i.defId).filter(Boolean));
  const groups = {common:'codex-common', rare:'codex-rare', epic:'codex-epic', legendary:'codex-legendary'};
  const titles = currentLang === 'en'
    ? {common:'Common Items', rare:'Rare Items', epic:'Epic Items', legendary:'Legendary Items'}
    : {common:'Objets Communs', rare:'Objets Rares', epic:'Objets Épiques', legendary:'Objets Légendaires'};
  const statLabel = currentLang === 'en' ? STAT_LABEL_EN : STAT_LABEL;
  const ownedLabel = currentLang === 'en' ? '✓ Owned' : '✓ Obtenu';
  const lockedLabel = currentLang === 'en' ? '🔒 Not owned' : '🔒 Non obtenu';
  Object.entries(groups).forEach(([rarity, elId])=>{
    const wyrmItems = ITEM_DB.filter(i => i.rarity === rarity).map(i => ({...i, tag:'TW'}));
    const corruptItems = CORRUPT_ITEM_DB.filter(i => i.rarity === rarity).map(i => ({...i, tag:'SC'}));
    const items = [...wyrmItems, ...corruptItems];
    const card = $(elId);
    if(!card) return;
    const minFloor = wyrmItems.length ? Math.min(...wyrmItems.map(i => i.minFloor)) : null;
    const floorTxt = minFloor !== null ? ` <span class="meta" style="font-size:11px;font-weight:normal;">— ${currentLang==='en' ? `from floor ${minFloor}` : `dès l'étage ${minFloor}`}</span>` : '';
    let html = `<h2 class="rarity-${rarity}">${titles[rarity]}${floorTxt}</h2><ul class="codex-list">`;
    items.forEach(def=>{
      const has = owned.has(def.id);
      const name = currentLang==='en' ? (def.name_en||def.name) : def.name;
      const statTxt = def.stat2 ? `+${def.value} ${statLabel[def.stat]} / +${def.value2} ${statLabel[def.stat2]}` : `+${def.value} ${statLabel[def.stat]}`;
      html += `<li><span class="name">${name} <span class="meta">— ${statTxt} · <strong>${def.tag}</strong></span></span><span class="${has ? 'owned' : 'locked'}">${has ? ownedLabel : lockedLabel}</span></li>`;
    });
    html += '</ul>';
    card.innerHTML = html;
  });
  const uniqueCard = $('codex-unique');
  if(uniqueCard){
    const sourceLabel = currentLang === 'en'
      ? {treasure:'Treasure Hunt', dungeon:'Dungeons', boss:'Weekly World Boss ranking', chests:'Daily Chests', training:'Training', shop_real_money:'Real-money Shop purchase'}
      : {treasure:'Chasse au trésor', dungeon:'Donjons', boss:'Classement hebdo du Boss Mondial', chests:'Coffres quotidiens', training:'Entraînement', shop_real_money:'Achat en argent réel (Boutique)'};
    const uniqueTitle = currentLang === 'en' ? '✦ Moltyx — Unique Items' : '✦ Moltyx — Objets Uniques';
    const uniqueDesc = currentLang === 'en' ? 'Only one possible per player. Powerful, permanent effects — all equip in addition to your 5 normal items.' : 'Un seul exemplaire possible par joueur. Effets puissants et permanents — s\'équipent tous en plus des 5 objets normaux.';
    const sourceWord = currentLang === 'en' ? 'source' : 'source';
    let html = `<h2 class="rarity-unique">${uniqueTitle}</h2><p style="font-size:12px;color:var(--ivory-dim);margin-top:-4px;">${uniqueDesc}</p><ul class="codex-list">`;
    UNIQUE_ITEM_DB.forEach(def=>{
      const has = owned.has(def.id);
      const name = currentLang==='en' ? (def.name_en||def.name) : def.name;
      const desc = currentLang==='en' ? (def.description_en||def.description) : def.description;
      html += `<li><span class="name">${name} <span class="meta">— ${desc} · ${sourceWord} : ${sourceLabel[def.source]||'?'}</span></span><span class="${has ? 'owned' : 'locked'}">${has ? ownedLabel : lockedLabel}</span></li>`;
    });
    html += '</ul>';
    uniqueCard.innerHTML = html;
  }
  const consumCard = $('codex-consumables');
  if(consumCard){
    const candyTitle = currentLang === 'en' ? '🍬 Consumable Candies' : '🍬 Bonbons Consommables';
    const candyDesc = currentLang === 'en' ? 'Obtained via the Season Pass (Premium track). Consume them from the Backpack to restore attempts for the day.' : 'Obtenus via le Pass Saisonnier (voie Premium). Se consomment depuis le Sac à dos pour restaurer des tentatives du jour même.';
    const inStock = currentLang === 'en' ? (n) => `✓ ×${n} in stock` : (n) => `✓ ×${n} en stock`;
    const noStock = currentLang === 'en' ? '🔒 None in stock' : '🔒 Aucun en stock';
    let html = `<h2 style="color:var(--ember-bright);">${candyTitle}</h2><p style="font-size:12px;color:var(--ivory-dim);margin-top:-4px;">${candyDesc}</p><ul class="codex-list">`;
    CONSUMABLE_DB.forEach(def=>{
      const qty = (c && c.consumables) ? (c.consumables[def.id]||0) : 0;
      const name = currentLang==='en' ? (def.name_en||def.name) : def.name;
      const desc = currentLang==='en' ? (def.desc_en||def.desc) : def.desc;
      html += `<li><span class="name">${def.icon} ${name} <span class="meta">— ${desc}</span></span><span class="${qty>0 ? 'owned' : 'locked'}">${qty>0 ? inStock(qty) : noStock}</span></li>`;
    });
    html += '</ul>';
    consumCard.innerHTML = html;
  }
  const bossTiersTable = $('codex-boss-tiers');
  if(bossTiersTable){
    let html = `<tr><th>Rang</th><th>XP</th><th>Moltcoins 🪙</th><th>Chance d'Eclat du Monde</th></tr>`;
    BOSS_RANK_TIERS.forEach(t=>{
      const label = t.min === 1 && t.max === 1 ? '#1' : (t.max === Infinity ? `#${t.min}+` : `#${t.min}-${t.max}`);
      html += `<tr><td>${label}</td><td>${t.xp}</td><td>${t.moltcoins}</td><td>${(t.moltyxChance*100).toFixed(2).replace(/\.?0+$/,'')}%</td></tr>`;
    });
    bossTiersTable.innerHTML = html;
  }
}


// ============================================================
// ============ RESTAURATION DE COMPTE & INITIALISATION ============
// Récupération via code de sauvegarde, bootstrap complet de
// l'application (init/confirmUsername/startApp).
// ============================================================
function restoreFromCode(code, statusEl){
  if(!code){ statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Colle d\'abord un code de récupération.'; return; }
  if(!confirm('Restaurer ce code va remplacer la progression actuelle de cet appareil par celle liée à ce code. Continuer ?')) return;
  localStorage.setItem('moltchi_player_scope', code);
  location.reload();
}

let creature, myId, boss;
async function init(){
  const savedLang = await loadLanguage();
  applyLanguage(savedLang || 'fr');
  $('btn-pre-restore-recovery').onclick = () => {
    restoreFromCode($('pre-recovery-code-input').value.trim(), $('pre-recovery-status'));
  };
  myId = await getUsername();
  if(!myId){
    $('username-card').style.display = 'block';
    $('main-app').style.display = 'none';
    $('btn-confirm-username').onclick = confirmUsername;
    $('username-input').onkeydown = (e) => { if(e.key === 'Enter') confirmUsername(); };
    return;
  }
  await startApp();
}

async function confirmUsername(){
  const val = $('username-input').value.trim();
  const errorEl = $('username-error');
  if(val.length < 2 || val.length > 18){
    errorEl.textContent = 'Choisis un pseudo entre 2 et 18 caractères.';
    errorEl.style.display = 'block';
    return;
  }
  try{
    await setUsername(val);
  } catch(e){
    errorEl.textContent = e.message === 'ce pseudo est déjà pris'
      ? 'Ce pseudo est déjà pris — choisis-en un autre.'
      : 'Erreur — réessaie plus tard.';
    errorEl.style.display = 'block';
    return;
  }
  errorEl.style.display = 'none';
  myId = val;
  $('username-card').style.display = 'none';
  await startApp();
}

async function handleStripeReturn(){
  const params = new URLSearchParams(window.location.search);
  const status = params.get('stripe');
  if(!status) return;
  // Nettoie l'URL tout de suite pour éviter un retraitement si le joueur recharge la page
  window.history.replaceState({}, '', window.location.pathname);

  if(status === 'cancel'){
    log(currentLang==='en' ? 'Payment cancelled.' : 'Paiement annulé.', 'hit');
    return;
  }
  if(status !== 'success') return;

  // Le webhook Stripe est quasi instantané mais pas garanti avant cette redirection ;
  // on retente la synchronisation quelques secondes si le déblocage n'est pas encore là.
  for(let i=0; i<6; i++){
    if(creature.battlepass && creature.battlepass.premiumUnlocked) break;
    await new Promise(r => setTimeout(r, 1500));
    try{
      const data = await performAction('sync', {});
      creature = mergeDefaults(data.creature);
    } catch(e){ console.error(e); }
  }
  renderCreature(creature);
  if(creature.battlepass && creature.battlepass.premiumUnlocked){
    log(currentLang==='en' ? 'Payment confirmed — Premium track unlocked!' : 'Paiement confirmé — voie Premium débloquée !', 'good');
  } else {
    log(currentLang==='en'
      ? 'Payment received — it may take a little longer to unlock. Reload the page in a moment.'
      : 'Paiement bien reçu — le déblocage peut prendre un peu plus de temps. Recharge la page dans un instant.', 'hit');
  }
}

async function startApp(){
  $('main-app').style.display = 'block';
  creature = await loadCreature();
  if(creature.stage > 0){
    try{
      const data = await performAction('sync', {});
      creature = mergeDefaults(data.creature);
    } catch(e){ console.error('sync échoué :', e); }
  }
  renderCreature(creature);
  await handleStripeReturn();

  boss = await loadBoss();
  renderBoss(boss);
  const lb = await loadLeaderboard();
  renderLeaderboard(lb, myId);
  await renderPendingBossRewards();

  chatLastSentLocal = await getLastChatSent();
  renderChat(await loadChat());
  updateChatCooldownUI();
  $('btn-chat-send').onclick = sendChatMessage;
  $('chat-input').onkeydown = (e) => { if(e.key === 'Enter') sendChatMessage(); };
  $('chat-bubble-btn').onclick = () => { $('chat-bubble-window').classList.toggle('open'); };
  $('chat-bubble-close').onclick = () => { $('chat-bubble-window').classList.remove('open'); };
  setInterval(updateChatCooldownUI, 1000);
  setInterval(async () => {
    let raw = [];
    try{ const r = await window.storage.get('chat:messages', true); raw = JSON.parse(r.value) || []; }catch(e){ raw = []; }
    renderChat(pruneOldChatMessages(raw));
    // Note : la purge des vieux messages est désormais gérée côté serveur (Edge Function
    // send-chat-message, appelée à chaque envoi), car l'écriture cliente directe sur
    // scope='shared' est bloquée par RLS. Ici on ne fait que rafraîchir l'affichage.
  }, 4000);
  setInterval(() => {
    if(!creature || creature.stage === 0) return;
    function formatTimeLeft(ms){
      const h = Math.floor(ms/3600000);
      const m = Math.floor((ms%3600000)/60000);
      return `${h}h ${String(m).padStart(2,'0')}min avant reset`;
    }
    const now = new Date();
    const nextMidnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1, 0,0,0,0));
    const dailyTimerEl = $('daily-quests-timer');
    if(dailyTimerEl) dailyTimerEl.textContent = formatTimeLeft(nextMidnightUTC - now);
    const nextMonday = new Date(mondayStartOf(now).getTime() + 7*24*60*60*1000);
    const weeklyTimerEl = $('weekly-quests-timer');
    if(weeklyTimerEl) weeklyTimerEl.textContent = formatTimeLeft(nextMonday - now);
  }, 30000);

  $('btn-rename-toggle').onclick = () => {
    const row = $('rename-row');
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    $('rename-input').value = creature.name || '';
  };
  $('btn-rename-confirm').onclick = async () => {
    const val = $('rename-input').value.trim();
    if(val.length < 1 || val.length > 16) return;
    try{
      const data = await performAction('rename', { name: val });
      creature = mergeDefaults(data.creature);
      $('rename-row').style.display = 'none';
      renderCreature(creature);
    } catch(e){ console.error(e); }
  };

  const recoveryDisplay = $('recovery-code-display');
  if(recoveryDisplay) recoveryDisplay.textContent = localStorage.getItem('moltchi_player_scope') || '';
  $('btn-toggle-recovery-visibility').onclick = () => {
    const hidden = recoveryDisplay.style.filter !== 'none';
    recoveryDisplay.style.filter = hidden ? 'none' : 'blur(5px)';
    $('btn-toggle-recovery-visibility').textContent = hidden ? '🙈 Masquer' : '👁️ Afficher';
  };
  $('btn-copy-recovery').onclick = async () => {
    try{
      await navigator.clipboard.writeText(localStorage.getItem('moltchi_player_scope') || '');
      $('recovery-status').style.color = 'var(--gold)';
      $('recovery-status').textContent = 'Code copié ✓';
    }catch(e){
      $('recovery-status').style.color = 'var(--danger)';
      $('recovery-status').textContent = 'Copie impossible — sélectionne et copie le code manuellement.';
    }
  };

  $('btn-abandon-toggle').onclick = () => {
    const row = $('abandon-confirm-row');
    row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    $('abandon-input').value = '';
  };
  $('btn-abandon-confirm').onclick = async () => {
    if($('abandon-input').value.trim().toUpperCase() !== 'ADIEU') return;
    try{
      const data = await performAction('abandon', {});
      const oldName = data.oldName;
      creature = mergeDefaults(data.creature);
      $('abandon-confirm-row').style.display = 'none';
      renderCreature(creature);
      log(`${oldName} a été abandonné. Un nouveau Moltchi t'attend. Ton classement au Boss Mondial est conservé.`, 'hit');
    } catch(e){ console.error(e); }
  };

  $('btn-feed').onclick = async () => {
    if(careAttemptsLeft(creature) === 0) return;
    try{
      const data = await performAction('care_feed', {});
      creature = mergeDefaults(data.creature);
      renderCreature(creature);
      playActionAnimation(creature, 'eatVideo');
    } catch(e){ console.error(e); }
  };
  $('btn-play').onclick = async () => {
    if(careAttemptsLeft(creature) === 0) return;
    try{
      const data = await performAction('care_play', {});
      creature = mergeDefaults(data.creature);
      renderCreature(creature);
      playActionAnimation(creature, 'playVideo');
    } catch(e){ console.error(e); }
  };
  $('btn-sleep').onclick = async () => {
    if(careAttemptsLeft(creature) === 0) return;
    try{
      const data = await performAction('care_rest', {});
      creature = mergeDefaults(data.creature);
      renderCreature(creature);
      playActionAnimation(creature, 'sleepVideo');
    } catch(e){ console.error(e); }
  };

  $('btn-attack').onclick = async () => {
    const maxAtk = maxBossAttacks(creature);
    const attacksLeftLocal = creature.lastAttackDay === todayKey() ? maxAtk - creature.attacksToday : maxAtk;
    if(attacksLeftLocal <= 0) return;
    $('btn-attack').disabled = true;
    try{
      const res = await fetch('https://oouqtclsffybeloulvph.supabase.co/functions/v1/attack-boss', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ scope: _getPlayerScope() })
      });
      const data = await res.json();
      if(!res.ok){
        const msg = data.error === 'quota d\'attaques atteint'
          ? (currentLang==='en' ? 'No more attacks available today.' : 'Plus d\'attaque disponible aujourd\'hui.')
          : (currentLang==='en' ? 'Attack unavailable right now.' : 'Attaque impossible pour le moment.');
        log(msg, 'hit'); return;
      }
      creature = mergeDefaults(data.creature);
      const boss2 = data.boss;
      boss = boss2;
      const lb2 = data.leaderboard;
      if(data.bossDefeatedNow) log(currentLang==='en'
        ? `${bossDef(boss2).name} is defeated! It respawns immediately — the weekly ranking continues.`
        : `${bossDef(boss2).name} est vaincu ! Il renaît aussitôt — le classement de la semaine continue.`, 'good');
      renderCreature(creature); renderBoss(boss2); renderLeaderboard(lb2, myId);
      await renderPendingBossRewards();
      log(currentLang==='en'
        ? `${creature.name} deals ${data.dmg} damage to the Boss.`
        : `${creature.name} inflige ${data.dmg} dégâts au Boss.`, 'hit');
    } catch(e){
      log(currentLang==='en' ? 'Could not connect to the server — try again.' : 'Connexion au serveur impossible — réessaie.', 'hit');
    } finally {
      $('btn-attack').disabled = false;
    }
  };

  $('btn-start-reflex').onclick = () => startReflex(creature);
  $('btn-start-memory').onclick = () => startMemory(creature);
  $('btn-start-rhythm').onclick = () => startRhythm(creature);
  $('btn-start-arcane').onclick = () => startArcane(creature);

  $('btn-climb').onclick = async () => {
    const attemptsLeft = creature.dungeonDay === todayKey() ? Math.max(0, maxDungeonAttempts(creature) - creature.dungeonAttempts) : maxDungeonAttempts(creature);
    const clearsLeft = creature.dungeonDay === todayKey() ? Math.max(0, maxDungeonClears(creature) - creature.dungeonClears) : maxDungeonClears(creature);
    if(attemptsLeft === 0) return;
    if(clearsLeft === 0) return;
    let data;
    try{ data = await performAction('dungeon_climb', {}); }
    catch(e){ dungeonLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.', 'hit'); console.error(e); return; }
    creature = mergeDefaults(data.creature);
    const moltyxFoundTxt = currentLang==='en'
      ? (n) => ` ✦ Moltyx found: ${n}!`
      : (n) => ` ✦ Moltyx trouvé : ${n} !`;
    if(data.win){
      let msg = currentLang==='en'
        ? `Floor ${data.clearedFloor} cleared! +${data.xpGain} XP.`
        : `Étage ${data.clearedFloor} vaincu ! +${data.xpGain} XP.`;
      if(data.item){
        msg += currentLang==='en'
          ? ` Loot: ${itemDisplayName(data.item)} (${RARITY_LABEL_EN[data.item.rarity]}).`
          : ` Butin : ${itemDisplayName(data.item)} (${RARITY_LABEL[data.item.rarity]}).`;
      } else {
        const next = data.clearedFloor - (data.clearedFloor % 5) + 5;
        msg += currentLang==='en'
          ? ` No loot this time — next item at floor ${next}.`
          : ` Pas de butin cette fois — prochain objet à l'étage ${next}.`;
      }
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      dungeonLog(msg, 'good');
    } else {
      let msg = currentLang==='en'
        ? `Defeat at floor ${data.failFloor}. +${data.xpGain} XP anyway. Strengthen ${creature.name} and try again.`
        : `Défaite à l'étage ${data.failFloor}. +${data.xpGain} XP quand même. Renforce ${creature.name} et retente.`;
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      dungeonLog(msg, 'hit');
    }
    renderCreature(creature);
  };

  $('btn-unlock-corrupt').onclick = async () => {
    if(!corruptUnlockEligible(creature)) return;
    if((creature.moltcoins||0) < CORRUPT_UNLOCK_COST) return;
    try{
      const data = await performAction('dungeon_unlock_corrupt', {});
      creature = mergeDefaults(data.creature);
      log(`Le Sanctuaire Corrompu s'ouvre à ${creature.name}...`, 'good');
      renderCreature(creature);
    } catch(e){ log('Erreur — réessaie plus tard.', 'hit'); console.error(e); }
  };

  $('btn-climb-corrupt').onclick = async () => {
    if(!creature.corruptUnlocked) return;
    const attemptsLeft = creature.corruptDay === todayKey() ? Math.max(0, maxCorruptAttempts(creature) - creature.corruptAttempts) : maxCorruptAttempts(creature);
    const clearsLeft = creature.corruptDay === todayKey() ? Math.max(0, maxCorruptClears(creature) - creature.corruptClears) : maxCorruptClears(creature);
    if(attemptsLeft === 0) return;
    if(clearsLeft === 0) return;
    let data;
    try{ data = await performAction('dungeon_climb_corrupt', {}); }
    catch(e){ dungeonLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.', 'hit', 'corrupt-log'); console.error(e); return; }
    creature = mergeDefaults(data.creature);
    const moltyxFoundTxt = currentLang==='en'
      ? (n) => ` ✦ Moltyx found: ${n}!`
      : (n) => ` ✦ Moltyx trouvé : ${n} !`;
    if(data.win){
      let msg = currentLang==='en'
        ? `Sanctuary floor ${data.clearedFloor} cleared! +${data.xpGain} XP.`
        : `Étage ${data.clearedFloor} du Sanctuaire vaincu ! +${data.xpGain} XP.`;
      if(data.item){
        msg += currentLang==='en'
          ? ` Loot: ${itemDisplayName(data.item)} (${RARITY_LABEL_EN[data.item.rarity]}).`
          : ` Butin : ${itemDisplayName(data.item)} (${RARITY_LABEL[data.item.rarity]}).`;
      } else {
        const next = data.clearedFloor - (data.clearedFloor % 5) + 5;
        msg += currentLang==='en'
          ? ` No loot this time — next item at floor ${next}.`
          : ` Pas de butin cette fois — prochain objet à l'étage ${next}.`;
      }
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      dungeonLog(msg, 'good', 'corrupt-log');
    } else {
      let msg = currentLang==='en'
        ? `Defeat at Sanctuary floor ${data.failFloor}. +${data.xpGain} XP anyway. Strengthen ${creature.name} and try again.`
        : `Défaite à l'étage ${data.failFloor} du Sanctuaire. +${data.xpGain} XP quand même. Renforce ${creature.name} et retente.`;
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      dungeonLog(msg, 'hit', 'corrupt-log');
    }
    renderCreature(creature);
  };

  $('btn-dig').onclick = async () => {
    if(creature.treasureAP <= 0) return;
    try{
      const data = await performAction('treasure_dig', {});
      creature = mergeDefaults(data.creature);
      renderCreature(creature);
    } catch(e){ console.error(e); }
  };

  if(!window.__moltchiTreasureInterval){
    window.__moltchiTreasureInterval = setInterval(() => { if(creature && creature.stage > 0) renderTreasurePanel(creature); }, 30000);
  }
}
init();

// PWA : enregistre le Service Worker (nécessaire pour l'installabilité sur la plupart
// des navigateurs). Échec silencieux si indisponible (ex: navigateur trop ancien) —
// le jeu continue de fonctionner normalement, juste sans installation possible.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('Service Worker non enregistré :', e));
  });
}
