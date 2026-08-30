// supabase/functions/perform-action/index.ts
//
// Passerelle générique pour toute action de jeu qui modifie la créature d'un joueur.
// Reçoit { scope, action, payload }, recharge l'état réel depuis la base, valide/borne
// tout ce qui vient du client, recalcule le résultat avec les VRAIES formules du jeu,
// puis sauvegarde — le client ne fait plus jamais d'écriture directe dans kv_store.
//
// ÉTAT ACTUEL : Entraînement, Soins, Chasse au trésor, Coffres, Donjon (Tour + Sanctuaire
// Corrompu) sont portés ici. Tout le RNG de loot/coins/Moltyx tourne côté serveur — un
// joueur ne peut plus forcer un tirage favorable ni injecter un objet/montant arbitraire.
//
// Une fois TOUTES les actions du jeu migrées ici (il ne doit plus rester aucune écriture
// directe côté client), on pourra verrouiller la RLS de kv_store en lecture seule pour le
// client (voir conversation) — pas avant, sous peine de casser ce qui n'est pas encore migré.
//
// Sécurité des mini-jeux (temps de réaction, timing) : le serveur ne peut pas "prouver"
// une mesure de timing mesurée dans le navigateur — il borne donc chaque valeur reçue à sa
// plage légitime avant de calculer le gain, ce qui plafonne le pire cas exploitable au
// meilleur score légitime possible (jamais de valeur arbitraire/infinie).
//
// Déploiement : `supabase functions deploy perform-action`
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
// ---------- Anti-bot : limite de création de comptes (hatch) par IP ----------
// Créer un "compte" ne coûte rien (juste un UUID généré côté client, aucune vérification
// humaine) — sans garde-fou, un script peut créer un nombre illimité de faux joueurs et
// multiplier d'autant tous les plafonds quotidiens (entraînement, coffres, Donjon, et
// surtout le Boss Mondial qui est une ressource PARTAGÉE entre tous les joueurs).
// Ce garde-fou ne bloque pas un attaquant motivé (VPN/proxies rotatifs changent l'IP), mais
// il tue la création de comptes en boucle depuis une seule machine/script — la forme
// d'abus la plus probable ici. L'IP n'est jamais stockée en clair (seulement son hash).
// Le seuil (10) est volontairement large : il doit encaisser sans broncher une famille
// partageant une box internet ET un joueur qui teste ses 4 espèces d'affilée via
// abandon+re-hatch (jusqu'à 4 hatch en une session pour une seule vraie personne) — le but
// est de freiner un script qui crée des dizaines/centaines de comptes d'un coup, pas de
// gêner une poignée de vraies personnes le même jour depuis la même IP.
const MAX_HATCH_PER_IP_PER_DAY = 10;
function getClientIP(req) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
async function hashIP(ip) {
  const data = new TextEncoder().encode(ip + ":moltchi-rl-salt");
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
// ---------- Constantes portées depuis index.html (tenir synchronisé) ----------
const GLOBAL_TRAIN_ATTEMPTS = 8;
const ARCANE_ROUNDS = 5;
const ARCANE_ROUND_TIME = 1800; // ms
// Gain max théorique par manche Arcane (voir formule côté client) : 3 + speedBonus(max 15) = 18.
const ARCANE_MAX_SCORE_PER_ROUND = 18;
const CARE_MAX = 5;
const TREASURE_BASE_MAX_AP = 5;
const TREASURE_AP_REGEN_MS = 60 * 60 * 1000; // 1 point par heure
const CHESTS_MAX_PER_DAY = 3;
// Le serveur ne peut pas prouver qu'une pub a réellement été VUE (pas d'intégration API
// Monetag/postback) — mais il peut au moins prouver qu'un délai minimum s'est écoulé entre
// le clic "regarder la pub" et la réclamation, ce qui empêche l'appel direct de chest_claim
// (console/curl) sans passer par le minuteur. Ce n'est pas une preuve de visionnage à 100%
// (le joueur peut ouvrir l'onglet et revenir sans regarder), mais ça ferme le contournement
// trivial "sauter le délai entièrement" qui existait jusqu'ici.
const CHEST_WATCH_SECONDS = 15;
const CHEST_START_MAX_AGE_MS = 10 * 60 * 1000; // au-delà, un "chest_start" est considéré périmé
const CORRUPT_UNLOCK_FLOOR = 100;
const CORRUPT_UNLOCK_COST = 2000;
const NOYAU_UNLOCK_FLOOR = 100; // étage du SANCTUAIRE (pas de la Tour)
const NOYAU_UNLOCK_COST = 2000;
// ---------- Coffre Mystère (voir la conversation) ----------
const MYSTERY_CHEST_COST = 300; // Moltcoins
const MYSTERY_CHEST_FREE_DAILY = 2; // ouvertures/jour sans le déblocage illimité (payant réel)
// Même ordre que la rotation du Boss Mondial — utilisé par le Noyau Primordial.
// ⚠️ DOIT rester identique à la copie dans app.js/attack-boss.ts.
const ELEMENT_TO_STAT = {
  feu: "crit",
  vent: "dodge",
  terre: "stamina",
  eau: "magic"
};
const ELEMENT_CYCLE = [
  "feu",
  "vent",
  "terre",
  "eau"
];
const MAX_EQUIP = 5;
const SELL_PRICE = {
  common: 15,
  rare: 40,
  epic: 100,
  legendary: 250
};
// ---------- Succès / Hauts faits ----------
// Permanents et INDÉPENDANTS de `creature` : stockés dans leur propre ligne kv_store
// (scope=playerScope, key="achievements"), donc ils survivent à un abandon de Moltchi
// (qui remet `creature` à zéro via defaultCreature()) — c'est tout l'intérêt : un sentiment
// de progression qui ne repart jamais à zéro, contrairement aux quêtes/paliers du Pass.
// ⚠️ Cette liste DOIT rester identique à la copie dans app.js (icônes/noms FR y sont dupliqués
// pour l'affichage ; ici seule la condition `check` fait foi pour le déblocage réel).
const ACHIEVEMENTS = [
  {
    id: "first_legendary",
    check: (c, s)=>(c.inventory || []).some((i)=>i.rarity === "legendary")
  },
  {
    id: "first_unique",
    check: (c, s)=>(c.inventory || []).some((i)=>i.rarity === "unique")
  },
  {
    id: "floors_100",
    check: (c, s)=>(s.totalFloorsCleared || 0) >= 100
  },
  {
    id: "floors_500",
    check: (c, s)=>(s.totalFloorsCleared || 0) >= 500
  },
  {
    id: "boss_kills_10",
    check: (c, s)=>(s.bossKillsPersonal || 0) >= 10
  },
  {
    id: "boss_kills_50",
    check: (c, s)=>(s.bossKillsPersonal || 0) >= 50
  },
  {
    id: "moltcoins_10000",
    check: (c, s)=>(s.moltcoinsEarnedLifetime || 0) >= 10000
  },
  {
    id: "treasure_100",
    check: (c, s)=>(s.treasureDigsTotal || 0) >= 100
  },
  {
    id: "training_500",
    check: (c, s)=>(s.trainingSessionsTotal || 0) >= 500
  },
  {
    id: "pass_complete",
    check: (c, s)=>!!(c.battlepass && c.battlepass.xp >= 3500)
  },
  {
    id: "corrupt_unlocked",
    check: (c, s)=>!!c.corruptUnlocked
  },
  {
    id: "noyau_unlocked",
    check: (c, s)=>!!c.noyauUnlocked
  }
];
function defaultAchievements() {
  return {
    unlocked: {},
    stats: {
      totalFloorsCleared: 0,
      bossKillsPersonal: 0,
      moltcoinsEarnedLifetime: 0,
      treasureDigsTotal: 0,
      trainingSessionsTotal: 0
    },
    activeBadge: null
  };
}
// Évalue toutes les conditions et débloque les succès nouvellement atteints (avec horodatage).
// Retourne la liste des ids nouvellement débloqués (pour notifier le client).
function checkAchievements(ach, creature) {
  const newly = [];
  for (const a of ACHIEVEMENTS){
    if (ach.unlocked[a.id]) continue;
    if (a.check(creature, ach.stats)) {
      ach.unlocked[a.id] = Date.now();
      newly.push(a.id);
    }
  }
  return newly;
}
const BP_PREMIUM_COST_MOLTCOINS = 3000;
const BATTLEPASS_TIERS = [
  {
    tier: 1,
    xp: 60,
    free: {
      type: "coins",
      amount: 15
    },
    premium: {
      type: "coins",
      amount: 35
    }
  },
  {
    tier: 2,
    xp: 130,
    free: {
      type: "coins",
      amount: 15
    },
    premium: {
      type: "consumable",
      consumableId: "candy_dungeon",
      qty: 2
    }
  },
  {
    tier: 3,
    xp: 210,
    free: null,
    premium: {
      type: "coins",
      amount: 40
    }
  },
  {
    tier: 4,
    xp: 305,
    free: {
      type: "coins",
      amount: 15
    },
    premium: {
      type: "consumable",
      consumableId: "candy_boss",
      qty: 2
    }
  },
  {
    tier: 5,
    xp: 415,
    free: null,
    premium: {
      type: "coins",
      amount: 50
    }
  },
  {
    tier: 6,
    xp: 530,
    free: {
      type: "coins",
      amount: 20
    },
    premium: {
      type: "consumable",
      consumableId: "candy_treasure",
      qty: 2
    }
  },
  {
    tier: 7,
    xp: 660,
    free: {
      type: "coins",
      amount: 20
    },
    premium: {
      type: "consumable",
      consumableId: "candy_training",
      qty: 2
    }
  },
  {
    tier: 8,
    xp: 800,
    free: null,
    premium: {
      type: "coins",
      amount: 60
    }
  },
  {
    tier: 9,
    xp: 955,
    free: {
      type: "coins",
      amount: 25
    },
    premium: {
      type: "consumable",
      consumableId: "candy_dungeon",
      qty: 4
    }
  },
  {
    tier: 10,
    xp: 1120,
    free: null,
    premium: {
      type: "coins",
      amount: 75
    }
  },
  {
    tier: 11,
    xp: 1295,
    free: {
      type: "coins",
      amount: 25
    },
    premium: {
      type: "consumable",
      consumableId: "candy_boss",
      qty: 4
    }
  },
  {
    tier: 12,
    xp: 1485,
    free: {
      type: "coins",
      amount: 25
    },
    premium: {
      type: "consumable",
      consumableId: "candy_treasure",
      qty: 4
    }
  },
  {
    tier: 13,
    xp: 1685,
    free: null,
    premium: {
      type: "coins",
      amount: 85
    }
  },
  {
    tier: 14,
    xp: 1900,
    free: {
      type: "coins",
      amount: 30
    },
    premium: {
      type: "coins",
      amount: 100
    }
  },
  {
    tier: 15,
    xp: 2150,
    free: null,
    premium: {
      type: "consumable",
      consumableId: "candy_training",
      qty: 4
    }
  },
  {
    tier: 16,
    xp: 2400,
    free: {
      type: "coins",
      amount: 35
    },
    premium: {
      type: "consumable",
      consumableId: "candy_dungeon",
      qty: 6
    }
  },
  {
    tier: 17,
    xp: 2610,
    free: {
      type: "coins",
      amount: 35
    },
    premium: {
      type: "consumable",
      consumableId: "candy_boss",
      qty: 6
    }
  },
  {
    tier: 18,
    xp: 2865,
    free: null,
    premium: {
      type: "consumable",
      consumableId: "candy_training",
      qty: 6
    }
  },
  {
    tier: 19,
    xp: 3135,
    free: {
      type: "coins",
      amount: 45
    },
    premium: {
      type: "consumable",
      consumableId: "candy_treasure",
      qty: 6
    }
  },
  {
    tier: 20,
    xp: 3500,
    free: {
      type: "coins",
      amount: 70
    },
    premium: {
      type: "coins",
      amount: 190
    }
  }
];
// RÉFÉRENCE DU MAPPING STATS ↔ ÉLÉMENTS (identique à index.html, ne pas dupliquer/diverger) :
//   c.crit = Critique (Feu), c.dodge = Vitesse (Vent), c.stamina = Endurance (Terre), c.magic = Magie (Eau)
const SPECIES_KEYS = [
  "Braisien",
  "Ptimousse",
  "Luminel",
  "Epineombre"
];
const SPECIES_PASSIVE = {
  Braisien: "crit",
  Ptimousse: "stamina",
  Luminel: "magic",
  Epineombre: "dodge"
};
const NAMES = [
  "Ember",
  "Moss",
  "Thistle",
  "Bramble",
  "Sable",
  "Torgo"
];
function defaultCreature() {
  return {
    species: null,
    name: null,
    stage: 0,
    level: 1,
    xp: 0,
    hunger: 80,
    joy: 80,
    energy: 80,
    crit: 0,
    dodge: 0,
    stamina: 0,
    magic: 0,
    lastTick: Date.now(),
    attacksToday: 0,
    lastAttackDay: null,
    contributed: 0,
    trainCounts: {
      reflex: 0,
      memory: 0,
      rhythm: 0,
      arcane: 0
    },
    trainDay: null,
    dungeonFloor: 1,
    dungeonAttempts: 0,
    dungeonClears: 0,
    dungeonDay: null,
    dungeonFreeRerollUsed: false,
    corruptUnlocked: false,
    corruptFloor: 1,
    corruptAttempts: 0,
    corruptClears: 0,
    corruptDay: null,
    noyauUnlocked: false,
    noyauFloor: 1,
    noyauAttempts: 0,
    noyauClears: 0,
    noyauDay: null,
    careDay: null,
    careUsed: 0,
    chestsDay: null,
    chestsOpened: 0,
    chestPendingStartedAt: null,
    loginStreak: 0,
    bestLoginStreak: 0,
    lastLoginDay: null,
    inventory: [],
    consumables: {},
    moltcoins: 0,
    treasureAP: 5,
    treasureAPLastTick: Date.now(),
    treasureHistory: []
  };
}
function decayForElapsed(c) {
  const hoursElapsed = (Date.now() - c.lastTick) / (1000 * 60 * 60);
  let decay = Math.min(80, hoursElapsed * 1.8);
  if (c.species === "Ptimousse") decay *= 0.7;
  c.hunger = Math.max(0, c.hunger - decay);
  c.joy = Math.max(0, c.joy - decay * 0.8);
  c.energy = Math.max(0, c.energy - decay * 0.6);
  c.lastTick = Date.now();
  return c;
}
// ---------- Bases d'objets (identiques à index.html, tenir synchronisé) ----------
const ITEM_DB = [
  {
    id: "griffe_ambre",
    name: "Griffe d'Ambre",
    rarity: "common",
    stat: "crit",
    value: 20,
    minFloor: 1
  },
  {
    id: "ecaille_moussue",
    name: "Écaille Moussue",
    rarity: "common",
    stat: "stamina",
    value: 20,
    minFloor: 1
  },
  {
    id: "anneau_de_ronce",
    name: "Anneau de Ronce",
    rarity: "common",
    stat: "dodge",
    value: 20,
    minFloor: 1
  },
  {
    id: "orbe_vacillant",
    name: "Orbe Vacillant",
    rarity: "common",
    stat: "magic",
    value: 20,
    minFloor: 1
  },
  {
    id: "croc_dember",
    name: "Croc d'Ember",
    rarity: "rare",
    stat: "crit",
    value: 55,
    minFloor: 5
  },
  {
    id: "carapace_de_mousse",
    name: "Carapace de Mousse",
    rarity: "rare",
    stat: "stamina",
    value: 55,
    minFloor: 5
  },
  {
    id: "talisman_ombreux",
    name: "Talisman Ombreux",
    rarity: "rare",
    stat: "dodge",
    value: 55,
    minFloor: 5
  },
  {
    id: "sceau_arcane",
    name: "Sceau Arcane",
    rarity: "rare",
    stat: "magic",
    value: 55,
    minFloor: 5
  },
  {
    id: "griffe_du_wyrm",
    name: "Griffe du Wyrm",
    rarity: "epic",
    stat: "crit",
    value: 150,
    minFloor: 15
  },
  {
    id: "plaque_antique",
    name: "Plaque d'Endurance Antique",
    rarity: "epic",
    stat: "stamina",
    value: 150,
    minFloor: 15
  },
  {
    id: "voile_derobade",
    name: "Voile de Dérobade",
    rarity: "epic",
    stat: "dodge",
    value: 150,
    minFloor: 15
  },
  {
    id: "coeur_arcanique",
    name: "Cœur Arcanique",
    rarity: "epic",
    stat: "magic",
    value: 150,
    minFloor: 15
  },
  {
    id: "couronne_cendres",
    name: "Couronne de Cendres",
    rarity: "legendary",
    stat: "crit",
    value: 500,
    minFloor: 30
  },
  {
    id: "coeur_de_pierre",
    name: "Cœur de Pierre Ancien",
    rarity: "legendary",
    stat: "stamina",
    value: 500,
    minFloor: 30
  },
  {
    id: "ombre_eternelle",
    name: "Ombre Éternelle",
    rarity: "legendary",
    stat: "dodge",
    value: 500,
    minFloor: 30
  },
  {
    id: "oeil_du_wyrm",
    name: "Œil du Wyrm",
    rarity: "legendary",
    stat: "magic",
    value: 500,
    minFloor: 30
  },
  {
    id: "sceptre_wyrm_ancien",
    name: "Sceptre du Wyrm Ancien",
    rarity: "legendary",
    stat: "crit",
    value: 375,
    stat2: "magic",
    value2: 125,
    minFloor: 30
  }
];
const CORRUPT_ITEM_DB = [
  {
    id: "crocs_jumeaux",
    name: "Crocs Jumeaux",
    rarity: "common",
    stat: "crit",
    value: 180,
    stat2: "dodge",
    value2: 60,
    minFloor: 1
  },
  {
    id: "racine_gangrenee",
    name: "Racine Gangrenée",
    rarity: "common",
    stat: "stamina",
    value: 200,
    minFloor: 1
  },
  {
    id: "lentille_trouble",
    name: "Lentille Trouble",
    rarity: "common",
    stat: "magic",
    value: 180,
    stat2: "crit",
    value2: 60,
    minFloor: 1
  },
  {
    id: "griffe_binaire",
    name: "Griffe Binaire",
    rarity: "rare",
    stat: "crit",
    value: 400,
    stat2: "stamina",
    value2: 130,
    minFloor: 1
  },
  {
    id: "carapace_suintante",
    name: "Carapace Suintante",
    rarity: "rare",
    stat: "stamina",
    value: 450,
    minFloor: 1
  },
  {
    id: "sceau_fracture",
    name: "Sceau Fracturé",
    rarity: "rare",
    stat: "magic",
    value: 400,
    stat2: "dodge",
    value2: 130,
    minFloor: 1
  },
  {
    id: "croc_du_corrupteur",
    name: "Croc du Corrupteur",
    rarity: "epic",
    stat: "crit",
    value: 900,
    stat2: "magic",
    value2: 300,
    minFloor: 1
  },
  {
    id: "plaque_infestee",
    name: "Plaque Infestée",
    rarity: "epic",
    stat: "stamina",
    value: 1000,
    stat2: "dodge",
    value2: 300,
    minFloor: 1
  },
  {
    id: "voile_du_neant",
    name: "Voile du Néant",
    rarity: "epic",
    stat: "dodge",
    value: 900,
    stat2: "crit",
    value2: 300,
    minFloor: 1
  },
  {
    id: "couronne_fletrie",
    name: "Couronne Flétrie",
    rarity: "legendary",
    stat: "crit",
    value: 2000,
    stat2: "magic",
    value2: 650,
    minFloor: 1
  },
  {
    id: "coeur_corrompu",
    name: "Cœur Corrompu",
    rarity: "legendary",
    stat: "stamina",
    value: 2000,
    stat2: "dodge",
    value2: 650,
    minFloor: 1
  },
  {
    id: "oeil_du_neant",
    name: "Œil du Néant",
    rarity: "legendary",
    stat: "magic",
    value: 2000,
    stat2: "crit",
    value2: 650,
    minFloor: 1
  },
  {
    id: "couronne_du_vide",
    name: "Couronne du Vide",
    rarity: "legendary",
    stat: "dodge",
    value: 2000,
    minFloor: 1
  },
  {
    id: "griffe_corrompue",
    name: "Griffe Corrompue",
    rarity: "legendary",
    stat: "crit",
    value: 2000,
    stat2: "dodge",
    value2: 650,
    minFloor: 1
  }
];
// Noyau Primordial — objets généralistes (allStat = bonus uniforme sur les 4 stats).
// ⚠️ DOIT rester identique à la copie dans app.js.
const NOYAU_ITEM_DB = [
  {
    id: "noyau_eclat_commun",
    name: "Éclat du Noyau",
    rarity: "common",
    allStat: 780,
    minFloor: 1
  },
  {
    id: "noyau_fragment_commun",
    name: "Fragment Primordial",
    rarity: "common",
    allStat: 780,
    minFloor: 1
  },
  {
    id: "noyau_sceau_rare",
    name: "Sceau des Quatre Vents",
    rarity: "rare",
    allStat: 1740,
    minFloor: 1
  },
  {
    id: "noyau_orbe_rare",
    name: "Orbe en Convergence",
    rarity: "rare",
    allStat: 1740,
    minFloor: 1
  },
  {
    id: "noyau_coeur_epique",
    name: "Cœur du Noyau",
    rarity: "epic",
    allStat: 3880,
    minFloor: 1
  },
  {
    id: "noyau_prisme_epique",
    name: "Prisme Élémentaire",
    rarity: "epic",
    allStat: 3880,
    minFloor: 1
  },
  {
    id: "noyau_couronne_leg",
    name: "Couronne du Premier Cycle",
    rarity: "legendary",
    allStat: 8170,
    minFloor: 1
  },
  {
    id: "noyau_diademe_leg",
    name: "Diadème Primordial",
    rarity: "legendary",
    allStat: 8170,
    minFloor: 1
  }
];
// ---------- Boutique hebdomadaire ----------
// Sélection 100% déterministe à partir de la semaine en cours (weekKey) : aucun
// stockage ni tâche planifiée nécessaire, client et serveur retombent toujours
// sur le même objet indépendamment, sans risque de désynchronisation.
const SHOP_TOWER_COST = 1000;
const SHOP_CORRUPT_COST = 2500;
const SHOP_CANDY_COST = 250;
function hashStringToInt(s) {
  let h = 0;
  for(let i = 0; i < s.length; i++){
    h = h * 31 + s.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}
function weeklyShopPick(dungeonId) {
  if (dungeonId === "candy") {
    const seed = hashStringToInt(weekKey() + ":candy");
    return CONSUMABLE_DB[seed % CONSUMABLE_DB.length];
  }
  const pool = (dungeonId === "wyrm" ? ITEM_DB : CORRUPT_ITEM_DB).filter((i)=>i.rarity === "legendary");
  const seed = hashStringToInt(weekKey() + ":" + dungeonId);
  return pool[seed % pool.length];
}
function shopPurchasedThisWeek(c, dungeonId) {
  if (!c.shopPurchases || c.shopPurchases.weekKey !== weekKey()) return false;
  return !!c.shopPurchases[dungeonId];
}
function markShopPurchased(c, dungeonId) {
  if (!c.shopPurchases || c.shopPurchases.weekKey !== weekKey()) c.shopPurchases = {
    weekKey: weekKey()
  };
  c.shopPurchases[dungeonId] = true;
}
const UNIQUE_ITEM_DB = [
  {
    id: "eclat_du_negociateur",
    name: "Eclat du Négociateur",
    rarity: "unique",
    source: "shop_real_money",
    special: {
      type: "shopDiscountPct",
      amount: 25
    }
  },
  {
    id: "eclat_du_tresor",
    name: "Eclat du Trésor",
    rarity: "unique",
    source: "treasure",
    special: {
      type: "treasureCoinsPct",
      amount: 25
    }
  },
  {
    id: "eclat_de_ascension",
    name: "Eclat de l'Ascension",
    rarity: "unique",
    source: "dungeon",
    special: {
      type: "dungeonXPPct",
      amount: 20,
      type2: "dungeonReqReductionPct",
      amount2: 15
    }
  },
  {
    id: "eclat_du_monde",
    name: "Eclat du Monde",
    rarity: "unique",
    source: "boss",
    special: {
      type: "bossDamagePct",
      amount: 20
    }
  },
  {
    id: "eclat_de_cupidite",
    name: "Eclat de la Cupidité",
    rarity: "unique",
    source: "chests",
    special: {
      type: "treasureApBonus",
      amount: 1
    }
  },
  {
    id: "eclat_de_puissance",
    name: "Eclat de Puissance",
    rarity: "unique",
    source: "training",
    special: {
      type: "statPct",
      amount: 25
    }
  }
];
const CONSUMABLE_DB = [
  {
    id: "candy_dungeon",
    name: "Bonbon des Marcheurs"
  },
  {
    id: "candy_boss",
    name: "Bonbon Rugissant"
  },
  {
    id: "candy_treasure",
    name: "Bonbon Doré"
  },
  {
    id: "candy_training",
    name: "Bonbon Vif"
  }
];
// ---------- Streak de connexion quotidienne ----------
// Cycle de 30 jours qui se répète indéfiniment (jour 31 = récompense du jour 1, etc.) — le
// compteur loginStreak, lui, continue de grimper sans plafond (utile pour un futur badge
// "60 jours d'affilée" par exemple), seule la récompense se recale sur le cycle de 30.
// Un bonbon différent à la fin de chaque semaine de connexion (jours 7/14/21/28 — un par
// bonbon existant), et un jackpot au jour 30 (gros bonus + les 4 bonbons d'un coup) pour
// marquer un mois complet.
const DAILY_STREAK_REWARDS = {
  1: {
    coins: 10
  },
  2: {
    coins: 12
  },
  3: {
    coins: 14
  },
  4: {
    coins: 17
  },
  5: {
    coins: 20
  },
  6: {
    coins: 24
  },
  7: {
    coins: 40,
    consumables: [
      {
        id: "candy_training",
        qty: 1
      }
    ]
  },
  8: {
    coins: 16
  },
  9: {
    coins: 18
  },
  10: {
    coins: 21
  },
  11: {
    coins: 24
  },
  12: {
    coins: 28
  },
  13: {
    coins: 32
  },
  14: {
    coins: 55,
    consumables: [
      {
        id: "candy_dungeon",
        qty: 1
      }
    ]
  },
  15: {
    coins: 20
  },
  16: {
    coins: 23
  },
  17: {
    coins: 26
  },
  18: {
    coins: 30
  },
  19: {
    coins: 34
  },
  20: {
    coins: 39
  },
  21: {
    coins: 70,
    consumables: [
      {
        id: "candy_boss",
        qty: 1
      }
    ]
  },
  22: {
    coins: 26
  },
  23: {
    coins: 29
  },
  24: {
    coins: 33
  },
  25: {
    coins: 37
  },
  26: {
    coins: 42
  },
  27: {
    coins: 47
  },
  28: {
    coins: 90,
    consumables: [
      {
        id: "candy_treasure",
        qty: 1
      }
    ]
  },
  29: {
    coins: 55
  },
  30: {
    coins: 150,
    consumables: [
      {
        id: "candy_training",
        qty: 1
      },
      {
        id: "candy_dungeon",
        qty: 1
      },
      {
        id: "candy_boss",
        qty: 1
      },
      {
        id: "candy_treasure",
        qty: 1
      }
    ]
  }
};
function yesterdayKey() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function mondayStartOf(d) {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  utc.setUTCDate(utc.getUTCDate() + diff);
  return utc;
}
function weekKey() {
  const monday = mondayStartOf(new Date());
  return monday.getUTCFullYear() + "-" + String(monday.getUTCMonth() + 1).padStart(2, "0") + "-" + String(monday.getUTCDate()).padStart(2, "0");
}
const BP_SEASON_LABELS = [
  "Janv-Fév",
  "Mars-Avril",
  "Mai-Juin",
  "Juil-Août",
  "Sept-Oct",
  "Nov-Déc"
];
function currentSeasonInfo() {
  const now = new Date();
  const year = now.getFullYear();
  const blockIndex = Math.floor(now.getMonth() / 2);
  return {
    seasonKey: `${year}-${blockIndex}`
  };
}
function defaultBattlepass() {
  const info = currentSeasonInfo();
  return {
    seasonKey: info.seasonKey,
    xp: 0,
    premiumUnlocked: false,
    claimedFree: [],
    claimedPremium: [],
    dailyDay: null,
    dailyProgress: {},
    dailyCompleted: [],
    weekKey: null,
    weeklyProgress: {},
    weeklyCompleted: []
  };
}
function ensureBattlepass(c) {
  if (!c.battlepass) c.battlepass = defaultBattlepass();
  const info = currentSeasonInfo();
  if (c.battlepass.seasonKey !== info.seasonKey) c.battlepass = defaultBattlepass();
  const bp = c.battlepass;
  if (bp.dailyDay !== todayKey()) {
    bp.dailyDay = todayKey();
    bp.dailyProgress = {};
    bp.dailyCompleted = [];
  }
  if (bp.weekKey !== weekKey()) {
    bp.weekKey = weekKey();
    bp.weeklyProgress = {};
    bp.weeklyCompleted = [];
  }
  return bp;
}
// Mêmes quêtes que index.html (BP_DAILY_QUESTS / BP_WEEKLY_QUESTS) — seuls id/target/points
// sont nécessaires ici (les labels affichés restent gérés côté client).
const BP_DAILY_QUESTS = [
  {
    id: "care",
    target: 3,
    points: 15
  },
  {
    id: "train",
    target: 3,
    points: 15
  },
  {
    id: "dungeon",
    target: 2,
    points: 20
  },
  {
    id: "boss",
    target: 1,
    points: 15
  },
  {
    id: "treasure",
    target: 1,
    points: 10
  }
];
const BP_WEEKLY_QUESTS = [
  {
    id: "care",
    target: 15,
    points: 60
  },
  {
    id: "train",
    target: 20,
    points: 60
  },
  {
    id: "dungeon",
    target: 20,
    points: 80
  },
  {
    id: "boss",
    target: 10,
    points: 80
  },
  {
    id: "treasure",
    target: 50,
    points: 50
  }
];
function bpTrack(c, key, amount = 1) {
  const bp = ensureBattlepass(c);
  bp.dailyProgress[key] = (bp.dailyProgress[key] || 0) + amount;
  bp.weeklyProgress[key] = (bp.weeklyProgress[key] || 0) + amount;
  const dq = BP_DAILY_QUESTS.find((q)=>q.id === key);
  if (dq && !bp.dailyCompleted.includes(key) && bp.dailyProgress[key] >= dq.target) {
    bp.dailyCompleted.push(key);
    bp.xp += dq.points;
  }
  const wq = BP_WEEKLY_QUESTS.find((q)=>q.id === key);
  if (wq && !bp.weeklyCompleted.includes(key) && bp.weeklyProgress[key] >= wq.target) {
    bp.weeklyCompleted.push(key);
    bp.xp += wq.points;
  }
}
function applyTrainGain(c, stat, baseGain) {
  const passive = SPECIES_PASSIVE[c.species];
  let gain = passive === stat ? Math.round(baseGain * 1.2) : baseGain;
  const statPct = equippedSpecialBonus(c).statPct || 0;
  if (statPct) gain = Math.ceil(gain * (1 + statPct / 100));
  c[stat] = (c[stat] || 0) + gain;
  c.hunger = Math.max(0, c.hunger - 3);
  return gain;
}
function trainAttemptsLeft(c) {
  const used = c.trainDay === todayKey() ? Object.values(c.trainCounts || {}).reduce((a, b)=>a + b, 0) : 0;
  return Math.max(0, GLOBAL_TRAIN_ATTEMPTS - used);
}
function useTrainAttempt(c, game) {
  if (c.trainDay !== todayKey()) {
    c.trainDay = todayKey();
    c.trainCounts = {
      reflex: 0,
      memory: 0,
      rhythm: 0,
      arcane: 0
    };
  }
  c.trainCounts[game] = (c.trainCounts[game] || 0) + 1;
  bpTrack(c, "train");
}
// ---------- Équipement, XP, Puissance (identiques à index.html) ----------
// IMPORTANT : les stats équipées sont relues en direct depuis ITEM_DB /
// CORRUPT_ITEM_DB / UNIQUE_ITEM_DB via defId, plutôt que depuis les valeurs
// figées au moment du drop sur l'objet d'inventaire. Ça permet de rééquilibrer
// un objet dans ITEM_DB et de voir l'effet immédiatement sur tous les
// inventaires existants, sans script de migration.
// Repli sur les valeurs stockées sur l'item (stat/value/stat2/value2) unique-
// ment pour les très vieux objets "legacy" sans defId, créés avant ce système.
function findItemDef(item) {
  if (!item.defId) return null;
  if (item.rarity === "unique") return UNIQUE_ITEM_DB.find((d)=>d.id === item.defId);
  return ITEM_DB.find((d)=>d.id === item.defId) || CORRUPT_ITEM_DB.find((d)=>d.id === item.defId) || NOYAU_ITEM_DB.find((d)=>d.id === item.defId);
}
function equippedBonus(c) {
  const bonus = {
    crit: 0,
    dodge: 0,
    stamina: 0,
    magic: 0
  };
  (c.inventory || []).forEach((item)=>{
    if (!item.equipped || item.rarity === "unique") return;
    const def = findItemDef(item);
    const stat = def ? def.stat : item.stat;
    const value = def ? def.value : item.value;
    const stat2 = def ? def.stat2 : item.stat2;
    const value2 = def ? def.value2 : item.value2;
    const allStat = def ? def.allStat : item.allStat;
    if (stat) bonus[stat] = (bonus[stat] || 0) + value;
    if (stat2) bonus[stat2] = (bonus[stat2] || 0) + value2;
    // Objets généralistes du Noyau Primordial : bonus uniforme sur les 4 stats.
    if (allStat) {
      bonus.crit += allStat;
      bonus.dodge += allStat;
      bonus.stamina += allStat;
      bonus.magic += allStat;
    }
  });
  return bonus;
}
function equippedSpecialBonus(c) {
  const bonus = {};
  (c.inventory || []).forEach((item)=>{
    if (!item.equipped || item.rarity !== "unique") return;
    const def = findItemDef(item);
    const special = def ? def.special : item.special;
    if (!special) return;
    const t = special.type;
    bonus[t] = (bonus[t] || 0) + special.amount;
    if (special.type2) bonus[special.type2] = (bonus[special.type2] || 0) + (special.amount2 || 0);
  });
  return bonus;
}
function grantXP(c, amount) {
  c.xp += amount;
  while(c.xp >= c.level * 50){
    c.xp -= c.level * 50;
    c.level += 1;
    if (c.level >= 5 && c.stage < 2) c.stage = 2;
    if (c.level >= 15 && c.stage < 3) c.stage = 3; // Adolescent — synchronisé avec index.html
    c.hunger = 100;
    c.joy = 100;
    c.energy = 100;
  }
}
function totalPower(c) {
  const eq = equippedBonus(c);
  const wellbeing = (c.hunger + c.joy + c.energy) / 3;
  const raw = c.level * 12 + (c.crit + eq.crit) + (c.dodge + eq.dodge) + (c.stamina + eq.stamina) + (c.magic + eq.magic);
  return Math.round(raw * (0.5 + wellbeing / 100 * 0.6));
}
function rollDungeonUnique(c) {
  const ownedUniqueIds = new Set((c.inventory || []).filter((i)=>i.rarity === "unique").map((i)=>i.defId));
  const availableUniques = UNIQUE_ITEM_DB.filter((u)=>u.source === "dungeon" && !ownedUniqueIds.has(u.id));
  if (availableUniques.length === 0) return null;
  if (Math.random() >= 0.003) return null;
  const def = availableUniques[Math.floor(Math.random() * availableUniques.length)];
  const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  const item = {
    id: uid,
    defId: def.id,
    name: def.name,
    rarity: "unique",
    special: def.special,
    equipped: false
  };
  c.inventory.push(item);
  return item;
}
function rollTrainingUnique(c) {
  const ownedUniqueIds = new Set((c.inventory || []).filter((i)=>i.rarity === "unique").map((i)=>i.defId));
  const availableUniques = UNIQUE_ITEM_DB.filter((u)=>u.source === "training" && !ownedUniqueIds.has(u.id));
  if (availableUniques.length === 0) return null;
  if (Math.random() >= 0.003) return null;
  const def = availableUniques[Math.floor(Math.random() * availableUniques.length)];
  const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  const item = {
    id: uid,
    defId: def.id,
    name: def.name,
    rarity: "unique",
    special: def.special,
    equipped: false
  };
  c.inventory.push(item);
  return item;
}
// ---------- Consommables, Pass Saisonnier (achat/palier) ----------
function consumeCandy(c, defId) {
  const def = CONSUMABLE_DB.find((x)=>x.id === defId);
  if (!def) return false;
  if (!c.consumables || !c.consumables[defId] || c.consumables[defId] <= 0) return false;
  c.consumables[defId] -= 1;
  const restore = {
    candy_dungeon: 3,
    candy_boss: 2,
    candy_treasure: 3,
    candy_training: 4
  };
  const amount = restore[defId] || 0;
  if (defId === "candy_dungeon") {
    if (c.dungeonDay !== todayKey()) {
      c.dungeonDay = todayKey();
      c.dungeonAttempts = 0;
    }
    c.dungeonAttempts = Math.max(0, c.dungeonAttempts - amount);
    if (c.corruptDay !== todayKey()) {
      c.corruptDay = todayKey();
      c.corruptAttempts = 0;
      c.corruptClears = 0;
    }
    c.corruptAttempts = Math.max(0, c.corruptAttempts - amount);
    if (c.noyauDay !== todayKey()) {
      c.noyauDay = todayKey();
      c.noyauAttempts = 0;
      c.noyauClears = 0;
    }
    c.noyauAttempts = Math.max(0, c.noyauAttempts - amount);
  } else if (defId === "candy_boss") {
    if (c.lastAttackDay !== todayKey()) {
      c.lastAttackDay = todayKey();
      c.attacksToday = 0;
    }
    c.attacksToday = Math.max(0, c.attacksToday - amount);
  } else if (defId === "candy_treasure") {
    c.treasureAP = Math.min(maxTreasureAP(c), (c.treasureAP || 0) + amount);
  } else if (defId === "candy_training") {
    if (c.trainDay !== todayKey()) {
      c.trainDay = todayKey();
      c.trainCounts = {
        reflex: 0,
        memory: 0,
        rhythm: 0,
        arcane: 0
      };
    }
    let remain = amount;
    const games = [
      "reflex",
      "memory",
      "rhythm",
      "arcane"
    ];
    while(remain > 0){
      const gk = games.reduce((a, b)=>(c.trainCounts[b] || 0) > (c.trainCounts[a] || 0) ? b : a);
      if ((c.trainCounts[gk] || 0) <= 0) break;
      c.trainCounts[gk] -= 1;
      remain -= 1;
    }
  }
  return true;
}
// Applique la mutation d'une récompense de palier (coins/consommable/objet) et renvoie une
// description neutre (pas de texte localisé — géré côté client à partir de ces données).
function bpGrantReward(c, reward) {
  if (reward.type === "coins") {
    c.moltcoins = (c.moltcoins || 0) + reward.amount;
    return {
      type: "coins",
      amount: reward.amount
    };
  }
  if (reward.type === "consumable") {
    const def = CONSUMABLE_DB.find((x)=>x.id === reward.consumableId);
    if (!def) return {
      type: "none"
    };
    if (!c.consumables) c.consumables = {};
    c.consumables[def.id] = (c.consumables[def.id] || 0) + (reward.qty || 1);
    return {
      type: "consumable",
      consumableId: def.id,
      consumableName: def.name,
      qty: reward.qty || 1
    };
  }
  const def = ITEM_DB.find((i)=>i.id === reward.itemId);
  if (!def) return {
    type: "none"
  };
  const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  c.inventory.push({
    id: uid,
    defId: def.id,
    name: def.name,
    rarity: def.rarity,
    stat: def.stat,
    value: def.value,
    equipped: false
  });
  return {
    type: "item",
    itemName: def.name,
    itemRarity: def.rarity
  };
}
function careAttemptsLeft(c) {
  return c.careDay === todayKey() ? Math.max(0, CARE_MAX - c.careUsed) : CARE_MAX;
}
function useCareAttempt(c) {
  if (c.careDay !== todayKey()) {
    c.careDay = todayKey();
    c.careUsed = 0;
  }
  c.careUsed += 1;
}
// ---------- Chasse au trésor ----------
function maxTreasureAP(c) {
  return TREASURE_BASE_MAX_AP + (equippedSpecialBonus(c).treasureApBonus || 0);
}
function regenTreasureAP(c) {
  const cap = maxTreasureAP(c);
  if (c.treasureAP === undefined) c.treasureAP = cap;
  if (c.treasureAP > cap) c.treasureAP = cap;
  if (c.treasureAPLastTick === undefined) c.treasureAPLastTick = Date.now();
  if (c.treasureAP >= cap) {
    c.treasureAPLastTick = Date.now();
    return;
  }
  const elapsed = Date.now() - c.treasureAPLastTick;
  const gained = Math.floor(elapsed / TREASURE_AP_REGEN_MS);
  if (gained > 0) {
    c.treasureAP = Math.min(cap, c.treasureAP + gained);
    c.treasureAPLastTick += gained * TREASURE_AP_REGEN_MS;
    if (c.treasureAP >= cap) c.treasureAPLastTick = Date.now();
  }
}
function digTreasure(c) {
  regenTreasureAP(c);
  if (c.treasureAP <= 0) return null;
  c.treasureAP -= 1;
  let coins = 5 + Math.floor(Math.random() * 16);
  const bonusPct = equippedSpecialBonus(c).treasureCoinsPct || 0;
  if (bonusPct > 0) coins = Math.round(coins * (1 + bonusPct / 100));
  c.moltcoins = (c.moltcoins || 0) + coins;
  let item = null;
  const ownedUniqueIds = new Set((c.inventory || []).filter((i)=>i.rarity === "unique").map((i)=>i.defId));
  const availableUniques = UNIQUE_ITEM_DB.filter((u)=>u.source === "treasure" && !ownedUniqueIds.has(u.id));
  if (availableUniques.length > 0 && Math.random() < 0.003) {
    const def = availableUniques[Math.floor(Math.random() * availableUniques.length)];
    const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    item = {
      id: uid,
      defId: def.id,
      name: def.name,
      rarity: "unique",
      special: def.special,
      equipped: false
    };
    c.inventory.push(item);
  } else if (Math.random() < 0.06) {
    const roll = Math.random();
    let rarity = "common";
    if (roll < 0.02) rarity = "legendary";
    else if (roll < 0.10) rarity = "epic";
    else if (roll < 0.35) rarity = "rare";
    let pool = ITEM_DB.filter((i)=>i.rarity === rarity && (c.dungeonFloor || 1) >= i.minFloor);
    if (c.corruptUnlocked) pool = pool.concat(CORRUPT_ITEM_DB.filter((i)=>i.rarity === rarity));
    if (pool.length === 0) {
      pool = ITEM_DB.filter((i)=>i.rarity === "common" && (c.dungeonFloor || 1) >= i.minFloor);
      if (c.corruptUnlocked) pool = pool.concat(CORRUPT_ITEM_DB.filter((i)=>i.rarity === "common"));
    }
    if (pool.length > 0) {
      const def = pool[Math.floor(Math.random() * pool.length)];
      const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
      item = {
        id: uid,
        defId: def.id,
        name: def.name,
        rarity: def.rarity,
        stat: def.stat,
        value: def.value,
        stat2: def.stat2 || null,
        value2: def.value2 || null,
        equipped: false
      };
      c.inventory.push(item);
    }
  }
  if (!c.treasureHistory) c.treasureHistory = [];
  c.treasureHistory.push({
    ts: Date.now(),
    coins,
    itemName: item ? item.name : null,
    itemRarity: item ? item.rarity : null
  });
  if (c.treasureHistory.length > 10) c.treasureHistory = c.treasureHistory.slice(-10);
  return {
    coins,
    item
  };
}
// ---------- Coffres quotidiens ----------
function chestsRemaining(c) {
  const opened = c.chestsDay === todayKey() ? c.chestsOpened : 0;
  return Math.max(0, CHESTS_MAX_PER_DAY - opened);
}
// ---------- Donjon (Tour du Wyrm + Sanctuaire Corrompu) ----------
// Taux à deux paliers : 1.0422 jusqu'à l'étage 100 inclus, puis 1.038 au-delà.
// La continuité est assurée en repartant de la valeur BRUTE (non arrondie) atteinte
// à l'étage 100 avec le premier taux, plutôt que de recalculer depuis la base —
// ça évite un saut de valeur au changement de palier.
// ⚠️ DOIT rester identique à la copie dans app.js.
const DUNGEON_RATE_1 = 1.0422, DUNGEON_RATE_2 = 1.038, DUNGEON_RATE_SWITCH_FLOOR = 100;
function floorRequirement(floor) {
  const base = 50;
  if (floor <= DUNGEON_RATE_SWITCH_FLOOR) return Math.round(base * Math.pow(DUNGEON_RATE_1, floor - 1));
  const atSwitch = base * Math.pow(DUNGEON_RATE_1, DUNGEON_RATE_SWITCH_FLOOR - 1);
  return Math.round(atSwitch * Math.pow(DUNGEON_RATE_2, floor - DUNGEON_RATE_SWITCH_FLOOR));
}
// Taux à deux paliers pour le Sanctuaire : 1.020 jusqu'à l'étage 100 inclus, puis 1.018
// au-delà. Même principe de continuité que floorRequirement ci-dessus.
// ⚠️ DOIT rester identique à la copie dans app.js.
const CORRUPT_RATE_1 = 1.020, CORRUPT_RATE_2 = 1.018, CORRUPT_RATE_SWITCH_FLOOR = 100;
function corruptFloorRequirement(floor) {
  const base = floorRequirement(CORRUPT_UNLOCK_FLOOR);
  if (floor <= CORRUPT_RATE_SWITCH_FLOOR) return Math.round(base * Math.pow(CORRUPT_RATE_1, floor - 1));
  const atSwitch = base * Math.pow(CORRUPT_RATE_1, CORRUPT_RATE_SWITCH_FLOOR - 1);
  return Math.round(atSwitch * Math.pow(CORRUPT_RATE_2, floor - CORRUPT_RATE_SWITCH_FLOOR));
}
function maxDungeonAttempts(c) {
  return c.species === "Epineombre" ? 6 : 5;
}
function maxDungeonClears(c) {
  return c.species === "Epineombre" ? 11 : 10;
}
function maxCorruptAttempts(c) {
  return c.species === "Epineombre" ? 6 : 5;
}
function maxCorruptClears(c) {
  return c.species === "Epineombre" ? 11 : 10;
}
function dungeonXP(floor) {
  return floor <= 100 ? 15 + floor : 15;
} // au-delà de l'étage 100, retour à la base fixe (15) : la Tour reste utile pour le loot/Moltyx, mais c'est le Sanctuaire Corrompu qui prend le relais pour l'XP
function corruptXP(floor) {
  return floor <= 100 ? 30 + floor * 2 : 30;
} // même principe que dungeonXP : au-delà de l'étage 100, retour à la base fixe (30) — le Noyau Primordial prend le relais côté XP
function isLootFloor(floor) {
  return floor % 5 === 0;
}
// ---------- Noyau Primordial (3ᵉ donjon) ----------
// ⚠️ Toutes ces formules DOIVENT rester identiques à la copie dans app.js.
function noyauUnlockEligible(c) {
  return (c.corruptFloor || 1) >= NOYAU_UNLOCK_FLOOR;
}
function noyauFloorRequirement(floor) {
  // Base fixe à 15 000 pour l'étage 1, indépendante du Sanctuaire (auparavant calée sur
  // corruptFloorRequirement(NOYAU_UNLOCK_FLOOR), ce qui faisait dépendre la difficulté du
  // Noyau de la progression au Sanctuaire — plus le cas depuis ce correctif).
  // Taux réduit de 1.03 à 1.022 puis 1.020 (voir la conversation) : à taux égal sans palier
  // de ralentissement (contrairement à la Tour/au Sanctuaire, qui ralentissent après
  // l'étage 100), le Noyau finissait par exiger jusqu'à 13× plus que le Sanctuaire au même
  // étage — beaucoup trop écrasant en fin de jeu. Étage 100 : 279 883 -> 106 539 à 1.020.
  // ⚠️ DOIT rester identique à la copie dans app.js.
  return Math.round(15000 * Math.pow(1.020, floor - 1));
}
function maxNoyauAttempts(c) {
  return c.species === "Epineombre" ? 6 : 5;
}
function maxNoyauClears(c) {
  return c.species === "Epineombre" ? 11 : 10;
}
function noyauXP(floor) {
  return 45 + floor * 3;
}
function isNoyauLootFloor(floor) {
  return floor % 5 === 0;
}
function noyauFloorElement(floor) {
  return ELEMENT_CYCLE[(floor - 1) % 4];
}
function noyauOpposedElement(floor) {
  return ELEMENT_CYCLE[(floor - 1 + 2) % 4];
}
// Puissance pondérée par l'affinité élémentaire de l'étage — UNIQUEMENT pour le Noyau
// (les 2 autres donjons restent en Puissance simple via totalPower, sans pondération).
function noyauPower(c, floor) {
  const eq = equippedBonus(c);
  const favored = ELEMENT_TO_STAT[noyauFloorElement(floor)];
  const opposed = ELEMENT_TO_STAT[noyauOpposedElement(floor)];
  const weight = {
    crit: 1,
    dodge: 1,
    stamina: 1,
    magic: 1
  };
  weight[favored] = 1.3;
  weight[opposed] = 0.7;
  const statSum = (c.crit + eq.crit) * weight.crit + (c.dodge + eq.dodge) * weight.dodge + (c.stamina + eq.stamina) * weight.stamina + (c.magic + eq.magic) * weight.magic;
  const wellbeing = (c.hunger + c.joy + c.energy) / 3;
  return Math.round((c.level * 12 + statSum) * (0.5 + wellbeing / 100 * 0.6));
}
function isCorruptLootFloor(floor) {
  return floor % 5 === 0;
}
function corruptUnlockEligible(c) {
  return (c.dungeonFloor || 1) >= CORRUPT_UNLOCK_FLOOR;
}
function rollLoot(floor, dungeonId) {
  let rarity = "common";
  const roll = Math.random();
  // Mêmes seuils de palier pour les deux donjons (appliqués à l'étage PROPRE au donjon concerné :
  // l'étage du Sanctuaire repart de 1, indépendamment de l'étage atteint dans la Tour).
  if (floor >= 30 && roll < 0.05) rarity = "legendary";
  else if (floor >= 15 && roll < 0.18) rarity = "epic";
  else if (floor >= 5 && roll < 0.45) rarity = "rare";
  if (dungeonId !== "corrupt" && floor >= 100 && rarity === "common") rarity = "rare";
  let pool;
  if (dungeonId === "corrupt") {
    // Sanctuaire : uniquement ses objets exclusifs (mêmes paliers de rareté que la Tour,
    // mais plus question d'y piocher les objets de la Tour elle-même).
    pool = CORRUPT_ITEM_DB.filter((i)=>i.rarity === rarity);
  } else if (dungeonId === "noyau") {
    pool = NOYAU_ITEM_DB.filter((i)=>i.rarity === rarity);
  } else {
    pool = ITEM_DB.filter((i)=>i.rarity === rarity && floor >= i.minFloor);
  }
  if (pool.length === 0) {
    pool = dungeonId === "corrupt" ? CORRUPT_ITEM_DB.filter((i)=>i.rarity === "common") : dungeonId === "noyau" ? NOYAU_ITEM_DB.filter((i)=>i.rarity === "common") : ITEM_DB.filter((i)=>i.rarity === "common" && floor >= i.minFloor);
  }
  const def = pool[Math.floor(Math.random() * pool.length)];
  const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  return {
    id: uid,
    defId: def.id,
    name: def.name,
    rarity: def.rarity,
    stat: def.stat || null,
    value: def.value || null,
    stat2: def.stat2 || null,
    value2: def.value2 || null,
    allStat: def.allStat || null,
    equipped: false,
    dungeonSource: dungeonId
  };
}
/** Détermine quel donjon utiliser pour le Coffre Mystère : le plus avancé débloqué par le
 * joueur (Noyau > Sanctuaire > Tour) — voir la conversation. */
function mysteryChestDungeonId(c) {
  if (c.noyauUnlocked) return "noyau";
  if (c.corruptUnlocked) return "corrupt";
  return "wyrm";
}
function mysteryChestItemPool(dungeonId, rarity) {
  if (dungeonId === "corrupt") return CORRUPT_ITEM_DB.filter((i)=>i.rarity === rarity);
  if (dungeonId === "noyau") return NOYAU_ITEM_DB.filter((i)=>i.rarity === rarity);
  // Pas de filtre minFloor ici, contrairement à rollLoot() : un achat de coffre n'est
  // rattaché à aucun étage précis, on pioche dans tout ce que la Tour propose à cette
  // rareté.
  return ITEM_DB.filter((i)=>i.rarity === rarity);
}
function rollMysteryChestItem(dungeonId, rarity) {
  const pool = mysteryChestItemPool(dungeonId, rarity);
  if (pool.length === 0) return null;
  const def = pool[Math.floor(Math.random() * pool.length)];
  const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  return {
    id: uid,
    defId: def.id,
    name: def.name,
    rarity: def.rarity,
    stat: def.stat || null,
    value: def.value || null,
    stat2: def.stat2 || null,
    value2: def.value2 || null,
    allStat: def.allStat || null,
    equipped: false,
    dungeonSource: dungeonId
  };
}
serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  try {
    const { scope, action, payload } = await req.json();
    if (!scope || typeof scope !== "string") {
      return new Response(JSON.stringify({
        error: "scope manquant"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    if (!action || typeof action !== "string") {
      return new Response(JSON.stringify({
        error: "action manquante"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    // Pseudo et langue : indépendants de la créature (peuvent être réglés avant l'éclosion),
    // traités à part pour ne pas exiger une ligne "creature" existante.
    if (action === "set_username") {
      const val = typeof payload?.name === "string" ? payload.name.trim() : "";
      if (val.length < 2 || val.length > 18) {
        return new Response(JSON.stringify({
          error: "pseudo invalide (2 à 18 caractères)"
        }), {
          status: 400,
          headers: corsHeaders
        });
      }
      // Vérifie qu'aucun AUTRE joueur n'a déjà exactement ce pseudo (insensible à la casse).
      // Le classement du Boss et les récompenses en attente sont indexés par pseudo — un
      // doublon mélangerait les dégâts/récompenses de deux joueurs différents.
      const { data: allUsernames } = await supabase.from("kv_store").select("scope, value").eq("key", "username");
      const taken = (allUsernames || []).some((row)=>row.scope !== scope && typeof row.value === "string" && row.value.toLowerCase() === val.toLowerCase());
      if (taken) {
        return new Response(JSON.stringify({
          error: "ce pseudo est déjà pris"
        }), {
          status: 409,
          headers: corsHeaders
        });
      }
      await supabase.from("kv_store").upsert({
        scope,
        key: "username",
        value: val,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "scope,key"
      });
      return new Response(JSON.stringify({
        username: val
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (action === "set_language") {
      const lang = payload?.lang === "en" ? "en" : "fr";
      await supabase.from("kv_store").upsert({
        scope,
        key: "language",
        value: lang,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "scope,key"
      });
      return new Response(JSON.stringify({
        language: lang
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Préférences musicales — seules écritures privées encore faites depuis le client avant
    // le verrouillage de la policy SELECT/INSERT/UPDATE de kv_store ; migrées ici pour rester
    // cohérentes avec le reste (plus aucune écriture directe côté client, uniquement via
    // service_role). Whitelist stricte des clés + validation du type de valeur.
    if (action === "set_pref") {
      const prefKey = typeof payload?.key === "string" ? payload.key : "";
      if (![
        "music_on",
        "music_volume"
      ].includes(prefKey)) {
        return new Response(JSON.stringify({
          error: "préférence inconnue"
        }), {
          status: 400,
          headers: corsHeaders
        });
      }
      const storeVal = prefKey === "music_on" ? payload?.value === "true" || payload?.value === true : Math.max(0, Math.min(1, Number(payload?.value)) || 0);
      await supabase.from("kv_store").upsert({
        scope,
        key: prefKey,
        value: storeVal,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "scope,key"
      });
      return new Response(JSON.stringify({
        [prefKey]: storeVal
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const { data: creatureRow, error: creatureErr } = await supabase.from("kv_store").select("value").eq("scope", scope).eq("key", "creature").maybeSingle();
    if (creatureErr) {
      return new Response(JSON.stringify({
        error: "erreur de lecture"
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
    let creature = creatureRow?.value;
    if (!creature) {
      // Pas encore de ligne en base : normal pour un joueur qui n'a jamais éclos son Moltchi.
      // Seule l'action "hatch" est autorisée à partir de zéro ; tout le reste exige une créature existante.
      if (action !== "hatch") {
        return new Response(JSON.stringify({
          error: "créature introuvable"
        }), {
          status: 404,
          headers: corsHeaders
        });
      }
      creature = defaultCreature();
    }
    const { data: achievementsRow } = await supabase.from("kv_store").select("value").eq("scope", scope).eq("key", "achievements").maybeSingle();
    const achievements = achievementsRow?.value || defaultAchievements();
    if (!achievements.stats) achievements.stats = defaultAchievements().stats; // compat lignes créées avant l'ajout d'un nouveau compteur
    if (!achievementsRow) {
      // Première ligne "achievements" jamais créée pour ce joueur (déploiement initial du
      // système, ou joueur qui n'avait encore rien débloqué) : rattrapage ponctuel des
      // compteurs dérivables de l'état ACTUEL de la créature. Approximatif par nature —
      // voir l'explication complète dans le chat du 16/08/2026 : sous-estime pour un joueur
      // ayant déjà abandonné son Moltchi (étages) ou déjà dépensé des Moltcoins (solde).
      // Les 3 autres compteurs (bossKillsPersonal/treasureDigsTotal/trainingSessionsTotal)
      // n'ont jamais été enregistrés nulle part avant ce système : irrécupérables, restent à 0.
      achievements.stats.totalFloorsCleared = Math.max(0, (creature.dungeonFloor || 1) + (creature.corruptFloor || 1) + (creature.noyauFloor || 1) - 3);
      achievements.stats.moltcoinsEarnedLifetime = Math.max(0, creature.moltcoins || 0);
    }
    const moltcoinsBeforeAction = creature.moltcoins || 0;
    const TRAIN_ACTIONS = [
      "train_reflex",
      "train_memory",
      "train_rhythm",
      "train_arcane"
    ];
    if (TRAIN_ACTIONS.includes(action) && trainAttemptsLeft(creature) <= 0) {
      return new Response(JSON.stringify({
        error: "plus de tentative d'entraînement aujourd'hui"
      }), {
        status: 403,
        headers: corsHeaders
      });
    }
    let result = {};
    switch(action){
      case "train_reflex":
        {
          if (payload?.tooEarly === true) {
            useTrainAttempt(creature, "reflex");
            achievements.stats.trainingSessionsTotal = (achievements.stats.trainingSessionsTotal || 0) + 1;
            result = {
              gain: 0,
              stat: "crit",
              tooEarly: true
            };
          } else {
            // Bornée à [0, 10000]ms : un temps de réaction ne peut jamais donner plus que le
            // gain max légitime (15, ou 18 avec le bonus d'espèce Braisien).
            const reactionMs = Math.max(0, Math.min(10000, Number(payload?.reactionMs) || 10000));
            const baseGain = Math.max(1, Math.round(15 - reactionMs / 100));
            const gain = applyTrainGain(creature, "crit", baseGain);
            useTrainAttempt(creature, "reflex");
            achievements.stats.trainingSessionsTotal = (achievements.stats.trainingSessionsTotal || 0) + 1;
            const uniqueFound = rollTrainingUnique(creature);
            result = {
              gain,
              stat: "crit",
              reactionMs,
              uniqueFound
            };
          }
          break;
        }
      case "train_memory":
        {
          const success = payload?.success === true;
          // Bornée à [0,4] (longueur de séquence) : plafonne le gain d'échec à son max légitime.
          const playerIdx = Math.max(0, Math.min(4, Number(payload?.playerIdx) || 0));
          const gain = success ? applyTrainGain(creature, "dodge", 12) : applyTrainGain(creature, "dodge", Math.max(1, playerIdx * 2));
          useTrainAttempt(creature, "memory");
          achievements.stats.trainingSessionsTotal = (achievements.stats.trainingSessionsTotal || 0) + 1;
          const uniqueFound = rollTrainingUnique(creature);
          result = {
            gain,
            stat: "dodge",
            success,
            uniqueFound
          };
          break;
        }
      case "train_rhythm":
        {
          // Bornée à [0,50] (distance max possible au centre de la barre) : plafonne le gain
          // à son max légitime (15, ou 18 avec le bonus d'espèce Ptimousse).
          const distFromCenter = Math.max(0, Math.min(50, Number(payload?.distFromCenter) ?? 50));
          const baseGain = Math.max(1, Math.round(15 - distFromCenter * 0.5));
          const gain = applyTrainGain(creature, "stamina", baseGain);
          useTrainAttempt(creature, "rhythm");
          achievements.stats.trainingSessionsTotal = (achievements.stats.trainingSessionsTotal || 0) + 1;
          const uniqueFound = rollTrainingUnique(creature);
          result = {
            gain,
            stat: "stamina",
            uniqueFound
          };
          break;
        }
      case "train_arcane":
        {
          // Bornée à [0, 5 manches × 18 pts max] : plafonne le gain à son max légitime.
          const totalScore = Math.max(0, Math.min(ARCANE_ROUNDS * ARCANE_MAX_SCORE_PER_ROUND, Number(payload?.totalScore) || 0));
          const gain = applyTrainGain(creature, "magic", Math.max(1, Math.round(totalScore / ARCANE_ROUNDS)));
          useTrainAttempt(creature, "arcane");
          achievements.stats.trainingSessionsTotal = (achievements.stats.trainingSessionsTotal || 0) + 1;
          const uniqueFound = rollTrainingUnique(creature);
          result = {
            gain,
            stat: "magic",
            uniqueFound
          };
          break;
        }
      case "hatch":
        {
          if (creature.stage > 0) {
            return new Response(JSON.stringify({
              error: "Moltchi déjà éclos"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          // Garde-fou anti-bot (voir commentaire en haut du fichier) : max N nouveaux Moltchi
          // par IP et par jour, tous comptes/scopes confondus.
          const ip = getClientIP(req);
          const ipHash = await hashIP(ip);
          const rlKey = `hatchrl:${ipHash}:${todayKey()}`;
          const { data: rlRow } = await supabase.from("kv_store").select("value").eq("scope", "shared").eq("key", rlKey).maybeSingle();
          const countSoFar = Number(rlRow?.value) || 0;
          if (countSoFar >= MAX_HATCH_PER_IP_PER_DAY) {
            return new Response(JSON.stringify({
              error: "trop de nouveaux Moltchi créés depuis cette connexion aujourd'hui, réessaie demain"
            }), {
              status: 429,
              headers: corsHeaders
            });
          }
          await supabase.from("kv_store").upsert({
            scope: "shared",
            key: rlKey,
            value: countSoFar + 1,
            updated_at: new Date().toISOString()
          }, {
            onConflict: "scope,key"
          });
          let species = typeof payload?.species === "string" ? payload.species : null;
          if (!species || !SPECIES_KEYS.includes(species)) {
            species = SPECIES_KEYS[Math.floor(Math.random() * SPECIES_KEYS.length)];
          }
          creature.species = species;
          creature.stage = 1;
          creature.name = NAMES[Math.floor(Math.random() * NAMES.length)];
          creature.hunger = 80;
          creature.joy = 80;
          creature.energy = 80;
          result = {
            species: creature.species,
            name: creature.name
          };
          break;
        }
      case "sync":
        {
          // Persiste l'usure naturelle (faim/joie/énergie) écoulée depuis la dernière visite.
          // N'a de sens que pour une créature déjà éclose.
          if (creature.stage > 0) decayForElapsed(creature);
          ensureBattlepass(creature); // recale/réinitialise le Pass Saisonnier si la saison a changé
          result = {};
          break;
        }
      case "claim_daily_login":
        {
          const today = todayKey();
          if (creature.lastLoginDay === today) {
            return new Response(JSON.stringify({
              error: "déjà réclamé aujourd'hui"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          // Rupture de streak si le dernier login n'était ni hier ni aujourd'hui (jour manqué).
          creature.loginStreak = creature.lastLoginDay === yesterdayKey() ? (creature.loginStreak || 0) + 1 : 1;
          creature.lastLoginDay = today;
          creature.bestLoginStreak = Math.max(creature.bestLoginStreak || 0, creature.loginStreak);
          const cycleDay = (creature.loginStreak - 1) % 30 + 1;
          const reward = DAILY_STREAK_REWARDS[cycleDay];
          creature.moltcoins = (creature.moltcoins || 0) + reward.coins;
          if (reward.consumables && reward.consumables.length) {
            if (!creature.consumables) creature.consumables = {};
            reward.consumables.forEach((c)=>{
              creature.consumables[c.id] = (creature.consumables[c.id] || 0) + c.qty;
            });
          }
          result = {
            streak: creature.loginStreak,
            best: creature.bestLoginStreak,
            cycleDay,
            reward
          };
          break;
        }
      case "shop_buy":
        {
          const which = payload?.which;
          if (which !== "wyrm" && which !== "corrupt" && which !== "candy") {
            return new Response(JSON.stringify({
              error: "objet de boutique invalide"
            }), {
              status: 400,
              headers: corsHeaders
            });
          }
          if (which === "corrupt" && !creature.corruptUnlocked) {
            return new Response(JSON.stringify({
              error: "Sanctuaire Corrompu non débloqué"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          if (shopPurchasedThisWeek(creature, which)) {
            return new Response(JSON.stringify({
              error: "déjà acheté cette semaine"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          const baseCost = which === "wyrm" ? SHOP_TOWER_COST : which === "corrupt" ? SHOP_CORRUPT_COST : SHOP_CANDY_COST;
          const discountPct = equippedSpecialBonus(creature).shopDiscountPct || 0;
          const cost = Math.round(baseCost * (1 - discountPct / 100));
          if ((creature.moltcoins || 0) < cost) {
            return new Response(JSON.stringify({
              error: "Moltcoins insuffisants"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          const def = weeklyShopPick(which);
          creature.moltcoins -= cost;
          if (which === "candy") {
            if (!creature.consumables) creature.consumables = {};
            creature.consumables[def.id] = (creature.consumables[def.id] || 0) + 1;
            markShopPurchased(creature, which);
            result = {
              itemName: def.name
            };
            break;
          }
          const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
          creature.inventory.push({
            id: uid,
            defId: def.id,
            name: def.name,
            rarity: def.rarity,
            stat: def.stat,
            value: def.value,
            stat2: def.stat2 || null,
            value2: def.value2 || null,
            equipped: false,
            dungeonSource: which
          });
          markShopPurchased(creature, which);
          result = {
            itemName: def.name
          };
          break;
        }
      case "rename":
        {
          const val = typeof payload?.name === "string" ? payload.name.trim() : "";
          if (val.length < 1 || val.length > 16) {
            return new Response(JSON.stringify({
              error: "nom invalide (1 à 16 caractères)"
            }), {
              status: 400,
              headers: corsHeaders
            });
          }
          creature.name = val;
          result = {};
          break;
        }
      case "abandon":
        {
          const keepLastAttackDay = creature.lastAttackDay;
          const keepAttacksToday = creature.attacksToday;
          const oldName = creature.name;
          creature = defaultCreature();
          creature.lastAttackDay = keepLastAttackDay;
          creature.attacksToday = keepAttacksToday;
          result = {
            oldName
          };
          break;
        }
      case "bp_claim_tier":
        {
          const bp = ensureBattlepass(creature);
          const track = payload?.track === "premium" ? "premium" : "free";
          const tierNum = Number(payload?.tier);
          const tDef = BATTLEPASS_TIERS.find((t)=>t.tier === tierNum);
          if (!tDef) return new Response(JSON.stringify({
            error: "palier inconnu"
          }), {
            status: 400,
            headers: corsHeaders
          });
          const claimedList = track === "free" ? bp.claimedFree : bp.claimedPremium;
          if (claimedList.includes(tDef.tier)) return new Response(JSON.stringify({
            error: "déjà réclamé"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if (track === "premium" && !bp.premiumUnlocked) return new Response(JSON.stringify({
            error: "Pass Premium non débloqué"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if (bp.xp < tDef.xp) return new Response(JSON.stringify({
            error: "XP insuffisante"
          }), {
            status: 403,
            headers: corsHeaders
          });
          const rewardDef = tDef[track];
          if (!rewardDef) return new Response(JSON.stringify({
            error: "rien à réclamer sur cette voie"
          }), {
            status: 400,
            headers: corsHeaders
          });
          const reward = bpGrantReward(creature, rewardDef);
          claimedList.push(tDef.tier);
          result = {
            track,
            tier: tDef.tier,
            reward
          };
          break;
        }
      case "consume_candy":
        {
          const candyId = typeof payload?.candyId === "string" ? payload.candyId : "";
          const ok = consumeCandy(creature, candyId);
          if (!ok) return new Response(JSON.stringify({
            error: "bonbon indisponible"
          }), {
            status: 403,
            headers: corsHeaders
          });
          result = {};
          break;
        }
      case "sell_item":
        {
          const itemId = payload?.itemId;
          const item = (creature.inventory || []).find((i)=>i.id === itemId);
          if (!item) return new Response(JSON.stringify({
            error: "objet introuvable"
          }), {
            status: 404,
            headers: corsHeaders
          });
          const price = SELL_PRICE[item.rarity];
          if (!price) return new Response(JSON.stringify({
            error: "objet non vendable"
          }), {
            status: 400,
            headers: corsHeaders
          });
          creature.inventory = creature.inventory.filter((i)=>i.id !== itemId);
          creature.moltcoins = (creature.moltcoins || 0) + price;
          result = {
            price
          };
          break;
        }
      case "equip_toggle":
        {
          const itemId = payload?.itemId;
          const item = (creature.inventory || []).find((i)=>i.id === itemId);
          if (!item) return new Response(JSON.stringify({
            error: "objet introuvable"
          }), {
            status: 404,
            headers: corsHeaders
          });
          if (item.equipped) {
            item.equipped = false;
          } else if (item.rarity === "unique") {
            item.equipped = true;
          } else {
            const duplicateEquipped = creature.inventory.find((i)=>i.equipped && i.defId === item.defId && i.id !== item.id);
            if (duplicateEquipped) return new Response(JSON.stringify({
              error: "une autre copie de cet objet est déjà équipée"
            }), {
              status: 403,
              headers: corsHeaders
            });
            const equippedCount = creature.inventory.filter((i)=>i.equipped && i.rarity !== "unique").length;
            if (equippedCount >= MAX_EQUIP) return new Response(JSON.stringify({
              error: "plus de place d'équipement"
            }), {
              status: 403,
              headers: corsHeaders
            });
            item.equipped = true;
          }
          result = {
            equipped: item.equipped
          };
          break;
        }
      case "auto_equip":
        {
          creature.inventory.forEach((i)=>{
            if (i.rarity === "unique") i.equipped = true;
            else i.equipped = false;
          });
          const seenDefIds = new Set();
          const nonUnique = creature.inventory.filter((i)=>i.rarity !== "unique").sort((a, b)=>b.value - a.value).filter((i)=>{
            if (seenDefIds.has(i.defId)) return false; // une seule copie du même objet à la fois
            seenDefIds.add(i.defId);
            return true;
          });
          // Les meilleurs objets d'abord (peu importe la rareté), dans la limite de MAX_EQUIP
          // et sans doublon de defId — plus de plafond spécifique aux légendaires.
          nonUnique.slice(0, MAX_EQUIP).forEach((i)=>{
            i.equipped = true;
          });
          result = {};
          break;
        }
      case "care_feed":
        {
          if (careAttemptsLeft(creature) <= 0) return new Response(JSON.stringify({
            error: "plus de soin disponible aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          creature.hunger = Math.min(100, creature.hunger + 55);
          useCareAttempt(creature);
          bpTrack(creature, "care");
          result = {};
          break;
        }
      case "care_play":
        {
          if (careAttemptsLeft(creature) <= 0) return new Response(JSON.stringify({
            error: "plus de soin disponible aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          creature.joy = Math.min(100, creature.joy + 55);
          creature.energy = Math.max(0, creature.energy - 8);
          useCareAttempt(creature);
          bpTrack(creature, "care");
          result = {};
          break;
        }
      case "care_rest":
        {
          if (careAttemptsLeft(creature) <= 0) return new Response(JSON.stringify({
            error: "plus de soin disponible aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          creature.energy = Math.min(100, creature.energy + 75);
          useCareAttempt(creature);
          bpTrack(creature, "care");
          result = {};
          break;
        }
      case "treasure_dig":
        {
          regenTreasureAP(creature);
          if (creature.treasureAP <= 0) return new Response(JSON.stringify({
            error: "plus de point d'action disponible"
          }), {
            status: 403,
            headers: corsHeaders
          });
          const dig = digTreasure(creature);
          creature.energy = Math.max(0, creature.energy - 1);
          bpTrack(creature, "treasure");
          achievements.stats.treasureDigsTotal = (achievements.stats.treasureDigsTotal || 0) + 1;
          result = {
            coins: dig?.coins || 0,
            item: dig?.item || null
          };
          break;
        }
      case "chest_start":
        {
          if (chestsRemaining(creature) <= 0) return new Response(JSON.stringify({
            error: "plus de coffre disponible aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          creature.chestPendingStartedAt = Date.now();
          result = {};
          break;
        }
      case "chest_claim":
        {
          if (chestsRemaining(creature) <= 0) return new Response(JSON.stringify({
            error: "plus de coffre disponible aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          const startedAt = creature.chestPendingStartedAt;
          const elapsed = startedAt ? Date.now() - startedAt : Infinity;
          if (!startedAt || elapsed < CHEST_WATCH_SECONDS * 1000 || elapsed > CHEST_START_MAX_AGE_MS) {
            return new Response(JSON.stringify({
              error: "délai de visionnage non respecté"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          creature.chestPendingStartedAt = null;
          if (creature.chestsDay !== todayKey()) {
            creature.chestsDay = todayKey();
            creature.chestsOpened = 0;
          }
          creature.chestsOpened += 1;
          const coins = 5 + Math.floor(Math.random() * 11); // 5 à 15 Moltcoins
          creature.moltcoins = (creature.moltcoins || 0) + coins;
          let candy = null;
          if (Math.random() < 0.10) {
            const def = CONSUMABLE_DB[Math.floor(Math.random() * CONSUMABLE_DB.length)];
            if (!creature.consumables) creature.consumables = {};
            creature.consumables[def.id] = (creature.consumables[def.id] || 0) + 1;
            candy = {
              id: def.id,
              name: def.name
            };
          }
          let uniqueFound = null;
          if (Math.random() < 0.003) {
            const ownedUniqueIds = new Set((creature.inventory || []).filter((i)=>i.rarity === "unique").map((i)=>i.defId));
            if (!ownedUniqueIds.has("eclat_de_cupidite")) {
              const def = UNIQUE_ITEM_DB.find((u)=>u.id === "eclat_de_cupidite");
              const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
              uniqueFound = {
                id: uid,
                defId: def.id,
                name: def.name,
                rarity: "unique",
                special: def.special,
                equipped: true
              };
              creature.inventory.push(uniqueFound);
            }
          }
          result = {
            coins,
            candy,
            uniqueFound
          };
          break;
        }
      case "mystery_chest_buy":
        {
          if (creature.mysteryChestDay !== todayKey()) {
            creature.mysteryChestDay = todayKey();
            creature.mysteryChestOpened = 0;
          }
          // Paiement à l'unité (voir stripe-webhook.ts) : un crédit payé en attente est
          // TOUJOURS consommé en priorité, avant même de regarder le plafond quotidien ou le
          // solde Moltcoins — c'est une réserve totalement séparée, pas soumise au plafond
          // des ouvertures gratuites/Moltcoins.
          const usedPaidCredit = (creature.mysteryChestPendingPaid || 0) > 0;
          if (usedPaidCredit) {
            creature.mysteryChestPendingPaid -= 1;
          } else {
            if (creature.mysteryChestOpened >= MYSTERY_CHEST_FREE_DAILY) {
              return new Response(JSON.stringify({
                error: "limite quotidienne de coffres mystère atteinte"
              }), {
                status: 403,
                headers: corsHeaders
              });
            }
            if ((creature.moltcoins || 0) < MYSTERY_CHEST_COST) {
              return new Response(JSON.stringify({
                error: "Moltcoins insuffisants"
              }), {
                status: 403,
                headers: corsHeaders
              });
            }
            creature.moltcoins -= MYSTERY_CHEST_COST;
            creature.mysteryChestOpened += 1;
          }
          achievements.stats.mysteryChestsOpenedTotal = (achievements.stats.mysteryChestsOpenedTotal || 0) + 1;
          const dungeonId = mysteryChestDungeonId(creature);
          // Tirages INDÉPENDANTS (pas un choix exclusif) — voir la conversation : une seule
          // ouverture peut cumuler plusieurs récompenses à la fois.
          const mcCoins = 80 + Math.floor(Math.random() * 71); // 80-150
          creature.moltcoins += mcCoins;
          let mcCandy = null;
          if (Math.random() < 0.30) {
            const def = CONSUMABLE_DB[Math.floor(Math.random() * CONSUMABLE_DB.length)];
            if (!creature.consumables) creature.consumables = {};
            creature.consumables[def.id] = (creature.consumables[def.id] || 0) + 1;
            mcCandy = {
              id: def.id,
              name: def.name
            };
          }
          const mcItems = [];
          if (Math.random() < 0.25) {
            const it = rollMysteryChestItem(dungeonId, Math.random() < 0.5 ? "common" : "rare");
            if (it) { creature.inventory.push(it); mcItems.push(it); }
          }
          if (Math.random() < 0.05) {
            const it = rollMysteryChestItem(dungeonId, "epic");
            if (it) { creature.inventory.push(it); mcItems.push(it); }
          }
          if (Math.random() < 0.03) {
            const it = rollMysteryChestItem(dungeonId, "legendary");
            if (it) { creature.inventory.push(it); mcItems.push(it); }
          }
          let mcUniqueFound = null;
          const ownedUniqueIds = new Set((creature.inventory || []).filter((i)=>i.rarity === "unique").map((i)=>i.defId));
          if (!ownedUniqueIds.has("eclat_du_negociateur") && Math.random() < 0.005) {
            const def = UNIQUE_ITEM_DB.find((u)=>u.id === "eclat_du_negociateur");
            const uid = "item_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
            mcUniqueFound = {
              id: uid,
              defId: def.id,
              name: def.name,
              rarity: "unique",
              special: def.special,
              equipped: false
            };
            creature.inventory.push(mcUniqueFound);
          }
          result = {
            coins: mcCoins,
            candy: mcCandy,
            items: mcItems,
            uniqueFound: mcUniqueFound,
            openedToday: creature.mysteryChestOpened,
            freeDailyLimit: MYSTERY_CHEST_FREE_DAILY,
            usedPaidCredit,
            pendingPaid: creature.mysteryChestPendingPaid || 0
          };
          break;
        }
      case "dungeon_climb":
        {
          if (creature.dungeonDay !== todayKey()) {
            creature.dungeonDay = todayKey();
            creature.dungeonAttempts = 0;
            creature.dungeonClears = 0;
          }
          if (creature.dungeonAttempts >= maxDungeonAttempts(creature)) return new Response(JSON.stringify({
            error: "plus de tentative de Donjon aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if (creature.dungeonClears >= maxDungeonClears(creature)) return new Response(JSON.stringify({
            error: "plafond de réussites du jour atteint"
          }), {
            status: 403,
            headers: corsHeaders
          });
          const specialBonus = equippedSpecialBonus(creature);
          const power = totalPower(creature);
          let req = floorRequirement(creature.dungeonFloor);
          if (specialBonus.dungeonReqReductionPct) req = Math.round(req * (1 - specialBonus.dungeonReqReductionPct / 100));
          const winChance = Math.min(0.95, Math.max(0.08, 0.5 + (power / req - 0.9) * (9 / 7)));
          const win = Math.random() < winChance;
          if (win) creature.dungeonClears += 1;
          else creature.dungeonAttempts += 1;
          // Coût en bien-être uniquement jusqu'à l'étage 100 inclus — au-delà, la Tour
          // devient une activité "libre" niveau bien-être, comme les 2 autres donjons.
          if (creature.dungeonFloor <= 100) creature.joy = Math.max(0, creature.joy - 4);
          bpTrack(creature, "dungeon");
          const uniqueFound = rollDungeonUnique(creature);
          if (win) {
            const clearedFloor = creature.dungeonFloor;
            let xpGain = dungeonXP(clearedFloor);
            if (specialBonus.dungeonXPPct) xpGain = Math.round(xpGain * (1 + specialBonus.dungeonXPPct / 100));
            grantXP(creature, xpGain);
            let item = null;
            if (isLootFloor(clearedFloor)) {
              item = rollLoot(clearedFloor, "wyrm");
              creature.inventory.push(item);
            }
            creature.dungeonFloor += 1;
            achievements.stats.totalFloorsCleared = (achievements.stats.totalFloorsCleared || 0) + 1;
            result = {
              win: true,
              clearedFloor,
              xpGain,
              item,
              uniqueFound
            };
          } else {
            const failFloor = creature.dungeonFloor;
            let failXp = Math.max(1, Math.round(dungeonXP(failFloor) * 0.25));
            if (specialBonus.dungeonXPPct) failXp = Math.round(failXp * (1 + specialBonus.dungeonXPPct / 100));
            grantXP(creature, failXp);
            result = {
              win: false,
              failFloor,
              xpGain: failXp,
              uniqueFound
            };
          }
          break;
        }
      case "dungeon_unlock_corrupt":
        {
          if (!corruptUnlockEligible(creature)) return new Response(JSON.stringify({
            error: "étage 100 non atteint"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if ((creature.moltcoins || 0) < CORRUPT_UNLOCK_COST) return new Response(JSON.stringify({
            error: "Moltcoins insuffisants"
          }), {
            status: 403,
            headers: corsHeaders
          });
          creature.moltcoins -= CORRUPT_UNLOCK_COST;
          creature.corruptUnlocked = true;
          result = {};
          break;
        }
      case "dungeon_climb_corrupt":
        {
          if (!creature.corruptUnlocked) return new Response(JSON.stringify({
            error: "Sanctuaire Corrompu non débloqué"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if (creature.corruptDay !== todayKey()) {
            creature.corruptDay = todayKey();
            creature.corruptAttempts = 0;
            creature.corruptClears = 0;
          }
          if (creature.corruptAttempts >= maxCorruptAttempts(creature)) return new Response(JSON.stringify({
            error: "plus de tentative de Sanctuaire aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if (creature.corruptClears >= maxCorruptClears(creature)) return new Response(JSON.stringify({
            error: "plafond de réussites du jour atteint"
          }), {
            status: 403,
            headers: corsHeaders
          });
          const specialBonus = equippedSpecialBonus(creature);
          const power = totalPower(creature);
          let req = corruptFloorRequirement(creature.corruptFloor);
          if (specialBonus.dungeonReqReductionPct) req = Math.round(req * (1 - specialBonus.dungeonReqReductionPct / 100));
          const winChance = Math.min(0.95, Math.max(0.08, 0.5 + (power / req - 0.9) * (9 / 7)));
          const win = Math.random() < winChance;
          if (win) creature.corruptClears += 1;
          else creature.corruptAttempts += 1;
          // Même règle que la Tour : plus de coût en bien-être au-delà de l'étage 100.
          if (creature.corruptFloor <= 100) creature.joy = Math.max(0, creature.joy - 4);
          bpTrack(creature, "dungeon");
          const uniqueFound = rollDungeonUnique(creature);
          if (win) {
            const clearedFloor = creature.corruptFloor;
            let xpGain = corruptXP(clearedFloor);
            if (specialBonus.dungeonXPPct) xpGain = Math.round(xpGain * (1 + specialBonus.dungeonXPPct / 100));
            grantXP(creature, xpGain);
            let item = null;
            if (isCorruptLootFloor(clearedFloor)) {
              item = rollLoot(clearedFloor, "corrupt");
              creature.inventory.push(item);
            }
            creature.corruptFloor += 1;
            achievements.stats.totalFloorsCleared = (achievements.stats.totalFloorsCleared || 0) + 1;
            result = {
              win: true,
              clearedFloor,
              xpGain,
              item,
              uniqueFound
            };
          } else {
            const failFloor = creature.corruptFloor;
            let failXp = Math.max(1, Math.round(corruptXP(failFloor) * 0.25));
            if (specialBonus.dungeonXPPct) failXp = Math.round(failXp * (1 + specialBonus.dungeonXPPct / 100));
            grantXP(creature, failXp);
            result = {
              win: false,
              failFloor,
              xpGain: failXp,
              uniqueFound
            };
          }
          break;
        }
      case "dungeon_unlock_noyau":
        {
          if (!noyauUnlockEligible(creature)) return new Response(JSON.stringify({
            error: "étage 100 du Sanctuaire non atteint"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if ((creature.moltcoins || 0) < NOYAU_UNLOCK_COST) return new Response(JSON.stringify({
            error: "Moltcoins insuffisants"
          }), {
            status: 403,
            headers: corsHeaders
          });
          creature.moltcoins -= NOYAU_UNLOCK_COST;
          creature.noyauUnlocked = true;
          creature.noyauFloor = 1;
          creature.noyauAttempts = 0;
          creature.noyauClears = 0;
          creature.noyauDay = null;
          result = {};
          break;
        }
      case "dungeon_climb_noyau":
        {
          if (!creature.noyauUnlocked) return new Response(JSON.stringify({
            error: "Noyau Primordial non débloqué"
          }), {
            status: 403,
            headers: corsHeaders
          });
          // Auto-réparation : répare les sauvegardes où noyauFloor n'a jamais été initialisé
          // (bug corrigé dans dungeon_unlock_noyau, mais les comptes débloqués avant ce
          // correctif restaient bloqués avec noyauFloor undefined → NaN partout ensuite).
          if (!creature.noyauFloor) creature.noyauFloor = 1;
          if (creature.noyauDay !== todayKey()) {
            creature.noyauDay = todayKey();
            creature.noyauAttempts = 0;
            creature.noyauClears = 0;
          }
          if (creature.noyauAttempts >= maxNoyauAttempts(creature)) return new Response(JSON.stringify({
            error: "plus de tentative de Noyau aujourd'hui"
          }), {
            status: 403,
            headers: corsHeaders
          });
          if (creature.noyauClears >= maxNoyauClears(creature)) return new Response(JSON.stringify({
            error: "plafond de réussites du jour atteint"
          }), {
            status: 403,
            headers: corsHeaders
          });
          const specialBonusNoyau = equippedSpecialBonus(creature);
          const powerNoyau = noyauPower(creature, creature.noyauFloor); // Puissance pondérée par l'affinité élémentaire de CET étage
          let reqNoyau = noyauFloorRequirement(creature.noyauFloor);
          if (specialBonusNoyau.dungeonReqReductionPct) reqNoyau = Math.round(reqNoyau * (1 - specialBonusNoyau.dungeonReqReductionPct / 100));
          const winChanceNoyau = Math.min(0.95, Math.max(0.08, 0.5 + (powerNoyau / reqNoyau - 0.9) * (9 / 7)));
          const winNoyau = Math.random() < winChanceNoyau;
          if (winNoyau) creature.noyauClears += 1;
          else creature.noyauAttempts += 1;
          // Même règle : plus de coût en bien-être au-delà de l'étage 100 du Noyau
          // lui-même (son propre compteur, indépendant du Sanctuaire).
          if (creature.noyauFloor <= 100) creature.joy = Math.max(0, creature.joy - 4);
          bpTrack(creature, "dungeon");
          const uniqueFoundNoyau = rollDungeonUnique(creature);
          if (winNoyau) {
            const clearedFloor = creature.noyauFloor;
            let xpGain = noyauXP(clearedFloor);
            if (specialBonusNoyau.dungeonXPPct) xpGain = Math.round(xpGain * (1 + specialBonusNoyau.dungeonXPPct / 100));
            grantXP(creature, xpGain);
            let item = null;
            if (isNoyauLootFloor(clearedFloor)) {
              item = rollLoot(clearedFloor, "noyau");
              creature.inventory.push(item);
            }
            creature.noyauFloor += 1;
            achievements.stats.totalFloorsCleared = (achievements.stats.totalFloorsCleared || 0) + 1;
            result = {
              win: true,
              clearedFloor,
              xpGain,
              item,
              uniqueFound: uniqueFoundNoyau
            };
          } else {
            const failFloor = creature.noyauFloor;
            let failXp = Math.max(1, Math.round(noyauXP(failFloor) * 0.25));
            if (specialBonusNoyau.dungeonXPPct) failXp = Math.round(failXp * (1 + specialBonusNoyau.dungeonXPPct / 100));
            grantXP(creature, failXp);
            result = {
              win: false,
              failFloor,
              xpGain: failXp,
              uniqueFound: uniqueFoundNoyau
            };
          }
          break;
        }
      case "set_active_badge":
        {
          const badgeId = payload?.badgeId;
          if (badgeId !== null && (typeof badgeId !== "string" || !achievements.unlocked[badgeId])) {
            return new Response(JSON.stringify({
              error: "succès non débloqué"
            }), {
              status: 403,
              headers: corsHeaders
            });
          }
          achievements.activeBadge = badgeId;
          result = {};
          break;
        }
      default:
        return new Response(JSON.stringify({
          error: "action inconnue : " + action
        }), {
          status: 400,
          headers: corsHeaders
        });
    }
    // Solde de Moltcoins uniquement en hausse compté comme "gagné" (une dépense en boutique/
    // déblocage ne doit jamais faire reculer ce compteur cumulatif).
    const moltcoinsDelta = (creature.moltcoins || 0) - moltcoinsBeforeAction;
    if (moltcoinsDelta > 0) {
      achievements.stats.moltcoinsEarnedLifetime = (achievements.stats.moltcoinsEarnedLifetime || 0) + moltcoinsDelta;
    }
    const newlyUnlocked = checkAchievements(achievements, creature);
    await supabase.from("kv_store").upsert({
      scope,
      key: "creature",
      value: creature,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "scope,key"
    });
    await supabase.from("kv_store").upsert({
      scope,
      key: "achievements",
      value: achievements,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "scope,key"
    });
    return new Response(JSON.stringify({
      creature,
      achievements,
      newlyUnlocked,
      ...result
    }), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: String(e)
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
