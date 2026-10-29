// KayRobot proxy (Cloudflare Worker)
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
  [['PUT'], /^\/guilds\/(\d+)\/bans\/\d+$/, 'guild'],
  [['PATCH', 'DELETE'], /^\/guilds\/(\d+)\/members\/\d+$/, 'guild'],
  [['POST'], /^\/guilds\/(\d+)\/roles$/, 'guild'],
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

export default {
  async fetch(request, env) {
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
