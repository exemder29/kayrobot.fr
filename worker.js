// KayroBot proxy (Cloudflare Worker)
// - Garde le token du bot en secret (variable BOT_TOKEN), jamais envoyé au navigateur.
// - Vérifie que l'utilisateur connecté via Discord est admin/owner du serveur ciblé.
// - Ne laisse passer qu'une liste précise de routes Discord.

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
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Guild-Id, X-Audit-Log-Reason',
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

const guildListCache = new Map(); // token -> { exp, guilds }

async function isGuildAdmin(userToken, guildId) {
  let entry = guildListCache.get(userToken);
  if (!entry || entry.exp < Date.now()) {
    const res = await fetch(`${DISCORD}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    if (!res.ok) return false;
    entry = { exp: Date.now() + 60_000, guilds: await res.json() };
    guildListCache.set(userToken, entry);
  }
  const g = entry.guilds.find(x => x.id === guildId);
  return !!g && (g.owner || (BigInt(g.permissions) & 8n) === 8n);
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
  for (let i = 0; i < 10; i++) { // 10 pages x 200 = 2000 serveurs max
    const res = await fetch(`${DISCORD}/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`, {
      headers: { Authorization: `Bot ${botToken}` }
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    const page = await res.json();
    page.forEach(g => ids.add(g.id));
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }
  botGuildsCache = { exp: Date.now() + 30_000, ids };
  return ids;
}

async function getUserAdminGuilds(userToken) {
  let entry = guildListCache.get(userToken);
  if (!entry || entry.exp < Date.now()) {
    const res = await fetch(`${DISCORD}/users/@me/guilds`, { headers: { Authorization: `Bearer ${userToken}` } });
    if (!res.ok) return null;
    entry = { exp: Date.now() + 60_000, guilds: await res.json() };
    guildListCache.set(userToken, entry);
  }
  return entry.guilds.filter(g => g.owner || (BigInt(g.permissions) & 8n) === 8n);
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

// Routes réservées au bot (pas d'Origin navigateur) : protégées par la clé BOT_API_KEY
async function botRoute(request, env, url) {
  const key = request.headers.get('X-Bot-Key') || '';
  if (!env.BOT_API_KEY || key.length !== env.BOT_API_KEY.length ||
      ![...key].every((c, i) => c === env.BOT_API_KEY[i])) {
    return new Response(JSON.stringify({ message: 'Clé invalide' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!env.CONFIG) return new Response(JSON.stringify({ message: 'KV non lié' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  if (url.pathname === '/bot/jobs' && request.method === 'GET') {
    const pending = await readPending(env);
    return new Response(JSON.stringify(pending), { headers: { 'Content-Type': 'application/json' } });
  }
  const jr = url.pathname.match(/^\/bot\/jobs\/([a-z0-9]+)\/result$/);
  if (jr && request.method === 'POST') {
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const pending = (await readPending(env)).filter(j => j.id !== jr[1]);
    await env.CONFIG.put('jobs:pending', JSON.stringify(pending));
    await env.CONFIG.put(`jobs:result:${jr[1]}`, JSON.stringify({ ok: !!body.ok, message: String(body.message || '').slice(0, 1500) }), { expirationTtl: 300 });
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }
  const m = url.pathname.match(/^\/bot\/config\/(\d+)\/tickets$/);
  if (!m) return new Response(JSON.stringify({ message: 'Route inconnue' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const kvKey = `tickets:${m[1]}`;
  if (request.method === 'GET') {
    const raw = await env.CONFIG.get(kvKey);
    return new Response(raw || 'null', { status: raw ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }
  if (request.method === 'PUT') {
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const doc = { ...cleanTicketConfig(body), updatedAt: Date.now(), updatedBy: 'discord' };
    await env.CONFIG.put(kvKey, JSON.stringify(doc));
    return new Response(JSON.stringify(doc), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ message: 'Méthode non autorisée' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const earlyUrl = new URL(request.url);
    if (earlyUrl.pathname.startsWith('/bot/')) return botRoute(request, env, earlyUrl);

    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Origin non autorisée', { status: 403 });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    // Nettoyage strict : retire guillemets, préfixe "Bot ", espaces, retours à la ligne et caractères invisibles
    const BOT_TOKEN = (env.BOT_TOKEN || '')
      .replace(/^\s*["']?\s*(Bot\s+)?/i, '')
      .replace(/[^\x21-\x7E]/g, '')
      .replace(/["']$/g, '');
    if (!BOT_TOKEN) {
      return json({ message: 'BOT_TOKEN non configuré sur le Worker' }, 500, origin);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Infos publiques pour la page d'accueil (nombre de serveurs). Aucune donnée sensible.
    if (path === '/__stats') {
      const r = await fetch(`${DISCORD}/applications/@me`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
      if (!r.ok) return json({ ok: false, status: r.status }, 200, origin);
      const app = await r.json();
      return json({ ok: true, serveurs: app.approximate_guild_count ?? null, nom: app.name || null }, 200, origin);
    }

    // Diagnostic : ne révèle jamais le token, seulement sa forme et la réponse de Discord
    if (path === '/__check') {
      const parts = BOT_TOKEN.split('.');
      let idFromToken = '';
      try { idFromToken = atob(parts[0]); } catch (e) {}
      const r = await fetch(`${DISCORD}/users/@me`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } });
      let me = {};
      try { me = await r.json(); } catch (e) {}
      return json({
        longueur: BOT_TOKEN.length,
        morceaux: parts.length,
        longueurs: parts.map(p => p.length),
        debutDuToken: parts[0],  // = ID du bot encodé, public (pas un secret)
        idDansLeToken: idFromToken,
        discordStatus: r.status,
        discordMessage: me.message || null,
        nomDuBot: me.username || null
      }, 200, origin);
    }
    // Quels serveurs de l'utilisateur ont le bot ? Un seul appel, résultat en cache 30 s.
    if (path === '/__presence') {
      const userTok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      try {
        const [mine, botIds] = await Promise.all([getUserAdminGuilds(userTok), getBotGuildIds(BOT_TOKEN)]);
        if (!mine) return json({ message: 'Session Discord invalide' }, 401, origin);
        return json({ present: mine.filter(g => botIds.has(g.id)).map(g => g.id) }, 200, origin);
      } catch (e) {
        return json({ message: `Vérification impossible (${e.message})` }, 502, origin);
      }
    }

    // Configuration des tickets partagée avec le bot
    const cfg = path.match(/^\/config\/(\d+)\/tickets$/);
    if (cfg) {
      const gid = cfg[1];
      const userTok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      if (!(await isGuildAdmin(userTok, gid))) return json({ message: "Vous n'êtes pas administrateur de ce serveur" }, 403, origin);
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
          fetch(`${DISCORD}/guilds/${gid}/channels`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } }),
          fetch(`${DISCORD}/guilds/${gid}/roles`, { headers: { Authorization: `Bot ${BOT_TOKEN}` } })
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
      const userTok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      if (!(await isGuildAdmin(userTok, gid))) return json({ message: "Vous n'êtes pas administrateur de ce serveur" }, 403, origin);
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

    const route = ROUTES.find(([methods, re]) => methods.includes(request.method) && re.test(path));
    if (!route) return json({ message: 'Route non autorisée' }, 403, origin);

    const userToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!userToken) return json({ message: 'Non connecté' }, 401, origin);
    const guildId = request.headers.get('X-Guild-Id') || '';

    const kind = route[2];
    const match = path.match(route[1]);

    // --- Autorisation ---
    if (kind === 'me') {
      if (!(await userTokenValid(userToken))) return json({ message: 'Session Discord invalide' }, 401, origin);
    } else {
      if (!/^\d+$/.test(guildId) || !(await isGuildAdmin(userToken, guildId))) {
        return json({ message: "Vous n'êtes pas administrateur de ce serveur" }, 403, origin);
      }
      if (kind === 'guild' && match[1] !== guildId) {
        return json({ message: 'Serveur incohérent' }, 403, origin);
      }
      if (kind === 'channel') {
        const ch = await fetch(`${DISCORD}/channels/${match[1]}`, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        if (!ch.ok) return json({ message: 'Salon introuvable pour le bot' }, ch.status, origin);
        const info = await ch.json();
        const inGuild = info.guild_id === guildId;
        const isDm = info.type === 1 && request.method === 'POST' && /\/messages$/.test(path);
        if (!inGuild && !isDm) return json({ message: "Ce salon n'appartient pas à ce serveur" }, 403, origin);
      }
    }

    // --- Transfert vers Discord avec le token du bot ---
    const headers = { Authorization: `Bot ${BOT_TOKEN}` };
    const ct = request.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;
    const reason = request.headers.get('X-Audit-Log-Reason');
    if (reason) headers['X-Audit-Log-Reason'] = reason;

    const hasBody = !['GET', 'DELETE'].includes(request.method) || false;
    const res = await fetch(`${DISCORD}${path}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined
    });

    return new Response(res.status === 204 ? null : await res.text(), {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', ...cors(origin) }
    });
  }
};
