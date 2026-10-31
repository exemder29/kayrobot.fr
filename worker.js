// KayroBot proxy (Cloudflare Worker)
// - Garde le token du bot en secret (variable BOT_TOKEN), jamais envoyé au navigateur.
// - Détecte les serveurs où le bot est présent (/__presence).
// - Vérifie que l'utilisateur connecté via Discord est admin/owner du serveur ciblé.
// - Ne laisse passer qu'une liste précise de routes Discord (salons, rôles, membres, messages…).
// - Stocke la config des tickets et les tâches du bot dans Workers KV (variable CONFIG).

const ALLOWED_ORIGINS = [
  'https://exemder29.github.io',
  'https://kayrobot.fr',
  'https://www.kayrobot.fr'
];
const DISCORD = 'https://discord.com/api/v10';

// [méthodes, regex du chemin, type] — type : guild | channel | me | dm
const ROUTES = [
  [['GET'], /^\/guilds\/(\d+)$/, 'guild'],
  [['GET', 'POST'], /^\/guilds\/(\d+)\/channels$/, 'guild'],
  [['GET'], /^\/guilds\/(\d+)\/members$/, 'guild'],           // liste des membres (intent « Server Members » requis)
  [['GET'], /^\/guilds\/(\d+)\/members\/search$/, 'guild'],   // recherche d'un membre par pseudo
  [['PUT', 'DELETE'], /^\/guilds\/(\d+)\/bans\/\d+$/, 'guild'],
  [['GET', 'PATCH', 'DELETE'], /^\/guilds\/(\d+)\/members\/\d+$/, 'guild'],
  [['PATCH', 'DELETE'], /^\/guilds\/(\d+)\/roles\/\d+$/, 'guild'],
  [['GET', 'POST'], /^\/guilds\/(\d+)\/roles$/, 'guild'],
  [['PUT', 'DELETE'], /^\/guilds\/(\d+)\/members\/\d+\/roles\/\d+$/, 'guild'],
  [['GET', 'PATCH'], /^\/channels\/(\d+)$/, 'channel'],
  [['GET', 'POST'], /^\/channels\/(\d+)\/messages$/, 'channel'],
  [['DELETE'], /^\/channels\/(\d+)\/messages\/\d+$/, 'channel'],
  [['POST'], /^\/channels\/(\d+)\/messages\/bulk-delete$/, 'channel'],
  [['PUT'], /^\/channels\/(\d+)\/permissions\/\d+$/, 'channel'],
  [['POST'], /^\/users\/@me\/channels$/, 'dm'],
  [['GET'], /^\/users\/@me$/, 'me']
];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Guild-Id, X-Audit-Log-Reason, X-Admin-Code',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) }
  });
}

const bearer = request => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
const isAdminPerm = g => g.owner || (BigInt(g.permissions || 0) & 8n) === 8n;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Appel Discord avec un nouvel essai si Discord répond « trop de requêtes » (429)
async function discordFetch(path, headers) {
  let res = await fetch(`${DISCORD}${path}`, { headers });
  if (res.status === 429) {
    let wait = 1;
    try { wait = Math.min(Number((await res.json()).retry_after) || 1, 3); } catch (e) {}
    await sleep(wait * 1000);
    res = await fetch(`${DISCORD}${path}`, { headers });
  }
  return res;
}

// ---------- Serveurs de l'utilisateur ----------
const guildListCache = new Map(); // token -> { exp, guilds }

// Renvoie { status, guilds } : status 200 si OK, 401 si le token Discord est refusé, autre = Discord injoignable
async function getUserGuilds(userToken) {
  const cached = guildListCache.get(userToken);
  if (cached && cached.exp > Date.now()) return { status: 200, guilds: cached.guilds };
  const res = await discordFetch('/users/@me/guilds', { Authorization: `Bearer ${userToken}` });
  if (!res.ok) return { status: res.status, guilds: [] };
  const guilds = await res.json();
  if (!Array.isArray(guilds)) return { status: 502, guilds: [] };
  if (guildListCache.size > 500) guildListCache.clear();
  guildListCache.set(userToken, { exp: Date.now() + 60_000, guilds });
  return { status: 200, guilds };
}

// true / false, ou null si Discord n'a pas permis de vérifier
async function isGuildAdmin(userToken, guildId) {
  const { status, guilds } = await getUserGuilds(userToken);
  if (status === 401) return false;
  if (status !== 200) return null;
  const g = guilds.find(x => x.id === guildId);
  return !!g && isAdminPerm(g);
}

// Réponse d'erreur adaptée quand l'autorisation échoue
function adminError(ok, origin) {
  if (ok === null) return json({ message: 'Discord ne répond pas, réessaie dans quelques secondes' }, 503, origin);
  return json({ message: "Vous n'êtes pas administrateur de ce serveur (ou la session Discord a expiré)" }, 403, origin);
}

async function userTokenValid(userToken) {
  const res = await fetch(`${DISCORD}/users/@me`, { headers: { Authorization: `Bearer ${userToken}` } });
  return res.ok;
}

// ---------- Présence du bot (1 seul appel au lieu d'un par serveur) ----------
let botGuildsCache = { exp: 0, ids: new Set() };

async function getBotGuildIds(botToken) {
  if (botGuildsCache.exp > Date.now()) return botGuildsCache.ids;
  const ids = new Set();
  let after = '';
  try {
    for (let i = 0; i < 10; i++) { // 10 pages x 200 = 2000 serveurs max
      const res = await discordFetch(`/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`, { Authorization: `Bot ${botToken}` });
      if (!res.ok) throw new Error(`Discord ${res.status}`);
      const page = await res.json();
      if (!Array.isArray(page)) throw new Error('réponse inattendue');
      page.forEach(g => ids.add(g.id));
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
  } catch (e) {
    // En cas d'échec, on garde la dernière liste connue plutôt que d'afficher « bot absent » partout
    if (botGuildsCache.ids.size) { botGuildsCache.exp = Date.now() + 5_000; return botGuildsCache.ids; }
    throw e;
  }
  botGuildsCache = { exp: Date.now() + 30_000, ids };
  return ids;
}

// ---------- File de tâches : le site demande, le bot exécute (avertissements, programmations, bump…) ----------
const JOB_TYPES = new Set([
  'avertir', 'avertissements', 'effacer-avertissements',
  'programmer', 'programmations', 'annuler-programmation',
  'bump-activer', 'bump-desactiver', 'bump-statut',
  'apparence'
]);

async function readPending(env) {
  const raw = await env.CONFIG.get('jobs:pending');
  let list = [];
  try { list = raw ? JSON.parse(raw) : []; } catch (e) {}
  const limit = Date.now() - 120_000; // une tâche non prise en charge au bout de 2 min est abandonnée
  return list.filter(j => j.createdAt > limit);
}

// ---------- Configuration partagée site <-> bot (stockée dans Workers KV) ----------
const SNOWFLAKE = /^\d{15,25}$/;

function cleanTicketConfig(input) {
  const id = v => (typeof v === 'string' && SNOWFLAKE.test(v.trim()) ? v.trim() : '');
  const lines = (arr, max, len) => (Array.isArray(arr) ? arr : [])
    .map(x => String(x).trim().slice(0, len)).filter(Boolean).slice(0, max);
  return {
    requestChannelId: id(input.requestChannelId),
    staffRoleId: id(input.staffRoleId),
    categoryId: id(input.categoryId),
    questions: lines(input.questions, 5, 45),
    options: lines(input.options, 25, 150)
  };
}

function kvOrError(env, origin) {
  if (!env.CONFIG) return json({ message: "Le stockage KV « CONFIG » n'est pas lié au Worker" }, 500, origin);
  return null;
}

const plain = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Routes réservées au bot (pas d'Origin navigateur) : protégées par la clé BOT_API_KEY
async function botRoute(request, env, url) {
  const key = request.headers.get('X-Bot-Key') || '';
  if (!env.BOT_API_KEY || key.length !== env.BOT_API_KEY.length ||
      ![...key].every((c, i) => c === env.BOT_API_KEY[i])) {
    return plain({ message: 'Clé invalide' }, 401);
  }
  if (!env.CONFIG) return plain({ message: 'KV non lié' }, 500);

  if (url.pathname === '/bot/jobs' && request.method === 'GET') {
    return plain(await readPending(env));
  }
  const jr = url.pathname.match(/^\/bot\/jobs\/([a-z0-9]+)\/result$/);
  if (jr && request.method === 'POST') {
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const pending = (await readPending(env)).filter(j => j.id !== jr[1]);
    await env.CONFIG.put('jobs:pending', JSON.stringify(pending));
    await env.CONFIG.put(`jobs:result:${jr[1]}`, JSON.stringify({ ok: !!body.ok, message: String(body.message || '').slice(0, 1500) }), { expirationTtl: 300 });
    return plain({ ok: true });
  }
  const m = url.pathname.match(/^\/bot\/config\/(\d+)\/tickets$/);
  if (!m) return plain({ message: 'Route inconnue' }, 404);
  const kvKey = `tickets:${m[1]}`;
  if (request.method === 'GET') {
    const raw = await env.CONFIG.get(kvKey);
    return new Response(raw || 'null', { status: raw ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }
  if (request.method === 'PUT') {
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const doc = { ...cleanTicketConfig(body), updatedAt: Date.now(), updatedBy: 'discord' };
    await env.CONFIG.put(kvKey, JSON.stringify(doc));
    return plain(doc);
  }
  return plain({ message: 'Méthode non autorisée' }, 405);
}

// ---------- Support : messages envoyés depuis la page /support, lus dans l'espace admin (aucun KV nécessaire) ----------
const SUPPORT_SUBJECTS = new Set(['Commandes', 'Tickets', 'Dashboard', 'Autre']);
const adminFails = new Map(); // ip -> { count, exp } (limite les essais de code, au mieux)
let adminCodeCache = { exp: 0, code: '' };

function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Code admin : secret ADMIN_CODE s'il existe, sinon le même code que la page admin (Firestore admin/config)
async function getAdminCode(env) {
  if (env.ADMIN_CODE) return String(env.ADMIN_CODE).trim();
  if (adminCodeCache.exp > Date.now()) return adminCodeCache.code;
  const res = await fetch('https://firestore.googleapis.com/v1/projects/kayrobot-discord/databases/(default)/documents/admin/config');
  if (!res.ok) throw new Error(`Firestore ${res.status}`);
  const f = ((await res.json()).fields || {}).code || {};
  const code = String(f.stringValue ?? f.integerValue ?? '').trim();
  if (!code) throw new Error('code absent');
  adminCodeCache = { exp: Date.now() + 60_000, code };
  return code;
}

// Renvoie null si le code est bon, sinon la réponse d'erreur à renvoyer
async function checkAdminCode(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
  const prev = adminFails.get(ip);
  const active = prev && prev.exp > Date.now() ? prev : null;
  if (active && active.count >= 10) return json({ message: "Trop d'essais, réessaie dans quelques minutes" }, 429, origin);
  const given = (request.headers.get('X-Admin-Code') || '').trim();
  let expected;
  try { expected = await getAdminCode(env); } catch (e) { return json({ message: 'Impossible de vérifier le code admin' }, 503, origin); }
  if (!given || !safeEqual(given, expected)) {
    if (adminFails.size > 500) adminFails.clear();
    const cur = active || { count: 0, exp: Date.now() + 600_000 };
    cur.count++;
    adminFails.set(ip, cur);
    return json({ message: 'Code administrateur invalide' }, 403, origin);
  }
  return null;
}

const supportSeen = new Map(); // ip -> dernier envoi (limite d'un message par minute, au mieux)
const SUPPORT_FOOTER = 'KayroBot Support';
const SUPPORT_REPLY_FOOTER = 'KayroBot Support · Réponse';
let supportCache = { exp: 0, rows: [] };

// Jeton privé d'une demande : calculé à partir de l'identifiant du message et du token du bot, rien à stocker.
// Il est remis au visiteur à l'envoi : lui seul peut relire sa demande et les réponses.
async function ticketToken(botToken, id) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(botToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`support:${id}`)));
  let bin = ''; sig.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

// Derniers messages du salon (jusqu'à 300), mis en cache 8 secondes. null si Discord refuse.
async function loadSupportRows(channelId, botHeaders, fresh) {
  if (!fresh && supportCache.exp > Date.now()) return supportCache.rows;
  let rows = []; let before = '';
  for (let i = 0; i < 3; i++) {
    const res = await discordFetch(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`, botHeaders);
    if (!res.ok) return null;
    const page = await res.json();
    if (!Array.isArray(page)) return null;
    rows = rows.concat(page);
    if (page.length < 100) break;
    before = page[page.length - 1].id;
  }
  supportCache = { exp: Date.now() + 8_000, rows };
  return rows;
}

// Transforme les messages du salon en demandes (les plus récentes d'abord), chacune avec ses réponses
function parseSupport(rows, botId) {
  const replies = new Map();
  const requests = [];
  rows.forEach(r => {
    const e = r.author && r.author.id === botId && r.embeds && r.embeds[0];
    if (!e || !e.footer) return;
    const createdAt = Date.parse(e.timestamp || r.timestamp) || Date.now();
    if (e.footer.text === SUPPORT_FOOTER) {
      requests.push({
        id: r.id, createdAt,
        subject: String(e.title || '').replace(/^Support · /, ''),
        contact: ((e.fields || [])[0] || {}).value || '',
        message: e.description || '',
        replies: []
      });
    } else if (e.footer.text === SUPPORT_REPLY_FOOTER && r.message_reference && r.message_reference.message_id) {
      const pid = r.message_reference.message_id;
      if (!replies.has(pid)) replies.set(pid, []);
      replies.get(pid).push({ id: r.id, createdAt, text: e.description || '' });
    }
  });
  requests.forEach(q => { q.replies = (replies.get(q.id) || []).sort((x, y) => x.createdAt - y.createdAt); });
  return requests;
}

// Les messages et les réponses sont rangés dans un salon Discord privé (variable SUPPORT_CHANNEL_ID du Worker), via le bot
async function supportRoute(request, env, url, origin, botHeaders, botToken) {
  if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Origin non autorisée', { status: 403 });
  const channelId = String(env.SUPPORT_CHANNEL_ID || '').trim();
  if (!SNOWFLAKE.test(channelId)) return json({ message: "Le salon du support n'est pas configuré (variable SUPPORT_CHANNEL_ID sur le Worker)" }, 500, origin);
  const m = url.pathname.match(/^\/support(?:\/(mine|\d{15,25})(?:\/(reply))?)?$/);
  if (!m) return json({ message: 'Route inconnue' }, 404, origin);
  const target = m[1]; const action = m[2];
  const noAccess = () => json({ message: "Le bot n'a pas accès au salon du support" }, 502, origin);
  const botId = idFromBot(botToken);
  const readJson = async () => { try { return await request.json(); } catch (e) { return null; } };

  // Envoi d'un message (public)
  if (request.method === 'POST' && !target) {
    const body = await readJson();
    if (!body) return json({ message: 'JSON invalide' }, 400, origin);
    if (body.website) return json({ ok: true }, 200, origin); // champ piège : on fait semblant d'accepter
    const subject = String(body.subject || '');
    const contact = String(body.contact || '').trim();
    const message = String(body.message || '').trim();
    if (!SUPPORT_SUBJECTS.has(subject)) return json({ message: 'Choisis un sujet' }, 400, origin);
    if (contact.length < 3 || contact.length > 120) return json({ message: "Indique un pseudo Discord ou un e-mail pour qu'on puisse te répondre" }, 400, origin);
    if (message.length < 10 || message.length > 2000) return json({ message: 'Le message doit faire entre 10 et 2000 caractères' }, 400, origin);

    const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
    const last = supportSeen.get(ip) || 0;
    if (Date.now() - last < 60_000) return json({ message: "Un message vient d'être envoyé, patiente une minute avant le suivant" }, 429, origin);
    if (supportSeen.size > 500) supportSeen.clear();
    supportSeen.set(ip, Date.now());

    const res = await fetch(`${DISCORD}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...botHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        embeds: [{
          title: `Support · ${subject}`,
          description: message,
          color: 0x5865f2,
          fields: [{ name: 'Contact', value: contact }],
          footer: { text: SUPPORT_FOOTER },
          timestamp: new Date().toISOString()
        }]
      })
    });
    if (!res.ok) { supportSeen.delete(ip); return noAccess(); }
    supportCache.exp = 0;
    const sent = await res.json().catch(() => ({}));
    if (!sent.id) return json({ ok: true }, 200, origin);
    return json({ ok: true, id: sent.id, token: await ticketToken(botToken, sent.id) }, 200, origin);
  }

  // Le visiteur relit ses propres demandes et les réponses (il envoie les jetons qu'il a reçus)
  if (request.method === 'POST' && target === 'mine' && !action) {
    const body = await readJson();
    const tickets = body && Array.isArray(body.tickets) ? body.tickets.slice(0, 20) : [];
    const allowed = new Set();
    for (const t of tickets) {
      if (!t || !SNOWFLAKE.test(String(t.id)) || typeof t.token !== 'string') continue;
      if (safeEqual(t.token, await ticketToken(botToken, String(t.id)))) allowed.add(String(t.id));
    }
    if (!allowed.size) return json({ messages: [] }, 200, origin);
    const rows = await loadSupportRows(channelId, botHeaders, false);
    if (!rows) return noAccess();
    const messages = parseSupport(rows, botId)
      .filter(q => allowed.has(q.id))
      .map(q => ({ id: q.id, createdAt: q.createdAt, subject: q.subject, message: q.message, replies: q.replies.map(r => ({ createdAt: r.createdAt, text: r.text })) }));
    return json({ messages }, 200, origin);
  }

  // Tout le reste : réservé à l'admin
  const denied = await checkAdminCode(request, env, origin);
  if (denied) return denied;

  if (request.method === 'GET' && !target) {
    const rows = await loadSupportRows(channelId, botHeaders, true);
    if (!rows) return noAccess();
    return json({ messages: parseSupport(rows, botId), more: rows.length >= 300 }, 200, origin);
  }

  if (request.method === 'POST' && target && target !== 'mine' && action === 'reply') {
    const body = await readJson();
    const text = String((body && body.text) || '').trim();
    if (text.length < 1 || text.length > 2000) return json({ message: 'La réponse doit faire entre 1 et 2000 caractères' }, 400, origin);
    const rows = await loadSupportRows(channelId, botHeaders, true);
    if (!rows) return noAccess();
    if (!parseSupport(rows, botId).some(q => q.id === target)) return json({ message: 'Message introuvable' }, 404, origin);
    const res = await fetch(`${DISCORD}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...botHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: target, fail_if_not_exists: false },
        embeds: [{
          title: 'Réponse du support',
          description: text,
          color: 0x3ddc97,
          footer: { text: SUPPORT_REPLY_FOOTER },
          timestamp: new Date().toISOString()
        }]
      })
    });
    if (!res.ok) return noAccess();
    supportCache.exp = 0;
    return json({ ok: true }, 200, origin);
  }

  if (request.method === 'DELETE' && target && target !== 'mine' && !action) {
    // On supprime aussi les réponses liées à ce message
    const rows = await loadSupportRows(channelId, botHeaders, true);
    const linked = (rows || []).filter(r => r.message_reference && r.message_reference.message_id === target && r.author && r.author.id === botId).map(r => r.id);
    for (const id of [...linked, target]) {
      const res = await fetch(`${DISCORD}/channels/${channelId}/messages/${id}`, { method: 'DELETE', headers: botHeaders });
      if (!res.ok && res.status !== 404) return noAccess();
    }
    supportCache.exp = 0;
    return json({ ok: true }, 200, origin);
  }
  return json({ message: 'Méthode non autorisée' }, 405, origin);
}

// Nettoyage strict du token : retire guillemets, préfixe « Bot », espaces, retours à la ligne, caractères invisibles
function cleanToken(raw) {
  return String(raw || '')
    .replace(/^\s*["']?\s*(Bot\s+)?/i, '')
    .replace(/[^\x21-\x7E]/g, '')
    .replace(/["']$/g, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/bot/')) return botRoute(request, env, url);

    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const BOT_TOKEN = cleanToken(env.BOT_TOKEN);
    if (!BOT_TOKEN) return json({ message: 'BOT_TOKEN non configuré sur le Worker' }, 500, origin);
    const botHeaders = { Authorization: `Bot ${BOT_TOKEN}` };

    // Messages du support (rangés dans un salon Discord)
    if (/^\/support(\/|$)/.test(path)) return supportRoute(request, env, url, origin, botHeaders, BOT_TOKEN);

    // ---- Routes publiques (aucune donnée sensible) : page d'accueil et diagnostic ----

    // Nombre de serveurs pour la page d'accueil
    if (path === '/__stats') {
      try {
        const ids = await getBotGuildIds(BOT_TOKEN);
        return json({ ok: true, serveurs: ids.size }, 200, origin);
      } catch (e) {
        // Repli : compteur approximatif de l'application
        try {
          const r = await discordFetch('/applications/@me', botHeaders);
          if (r.ok) {
            const app = await r.json();
            return json({ ok: true, serveurs: app.approximate_guild_count ?? null }, 200, origin);
          }
        } catch (e2) {}
        return json({ ok: false }, 200, origin);
      }
    }

    // Diagnostic : ne révèle jamais le token, seulement sa forme et la réponse de Discord
    if (path === '/__check') {
      const parts = BOT_TOKEN.split('.');
      let idFromToken = '';
      try { idFromToken = atob(parts[0].padEnd(Math.ceil(parts[0].length / 4) * 4, '=')); } catch (e) {}
      let me = {}; let status = 500;
      try {
        const r = await discordFetch('/users/@me', botHeaders);
        status = r.status;
        me = await r.json().catch(() => ({}));
      } catch (e) { me = { message: e.message }; }

      // L'intent « Server Members » est nécessaire pour lister les membres
      let intentMembres = null;
      if (status === 200) {
        try {
          const r = await discordFetch('/applications/@me', botHeaders);
          if (r.ok) {
            const flags = Number((await r.json()).flags || 0);
            intentMembres = (flags & (1 << 14)) !== 0 || (flags & (1 << 15)) !== 0;
          }
        } catch (e) {}
      }
      return json({
        discordStatus: status,
        discordMessage: status === 200 ? 'OK' : (me.message || `Discord ${status}`),
        nomDuBot: me.username || 'Inconnu',
        idDuBot: me.id || '',
        longueur: BOT_TOKEN.length,
        morceaux: parts.length,
        longueurs: parts.map(p => p.length),
        idDansLeToken: idFromToken,
        intentMembres
      }, 200, origin);
    }

    // ---- Tout le reste est réservé aux sites autorisés ----
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origin non autorisée', { status: 403 });
    }

    // Quels serveurs de l'utilisateur ont le bot ? Un seul appel, liste du bot en cache 30 s.
    // Le navigateur peut joindre ?ids=1,2,3 (ses propres serveurs) : utile si Discord limite les appels du Worker.
    if (path === '/__presence') {
      const userTok = bearer(request);
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      let botIds;
      try {
        botIds = await getBotGuildIds(BOT_TOKEN);
      } catch (e) {
        return json({ message: `Vérification impossible (${e.message})` }, 502, origin);
      }
      const { status, guilds } = await getUserGuilds(userTok);
      if (status === 401) return json({ message: 'Session Discord invalide' }, 401, origin);
      if (status === 200) {
        const mine = guilds.filter(isAdminPerm);
        return json({ present: mine.filter(g => botIds.has(g.id)).map(g => g.id), botId: idFromBot(BOT_TOKEN), total: botIds.size }, 200, origin);
      }
      // Repli : Discord refuse temporairement la liste de l'utilisateur, on utilise celle envoyée par le navigateur
      const asked = (url.searchParams.get('ids') || '').split(',').filter(x => /^\d{15,25}$/.test(x)).slice(0, 200);
      if (asked.length) return json({ present: asked.filter(id => botIds.has(id)), botId: idFromBot(BOT_TOKEN), total: botIds.size }, 200, origin);
      return json({ message: 'Discord ne répond pas, réessaie dans quelques secondes' }, 503, origin);
    }

    // Configuration des tickets partagée avec le bot
    const cfg = path.match(/^\/config\/(\d+)\/tickets$/);
    if (cfg) {
      const gid = cfg[1];
      const userTok = bearer(request);
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      const adm = await isGuildAdmin(userTok, gid);
      if (adm !== true) return adminError(adm, origin);
      const kvErr = kvOrError(env, origin); if (kvErr) return kvErr;
      const kvKey = `tickets:${gid}`;

      if (request.method === 'GET') {
        const raw = await env.CONFIG.get(kvKey);
        return json(raw ? JSON.parse(raw) : { requestChannelId: '', staffRoleId: '', categoryId: '', questions: [], options: [] }, 200, origin);
      }
      if (request.method === 'PUT') {
        let body; try { body = await request.json(); } catch (e) { return json({ message: 'JSON invalide' }, 400, origin); }
        const doc = cleanTicketConfig(body);
        // Les salons et le rôle doivent exister sur CE serveur
        const [chRes, roRes] = await Promise.all([
          discordFetch(`/guilds/${gid}/channels`, botHeaders),
          discordFetch(`/guilds/${gid}/roles`, botHeaders)
        ]);
        if (!chRes.ok || !roRes.ok) return json({ message: "Le bot n'est pas sur ce serveur" }, 403, origin);
        const channels = await chRes.json(); const roles = await roRes.json();
        const chOk = (id, types) => !id || channels.some(c => c.id === id && types.includes(c.type));
        if (!chOk(doc.requestChannelId, [0, 5])) return json({ message: 'Salon des demandes introuvable sur ce serveur' }, 400, origin);
        if (!chOk(doc.categoryId, [4])) return json({ message: 'Catégorie introuvable sur ce serveur' }, 400, origin);
        if (doc.staffRoleId && !roles.some(r => r.id === doc.staffRoleId)) return json({ message: 'Rôle staff introuvable sur ce serveur' }, 400, origin);
        doc.updatedAt = Date.now();
        doc.updatedBy = 'site';
        await env.CONFIG.put(kvKey, JSON.stringify(doc));
        return json(doc, 200, origin);
      }
      return json({ message: 'Méthode non autorisée' }, 405, origin);
    }

    // Tâches pour le bot
    const jb = path.match(/^\/jobs\/(\d+)(?:\/([a-z0-9]+))?$/);
    if (jb) {
      const gid = jb[1];
      const userTok = bearer(request);
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      const adm = await isGuildAdmin(userTok, gid);
      if (adm !== true) return adminError(adm, origin);
      const kvErr = kvOrError(env, origin); if (kvErr) return kvErr;

      if (request.method === 'POST' && !jb[2]) {
        let body; try { body = await request.json(); } catch (e) { return json({ message: 'JSON invalide' }, 400, origin); }
        if (!JOB_TYPES.has(body.type)) return json({ message: 'Type de tâche inconnu' }, 400, origin);
        const args = body.args && typeof body.args === 'object' ? body.args : {};
        if (JSON.stringify(args).length > 4000) return json({ message: 'Tâche trop volumineuse' }, 400, origin);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const pending = await readPending(env);
        if (pending.filter(j => j.guildId === gid).length >= 10) return json({ message: 'Trop de tâches en attente, réessaie dans un instant' }, 429, origin);
        pending.push({ id, guildId: gid, type: body.type, args, createdAt: Date.now() });
        await env.CONFIG.put('jobs:pending', JSON.stringify(pending));
        return json({ id }, 200, origin);
      }
      if (request.method === 'GET' && jb[2]) {
        const raw = await env.CONFIG.get(`jobs:result:${jb[2]}`);
        return json(raw ? { done: true, ...JSON.parse(raw) } : { done: false }, 200, origin);
      }
      return json({ message: 'Méthode non autorisée' }, 405, origin);
    }

    // ---- Relais vers Discord (salons, rôles, membres, messages…) ----
    const route = ROUTES.find(([methods, re]) => methods.includes(request.method) && re.test(path));
    if (!route) return json({ message: 'Route non autorisée' }, 403, origin);

    const userToken = bearer(request);
    if (!userToken) return json({ message: 'Non connecté' }, 401, origin);
    const guildId = request.headers.get('X-Guild-Id') || '';

    const kind = route[2];
    const match = path.match(route[1]);

    // --- Autorisation ---
    if (kind === 'me') {
      if (!(await userTokenValid(userToken))) return json({ message: 'Session Discord invalide' }, 401, origin);
    } else {
      const adm = /^\d+$/.test(guildId) ? await isGuildAdmin(userToken, guildId) : false;
      if (adm !== true) return adminError(adm, origin);
      if (kind === 'guild' && match[1] !== guildId) {
        return json({ message: 'Serveur incohérent' }, 403, origin);
      }
      if (kind === 'channel') {
        const ch = await discordFetch(`/channels/${match[1]}`, botHeaders);
        if (!ch.ok) return json({ message: 'Salon introuvable pour le bot' }, ch.status, origin);
        const info = await ch.json();
        const inGuild = info.guild_id === guildId;
        const isDm = info.type === 1 && request.method === 'POST' && /\/messages$/.test(path);
        if (!inGuild && !isDm) return json({ message: "Ce salon n'appartient pas à ce serveur" }, 403, origin);
      }
    }

    // --- Transfert vers Discord avec le token du bot ---
    const headers = { ...botHeaders };
    const ct = request.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;
    const reason = request.headers.get('X-Audit-Log-Reason');
    if (reason) headers['X-Audit-Log-Reason'] = reason;

    const hasBody = !['GET', 'DELETE'].includes(request.method);
    let res;
    try {
      res = await fetch(`${DISCORD}${path}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? await request.text() : undefined
      });
    } catch (e) {
      return json({ message: `Discord injoignable (${e.message})` }, 502, origin);
    }

    return new Response(res.status === 204 ? null : await res.text(), {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', ...cors(origin) }
    });
  }
};

// ID du bot, lu au début du token (c'est public : le token commence par l'ID encodé en base64)
function idFromBot(token) {
  try {
    const p = token.split('.')[0];
    return atob(p.padEnd(Math.ceil(p.length / 4) * 4, '='));
  } catch (e) { return ''; }
}
