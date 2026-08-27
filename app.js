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
// État des succès du joueur (permanent, indépendant de `creature` — voir section
// SUCCÈS / HAUTS FAITS plus bas). Mis à jour automatiquement à chaque appel serveur
// qui en renvoie une version à jour, pour ne pas avoir à toucher chaque site d'appel.
let achievements = null;

async function performAction(action, payload){
  const res = await fetch(`${SUPABASE_URL}/functions/v1/perform-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
    body: JSON.stringify({ scope: _getPlayerScope(), action, payload })
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || 'action refusée par le serveur');
  if(data.achievements){
    achievements = data.achievements;
    if(data.newlyUnlocked && data.newlyUnlocked.length) showAchievementToasts(data.newlyUnlocked);
  }
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
  // Cache mémoire de l'état privé du joueur (creature, username, language, ...),
  // rempli une seule fois via l'Edge Function load-state (service_role). Depuis le
  // verrouillage de la policy SELECT de kv_store à scope='shared' uniquement (la
  // scope étant aussi le code de récupération — un secret — RLS ne peut plus la
  // laisser lisible publiquement), un SELECT direct sur son propre scope n'est
  // plus possible côté client : voir la conversation du 8 août 2026 / load-state.ts.
  _privateCache: null,
  _privateCachePromise: null,
  async _loadPrivateState(force=false){
    if(force){ this._privateCache = null; this._privateCachePromise = null; }
    if(this._privateCache) return this._privateCache;
    if(!this._privateCachePromise){
      this._privateCachePromise = fetch(`${SUPABASE_URL}/functions/v1/load-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
        body: JSON.stringify({ scope: _getPlayerScope() })
      }).then(async res => {
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || 'lecture refusée par le serveur');
        this._privateCache = data.values || {};
        return this._privateCache;
      }).finally(() => { this._privateCachePromise = null; });
    }
    return this._privateCachePromise;
  },
  async get(key, shared=false){
    if(shared){
      const { data, error } = await _sb.from('kv_store').select('value').eq('scope', 'shared').eq('key', key).maybeSingle();
      if(error) throw error;
      if(!data) throw new Error('not found');
      const raw = typeof data.value === 'string' ? data.value : JSON.stringify(data.value);
      return { key, value: raw, shared };
    }
    const values = await this._loadPrivateState();
    if(!(key in values)) throw new Error('not found');
    const raw = typeof values[key] === 'string' ? values[key] : JSON.stringify(values[key]);
    return { key, value: raw, shared };
  },
  // Écriture directe désactivée : RLS ne permet plus d'INSERT/UPDATE anon sur kv_store
  // (voir SQL fourni). Toute écriture doit passer par performAction(...) (perform-action.ts,
  // set_username, set_language, set_pref...), qui écrit en service_role après validation.
  async set(key, value, shared=false){
    throw new Error(`écriture directe désactivée pour "${key}" — utilise performAction(...) à la place`);
  },
  async delete(key, shared=false){
    throw new Error(`suppression directe désactivée pour "${key}" — utilise performAction(...) à la place`);
  },
  async list(prefix='', shared=false){
    if(shared){
      const { data, error } = await _sb.from('kv_store').select('key').eq('scope', 'shared').like('key', prefix + '%');
      if(error) throw error;
      return { keys: (data||[]).map(r=>r.key), prefix, shared };
    }
    const values = await this._loadPrivateState();
    return { keys: Object.keys(values).filter(k => k.startsWith(prefix)), prefix, shared };
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
  tab_achievements: '🏆 Achievements',
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
  h2_noyau_locked: '🔒 Primordial Core',
  h2_noyau: 'Primordial Core',
  h2_pending_rewards: '🎁 Last week\'s rewards',
  h2_contributors: 'Contributors ranking',
  h2_codex_title: 'Compendium',
  h2_daily_quests: 'Daily quests',
  h2_weekly_quests: 'Weekly quests',
  h2_reward_tiers: 'Reward tiers',
  h2_achievements: '🏆 Achievements & Milestones',
  p_achievements_intro: 'Permanent accomplishments, independent from the Season Pass — they never reset, even if you abandon your Moltchi. Pick one as the title shown on your companion card.',
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
  btn_climb_noyau: '🌀 Try the floor',
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
  p_formula_boss_damage: '<strong>Boss Damage</strong> = (Crit (Fire) + Magic (Water) + Stamina (Earth) + Speed (Wind)) × Wellbeing — same principle as Dungeon Power. The final result varies slightly on each attack (±15%) to keep things suspenseful.',
  p_formula_dungeon_power: '<strong>Dungeon Power</strong> = (Level + Crit (Fire) + Speed (Wind) + Stamina (Earth) + Magic (Water)) × Wellbeing. Each Dungeon floor requires more Power (roughly +5% per floor — same principle for both the Wyrm Tower and the Corrupt Sanctuary, which restarts from the Tower\'s floor-100 challenge level, with much stronger items to compensate for the new scale).',
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
  p_codex_legend: '<strong>TW</strong> = Wyrm Tower · <strong>SC</strong> = Corrupt Sanctuary · <strong>NP</strong> = Primordial Core',
  footer_rights: 'All rights reserved.',
  footer_terms: 'Terms of Service & Sale',
  streak_title: 'Daily Login Bonus',
  streak_claim: 'Claim',

  // --- Ajouts audit i18n HTML du 16/08/2026 ---
  page_title: 'Moltchi — Virtual Pet RPG Simulator',
  eyebrow_subtitle: 'Virtual Pet RPG Simulator',
  title_back_home: 'Back to My Creature',
  ph_username: 'Your username…',
  btn_start: "Let's go!",
  err_username_length: 'Choose a username between 2 and 18 characters.',
  ph_recovery_code: 'Paste your recovery code…',
  btn_restore: 'Restore',
  stat_crit_fire: 'Crit (Fire)',
  stat_speed_wind: 'Speed (Wind)',
  stat_stamina_earth: 'Stamina (Earth)',
  stat_magic_water: 'Magic (Water)',
  mg_reflex_name: 'Reflex',
  mg_memory_name: 'Memory',
  mg_rhythm_name: 'Rhythm',
  mg_arcane_name: 'Arcane',
  stat_crit_fire_arrow: '→ Crit (Fire)',
  stat_speed_wind_arrow: '→ Speed (Wind)',
  stat_stamina_earth_arrow: '→ Stamina (Earth)',
  stat_magic_water_arrow: '→ Magic (Water)',
  btn_surprise: '🎲 Surprise me',
  btn_auto_equip: '⚡ Auto-equip the best',
  h3_consumables: '🍬 Consumables',
  btn_show: '👁️ Show',
  btn_copy: '📋 Copy',
  btn_abandon: '💀 Abandon this Moltchi',
  btn_abandon_confirm: 'Confirm abandon',
  lbl_current_floor: 'Current floor',
  lbl_your_power: 'Your power',
  lbl_floor_challenge: 'Floor challenge',
  btn_unlock_corrupt: 'Unlock — 🪙 2000 Moltcoins',
  btn_unlock_noyau: 'Unlock — 🪙 2000 Moltcoins',
  bp_premium_title: '✦ Premium Pass',
  p_chest_adblock: '🚫 Ad blocker detected — disable it for this site (or whitelist Moltchi) to open chests.',
  btn_chest_claim: '🎉 Claim reward',
  lbl_moltcoins: 'Moltcoins 🪙',
  lbl_action_points: 'Action Points',
  btn_dig: '⛏️ Dig (1 AP)',
  p_treasure_history: 'The last 10 digs are shown and kept.',
  chat_title: '💬 World Chat',
  lbl_wellbeing: 'Wellbeing',
  lbl_est_damage: 'Est. Damage',
  stat_crit_short: 'Crit',
  stat_speed_short: 'Speed',
  stat_stamina_short: 'Stamina',
  stat_magic_short: 'Magic',
};

async function loadLanguage(){
  try{ const r = await window.storage.get('language', false); return r.value; }
  catch(e){ return 'fr'; }
}
async function saveLanguage(lang){ try{ await performAction('set_language', { lang }); if(window.storage._privateCache) window.storage._privateCache.language = lang; }catch(e){console.error(e);} }

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
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if(el.dataset.frOriginalPlaceholder === undefined) el.dataset.frOriginalPlaceholder = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', (lang === 'en' && I18N_EN[key] !== undefined) ? I18N_EN[key] : el.dataset.frOriginalPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if(el.dataset.frOriginalTitle === undefined) el.dataset.frOriginalTitle = el.getAttribute('title') || '';
    el.setAttribute('title', (lang === 'en' && I18N_EN[key] !== undefined) ? I18N_EN[key] : el.dataset.frOriginalTitle);
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
      try{ await performAction('set_pref', { key: 'music_volume', value: '0.5' }); }catch(e){}
    }
    try{ await bgMusic.play(); }catch(e){}
  } else {
    musicPreferenceOff = true;
    bgMusic.pause();
  }
  updateMusicButton();
  try{ await performAction('set_pref', { key: 'music_on', value: String(!musicPreferenceOff) }); }catch(e){}
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
    await performAction('set_pref', { key: 'music_on', value: String(!musicPreferenceOff) });
    await performAction('set_pref', { key: 'music_volume', value: String(vol) });
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
    // Idle Phaser du boss superposé au portrait statique : ne se déclenche qu'à l'ouverture
    // de l'onglet (pas à chaque rendu), pour ne pas voler le canvas partagé à une autre
    // zone (soin, mini-jeu...) tant que le joueur ne regarde pas vraiment le Boss.
    if(tab.dataset.tab === 'boss' && boss){
      renderBoss(boss); // (re)construit le HUD Phaser maintenant que le panel est actif — voir le garde-fou dans renderBoss()
      playFxEffectSafe(Bridge => Bridge.showBossIdle(boss.bossId));
    } else if(tab.dataset.tab === 'dungeon' && creature){
      // Les 3 (re)construisent leurs données HTML cachées sans souci ; seule celle qui
      // correspond à activeDungeonSection pousse réellement vers Phaser (garde-fou interne
      // à chaque fonction) — évite de devoir deviner ici laquelle est "la bonne".
      renderDungeonPanel(creature);
      renderCorruptPanel(creature);
      renderNoyauPanel(creature);
    } else if(tab.dataset.tab === 'creature'){
      // Sans ça, le canvas partagé peut rester coincé sur boss-fx-stage/dungeon-fx-stage
      // après un aller-retour sur un autre onglet (display:none sur le panel inactif ne
      // suffisait pas dans tous les cas observés — voir la conversation). Reprise
      // explicite, comme le fait déjà stopTrainingGame() en quittant un mini-jeu.
      playFxEffectSafe(Bridge => Bridge.reclaimCreatureStage());
    }
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

// Redimensionnement dynamique du HUD de combat Boss, sans recharger la page : on observe
// #boss-portrait-wrap et on relance renderBoss() (débouncé) dès que sa taille change réel-
// lement — couvre le redimensionnement de fenêtre desktop ET la rotation d'écran mobile.
// showBattleUI() détecte lui-même le changement de taille côté Phaser et reconstruit toute
// la mise en page (bascule desktop/mobile comprise, voir game/scenes/BossScene.js) — ici on
// ne fait que redéclencher un rendu avec les données à jour au bon moment.
if(typeof ResizeObserver !== 'undefined'){
  const bossPortraitWrap = $('boss-portrait-wrap');
  if(bossPortraitWrap){
    let bossResizeTimer = null;
    new ResizeObserver(() => {
      clearTimeout(bossResizeTimer);
      // Léger débounce : un redimensionnement de fenêtre déclenche l'event en rafale tant
      // qu'on fait glisser le bord — inutile de reconstruire toute l'UI Phaser à chaque
      // pixel, seulement une fois que ça s'est stabilisé.
      bossResizeTimer = setTimeout(() => {
        if(boss && $('panel-boss') && $('panel-boss').classList.contains('active')) renderBoss(boss);
      }, 150);
    }).observe(bossPortraitWrap);
  }

  // Même principe pour le HUD des donjons (voir DungeonScene.showDungeonHUD()) — un seul
  // observer pour les 3 conteneurs, mais ne redéclenche un rendu que pour la section
  // ACTUELLEMENT active (activeDungeonSection, suivi par l'IntersectionObserver plus bas) :
  // resize une section masquée/inactive ne sert à rien tant qu'elle n'a pas le canvas.
  const dungeonRenderers = {
    dungeon: () => renderDungeonPanel(creature),
    corrupt: () => renderCorruptPanel(creature),
    noyau: () => renderNoyauPanel(creature),
  };
  const dungeonResizeTargets = [
    { key: 'dungeon', el: $('dungeon-fx-wrap') },
    { key: 'corrupt', el: $('corrupt-fx-wrap') },
    { key: 'noyau', el: $('noyau-fx-wrap') },
  ].filter(t => t.el);
  if(dungeonResizeTargets.length){
    let dungeonResizeTimer = null;
    const dungeonRO = new ResizeObserver(() => {
      clearTimeout(dungeonResizeTimer);
      dungeonResizeTimer = setTimeout(() => {
        if(!creature || !$('panel-dungeon') || !$('panel-dungeon').classList.contains('active')) return;
        const renderFn = dungeonRenderers[activeDungeonSection];
        if(renderFn) renderFn();
      }, 150);
    });
    dungeonResizeTargets.forEach(t => dungeonRO.observe(t.el));
  }
}

// Sélecteur de donjon (boutons Tour/Sanctuaire/Noyau, voir index.html) : un seul affiché à
// la fois — contrainte du canvas Phaser partagé, voir la note en tête de DungeonScene.js.
// Le clic bascule activeDungeonSection, affiche la bonne section, cache les autres, et
// pousse immédiatement le HUD Phaser vers ce donjon.
document.querySelectorAll('.dungeon-section-btn').forEach(btn => {
  btn.onclick = () => {
    const key = btn.dataset.dungeonSection;
    if(!key || key === activeDungeonSection) return;
    activeDungeonSection = key;
    document.querySelectorAll('.dungeon-section-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.dungeon-section').forEach(section => {
      section.style.display = section.id === `dungeon-section-${key}` ? 'block' : 'none';
    });
    if(!creature) return;
    if(key === 'dungeon') renderDungeonPanel(creature);
    else if(key === 'corrupt') renderCorruptPanel(creature);
    else if(key === 'noyau') renderNoyauPanel(creature);
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
const LOCKED_WITHOUT_CREATURE = ['training','dungeon','boss','codex','treasure','battlepass','quests','chests','shop','achievements'];
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
    playFxEffectSafe(Bridge => Bridge.reclaimCreatureStage());
  }
}

async function getUsername(){
  try{ const r = await window.storage.get('username', false); return r.value; }
  catch(e){ return null; }
}
async function setUsername(name){
  const data = await performAction('set_username', { name });
  if(window.storage._privateCache) window.storage._privateCache.username = data.username;
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
  return ITEM_DB.find(d=>d.id===defId) || CORRUPT_ITEM_DB.find(d=>d.id===defId) || NOYAU_ITEM_DB.find(d=>d.id===defId);
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
  {id:'plaque_antique',     name:'Plaque d\'Endurance Antique',name_en:'Ancient Stamina Plate', rarity:'epic',      stat:'stamina', value:150, minFloor:15},
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

// Noyau Primordial — 3ᵉ donjon. Archétype "généraliste" : chaque objet boost les 4 stats
// d'un même montant modéré (`allStat`) plutôt que 1-2 stats à fond, cohérent avec le thème
// de convergence élémentaire du donjon. Valeurs = facteur d'échelle ×11,67 depuis le
// Sanctuaire (35000/3000, voir note de chaînage plus haut), à ~35% de l'équivalent
// mono-stat pour ne pas écraser les archétypes mono-stat des 2 premiers donjons.
// ⚠️ DOIT rester synchronisé avec la copie dans perform-action.ts.
const NOYAU_ITEM_DB = [
  {id:'noyau_eclat_commun',     name:'Éclat du Noyau',              name_en:'Core Shard',              rarity:'common',    allStat:780,  minFloor:1},
  {id:'noyau_fragment_commun',  name:'Fragment Primordial',         name_en:'Primordial Fragment',     rarity:'common',    allStat:780,  minFloor:1},
  {id:'noyau_sceau_rare',       name:'Sceau des Quatre Vents',      name_en:'Seal of the Four Winds',  rarity:'rare',      allStat:1740, minFloor:1},
  {id:'noyau_orbe_rare',        name:'Orbe en Convergence',         name_en:'Converging Orb',          rarity:'rare',      allStat:1740, minFloor:1},
  {id:'noyau_coeur_epique',     name:'Cœur du Noyau',               name_en:'Heart of the Core',       rarity:'epic',      allStat:3880, minFloor:1},
  {id:'noyau_prisme_epique',    name:'Prisme Élémentaire',          name_en:'Elemental Prism',         rarity:'epic',      allStat:3880, minFloor:1},
  {id:'noyau_couronne_leg',     name:'Couronne du Premier Cycle',   name_en:'Crown of the First Cycle',rarity:'legendary', allStat:8170, minFloor:1},
  {id:'noyau_diademe_leg',      name:'Diadème Primordial',          name_en:'Primordial Diadem',       rarity:'legendary', allStat:8170, minFloor:1},
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
  Ptimousse: { name:'Ptimousse', icon:'🛡️', video:'media/ptimousse.mp4', image:'media/Ptimousse.png', eatVideo:'media/ptimousse-eat.mp4', playVideo:'media/ptimousse-play.mp4',sleepVideo:'media/ptimousse-sleep.mp4', stage3Video:null, stage3Image:null, passiveStat:'stamina', passiveLabel:'+20% de gain en Endurance (Terre)', passiveLabel_en:'+20% Stamina (Earth) gained from training',
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
// ---------- Animation de soin (nourrir/jouer/reposer) — voir game/bridge.js et
// game/scenes/MainScene.js. Vit désormais entièrement dans Phaser (chargé une bonne
// fois pour toutes au tout début de l'appli, voir preloadPhaserBlocking() dans init()) —
// plus d'ancien système vidéo HTML en secours. Si Phaser n'était pas prêt (échec
// réseau/CDN), l'action ne fait simplement rien plutôt que de rejouer une vidéo HTML.
let _phaserBridgeModule = null;
async function playCareAnimation(c, fieldName){
  const spDef = SPECIES[c.species];
  const src = spDef && spDef[fieldName]; // vraie vidéo de la race, résolue AVANT l'appel — Phaser ne connaît rien des races
  if(!src) return;
  if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
  const { Bridge } = _phaserBridgeModule;
  // On attend ensureLoaded() plutôt que de se fier à un simple isReady() instantané :
  // preloadPhaserBlocking() a déjà tout chargé avant même que l'appli ne se dévoile
  // (voir init()), donc la promesse est déjà résolue ici dans l'immense majorité des
  // cas — ce await ne fait qu'assurer la cohérence si jamais cette fonction était
  // appelée avant la fin de l'écran de chargement. ensureLoaded() ne bloque jamais
  // indéfiniment : elle se résout toujours (true ou false), y compris en cas d'échec
  // réseau/CDN.
  await Bridge.ensureLoaded();
  if(Bridge.isReady() && Bridge.playCareAnimation(fieldName, src)) return;
  console.warn(`[Moltchi/Phaser] ${fieldName} indisponible (Phaser non prêt) — aucune action.`);
}

// Démarre le chargement de Phaser en tâche de fond dès le lancement de l'appli (voir
// l'appel dans init()), sans attendre que la carte créature existe : #creature-stage est
// déjà dans le DOM depuis le HTML de base (juste display:none tant que l'œuf n'a pas
// éclos), et ensureLoaded() retombe de toute façon sur 300x300 si clientWidth vaut 0.
// Charger le plus tôt possible maximise les chances que Phaser soit déjà prêt au moment
// où le joueur clique Nourrir/Jouer/Reposer ou lance un mini-jeu, plutôt que de faire la
// course entre le chargement réseau et le premier clic.
let _phaserPreloadStarted = false;
function preloadPhaserInBackground(){
  if(_phaserPreloadStarted) return;
  _phaserPreloadStarted = true;
  import('./game/bridge.js').then(mod => {
    _phaserBridgeModule = mod;
    mod.Bridge.ensureLoaded();
  }).catch(() => {}); // échec silencieux : preloadPhaserInBackground() n'est qu'une optimisation, jamais requis
}

// ---------- Écran de chargement bloquant au lancement de l'appli ----------
// Contrairement à preloadPhaserInBackground() (qui ne fait que lancer le chargement sans
// attendre), preloadPhaserBlocking() est utilisé au tout début de init() : l'écran
// #phaser-loading-overlay (visible par défaut dans le HTML) reste affiché avec une vraie
// barre de progression tant que Phaser + les scènes ne sont pas prêts, PUIS l'appli se
// dévoile. Comme il n'y a plus de fallback DOM pour les mini-jeux/animations de soin
// (voir plus bas), c'est cet écran de chargement qui évite qu'un joueur clique sur une
// action avant que Phaser ne soit prêt et ne se passe rien.
const PHASER_LOADING_LABELS = {
  init:                 { fr: 'Démarrage…',              en: 'Starting up…' },
  downloading:          { fr: 'Chargement du moteur…',   en: 'Loading the game engine…' },
  'engine-loaded':      { fr: 'Mise en scène…',          en: 'Setting the stage…' },
  'game-created':       { fr: 'Réveil des créatures…',   en: 'Waking the creatures…' },
  'main-scene-ready':   { fr: 'Presque prêt…',           en: 'Almost there…' },
  'training-scene-ready': { fr: 'Presque prêt…',         en: 'Almost there…' },
  ready:                { fr: 'Prêt !',                  en: 'Ready!' },
  'no-container':       { fr: 'Prêt !',                  en: 'Ready!' },
  'main-scene-failed':  { fr: 'Prêt !',                  en: 'Ready!' },
  timeout:              { fr: 'Prêt !',                  en: 'Ready!' },
  error:                { fr: 'Prêt !',                  en: 'Ready!' },
};
function setPhaserLoadingProgress(pct, stage){
  const bar = document.getElementById('phaser-loading-bar');
  if(bar) bar.style.width = Math.max(4, Math.min(100, pct)) + '%';
  const labelEl = document.getElementById('phaser-loading-label');
  if(labelEl){
    const entry = PHASER_LOADING_LABELS[stage];
    labelEl.textContent = entry ? (currentLang==='en' ? entry.en : entry.fr) : (currentLang==='en' ? 'Loading…' : 'Chargement…');
  }
}
function hidePhaserLoadingOverlay(){
  const overlay = document.getElementById('phaser-loading-overlay');
  if(!overlay) return;
  overlay.style.opacity = '0';
  overlay.style.pointerEvents = 'none';
  setTimeout(() => { overlay.style.display = 'none'; }, 400);
}
// Délai de sécurité : au-delà, on arrête d'attendre Phaser et on démarre l'appli quand
// même — les actions Phaser (mini-jeux, animations de soin) ne feront simplement rien
// tant qu'il ne sera pas prêt (plus de fallback DOM, voir playCareAnimation() plus haut)
// — mais un réseau capricieux ou un CDN bloqué ne doit jamais coincer le joueur
// indéfiniment sur l'écran de chargement.
const PHASER_LOADING_TIMEOUT_MS = 15000; // était 8000 — relevé pour laisser le temps aux assets du Boss (spritesheets, potentiellement plusieurs Mo) préchargés ici désormais, voir preloadPhaserBlocking() ci-dessous.
async function preloadPhaserBlocking(){
  try{
    // Police pixel du HUD de combat Boss (voir FONT_FAMILY dans BossScene.js) : attendue
    // AVANT que Phaser ne crée le moindre texte, sinon le tout premier rendu utilise le
    // repli 'monospace' du navigateur et ne se corrige jamais tout seul par la suite (un
    // Text Phaser déjà dessiné ne se redessine pas automatiquement quand la police finit de
    // charger après coup). Best-effort : si ça échoue (hors-ligne, CDN bloqué...), on
    // continue quand même avec le repli plutôt que de bloquer le jeu pour une police.
    try{
      if(document.fonts && document.fonts.load) await document.fonts.load('10px "Press Start 2P"');
    } catch(e){ /* police non critique */ }

    if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
    const { Bridge } = _phaserBridgeModule;
    _phaserPreloadStarted = true;
    await Promise.race([
      (async () => {
        await Bridge.ensureLoaded(setPhaserLoadingProgress);
        // Une fois le moteur prêt : précharge aussi les assets du Boss de la semaine
        // (idle/attacked/slash + fond/cadre HP/log/bouton/gemmes) directement dans cet
        // écran de chargement, plutôt qu'en tâche de fond après coup — pour que l'onglet
        // Boss soit instantané dès le premier clic, plutôt que de découvrir le
        // téléchargement à ce moment précis (voir la conversation sur le délai perçu).
        // Best-effort : un échec ici (requête boss ou assets) ne bloque jamais le reste du
        // jeu, le joueur attendra juste un peu plus longtemps au premier clic sur Boss.
        try{
          setPhaserLoadingProgress(85, 'boss-preview');
          const bossPreview = await loadBoss();
          if(bossPreview && bossPreview.bossId){
            setPhaserLoadingProgress(90, 'boss-assets');
            await Promise.all([
              Bridge.preloadBossIdle(bossPreview.bossId),
              Bridge.preloadBossAttacked(bossPreview.bossId),
              Bridge.preloadBossSlash(),
              Bridge.preloadBossBattleUIAssets(),
              Bridge.preloadBossArenaBg(bossPreview.bossId),
            ]);
          }
        } catch(e){ /* préchargement Boss best-effort, jamais bloquant */ }
        setPhaserLoadingProgress(100, 'ready');
      })(),
      new Promise(resolve => setTimeout(() => { setPhaserLoadingProgress(100, 'timeout'); resolve(false); }, PHASER_LOADING_TIMEOUT_MS)),
    ]);
  } catch(e){
    console.warn('[Moltchi/Phaser] Préchargement bloquant indisponible, l\'appli démarre sans Phaser :', e);
    setPhaserLoadingProgress(100, 'error');
  } finally {
    hidePhaserLoadingOverlay();
  }
}

// ---------- Pont Phaser — effets visuels ponctuels (Trésor/Donjons/Boss Mondial) ----------
// Contrairement aux mini-jeux d'entraînement, ces effets sont un pur bonus visuel : pas
// de résultat à remonter, pas de fallback DOM à prévoir (le texte du journal existant
// suffit à lui seul). Si Phaser n'est pas prêt, cette fonction ne fait simplement rien —
// le jeu continue de fonctionner exactement comme avant, échec totalement silencieux.
async function playFxEffectSafe(fn){
  try{
    if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
    fn(_phaserBridgeModule.Bridge);
  } catch(e){ /* effet décoratif seulement — échec silencieux, le jeu continue normalement */ }
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
    noyauUnlocked: false, noyauFloor: 1, noyauAttempts: 0, noyauClears: 0, noyauDay: null,
    careDay: null, careUsed: 0,
    chestsDay: null, chestsOpened: 0,
    loginStreak: 0, bestLoginStreak: 0, lastLoginDay: null,
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

// Montants Moltcoins calibrés sur BP_PREMIUM_COST_MOLTCOINS (voir calcul dans le chat) :
// somme des gains gratuits = 375 (1/4 du prix), somme des gains premium = 750 (2/4 du prix),
// total = 1125 (3/4 du prix) — le pass ne se rembourse jamais entièrement en Moltcoins.
// Les paliers premium qui donnaient un équipement donnent désormais des bonbons consommables
// (quantités croissantes au fil des paliers, réparties entre les 4 types).
const BATTLEPASS_TIERS = [
  {tier:1,  xp:60,  free:{type:'coins',amount:15},                  premium:{type:'coins',amount:35}},
  {tier:2,  xp:130,  free:{type:'coins',amount:15},                  premium:{type:'consumable',consumableId:'candy_dungeon',qty:2}},
  {tier:3,  xp:210,  free:null,                                     premium:{type:'coins',amount:40}},
  {tier:4,  xp:305,  free:{type:'coins',amount:15},                  premium:{type:'consumable',consumableId:'candy_boss',qty:2}},
  {tier:5,  xp:415,  free:null,                                     premium:{type:'coins',amount:50}},
  {tier:6,  xp:530,  free:{type:'coins',amount:20},                  premium:{type:'consumable',consumableId:'candy_treasure',qty:2}},
  {tier:7,  xp:660, free:{type:'coins',amount:20},                  premium:{type:'consumable',consumableId:'candy_training',qty:2}},
  {tier:8,  xp:800, free:null,                                     premium:{type:'coins',amount:60}},
  {tier:9,  xp:955, free:{type:'coins',amount:25},                  premium:{type:'consumable',consumableId:'candy_dungeon',qty:4}},
  {tier:10, xp:1120, free:null,                                     premium:{type:'coins',amount:75}},
  {tier:11, xp:1295, free:{type:'coins',amount:25},                  premium:{type:'consumable',consumableId:'candy_boss',qty:4}},
  {tier:12, xp:1485, free:{type:'coins',amount:25},                  premium:{type:'consumable',consumableId:'candy_treasure',qty:4}},
  {tier:13, xp:1685, free:null,                                     premium:{type:'coins',amount:85}},
  {tier:14, xp:1900, free:{type:'coins',amount:30},                  premium:{type:'coins',amount:100}},
  {tier:15, xp:2150, free:null,                                     premium:{type:'consumable',consumableId:'candy_training',qty:4}},
  {tier:16, xp:2400, free:{type:'coins',amount:35},                  premium:{type:'consumable',consumableId:'candy_dungeon',qty:6}},
  {tier:17, xp:2610, free:{type:'coins',amount:35},                  premium:{type:'consumable',consumableId:'candy_boss',qty:6}},
  {tier:18, xp:2865, free:null,                                     premium:{type:'consumable',consumableId:'candy_training',qty:6}},
  {tier:19, xp:3135, free:{type:'coins',amount:45},                  premium:{type:'consumable',consumableId:'candy_treasure',qty:6}},
  {tier:20, xp:3500, free:{type:'coins',amount:70},                  premium:{type:'coins',amount:190}},
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
function bpCurrentTier(xp){
  let tier = 0;
  for(const t of BATTLEPASS_TIERS){ if(xp >= t.xp) tier = t.tier; else break; }
  return tier;
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

// ============================================================
// ============ SUCCÈS / HAUTS FAITS (permanents) ============
// Les CONDITIONS de déblocage (ACHIEVEMENTS.check) vivent côté serveur
// (perform-action.ts / attack-boss.ts, seuls habilités à modifier l'état réel).
// Ici, uniquement l'AFFICHAGE (icône, nom, description) — la source de vérité
// sur ce qui est débloqué ou non reste toujours `achievements.unlocked` reçu du
// serveur, jamais recalculée côté client.
// ============================================================
const ACHIEVEMENT_DISPLAY = {
  first_legendary:  { icon:'🏆', name:'Premier Légendaire',        name_en:'First Legendary',      desc:'Obtiens ton premier objet légendaire.',                         desc_en:'Obtain your first legendary item.' },
  first_unique:     { icon:'✨', name:'Éclat Trouvé',               name_en:'Shard Found',          desc:'Trouve ton premier Moltyx unique.',                             desc_en:'Find your first unique Moltyx.' },
  floors_100:       { icon:'🗼', name:'Centurion',                  name_en:'Centurion',            desc:'Franchis 100 étages de donjon au total (tous donjons confondus).', desc_en:'Clear 100 dungeon floors in total (all dungeons combined).' },
  floors_500:       { icon:'🏔️', name:'Grand Explorateur',          name_en:'Grand Explorer',       desc:'Franchis 500 étages de donjon au total.',                       desc_en:'Clear 500 dungeon floors in total.' },
  boss_kills_10:    { icon:'⚔️', name:'Chasseur de Titans',         name_en:'Titan Hunter',         desc:'Participe à la mise à mort du Boss Mondial 10 fois.',           desc_en:'Land the killing blow on the World Boss 10 times.' },
  boss_kills_50:    { icon:'👑', name:'Légende du Boss Mondial',    name_en:'World Boss Legend',    desc:'Participe à la mise à mort du Boss Mondial 50 fois.',           desc_en:'Land the killing blow on the World Boss 50 times.' },
  moltcoins_10000:  { icon:'🪙', name:'Petit Fortuné',              name_en:'Small Fortune',        desc:'Gagne 10 000 Moltcoins au total, au fil de ta progression.',    desc_en:'Earn 10,000 Moltcoins in total over your progression.' },
  treasure_100:     { icon:'⛏️', name:'Chercheur d\'Or',            name_en:'Gold Seeker',          desc:'Effectue 100 fouilles à la Chasse au trésor.',                  desc_en:'Complete 100 digs at the Treasure Hunt.' },
  training_500:     { icon:'💪', name:'Discipline de Fer',          name_en:'Iron Discipline',      desc:'Termine 500 sessions d\'entraînement.',                          desc_en:'Complete 500 training sessions.' },
  pass_complete:    { icon:'🎟️', name:'Maître de Saison',           name_en:'Season Master',        desc:'Termine le Pass Saisonnier (palier maximum).',                  desc_en:'Complete the Season Pass (max tier).' },
  corrupt_unlocked: { icon:'🌑', name:'Éveil Corrompu',             name_en:'Corrupt Awakening',    desc:'Débloque le Sanctuaire Corrompu.',                              desc_en:'Unlock the Corrupted Sanctuary.' },
  noyau_unlocked:   { icon:'🌀', name:'Convergence',                name_en:'Convergence',          desc:'Débloque le Noyau Primordial.',                                 desc_en:'Unlock the Primordial Core.' },
};

// Succès à seuil numérique (les autres sont binaires : "obtenu" ou "pas obtenu",
// pas de notion de progression à afficher pour eux). statKey pointe directement
// vers un compteur de achievements.stats (voir perform-action.ts).
const ACHIEVEMENT_PROGRESS = {
  floors_100:      { statKey:'totalFloorsCleared',      target:100 },
  floors_500:      { statKey:'totalFloorsCleared',      target:500 },
  boss_kills_10:   { statKey:'bossKillsPersonal',        target:10 },
  boss_kills_50:   { statKey:'bossKillsPersonal',        target:50 },
  moltcoins_10000: { statKey:'moltcoinsEarnedLifetime',  target:10000 },
  treasure_100:    { statKey:'treasureDigsTotal',        target:100 },
  training_500:    { statKey:'trainingSessionsTotal',    target:500 },
};

function showAchievementToasts(ids){
  const wrap = $('ach-toast-wrap');
  if(!wrap) return;
  ids.forEach((id, idx) => {
    const def = ACHIEVEMENT_DISPLAY[id];
    if(!def) return;
    setTimeout(() => {
      const toast = document.createElement('div');
      toast.className = 'ach-toast';
      const name = currentLang==='en' ? def.name_en : def.name;
      const title = currentLang==='en' ? 'Achievement unlocked' : 'Succès débloqué';
      toast.innerHTML = `<span class="ach-icon">${def.icon}</span><span><div class="ach-toast-title">${title}</div><div class="ach-toast-name">${name}</div></span>`;
      wrap.appendChild(toast);
      setTimeout(() => toast.remove(), 5100);
    }, idx * 400); // léger décalage si plusieurs succès tombent d'un coup, pour ne pas les superposer
  });
}

function renderAchievementsPanel(c){
  const list = $('achievements-list');
  if(!list) return;
  if(!achievements){ list.innerHTML = ''; return; }
  list.innerHTML = '';
  Object.entries(ACHIEVEMENT_DISPLAY).forEach(([id, def]) => {
    const unlockedAt = achievements.unlocked[id];
    const name = currentLang==='en' ? def.name_en : def.name;
    const desc = currentLang==='en' ? def.desc_en : def.desc;
    const li = document.createElement('li');
    li.className = 'ach-card ' + (unlockedAt ? 'unlocked' : 'locked');
    let dateLine = '';
    if(unlockedAt){
      const d = new Date(unlockedAt);
      dateLine = `<div class="ach-date">${d.toLocaleDateString(currentLang==='en' ? 'en-US' : 'fr-FR')}</div>`;
    }
    const isActive = achievements.activeBadge === id;
    const badgeBtn = unlockedAt
      ? `<button class="ach-badge-btn${isActive?' active':''}" data-badge="${id}">${isActive ? (currentLang==='en'?'✓ Active':'✓ Actif') : (currentLang==='en'?'Use as title':'Utiliser')}</button>`
      : '';
    let progressLine = '';
    const prog = ACHIEVEMENT_PROGRESS[id];
    if(!unlockedAt && prog){
      const current = Math.min(prog.target, (achievements.stats && achievements.stats[prog.statKey]) || 0);
      const pct = Math.round((current / prog.target) * 100);
      progressLine = `<div class="ach-progress"><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:var(--gold);"></div></div><div class="ach-progress-text">${current.toLocaleString()} / ${prog.target.toLocaleString()}</div></div>`;
    }
    li.innerHTML = `<span class="ach-icon">${unlockedAt ? def.icon : '🔒'}</span>
      <span class="ach-info"><div class="ach-name">${name}</div><div class="ach-desc">${desc}</div>${dateLine}${progressLine}</span>
      ${badgeBtn}`;
    list.appendChild(li);
  });
  list.querySelectorAll('button[data-badge]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.badge;
      const newValue = achievements.activeBadge === id ? null : id; // re-cliquer sur l'actif le retire
      try{
        await performAction('set_active_badge', { badgeId: newValue });
        renderAchievementsPanel(c);
        renderActiveBadgePill();
      } catch(e){ console.error(e); }
    };
  });
}

// Affiche le titre choisi (badge actif) juste sous le nom/niveau sur la carte compagnon.
function renderActiveBadgePill(){
  const slot = $('active-badge-slot');
  if(!slot) return;
  if(!achievements || !achievements.activeBadge || !ACHIEVEMENT_DISPLAY[achievements.activeBadge]){
    slot.innerHTML = '';
    return;
  }
  const def = ACHIEVEMENT_DISPLAY[achievements.activeBadge];
  const name = currentLang==='en' ? def.name_en : def.name;
  slot.innerHTML = `<span class="active-badge-pill">${def.icon} ${name}</span>`;
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
    const allStat = def ? def.allStat : item.allStat;
    if(stat) bonus[stat] = (bonus[stat]||0) + value;
    if(stat2) bonus[stat2] = (bonus[stat2]||0) + value2;
    // Objets généralistes du Noyau Primordial : bonus uniforme sur les 4 stats.
    if(allStat){ bonus.crit+=allStat; bonus.dodge+=allStat; bonus.stamina+=allStat; bonus.magic+=allStat; }
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
// Dégâts moyens attendus par attaque contre le Boss Mondial, à partir des stats
// actuelles — même formule que le calcul de dégâts réel côté serveur, mais sans le
// tirage aléatoire final, pour un affichage stable dans l'onglet Créature. `boss`
// (état courant, avec ses affinités élémentaires) est optionnel : sans lui,
// l'estimation ignore juste la faiblesse/résistance du boss du moment (ex: avant que
// le Boss ait été chargé).
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
// Taux à deux paliers : 1.0422 jusqu'à l'étage 100 inclus, puis 1.038 au-delà.
// La continuité est assurée en repartant de la valeur BRUTE (non arrondie) atteinte
// à l'étage 100 avec le premier taux, plutôt que de recalculer depuis la base —
// ça évite un saut de valeur au changement de palier.
const DUNGEON_RATE_1 = 1.0422, DUNGEON_RATE_2 = 1.038, DUNGEON_RATE_SWITCH_FLOOR = 100;
function floorRequirement(floor){
  const base = 50;
  if(floor <= DUNGEON_RATE_SWITCH_FLOOR) return Math.round(base * Math.pow(DUNGEON_RATE_1, floor - 1));
  const atSwitch = base * Math.pow(DUNGEON_RATE_1, DUNGEON_RATE_SWITCH_FLOOR - 1);
  return Math.round(atSwitch * Math.pow(DUNGEON_RATE_2, floor - DUNGEON_RATE_SWITCH_FLOOR));
}
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
// Taux utilisés : Tour du Wyrm = 5%/étage. Sanctuaire Corrompu = 2,51%/étage (recalibré,
// voir note plus bas — le taux "identique au précédent" n'est plus une règle stricte : le
// vrai principe est "calibrer sur la Puissance réellement atteignable", voir point 0 ci-dessous).
// PRINCIPE À SUIVRE POUR TOUT FUTUR DONJON (n) :
// 0. AVANT de choisir un taux de croissance, ESTIMER par simulation la Puissance qu'un joueur
//    assidu peut réellement atteindre après quelques mois à un an (entraînement quotidien +
//    meilleur équipement du donjon précédent), et caler req_n(100) sur cette estimation —
//    ne JAMAIS composer aveuglément le même taux sur 100 étages supplémentaires, ça explose
//    de façon incontrôlable (voir l'erreur corrigée le 16/08/2026 : l'ancien taux de 5% pour le
//    Sanctuaire donnait un étage 100 à ~375 000, hors de portée avant plusieurs années).
// 1. req_n(1) = req_(n-1)(100) — l'étage 1 du nouveau donjon reprend exactement le niveau
//    de difficulté de l'étage 100 du précédent (pas de saut arbitraire).
// 2. Le taux de croissance est choisi selon le point 0 ci-dessus, pas recopié aveuglément.
// 3. Mêmes plafonds quotidiens d'échecs/réussites que le Wyrm (5 échecs / 10 réussites,
//    6/11 pour Épineombre) — ne PAS les gonfler pour "rattraper" un déséquilibre.
// 4. Les valeurs des objets du nouveau donjon doivent être recalculées en multipliant les
//    valeurs équivalentes du donjon précédent par le facteur d'échelle = req_n(1) / req_(n-1)(1).
// Sanctuaire Corrompu : req_wyrm(1)=50, req_corrompu(1)=req_wyrm(100)=2999→3000,
// req_corrompu(100) calibré à ≈35 000 initialement (≈6-9 mois pour un joueur assidu bien
// équipé), réduit le 16/08/2026 à ≈28 500 (taux 2,3%/étage, léger assouplissement demandé).
// Facteur d'échelle objets ×60 (inchangé, basé sur req_corrompu(1)/req_wyrm(1), pas sur l'étage 100).
// Noyau Primordial : req_corrompu(1)=3000, req_noyau(1)=req_corrompu(100)=~28 500 (baisse
// automatiquement avec le Sanctuaire, chaîné dessus),
// taux repris à 5% (comme le tout premier donjon, en attendant un futur rééquilibrage —
// l'étage 100 du Noyau reste un objectif de très long terme, à revoir plus tard).
// Facteur d'échelle objets ×11,67 conservé tel quel (calibré à l'origine, pas recalculé
// avec la baisse du Sanctuaire — les objets du Noyau restent à leur valeur actuelle).
// ⚠️ Toutes ces formules DOIVENT rester identiques entre app.js et perform-action.ts.
// Taux à deux paliers pour le Sanctuaire : 1.020 jusqu'à l'étage 100 inclus, puis 1.018
// au-delà. Même principe de continuité que floorRequirement ci-dessus (repartir de la
// valeur brute non arrondie atteinte au palier plutôt que recalculer depuis la base).
const CORRUPT_RATE_1 = 1.020, CORRUPT_RATE_2 = 1.018, CORRUPT_RATE_SWITCH_FLOOR = 100;
function corruptFloorRequirement(floor){
  const base = floorRequirement(CORRUPT_UNLOCK_FLOOR);
  if(floor <= CORRUPT_RATE_SWITCH_FLOOR) return Math.round(base * Math.pow(CORRUPT_RATE_1, floor - 1));
  const atSwitch = base * Math.pow(CORRUPT_RATE_1, CORRUPT_RATE_SWITCH_FLOOR - 1);
  return Math.round(atSwitch * Math.pow(CORRUPT_RATE_2, floor - CORRUPT_RATE_SWITCH_FLOOR));
}
function maxCorruptAttempts(c){ return c.species === 'Epineombre' ? 6 : 5; } // plafond d'ÉCHECS/jour — identique au Wyrm, par principe (voir note ci-dessus)
function maxCorruptClears(c){ return c.species === 'Epineombre' ? 11 : 10; } // plafond de RÉUSSITES/jour — identique au Wyrm
function corruptXP(floor){ return floor <= 100 ? 30 + floor * 2 : 30; } // au-delà de l'étage 100, le Noyau prend le relais côté XP
function isCorruptLootFloor(floor){ return floor % 5 === 0; }

// --- Noyau Primordial — troisième donjon, verrouillé jusqu'à l'étage 100 du Sanctuaire + achat ---
// Twist : chaque étage a une affinité élémentaire qui tourne Feu→Vent→Terre→Eau→Feu (même
// cycle que la rotation du Boss Mondial). La stat liée à l'élément de l'étage compte ×1.3,
// la stat "opposée" (2 crans plus loin dans le cycle de 4) compte ×0.7, les 2 autres restent
// à ×1 — les poids totalisent 4 (1.3+0.7+1+1), donc un joueur PARFAITEMENT équilibré n'est ni
// avantagé ni pénalisé : seul un profil mono-stat ressent vraiment l'effet, jour après jour.
const NOYAU_UNLOCK_FLOOR = 100; // étage du SANCTUAIRE (pas de la Tour) à atteindre
const NOYAU_UNLOCK_COST = 2000; // en Moltcoins
function noyauUnlockEligible(c){ return (c.corruptFloor||1) >= NOYAU_UNLOCK_FLOOR; }
// Base fixe à 15 000 pour l'étage 1 du Noyau, indépendante du Sanctuaire (auparavant calée
// sur corruptFloorRequirement(NOYAU_UNLOCK_FLOOR)). ⚠️ DOIT rester identique à perform-action.ts.
function noyauFloorRequirement(floor){ return Math.round(15000 * Math.pow(1.03, floor - 1)); }
function maxNoyauAttempts(c){ return c.species === 'Epineombre' ? 6 : 5; }
function maxNoyauClears(c){ return c.species === 'Epineombre' ? 11 : 10; }
function noyauXP(floor){ return 45 + floor * 3; }
function isNoyauLootFloor(floor){ return floor % 5 === 0; }
function noyauFloorElement(floor){ return ELEMENT_CYCLE[(floor-1) % 4]; }
function noyauOpposedElement(floor){ return ELEMENT_CYCLE[((floor-1)+2) % 4]; }
// Puissance pondérée par l'affinité élémentaire de l'étage — remplace totalPower() UNIQUEMENT
// pour le Noyau (les 2 autres donjons restent en Puissance simple, sans pondération).
function noyauPower(c, floor){
  const eq = equippedBonus(c);
  const favored = ELEMENT_TO_STAT[noyauFloorElement(floor)];
  const opposed = ELEMENT_TO_STAT[noyauOpposedElement(floor)];
  const weight = {crit:1, dodge:1, stamina:1, magic:1};
  weight[favored] = 1.3;
  weight[opposed] = 0.7;
  const statSum = (c.crit+eq.crit)*weight.crit + (c.dodge+eq.dodge)*weight.dodge
                + (c.stamina+eq.stamina)*weight.stamina + (c.magic+eq.magic)*weight.magic;
  const wellbeing = (c.hunger+c.joy+c.energy)/3;
  return Math.round((c.level*12 + statSum) * (0.5 + wellbeing/100*0.6));
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
const STAT_LABEL_EN = {crit:'Crit (Fire)', dodge:'Speed (Wind)', stamina:'Stamina (Earth)', magic:'Magic (Water)'};
const STAT_ICON = {crit:'🔥', dodge:'💨', stamina:'🪨', magic:'💧'};
const STAT_ACCENT = {crit:'var(--ember-bright)', dodge:'var(--blue)', stamina:'#5fbf9a', magic:'var(--violet)'};

// XP gagnée en vainquant un étage donné du Donjon — formule explicite, affichée dans l'UI.
function dungeonXP(floor){ return floor <= 100 ? 15 + floor : 15; } // au-delà de l'étage 100, retour à la base fixe (15) — le Sanctuaire Corrompu prend le relais côté XP. ⚠️ DOIT rester identique à perform-action.ts.
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
// Même ordre que la rotation du Boss Mondial — utilisé par le Noyau Primordial pour faire
// tourner l'affinité élémentaire de chaque étage (voir noyauFloorElement/noyauPower plus haut).
const ELEMENT_CYCLE = ['feu','vent','terre','eau'];
const ELEMENT_LABEL = { terre:'Terre', vent:'Vent', eau:'Eau', feu:'Feu' };
const ELEMENT_LABEL_EN = { terre:'Earth', vent:'Wind', eau:'Water', feu:'Fire' };
const BOSS_LIST = [
  { id:'ver_cendres',         name:'Le Ver-des-Cendres',         name_en:'The Ash-Worm',       element:'feu',   weakness:'eau',  resistance:'vent' },
  { id:'kraken_brumes',       name:'Le Kraken des Brumes',       name_en:'The Misty Kraken',    element:'eau',   weakness:'terre', resistance:'feu' },
  { id:'golem_granit',        name:'Le Golem de Granit',         name_en:'The Granite Golem',   element:'terre', weakness:'vent',  resistance:'eau' },
  { id:'spectre_bourrasques', name:'Le Spectre des Bourrasques', name_en:'The Gale Spectre',    element:'vent',  weakness:'feu',   resistance:'terre' },
];
function bossDef(boss){ return BOSS_LIST.find(b => b.id === boss?.bossId) || BOSS_LIST[0]; }
// Applique la faiblesse (+20%) et la résistance (-10%) élémentaires du boss courant aux 4
// stats combinées (créature + équipement), avant de les sommer dans estimatedDamage.
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
    errEl.textContent = currentLang==='en' ? `Message too long (max ${CHAT_MAX_LENGTH} characters).` : `Message trop long (max ${CHAT_MAX_LENGTH} caractères).`;
    errEl.style.display = 'block';
    return;
  }
  if(containsBannedWord(text)){
    errEl.textContent = currentLang==='en' ? 'Message blocked: please stay respectful of other players.' : 'Message bloqué : merci de rester respectueux envers les autres joueurs.';
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
        ? (currentLang==='en' ? 'Please wait a bit before sending another message.' : 'Merci d\'attendre un peu avant de renvoyer un message.')
        : (currentLang==='en' ? "Chat is very active right now, your message couldn't be sent — try again." : 'Le chat est très actif, ton message n\'a pas pu être envoyé — réessaie.');
      errEl.style.display = 'block';
      return;
    }
    chatLastSentLocal = Date.now();
    input.value = '';
    renderChat(pruneOldChatMessages(data.messages).slice(-CHAT_MAX_MESSAGES));
    updateChatCooldownUI();
  } catch(e){
    errEl.textContent = currentLang==='en' ? 'Could not reach the server — try again.' : 'Connexion au serveur impossible — réessaie.';
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
  } catch(e){ log(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.', 'hit'); console.error(e); }
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
  renderAchievementsPanel(c);
  renderActiveBadgePill();
  if(c.stage === 0){
    $('species-select-card').style.display = 'block';
    $('creature-card').style.display = 'none';
    $('danger-zone-card').style.display = 'none'; $('recovery-card').style.display = 'none';
    $('inventory-card').style.display = 'none';
    renderSpeciesSelect();
    renderTrainingPanel(c);
    renderDungeonPanel(c);
    renderCorruptPanel(c);
    renderNoyauPanel(c);
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
  preloadPhaserInBackground(); // filet de sécurité — normalement déjà lancé par init(), voir plus haut

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
  $('creature-name').textContent = c.name || (currentLang==='en' ? 'Unnamed' : 'Sans nom');
  const spName = SPECIES[c.species] ? SPECIES[c.species].name : '';
  $('level-pill').textContent = currentLang === 'en' ? `LVL ${c.level}` : `NIV. ${c.level}`;
  const stageLabels = currentLang === 'en' ? ['','Newborn','Juvenile','Teen'] : ['','Nouveau-né','Juvénile','Adolescent'];
  $('creature-meta').textContent = `${stageLabels[c.stage]} · ${spName}`;
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
  $('care-attempts-text').textContent = careLeft > 0
    ? (currentLang==='en' ? `${careLeft} care action${careLeft>1?'s':''} left today` : `${careLeft} action${careLeft>1?'s':''} de soin restante${careLeft>1?'s':''} aujourd'hui`)
    : (currentLang==='en' ? 'No more care actions today — come back tomorrow' : `Plus d'action de soin aujourd'hui — reviens demain`);
  const carePipRow = $('care-pip-row'); carePipRow.innerHTML = '';
  const careUsedToday = c.careDay === todayKey() ? c.careUsed : 0;
  for(let i=0;i<CARE_MAX;i++){ const pip = document.createElement('div'); pip.className = 'pip ' + (i < careUsedToday ? 'used' : 'available'); carePipRow.appendChild(pip); }
  $('btn-feed').disabled = careLeft === 0;
  $('btn-play').disabled = careLeft === 0;
  $('btn-sleep').disabled = careLeft === 0;

  // Tentatives d'attaque Boss : déplacé dans renderBoss() (dépend de `boss` en plus de `c`,
  // et alimente désormais le HUD Phaser plutôt que #attempts-text/#pip-row/#btn-attack,
  // retirés d'index.html).

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
      const dAllStat = liveDef ? liveDef.allStat : item.allStat;
      const desc = isUnique
        ? (item.special ? `${UNIQUE_ITEM_DB.find(u=>u.id===item.defId)?.description || ''}` : '')
        : dAllStat
          ? (currentLang==='en' ? `+${dAllStat} to all 4 stats` : `+${dAllStat} sur les 4 stats`)
          : `+${dValue} ${statLabel[dStat]}${dStat2 ? ` / +${dValue2} ${statLabel[dStat2]}` : ''}`;
      const icon = isUnique ? '✦' : dAllStat ? '🔮' : (STAT_ICON[dStat] || '❔');
      const accent = isUnique ? 'var(--ember-bright)' : dAllStat ? 'var(--gold)' : STAT_ACCENT[dStat];
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
  const statLabelForSummary = currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL;
  const parts = EQUIP_STATS.filter(s=>eq[s] > 0).map(s=>`+${eq[s]} ${statLabelForSummary[s]}`);
  const uniqueEquippedCount = c.inventory.filter(i=>i.equipped && i.rarity==='unique').length;
  const uniqueSummary = uniqueEquippedCount > 0
    ? (currentLang==='en' ? ` · ${uniqueEquippedCount} Moltyx active` : ` · ${uniqueEquippedCount} Moltyx actif${uniqueEquippedCount>1?'s':''}`)
    : '';
  $('equip-bonus-summary').textContent = (parts.length
    ? (currentLang==='en'
        ? `Active equipment bonus (${c.inventory.filter(i=>i.equipped && i.rarity!=='unique').length}/${MAX_EQUIP}): ${parts.join(' · ')}`
        : `Bonus d'équipement actif (${c.inventory.filter(i=>i.equipped && i.rarity!=='unique').length}/${MAX_EQUIP}) : ${parts.join(' · ')}`)
    : '') + uniqueSummary;
  renderTrainingPanel(c);
  renderDungeonPanel(c);
  renderCorruptPanel(c);
  renderNoyauPanel(c);
  renderTreasurePanel(c);
  renderChestsPanel(c);
  renderShopPanel(c);
  renderBoss(boss); // tentatives d'attaque dépendent de `c`, pas seulement de `boss` — voir la note dans renderBoss()
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
const SHOP_CANDY_COST = 250;
function hashStringToInt(s){
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function weeklyShopPick(dungeonId){
  if(dungeonId === 'candy'){
    const seed = hashStringToInt(weekKey() + ':candy');
    return CONSUMABLE_DB[seed % CONSUMABLE_DB.length];
  }
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
    { id:'candy', label: currentLang==='en' ? 'Weekly Candy' : 'Bonbon Hebdomadaire', cost: applyDiscount(SHOP_CANDY_COST), baseCost: SHOP_CANDY_COST, locked: false },
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
    const isCandy = entry.id === 'candy';
    const candyName = currentLang==='en' ? (def.name_en||def.name) : def.name;
    const candyDesc = currentLang==='en' ? (def.desc_en||def.desc) : def.desc;
    card.innerHTML = `
      <p style="font-size:11px;color:var(--ivory-dim);text-transform:uppercase;letter-spacing:0.04em;margin:0 0 4px;">${entry.label}</p>
      <p style="font-weight:700;color:var(--gold);margin:0 0 6px;">${isCandy ? `${def.icon} ${candyName}` : `✨ ${def.name}`}</p>
      <p style="font-size:12px;color:var(--ivory-dim);margin:0 0 10px;">${isCandy ? candyDesc : statLine(def)}</p>
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

  // Démarre le minuteur côté SERVEUR (horodatage en base) — c'est lui, et non le minuteur
  // local ci-dessous, qui fait foi pour chest_claim. Sans ça, un appel direct de chest_claim
  // (console/curl) pouvait sauter le délai d'attente entièrement.
  try{
    await performAction('chest_start', {});
  } catch(e){
    console.error(e);
    return;
  }

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
      statusEl.textContent = currentLang==='en' ? 'Ad finished!' : 'Publicité terminée !';
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
// Log de combat du Boss, INDÉPENDANT de log()/#log (qui garde toutes les autres
// notifications — éclosion, paiement, déblocage donjon...). Alimenté uniquement par
// handleBossAttackClick() ci-dessous, consommé par renderBoss() -> Bridge.showBossBattleUI.
let bossFightLog = [];
let bossAttackInFlight = false;
function pushBossFightLog(msg){
  bossFightLog.unshift(msg);
  if(bossFightLog.length > 20) bossFightLog.length = 20; // le HUD n'affiche que les 3 dernières, marge large pour usage futur
}

function renderBoss(boss){
  if(!boss) return; // peut être appelé (via renderCreature) avant que loadBoss() ait résolu
  const def = bossDef(boss);
  const elLabel = currentLang === 'en' ? ELEMENT_LABEL_EN : ELEMENT_LABEL;
  const bossName = currentLang==='en' ? (def.name_en || def.name) : def.name;
  const name = bossName + (boss.kills > 0 ? (currentLang==='en' ? ` (defeated ${boss.kills}x)` : ` (vaincu ${boss.kills}x)`) : '');
  const affinities = currentLang==='en'
    ? `Weak against ${elLabel[def.weakness]} (+20% damage taken) · Resists ${elLabel[def.resistance]} (-10% damage taken)`
    : `Faible contre ${elLabel[def.weakness]} (+20% dégâts subis) · Résiste à ${elLabel[def.resistance]} (-10% dégâts subis)`;
  const nextMonday = boss.cycleStart + 7*24*60*60*1000;
  const daysLeft = Math.max(0, Math.ceil((nextMonday - Date.now())/(1000*60*60*24)));
  const timerText = daysLeft > 0
    ? (currentLang==='en' ? `${daysLeft}d left` : `${daysLeft}j restants`)
    : (currentLang==='en' ? 'cycle ended' : 'cycle terminé');

  // Tentatives d'attaque — dépend de `creature`, pas de `boss` (déplacé depuis
  // renderCreature(), voir la note laissée là-bas).
  const c = creature;
  const attemptsMax = c ? maxBossAttacks(c) : 0;
  const attemptsUsed = c && c.lastAttackDay === todayKey() ? c.attacksToday : 0;
  const attemptsLeft = Math.max(0, attemptsMax - attemptsUsed);
  const attemptsText = attemptsLeft > 0
    ? (currentLang==='en' ? `${attemptsLeft} attack${attemptsLeft>1?'s':''} left today` : `${attemptsLeft} attaque${attemptsLeft>1?'s':''} restante${attemptsLeft>1?'s':''} aujourd'hui`)
    : (currentLang==='en' ? 'Come back tomorrow' : `Reviens demain`);
  const attackLabel = currentLang==='en' ? '⚔️ Attack' : '⚔️ Attaquer';

  // Ne pousse vers Phaser QUE si l'onglet Boss est réellement affiché — renderBoss() est
  // maintenant appelée à chaque renderCreature() (feed/play/training/...), pas seulement à
  // l'ouverture de l'onglet ; sans ce garde-fou, ça volerait sans arrêt le canvas partagé à
  // #creature-stage/#training-stage, cassant les animations en cours ailleurs.
  const bossPanelActive = $('panel-boss') && $('panel-boss').classList.contains('active');
  if(!bossPanelActive) return;

  playFxEffectSafe(Bridge => Bridge.showBossBattleUI({
    bossId: boss.bossId, name, affinities, weaknessElement: def.weakness, hp: boss.hp, maxHp: boss.maxHp, timerText,
    attemptsText, attemptsUsed, attemptsMax,
    attackDisabled: attemptsLeft === 0 || bossAttackInFlight,
    attackLabel, log: bossFightLog,
    onAttack: handleBossAttackClick,
  }));
}

/**
 * Callback du bouton Attaquer du HUD Phaser (voir onAttack passé à
 * Bridge.showBossBattleUI ci-dessus). Même logique réseau que l'ancien handler DOM
 * ($('btn-attack').onclick) — seule différence : les messages de combat vont dans
 * bossFightLog (HUD Phaser) au lieu de log()/#log, et la mise à jour du bouton
 * (désactivé pendant la requête) passe par un re-rendu de renderBoss() plutôt que
 * $('btn-attack').disabled.
 */
async function handleBossAttackClick(){
  if(bossAttackInFlight) return;
  const maxAtk = maxBossAttacks(creature);
  const attacksLeftLocal = creature.lastAttackDay === todayKey() ? maxAtk - creature.attacksToday : maxAtk;
  if(attacksLeftLocal <= 0) return;
  bossAttackInFlight = true;
  renderBoss(boss); // désactive visuellement le bouton pendant la requête
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
      pushBossFightLog(msg);
      return;
    }
    creature = mergeDefaults(data.creature);
    const boss2 = data.boss;
    boss = boss2;
    const lb2 = data.leaderboard;
    if(data.achievements){
      achievements = data.achievements;
      if(data.newlyUnlocked && data.newlyUnlocked.length) showAchievementToasts(data.newlyUnlocked);
    }
    if(data.bossDefeatedNow){
      const defeatedDef = bossDef(boss2);
      pushBossFightLog(currentLang==='en'
        ? `${defeatedDef.name_en || defeatedDef.name} is defeated! It respawns immediately.`
        : `${defeatedDef.name} est vaincu ! Il renaît aussitôt.`);
    }
    playFxEffectSafe(Bridge => Bridge.playBossEffect({}));
    // Le boss vient-il de tourner (reset hebdomadaire déclenché par CETTE attaque, voir
    // resetHappened dans attack-boss.ts) ? Si oui, le nouveau boss n'a pas réellement été
    // touché — on réaffiche juste son idle. Sinon (même boss, qu'il ait été achevé et
    // respawné à pleine vie ou non — voir bossDefeatedNow), on joue bien l'animation
    // "coup subi", qui revient automatiquement à l'idle une fois terminée.
    if(data.resetHappened) playFxEffectSafe(Bridge => Bridge.showBossIdle(boss2.bossId));
    else playFxEffectSafe(Bridge => Bridge.showBossAttacked(boss2.bossId));
    pushBossFightLog(currentLang==='en'
      ? `${creature.name} deals ${data.dmg} damage to the Boss.`
      : `${creature.name} inflige ${data.dmg} dégâts au Boss.`);
    renderCreature(creature); renderBoss(boss2); renderLeaderboard(lb2, myId);
    await renderPendingBossRewards();
  } catch(e){
    pushBossFightLog(currentLang==='en' ? 'Could not connect to the server — try again.' : 'Connexion au serveur impossible — réessaie.');
  } finally {
    bossAttackInFlight = false;
    renderBoss(boss);
  }
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

// ============ STREAK DE CONNEXION QUOTIDIENNE ============
// Cycle de 30 jours, récompenses croissantes, un bonbon différent aux jours 7/14/21/28
// (fin de chaque semaine de connexion) et un jackpot au jour 30. Purement décoratif/
// prévisionnel ici — le calcul du jour/série et l'octroi réel de la récompense sont
// entièrement décidés par le serveur (claim_daily_login, perform-action.ts /
// DAILY_STREAK_REWARDS). À tenir synchronisé avec le serveur si tu changes l'un des deux,
// mais un léger désaccord ici ne casserait rien de grave (juste un aperçu inexact avant le
// clic sur "Réclamer").
const DAILY_STREAK_REWARDS_PREVIEW = {
  1: { coins: 10 }, 2: { coins: 12 }, 3: { coins: 14 }, 4: { coins: 17 }, 5: { coins: 20 }, 6: { coins: 24 },
  7: { coins: 40, candyIds: ['candy_training'] },
  8: { coins: 16 }, 9: { coins: 18 }, 10: { coins: 21 }, 11: { coins: 24 }, 12: { coins: 28 }, 13: { coins: 32 },
  14: { coins: 55, candyIds: ['candy_dungeon'] },
  15: { coins: 20 }, 16: { coins: 23 }, 17: { coins: 26 }, 18: { coins: 30 }, 19: { coins: 34 }, 20: { coins: 39 },
  21: { coins: 70, candyIds: ['candy_boss'] },
  22: { coins: 26 }, 23: { coins: 29 }, 24: { coins: 33 }, 25: { coins: 37 }, 26: { coins: 42 }, 27: { coins: 47 },
  28: { coins: 90, candyIds: ['candy_treasure'] },
  29: { coins: 55 },
  30: { coins: 150, candyIds: ['candy_training','candy_dungeon','candy_boss','candy_treasure'] },
};
function yesterdayKeyClient(){ const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0,10); }

// Construit la grille des 30 jours (façon calendrier, 7 colonnes) — jour courant mis en
// avant — à partir de l'état ACTUEL de la créature, c'est-à-dire avant réclamation du jour.
// Le jour qui va être réclamé au clic est prévisible sans dupliquer la logique serveur :
// consécutif => streak+1, sinon => 1.
function renderStreakPreview(){
  const willBeConsecutive = creature.lastLoginDay === yesterdayKeyClient();
  const upcomingStreak = willBeConsecutive ? (creature.loginStreak || 0) + 1 : 1;
  const cycleDay = ((upcomingStreak - 1) % 30) + 1;
  const row = $('streak-days-row');
  row.innerHTML = '';
  for(let day = 1; day <= 30; day++){
    const r = DAILY_STREAK_REWARDS_PREVIEW[day];
    const badge = document.createElement('div');
    badge.className = 'streak-day-badge' + (day < cycleDay ? ' is-past' : '') + (day === cycleDay ? ' is-current' : '') + (r.candyIds ? ' has-candy' : '');
    const numEl = document.createElement('div'); numEl.className = 'day-num';
    numEl.textContent = day;
    const rewardEl = document.createElement('div'); rewardEl.className = 'day-reward';
    rewardEl.textContent = '+' + r.coins + '🪙';
    badge.appendChild(numEl); badge.appendChild(rewardEl);
    if(r.candyIds){
      const bonusEl = document.createElement('div'); bonusEl.className = 'day-candy';
      bonusEl.textContent = r.candyIds.map(id => (CONSUMABLE_DB.find(d=>d.id===id)||{}).icon || '🍬').join('');
      badge.appendChild(bonusEl);
      badge.title = r.candyIds.map(id => (CONSUMABLE_DB.find(d=>d.id===id)||{}).name || id).join(' · ');
    }
    row.appendChild(badge);
  }
  $('streak-count-line').textContent = currentLang === 'en'
    ? (upcomingStreak === 1 ? 'Day 1' : `Day ${upcomingStreak} in a row!`)
    : (upcomingStreak === 1 ? 'Jour 1' : `Jour ${upcomingStreak} d'affilée !`);
  $('streak-best-line').textContent = (creature.bestLoginStreak || 0) > 1
    ? (currentLang === 'en' ? `Best streak: ${creature.bestLoginStreak}` : `Record : ${creature.bestLoginStreak}`)
    : '';
}
function openStreakModalIfDue(){
  if(!creature || creature.stage === 0) return; // pas de Moltchi actif = pas de streak à proposer
  if(creature.lastLoginDay === todayKey()) return; // déjà réclamé aujourd'hui
  renderStreakPreview();
  $('streak-modal-overlay').style.display = 'flex';
}
async function claimDailyStreak(){
  const btn = $('btn-claim-streak');
  btn.disabled = true;
  let data;
  try{
    data = await performAction('claim_daily_login', {});
  } catch(e){
    console.error(e);
    btn.disabled = false;
    return;
  }
  creature = mergeDefaults(data.creature);
  renderCreature(creature);
  $('streak-modal-overlay').style.display = 'none';
  btn.disabled = false;

  let msg = currentLang === 'en'
    ? `Daily streak: day ${data.streak} — +${data.reward.coins} Moltcoins 🪙`
    : `Série quotidienne : jour ${data.streak} — +${data.reward.coins} Moltcoins 🪙`;
  if(data.reward.consumables && data.reward.consumables.length){
    const names = data.reward.consumables.map(c => {
      const def = CONSUMABLE_DB.find(d => d.id === c.id);
      return def ? `${def.icon} ${currentLang==='en' ? (def.name_en||def.name) : def.name}` : c.id;
    }).join(' · ');
    msg += currentLang === 'en' ? ` · ${names} obtained!` : ` · ${names} obtenu(s) !`;
  }
  log(msg, 'good');
}
$('btn-claim-streak').onclick = claimDailyStreak;
$('btn-close-streak').onclick = () => { $('streak-modal-overlay').style.display = 'none'; };
$('streak-modal-overlay').onclick = (e) => { if(e.target.id === 'streak-modal-overlay') $('streak-modal-overlay').style.display = 'none'; };

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
      if(!res.ok){
        pushBossFightLog(currentLang==='en' ? 'Could not claim rewards right now.' : 'Impossible de réclamer les récompenses pour le moment.');
        renderBoss(boss);
        return;
      }
      creature = mergeDefaults(data.creature);
      card.style.display = 'none';
      pushBossFightLog(currentLang==='en'
        ? `Weekly rewards claimed: +${data.totalXP} XP, +${data.totalCoins} Moltcoins.${data.moltyxWon ? ' ✦ Eclat du Monde obtained!' : ''}`
        : `Récompenses hebdomadaires réclamées : +${data.totalXP} XP, +${data.totalCoins} Moltcoins.${data.moltyxWon ? ' ✦ Eclat du Monde obtenu !' : ''}`);
      renderCreature(creature); // appelle déjà renderBoss(boss) en fin de fonction, voir la note dans renderBoss()
    } catch(e){
      pushBossFightLog(currentLang==='en' ? 'Could not connect to the server — try again.' : 'Connexion au serveur impossible — réessaie.');
      renderBoss(boss);
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
// Jeton de génération incrémenté à chaque démarrage d'un mini-jeu (Réflexe/Mémoire/
// Rythme/Invocation). Permet aux callbacks async d'un mini-jeu abandonné en cours de
// route (l'utilisateur a relancé un autre mini-jeu, ou changé d'onglet, avant la fin)
// de se rendre compte qu'ils ne sont plus d'actualité et de ne PAS toucher à l'écran
// suivant (ex: afficher le résultat serveur d'une partie déjà quittée par-dessus le
// mini-jeu qui a pris sa place).
let mgGen = 0;
function stopMinigameAmbience(){
  if(mgAmbientInterval){ clearInterval(mgAmbientInterval); mgAmbientInterval = null; }
  if(_phaserBridgeModule) _phaserBridgeModule.Bridge.stopTrainingGame(); // no-op si Phaser n'a jamais pris le relais
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
// ---------- Réflexe (voir game/bridge.js et game/scenes/TrainingScene.js) ----------
// Le mini-jeu vit désormais entièrement dans Phaser (plus de version DOM, plus de
// vérification de disponibilité à chaque clic) : Phaser est chargé une bonne fois pour
// toutes au tout début de l'appli (voir preloadPhaserBlocking() dans init()), avant même
// que l'écran ne se dévoile — il est donc déjà prêt à ce stade dans l'immense majorité
// des cas. Si jamais il ne l'était pas (échec réseau/CDN), le mini-jeu ne fait
// simplement rien plutôt que de retomber sur un ancien système DOM (supprimé).
async function startReflex(c){
  const myGen = ++mgGen;
  $('minigame-area').style.display = 'block';
  setMinigameTheme('fire');
  $('minigame-title').textContent = currentLang==='en' ? '⚡ Reflex — click as soon as the zone turns green' : '⚡ Réflexe — clique dès que la zone devient verte';
  const statLabel = currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL;

  if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
  await _phaserBridgeModule.Bridge.ensureLoaded();
  const { Bridge } = _phaserBridgeModule;
  if(myGen !== mgGen) return; // un autre mini-jeu a démarré pendant l'attente ci-dessus

  runMinigameCountdown(() => {
    if(myGen !== mgGen) return; // un autre mini-jeu a démarré pendant le décompte
    $('minigame-content').innerHTML = ''; // le mini-jeu Phaser se dessine dans #training-stage, juste au-dessus
    const started = Bridge.startReflexGame(async (result) => {
      try{
        let data, msg;
        if(result.tooEarly){
          data = await performAction('train_reflex', { tooEarly: true });
          msg = currentLang==='en' ? 'Too early! Try again.' : 'Trop tôt ! Réessaie.';
        } else {
          data = await performAction('train_reflex', { reactionMs: result.reactionMs });
          msg = `${result.reactionMs}ms — +${data.gain} ${statLabel.crit}`;
          if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
        }
        creature = mergeDefaults(data.creature);
        if(myGen !== mgGen) return; // mini-jeu abandonné pendant l'appel serveur : ne pas toucher à l'écran suivant
        Bridge.showTrainingResult(msg);
        renderCreature(creature);
      } catch(e){
        if(myGen === mgGen) Bridge.showTrainingResult(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.');
        console.error(e);
      }
    });
    if(!started) console.warn('[Moltchi/Phaser] Réflexe indisponible (Phaser non prêt) — aucune action.');
  });
}
// ---------- Mémoire (voir game/bridge.js et game/scenes/TrainingScene.js) ----------
async function startMemory(c){
  const myGen = ++mgGen;
  $('minigame-area').style.display = 'block';
  setMinigameTheme('wind');
  $('minigame-title').textContent = currentLang==='en' ? '🧩 Memory — reproduce the sequence' : '🧩 Mémoire — reproduis la séquence';
  const statLabel = currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL;

  if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
  await _phaserBridgeModule.Bridge.ensureLoaded();
  const { Bridge } = _phaserBridgeModule;
  if(myGen !== mgGen) return;

  runMinigameCountdown(() => {
    if(myGen !== mgGen) return; // un autre mini-jeu a démarré pendant le décompte
    $('minigame-content').innerHTML = ''; // sinon le dernier chiffre du décompte reste affiché sous le canvas
    const started = Bridge.startMemoryGame(async (result) => {
      try{
        let data, msg;
        if(result.success){
          data = await performAction('train_memory', { success: true, playerIdx: result.playerIdx });
          msg = currentLang==='en' ? `Perfect! +${data.gain} ${statLabel.dodge}` : `Parfait ! +${data.gain} ${statLabel.dodge}`;
        } else {
          data = await performAction('train_memory', { success: false, playerIdx: result.playerIdx });
          msg = currentLang==='en'
            ? `Missed at step ${result.playerIdx+1} — +${data.gain} ${statLabel.dodge} anyway`
            : `Raté à l'étape ${result.playerIdx+1} — +${data.gain} ${statLabel.dodge} quand même`;
        }
        if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
        creature = mergeDefaults(data.creature);
        if(myGen !== mgGen) return; // mini-jeu abandonné pendant l'appel serveur
        Bridge.showTrainingResult(msg);
        renderCreature(creature);
      } catch(e){
        if(myGen === mgGen) Bridge.showTrainingResult(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.');
        console.error(e);
      }
    });
    if(!started) console.warn('[Moltchi/Phaser] Mémoire indisponible (Phaser non prêt) — aucune action.');
  });
}
// ---------- Rythme (voir game/bridge.js et game/scenes/TrainingScene.js) ----------
async function startRhythm(c){
  const myGen = ++mgGen;
  $('minigame-area').style.display = 'block';
  setMinigameTheme('earth');
  $('minigame-title').textContent = currentLang==='en' ? '🎵 Rhythm — click when the cursor is in the golden zone' : '🎵 Rythme — clique quand le curseur est dans la zone dorée';
  const statLabel = (currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL).stamina;

  if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
  await _phaserBridgeModule.Bridge.ensureLoaded();
  const { Bridge } = _phaserBridgeModule;
  if(myGen !== mgGen) return;

  runMinigameCountdown(() => {
    if(myGen !== mgGen) return;
    $('minigame-content').innerHTML = '';
    const started = Bridge.startRhythmGame(async (result) => {
      try{
        const data = await performAction('train_rhythm', { distFromCenter: result.distFromCenter });
        creature = mergeDefaults(data.creature);
        if(myGen !== mgGen) return;
        let msg = `+${data.gain} ${statLabel}`;
        if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
        Bridge.showTrainingResult(msg);
        renderCreature(creature);
      } catch(e){
        if(myGen === mgGen) Bridge.showTrainingResult(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.');
        console.error(e);
      }
    });
    if(!started) console.warn('[Moltchi/Phaser] Rythme indisponible (Phaser non prêt) — aucune action.');
  });
}
// ---------- Invocation (voir game/bridge.js et game/scenes/TrainingScene.js) ----------
// Contrairement aux 3 autres, Phaser gère ici ENTIÈREMENT les 5 manches en interne — un
// seul appel serveur au tout final, avec le score cumulé.
async function startArcane(c){
  const myGen = ++mgGen;
  $('minigame-area').style.display = 'block';
  setMinigameTheme('water');
  $('minigame-title').textContent = currentLang==='en' ? '🔮 Invocation — click the rune matching the one shown, before the timer runs out' : '🔮 Invocation — clique la rune identique à celle affichée, avant la fin du sablier';

  if(!_phaserBridgeModule) _phaserBridgeModule = await import('./game/bridge.js');
  await _phaserBridgeModule.Bridge.ensureLoaded();
  const { Bridge } = _phaserBridgeModule;
  if(myGen !== mgGen) return;

  runMinigameCountdown(() => {
    if(myGen !== mgGen) return;
    $('minigame-content').innerHTML = '';
    const started = Bridge.startArcaneGame(async (result) => {
      try{
        const data = await performAction('train_arcane', { totalScore: result.totalScore });
        creature = mergeDefaults(data.creature);
        if(myGen !== mgGen) return;
        const magicLabel = (currentLang==='en' ? STAT_LABEL_EN : STAT_LABEL).magic;
        let msg = currentLang==='en' ? `Invocation complete — +${data.gain} ${magicLabel}` : `Invocation terminée — +${data.gain} ${magicLabel}`;
        if(data.uniqueFound) msg += currentLang==='en' ? ` ✦ Moltyx found: ${itemDisplayName(data.uniqueFound)}!` : ` ✦ Moltyx trouvé : ${itemDisplayName(data.uniqueFound)} !`;
        Bridge.showTrainingResult(msg);
        renderCreature(creature);
      } catch(e){
        if(myGen === mgGen) Bridge.showTrainingResult(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.');
        console.error(e);
      }
    });
    if(!started) console.warn('[Moltchi/Phaser] Invocation indisponible (Phaser non prêt) — aucune action.');
  });
}


// ============================================================
// ============ RENDU DONJON (Tour / Sanctuaire / Noyau) ============
// ============================================================
// Les 3 vivent dans LE MÊME panneau HTML (#panel-dungeon), empilés en scroll. Comme il n'y
// a qu'un seul canvas Phaser partagé pour toute l'app, un seul des 3 peut avoir le rendu
// riche à la fois — activeDungeonSection indique lequel, mis à jour par
// l'IntersectionObserver plus bas (suit le scroll du joueur).
let activeDungeonSection = 'dungeon';

// Logs de combat, INDÉPENDANTS de log()/#log — un par donjon, alimentés uniquement par
// leur handler de clic respectif, consommés par Bridge.showDungeonHUD(key, {...}).
let dungeonFightLog = [];
function pushDungeonFightLog(msg){
  dungeonFightLog.unshift(msg);
  if(dungeonFightLog.length > 20) dungeonFightLog.length = 20; // le HUD n'affiche que les 3 dernières (1 en mobile), marge large pour usage futur
}
let corruptFightLog = [];
function pushCorruptFightLog(msg){
  corruptFightLog.unshift(msg);
  if(corruptFightLog.length > 20) corruptFightLog.length = 20;
}
let noyauFightLog = [];
function pushNoyauFightLog(msg){
  noyauFightLog.unshift(msg);
  if(noyauFightLog.length > 20) noyauFightLog.length = 20;
}

function renderDungeonPanel(c){
  const attemptsLeft = c.dungeonDay === todayKey() ? Math.max(0, maxDungeonAttempts(c) - c.dungeonAttempts) : maxDungeonAttempts(c);
  const clearsLeft = c.dungeonDay === todayKey() ? Math.max(0, maxDungeonClears(c) - c.dungeonClears) : maxDungeonClears(c);
  const attemptsUsed = c.dungeonDay === todayKey() ? c.dungeonAttempts : 0;
  const attemptsMax = maxDungeonAttempts(c);

  const attemptsText = currentLang==='en'
    ? (attemptsLeft > 0 ? `${attemptsLeft} failure${attemptsLeft>1?'s':''} allowed today` : 'No more failures allowed today')
    : (attemptsLeft > 0 ? `${attemptsLeft} échec${attemptsLeft>1?'s':''} autorisé${attemptsLeft>1?'s':''} aujourd'hui` : "Plus d'échecs autorisés aujourd'hui");
  const clearsText = currentLang==='en'
    ? (clearsLeft > 0 ? `${clearsLeft} floor${clearsLeft>1?'s':''} climbable today` : 'Daily floor cap reached')
    : (clearsLeft > 0 ? `${clearsLeft} étage${clearsLeft>1?'s':''} franchissable${clearsLeft>1?'s':''} aujourd'hui` : "Plafond d'étages du jour atteint");
  const climbDisabled = c.stage === 0 || attemptsLeft === 0 || clearsLeft === 0 || towerClimbInFlight;
  const climbLabel = currentLang==='en' ? '⚔️ Climb' : "⚔️ Tenter l'étage";
  const floorLabel = currentLang==='en' ? 'FLOOR' : 'ÉTAGE';
  const powerLabel = currentLang==='en' ? 'YOUR POWER' : 'TA PUISSANCE';
  const reqLabel = currentLang==='en' ? 'FLOOR CHALLENGE' : "DÉFI DE L'ÉTAGE";

  const xpReward = dungeonXP(c.dungeonFloor);
  const xpFailReward = Math.max(1, Math.round(xpReward * 0.25));
  let rewardText;
  if(currentLang === 'en'){
    if(isLootFloor(c.dungeonFloor)){
      rewardText = `This floor's reward: +${xpReward} XP + 1 item (loot floor). A win costs no failure. Loss: +${xpFailReward} XP anyway.`;
    } else {
      const next = c.dungeonFloor - (c.dungeonFloor % 5) + 5;
      rewardText = `This floor's reward: +${xpReward} XP. Next item at floor ${next}. A win costs no failure. Loss: +${xpFailReward} XP anyway.`;
    }
  } else {
    if(isLootFloor(c.dungeonFloor)){
      rewardText = `Récompense de cet étage : +${xpReward} XP + 1 objet (palier de butin). Une victoire ne consomme aucun échec. Défaite : +${xpFailReward} XP quand même.`;
    } else {
      const next = c.dungeonFloor - (c.dungeonFloor % 5) + 5;
      rewardText = `Récompense de cet étage : +${xpReward} XP. Prochain objet à l'étage ${next}. Une victoire ne consomme aucun échec. Défaite : +${xpFailReward} XP quand même.`;
    }
  }
  $('dungeon-reward-info').textContent = rewardText; // gardé à jour même masqué, au cas où réactivé un jour

  // Même garde-fou que pour le Boss (onglet actif) + le nouveau garde-fou spécifique aux
  // donjons (activeDungeonSection) : ne pousse vers Phaser QUE si c'est cette section-ci
  // qui a actuellement le canvas, sinon les 3 fonctions de rendu se le disputeraient à
  // chaque rafraîchissement (voir la conversation).
  const dungeonPanelActive = $('panel-dungeon') && $('panel-dungeon').classList.contains('active');
  if(dungeonPanelActive && activeDungeonSection === 'dungeon'){
    playFxEffectSafe(Bridge => Bridge.showDungeonHUD('dungeon', {
      dungeonName: currentLang==='en' ? I18N_EN.h2_wyrm_tower : 'Tour du Wyrm',
      floorLabel, floorNum: c.dungeonFloor,
      powerLabel, yourPower: totalPower(c),
      reqLabel, floorPower: floorRequirement(c.dungeonFloor),
      attemptsText, attemptsUsed, attemptsMax,
      clearsText,
      climbLabel, climbDisabled,
      rewardText, log: dungeonFightLog,
      onClimb: handleTowerClimbClick,
    }));
  }
  renderCodex(c);
}

let towerClimbInFlight = false;

/**
 * Callback du bouton "Tenter l'étage" du HUD Phaser de la Tour (voir onClimb passé à
 * Bridge.showDungeonTowerHUD ci-dessus). Même logique réseau que l'ancien handler DOM
 * ($('btn-climb').onclick) — juste redirigée + un garde-fou anti-double-clic pendant la
 * requête (même principe que bossAttackInFlight pour le Boss).
 */
async function handleTowerClimbClick(){
  if(towerClimbInFlight) return;
  const attemptsLeft = creature.dungeonDay === todayKey() ? Math.max(0, maxDungeonAttempts(creature) - creature.dungeonAttempts) : maxDungeonAttempts(creature);
  const clearsLeft = creature.dungeonDay === todayKey() ? Math.max(0, maxDungeonClears(creature) - creature.dungeonClears) : maxDungeonClears(creature);
  if(attemptsLeft === 0) return;
  if(clearsLeft === 0) return;
  towerClimbInFlight = true;
  renderDungeonPanel(creature); // désactive visuellement le bouton pendant la requête
  try{
    const data = await performAction('dungeon_climb', {});
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
      pushDungeonFightLog(msg);
    } else {
      let msg = currentLang==='en'
        ? `Defeat at floor ${data.failFloor}. +${data.xpGain} XP anyway. Strengthen ${creature.name} and try again.`
        : `Défaite à l'étage ${data.failFloor}. +${data.xpGain} XP quand même. Renforce ${creature.name} et retente.`;
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      pushDungeonFightLog(msg);
    }
    playFxEffectSafe(Bridge => Bridge.playDungeonEffect('dungeon-fx-stage', { won: !!data.win }));
    renderCreature(creature);
  } catch(e){
    pushDungeonFightLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'); console.error(e);
  } finally {
    towerClimbInFlight = false;
    renderDungeonPanel(creature);
  }
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

  const attemptsLeft = c.corruptDay === todayKey() ? Math.max(0, maxCorruptAttempts(c) - c.corruptAttempts) : maxCorruptAttempts(c);
  const clearsLeft = c.corruptDay === todayKey() ? Math.max(0, maxCorruptClears(c) - c.corruptClears) : maxCorruptClears(c);
  const attemptsUsed = c.corruptDay === todayKey() ? c.corruptAttempts : 0;
  const attemptsMax = maxCorruptAttempts(c);

  const attemptsText = currentLang==='en'
    ? (attemptsLeft > 0 ? `${attemptsLeft} failure${attemptsLeft>1?'s':''} allowed today` : 'No more failures allowed today')
    : (attemptsLeft > 0 ? `${attemptsLeft} échec${attemptsLeft>1?'s':''} autorisé${attemptsLeft>1?'s':''} aujourd'hui` : "Plus d'échecs autorisés aujourd'hui");
  const clearsText = currentLang==='en'
    ? (clearsLeft > 0 ? `${clearsLeft} floor${clearsLeft>1?'s':''} climbable today` : 'Daily floor cap reached')
    : (clearsLeft > 0 ? `${clearsLeft} étage${clearsLeft>1?'s':''} franchissable${clearsLeft>1?'s':''} aujourd'hui` : "Plafond d'étages du jour atteint");
  const climbDisabled = c.stage === 0 || attemptsLeft === 0 || clearsLeft === 0 || corruptClimbInFlight;
  const climbLabel = currentLang==='en' ? '⚔️ Climb' : "⚔️ Tenter l'étage";
  const floorLabel = currentLang==='en' ? 'FLOOR' : 'ÉTAGE';
  const powerLabel = currentLang==='en' ? 'YOUR POWER' : 'TA PUISSANCE';
  const reqLabel = currentLang==='en' ? 'FLOOR CHALLENGE' : "DÉFI DE L'ÉTAGE";

  const xpReward = corruptXP(c.corruptFloor);
  const xpFailReward = Math.max(1, Math.round(xpReward * 0.25));
  let rewardText;
  if(currentLang === 'en'){
    if(isCorruptLootFloor(c.corruptFloor)){
      rewardText = `This floor's reward: +${xpReward} XP + 1 Sanctuary-exclusive item. Loss: +${xpFailReward} XP anyway.`;
    } else {
      const next = c.corruptFloor - (c.corruptFloor % 5) + 5;
      rewardText = `This floor's reward: +${xpReward} XP. Next item at floor ${next}. Loss: +${xpFailReward} XP anyway.`;
    }
  } else {
    if(isCorruptLootFloor(c.corruptFloor)){
      rewardText = `Récompense de cet étage : +${xpReward} XP + 1 objet exclusif au Sanctuaire. Défaite : +${xpFailReward} XP quand même.`;
    } else {
      const next = c.corruptFloor - (c.corruptFloor % 5) + 5;
      rewardText = `Récompense de cet étage : +${xpReward} XP. Prochain objet à l'étage ${next}. Défaite : +${xpFailReward} XP quand même.`;
    }
  }
  $('corrupt-reward-info').textContent = rewardText; // gardé à jour même masqué, au cas où réactivé un jour

  const dungeonPanelActive = $('panel-dungeon') && $('panel-dungeon').classList.contains('active');
  if(dungeonPanelActive && activeDungeonSection === 'corrupt'){
    playFxEffectSafe(Bridge => Bridge.showDungeonHUD('corrupt', {
      dungeonName: currentLang==='en' ? 'Corrupt Sanctuary' : 'Sanctuaire Corrompu',
      floorLabel, floorNum: c.corruptFloor,
      powerLabel, yourPower: totalPower(c),
      reqLabel, floorPower: corruptFloorRequirement(c.corruptFloor),
      attemptsText, attemptsUsed, attemptsMax,
      clearsText,
      climbLabel, climbDisabled,
      rewardText, log: corruptFightLog,
      onClimb: handleCorruptClimbClick,
    }));
  }
}

let corruptClimbInFlight = false;

/** Callback du bouton "Tenter l'étage" du HUD Phaser du Sanctuaire — même structure que
 * handleTowerClimbClick(), voir cette dernière pour le détail des commentaires. */
async function handleCorruptClimbClick(){
  if(corruptClimbInFlight) return;
  if(!creature.corruptUnlocked) return;
  const attemptsLeft = creature.corruptDay === todayKey() ? Math.max(0, maxCorruptAttempts(creature) - creature.corruptAttempts) : maxCorruptAttempts(creature);
  const clearsLeft = creature.corruptDay === todayKey() ? Math.max(0, maxCorruptClears(creature) - creature.corruptClears) : maxCorruptClears(creature);
  if(attemptsLeft === 0) return;
  if(clearsLeft === 0) return;
  corruptClimbInFlight = true;
  renderCorruptPanel(creature);
  try{
    const data = await performAction('dungeon_climb_corrupt', {});
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
      pushCorruptFightLog(msg);
    } else {
      let msg = currentLang==='en'
        ? `Defeat at Sanctuary floor ${data.failFloor}. +${data.xpGain} XP anyway. Strengthen ${creature.name} and try again.`
        : `Défaite à l'étage ${data.failFloor} du Sanctuaire. +${data.xpGain} XP quand même. Renforce ${creature.name} et retente.`;
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      pushCorruptFightLog(msg);
    }
    playFxEffectSafe(Bridge => Bridge.playDungeonEffect('corrupt-fx-stage', { won: !!data.win }));
    renderCreature(creature);
  } catch(e){
    pushCorruptFightLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'); console.error(e);
  } finally {
    corruptClimbInFlight = false;
    renderCorruptPanel(creature);
  }
}

function renderNoyauPanel(c){
  const eligible = noyauUnlockEligible(c);
  const lockedCard = $('noyau-locked-card');
  const playCard = $('noyau-play-card');

  if(!c.noyauUnlocked){
    lockedCard.style.display = 'block';
    playCard.style.display = 'none';
    const reqEl = $('noyau-req-text');
    const btn = $('btn-unlock-noyau');
    if(!eligible){
      reqEl.innerHTML = currentLang==='en'
        ? `Missing requirement: reach floor <strong>${NOYAU_UNLOCK_FLOOR}</strong> of the Corrupt Sanctuary (currently floor ${c.corruptFloor||1}).`
        : `Condition manquante : atteindre l'étage <strong>${NOYAU_UNLOCK_FLOOR}</strong> du Sanctuaire Corrompu (actuellement étage ${c.corruptFloor||1}).`;
      reqEl.style.color = 'var(--ember-bright)';
      btn.disabled = true;
    } else if((c.moltcoins||0) < NOYAU_UNLOCK_COST){
      reqEl.innerHTML = currentLang==='en'
        ? `Floor ${NOYAU_UNLOCK_FLOOR} reached ✓ — you're missing Moltcoins (${c.moltcoins||0} / ${NOYAU_UNLOCK_COST}).`
        : `Étage ${NOYAU_UNLOCK_FLOOR} atteint ✓ — il te manque des Moltcoins (${c.moltcoins||0} / ${NOYAU_UNLOCK_COST}).`;
      reqEl.style.color = 'var(--ivory-dim)';
      btn.disabled = true;
    } else {
      reqEl.innerHTML = currentLang==='en'
        ? `Floor ${NOYAU_UNLOCK_FLOOR} reached ✓ — the passage can be opened.`
        : `Étage ${NOYAU_UNLOCK_FLOOR} atteint ✓ — le passage peut être ouvert.`;
      reqEl.style.color = '#4ea88a';
      btn.disabled = false;
    }
    return;
  }

  lockedCard.style.display = 'none';
  playCard.style.display = 'block';

  const floor = c.noyauFloor;
  const favored = ELEMENT_TO_STAT[noyauFloorElement(floor)];
  const opposed = ELEMENT_TO_STAT[noyauOpposedElement(floor)];
  const elLabel = currentLang === 'en' ? ELEMENT_LABEL_EN : ELEMENT_LABEL;
  const statLabel = currentLang === 'en' ? STAT_LABEL_EN : STAT_LABEL;

  const affinityText = currentLang === 'en'
    ? `This floor's affinity: ${elLabel[noyauFloorElement(floor)]} (${statLabel[favored]} ×1.3) — opposed: ${statLabel[opposed]} ×0.7`
    : `Affinité de cet étage : ${elLabel[noyauFloorElement(floor)]} (${statLabel[favored]} ×1,3) — opposée : ${statLabel[opposed]} ×0,7`;
  $('noyau-affinity-text').innerHTML = currentLang === 'en'
    ? `This floor's affinity: <strong>${elLabel[noyauFloorElement(floor)]}</strong> (${statLabel[favored]} ×1.3) — opposed: ${statLabel[opposed]} ×0.7`
    : `Affinité de cet étage : <strong>${elLabel[noyauFloorElement(floor)]}</strong> (${statLabel[favored]} ×1,3) — opposée : ${statLabel[opposed]} ×0,7`; // gardé à jour même masqué

  const attemptsLeft = c.noyauDay === todayKey() ? Math.max(0, maxNoyauAttempts(c) - c.noyauAttempts) : maxNoyauAttempts(c);
  const clearsLeft = c.noyauDay === todayKey() ? Math.max(0, maxNoyauClears(c) - c.noyauClears) : maxNoyauClears(c);
  const attemptsUsed = c.noyauDay === todayKey() ? c.noyauAttempts : 0;
  const attemptsMax = maxNoyauAttempts(c);

  const attemptsText = currentLang==='en'
    ? (attemptsLeft > 0 ? `${attemptsLeft} failure${attemptsLeft>1?'s':''} allowed today` : 'No more failures allowed today')
    : (attemptsLeft > 0 ? `${attemptsLeft} échec${attemptsLeft>1?'s':''} autorisé${attemptsLeft>1?'s':''} aujourd'hui` : "Plus d'échecs autorisés aujourd'hui");
  const clearsText = currentLang==='en'
    ? (clearsLeft > 0 ? `${clearsLeft} floor${clearsLeft>1?'s':''} climbable today` : 'Daily floor cap reached')
    : (clearsLeft > 0 ? `${clearsLeft} étage${clearsLeft>1?'s':''} franchissable${clearsLeft>1?'s':''} aujourd'hui` : "Plafond d'étages du jour atteint");
  const climbDisabled = c.stage === 0 || attemptsLeft === 0 || clearsLeft === 0 || noyauClimbInFlight;
  const climbLabel = currentLang==='en' ? '⚔️ Climb' : "⚔️ Tenter l'étage";
  const floorLabel = currentLang==='en' ? 'FLOOR' : 'ÉTAGE';
  const powerLabel = currentLang==='en' ? 'YOUR POWER' : 'TA PUISSANCE';
  const reqLabel = currentLang==='en' ? 'FLOOR CHALLENGE' : "DÉFI DE L'ÉTAGE";

  const xpReward = noyauXP(floor);
  const xpFailReward = Math.max(1, Math.round(xpReward * 0.25));
  let rewardBody;
  if(currentLang === 'en'){
    if(isNoyauLootFloor(floor)){
      rewardBody = `This floor's reward: +${xpReward} XP + 1 Core-exclusive item. Loss: +${xpFailReward} XP anyway.`;
    } else {
      const next = floor - (floor % 5) + 5;
      rewardBody = `This floor's reward: +${xpReward} XP. Next item at floor ${next}. Loss: +${xpFailReward} XP anyway.`;
    }
  } else {
    if(isNoyauLootFloor(floor)){
      rewardBody = `Récompense de cet étage : +${xpReward} XP + 1 objet exclusif au Noyau. Défaite : +${xpFailReward} XP quand même.`;
    } else {
      const next = floor - (floor % 5) + 5;
      rewardBody = `Récompense de cet étage : +${xpReward} XP. Prochain objet à l'étage ${next}. Défaite : +${xpFailReward} XP quand même.`;
    }
  }
  // Affinité fusionnée AVEC la récompense (pas de 4e zone de texte dédiée dans le HUD
  // Phaser générique, voir DungeonScene.js) — seul le Noyau a cette info en plus.
  const rewardText = `${affinityText}\n${rewardBody}`;
  $('noyau-reward-info').textContent = rewardText; // gardé à jour même masqué

  const dungeonPanelActive = $('panel-dungeon') && $('panel-dungeon').classList.contains('active');
  if(dungeonPanelActive && activeDungeonSection === 'noyau'){
    playFxEffectSafe(Bridge => Bridge.showDungeonHUD('noyau', {
      dungeonName: currentLang==='en' ? 'Primordial Core' : 'Noyau Primordial',
      floorLabel, floorNum: floor,
      powerLabel, yourPower: noyauPower(c, floor),
      reqLabel, floorPower: noyauFloorRequirement(floor),
      attemptsText, attemptsUsed, attemptsMax,
      clearsText,
      climbLabel, climbDisabled,
      rewardText, log: noyauFightLog,
      onClimb: handleNoyauClimbClick,
    }));
  }
}

let noyauClimbInFlight = false;

/** Callback du bouton "Tenter l'étage" du HUD Phaser du Noyau — même structure que
 * handleTowerClimbClick(), voir cette dernière pour le détail des commentaires. */
async function handleNoyauClimbClick(){
  if(noyauClimbInFlight) return;
  if(!creature.noyauUnlocked) return;
  const attemptsLeft = creature.noyauDay === todayKey() ? Math.max(0, maxNoyauAttempts(creature) - creature.noyauAttempts) : maxNoyauAttempts(creature);
  const clearsLeft = creature.noyauDay === todayKey() ? Math.max(0, maxNoyauClears(creature) - creature.noyauClears) : maxNoyauClears(creature);
  if(attemptsLeft === 0) return;
  if(clearsLeft === 0) return;
  noyauClimbInFlight = true;
  renderNoyauPanel(creature);
  try{
    const data = await performAction('dungeon_climb_noyau', {});
    creature = mergeDefaults(data.creature);
    const moltyxFoundTxt = currentLang==='en'
      ? (n) => ` ✦ Moltyx found: ${n}!`
      : (n) => ` ✦ Moltyx trouvé : ${n} !`;
    if(data.win){
      let msg = currentLang==='en'
        ? `Core floor ${data.clearedFloor} cleared! +${data.xpGain} XP.`
        : `Étage ${data.clearedFloor} du Noyau vaincu ! +${data.xpGain} XP.`;
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
      pushNoyauFightLog(msg);
    } else {
      let msg = currentLang==='en'
        ? `Defeat at Core floor ${data.failFloor}. +${data.xpGain} XP anyway. Strengthen ${creature.name} and try again.`
        : `Défaite à l'étage ${data.failFloor} du Noyau. +${data.xpGain} XP quand même. Renforce ${creature.name} et retente.`;
      if(data.uniqueFound) msg += moltyxFoundTxt(itemDisplayName(data.uniqueFound));
      pushNoyauFightLog(msg);
    }
    playFxEffectSafe(Bridge => Bridge.playDungeonEffect('noyau-fx-stage', { won: !!data.win }));
    renderCreature(creature);
  } catch(e){
    pushNoyauFightLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.'); console.error(e);
  } finally {
    noyauClimbInFlight = false;
    renderNoyauPanel(creature);
  }
}
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
    rechargeEl.textContent = currentLang==='en' ? 'Action Points at maximum.' : "Points d'action au maximum.";
  } else {
    const msUntilNext = TREASURE_AP_REGEN_MS - (Date.now() - c.treasureAPLastTick);
    rechargeEl.textContent = currentLang==='en'
      ? `Next Action Point in ${formatMinutes(msUntilNext)} (1 per hour).`
      : `Prochain point d'action dans ${formatMinutes(msUntilNext)} (1 par heure).`;
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
    const noyauItems = NOYAU_ITEM_DB.filter(i => i.rarity === rarity).map(i => ({...i, tag:'NP'}));
    const items = [...wyrmItems, ...corruptItems, ...noyauItems];
    const card = $(elId);
    if(!card) return;
    const minFloor = wyrmItems.length ? Math.min(...wyrmItems.map(i => i.minFloor)) : null;
    const floorTxt = minFloor !== null ? ` <span class="meta" style="font-size:11px;font-weight:normal;">— ${currentLang==='en' ? `from floor ${minFloor}` : `dès l'étage ${minFloor}`}</span>` : '';
    let html = `<h2 class="rarity-${rarity}">${titles[rarity]}${floorTxt}</h2><ul class="codex-list">`;
    items.forEach(def=>{
      const has = owned.has(def.id);
      const name = currentLang==='en' ? (def.name_en||def.name) : def.name;
      const statTxt = def.allStat
        ? (currentLang==='en' ? `+${def.allStat} to all 4 stats` : `+${def.allStat} sur les 4 stats`)
        : def.stat2 ? `+${def.value} ${statLabel[def.stat]} / +${def.value2} ${statLabel[def.stat2]}` : `+${def.value} ${statLabel[def.stat]}`;
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
  if(!code){ statusEl.style.color = 'var(--danger)'; statusEl.textContent = currentLang==='en' ? 'Paste a recovery code first.' : 'Colle d\'abord un code de récupération.'; return; }
  const confirmMsg = currentLang==='en'
    ? "Restoring this code will replace this device's current progress with the one linked to this code. Continue?"
    : 'Restaurer ce code va remplacer la progression actuelle de cet appareil par celle liée à ce code. Continuer ?';
  if(!confirm(confirmMsg)) return;
  localStorage.setItem('moltchi_player_scope', code);
  location.reload();
}

let creature, myId, boss;
async function init(){
  // Écran de chargement plein écran tant que Phaser + les deux scènes ne sont pas prêts
  // (voir #phaser-loading-overlay dans index.html, visible par défaut). Bloque le
  // démarrage du reste de l'appli — mais jamais plus de PHASER_LOADING_TIMEOUT_MS, pour
  // ne pas coincer le joueur si le réseau/CDN a un problème.
  await preloadPhaserBlocking();
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
    errorEl.textContent = currentLang==='en' ? 'Choose a username between 2 and 18 characters.' : 'Choisis un pseudo entre 2 et 18 caractères.';
    errorEl.style.display = 'block';
    return;
  }
  try{
    await setUsername(val);
  } catch(e){
    errorEl.textContent = e.message === 'ce pseudo est déjà pris'
      ? (currentLang==='en' ? 'This username is already taken — pick another one.' : 'Ce pseudo est déjà pris — choisis-en un autre.')
      : (currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.');
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
  openStreakModalIfDue();
  await handleStripeReturn();

  boss = await loadBoss();
  renderBoss(boss);
  // Précharge en tâche de fond les spritesheets idle + attacked du boss de la semaine, dès
  // qu'on connaît son id — pour que l'ouverture de l'onglet Boss ET la première attaque
  // soient quasi instantanées, plutôt que de télécharger les PNG au moment précis. Ne
  // déplace pas le canvas partagé (voir Bridge.preloadBossIdle/preloadBossAttacked), donc
  // sans effet sur le reste de l'appli. Non bloquant, échec silencieux comme le reste des
  // effets Phaser optionnels.
  playFxEffectSafe(Bridge => Bridge.preloadBossIdle(boss.bossId));
  playFxEffectSafe(Bridge => Bridge.preloadBossAttacked(boss.bossId));
  // Slash partagé (media/attackboss_slash.png, voir playAttack() dans BossScene.js) : pas
  // besoin de bossId, un seul fichier commun à tous les boss.
  playFxEffectSafe(Bridge => Bridge.preloadBossSlash());
  // Assets fixes du HUD de combat (cadre HP, log, bouton, gemmes) — indépendants du boss,
  // une seule fois pour toute la session.
  playFxEffectSafe(Bridge => Bridge.preloadBossBattleUIAssets());
  // Fond d'arène : CELUI-LÀ dépend du boss (voir BOSS_ARENA_BG dans BossScene.js), donc
  // préchargé par bossId comme idle/attacked, pas dans le lot fixe ci-dessus.
  playFxEffectSafe(Bridge => Bridge.preloadBossArenaBg(boss.bossId));
  // Assets fixes du HUD de la Tour du Wyrm (fond, bouton, gemmes réutilisées du Boss) —
  // indépendants de toute donnée de partie, une seule fois pour toute la session.
  // Chrome partagé (bouton/panneau/gemmes) + fond de la Tour, toujours pertinent dès le
  // départ. Sanctuaire/Noyau préchargés aussi — best-effort, pas grave s'ils n'ont pas
  // encore de fond dédié généré (voir DUNGEON_BG dans DungeonScene.js, pas de repli).
  playFxEffectSafe(Bridge => Bridge.preloadDungeonAssets('dungeon'));
  playFxEffectSafe(Bridge => Bridge.preloadDungeonAssets('corrupt'));
  playFxEffectSafe(Bridge => Bridge.preloadDungeonAssets('noyau'));
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
    $('btn-toggle-recovery-visibility').textContent = hidden
      ? (currentLang==='en' ? '🙈 Hide' : '🙈 Masquer')
      : (currentLang==='en' ? '👁️ Show' : '👁️ Afficher');
  };
  $('btn-copy-recovery').onclick = async () => {
    try{
      await navigator.clipboard.writeText(localStorage.getItem('moltchi_player_scope') || '');
      $('recovery-status').style.color = 'var(--gold)';
      $('recovery-status').textContent = currentLang==='en' ? 'Code copied ✓' : 'Code copié ✓';
    }catch(e){
      $('recovery-status').style.color = 'var(--danger)';
      $('recovery-status').textContent = currentLang==='en' ? 'Could not copy — select and copy the code manually.' : 'Copie impossible — sélectionne et copie le code manuellement.';
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
      playCareAnimation(creature, 'eatVideo');
    } catch(e){ console.error(e); }
  };
  $('btn-play').onclick = async () => {
    if(careAttemptsLeft(creature) === 0) return;
    try{
      const data = await performAction('care_play', {});
      creature = mergeDefaults(data.creature);
      renderCreature(creature);
      playCareAnimation(creature, 'playVideo');
    } catch(e){ console.error(e); }
  };
  $('btn-sleep').onclick = async () => {
    if(careAttemptsLeft(creature) === 0) return;
    try{
      const data = await performAction('care_rest', {});
      creature = mergeDefaults(data.creature);
      renderCreature(creature);
      playCareAnimation(creature, 'sleepVideo');
    } catch(e){ console.error(e); }
  };

  $('btn-start-reflex').onclick = () => startReflex(creature);
  $('btn-start-memory').onclick = () => startMemory(creature);
  $('btn-start-rhythm').onclick = () => startRhythm(creature);
  $('btn-start-arcane').onclick = () => startArcane(creature);

  $('btn-unlock-corrupt').onclick = async () => {
    if(!corruptUnlockEligible(creature)) return;
    if((creature.moltcoins||0) < CORRUPT_UNLOCK_COST) return;
    try{
      const data = await performAction('dungeon_unlock_corrupt', {});
      creature = mergeDefaults(data.creature);
      dungeonLog(`Le Sanctuaire Corrompu s'ouvre à ${creature.name}...`, 'good', 'corrupt-log');
      renderCreature(creature);
    } catch(e){ dungeonLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.', 'hit', 'corrupt-log'); console.error(e); }
  };

  $('btn-unlock-noyau').onclick = async () => {
    if(!noyauUnlockEligible(creature)) return;
    if((creature.moltcoins||0) < NOYAU_UNLOCK_COST) return;
    try{
      const data = await performAction('dungeon_unlock_noyau', {});
      creature = mergeDefaults(data.creature);
      dungeonLog(currentLang==='en' ? `The Primordial Core opens to ${creature.name}...` : `Le Noyau Primordial s'ouvre à ${creature.name}...`, 'good', 'noyau-log');
      renderCreature(creature);
    } catch(e){ dungeonLog(currentLang==='en' ? 'Error — try again later.' : 'Erreur — réessaie plus tard.', 'hit', 'noyau-log'); console.error(e); }
  };

  // ---------- Pont Phaser — effets visuels ponctuels (Trésor/Donjons/Boss) ----------
  $('btn-dig').onclick = async () => {
    if(creature.treasureAP <= 0) return;
    try{
      const data = await performAction('treasure_dig', {});
      creature = mergeDefaults(data.creature);
      const lastDig = (creature.treasureHistory || []).slice(-1)[0];
      playFxEffectSafe(Bridge => Bridge.playTreasureEffect({ itemFound: !!(lastDig && lastDig.itemName) }));
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
//
// IMPORTANT — sw.js appelle self.skipWaiting() + self.clients.claim(), donc un nouveau
// Service Worker prend le contrôle immédiatement dès qu'il est détecté, SANS attendre
// que tous les onglets se ferment. Mais ça ne recharge pas pour autant le HTML/JS déjà
// chargé en mémoire dans l'onglet ouvert — sans le écouteur ci-dessous, le joueur reste
// bloqué sur l'ancienne version jusqu'à un rechargement manuel (parfois deux, selon le
// timing). navigator.serviceWorker.oncontrollerchange se déclenche pile au moment où ce
// changement de contrôle a lieu : on en profite pour recharger la page une seule fois
// (le garde-fou _swReloaded évite une boucle si l'événement se déclenchait plusieurs fois).
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('Service Worker non enregistré :', e));
  });
  let _swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(_swReloaded) return;
    _swReloaded = true;
    window.location.reload();
  });
}
