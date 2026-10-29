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

const adminCache = new Map(); // "token:guildId" -> expiration

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

async function isGuildAdmin(userToken, guildId) {
  const key = `${userToken}:${guildId}`;
  const exp = adminCache.get(key);
  if (exp && exp > Date.now()) return true;

  const res = await fetch(`${DISCORD}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  if (!res.ok) return false;
  const guilds = await res.json();
  const g = guilds.find(x => x.id === guildId);
  const ok = !!g && (g.owner || (BigInt(g.permissions) & 8n) === 8n);
  if (ok) adminCache.set(key, Date.now() + 60_000);
  return ok;
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
    if (!env.BOT_TOKEN) {
      return json({ message: 'BOT_TOKEN non configuré sur le Worker' }, 500, origin);
    }

    const url = new URL(request.url);
    const path = url.pathname;
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
          headers: { Authorization: `Bot ${env.BOT_TOKEN}` }
        });
        if (!ch.ok) return json({ message: 'Salon introuvable pour le bot' }, ch.status, origin);
        const info = await ch.json();
        const inGuild = info.guild_id === guildId;
        const isDm = info.type === 1 && request.method === 'POST' && /\/messages$/.test(path);
        if (!inGuild && !isDm) return json({ message: "Ce salon n'appartient pas à ce serveur" }, 403, origin);
      }
    }

    // --- Transfert vers Discord avec le token du bot ---
    const headers = { Authorization: `Bot ${env.BOT_TOKEN}` };
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
