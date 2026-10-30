// worker.js - Proxy Cloudflare Worker pour KayroBot (Production / Test)
const ALLOWED_ORIGINS = [
  'https://exemder29.github.io',
  'https://kayrobot.fr',
  'https://www.kayrobot.fr'
];
const DISCORD = 'https://discord.com/api/v10';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
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

let botGuildsCache = { exp: 0, ids: new Set() };

async function getBotGuildIds(botToken) {
  if (botGuildsCache.exp > Date.now()) return botGuildsCache.ids;
  const ids = new Set();
  let after = '';
  for (let i = 0; i < 10; i++) {
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

const guildListCache = new Map();
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    // Récupération stricte de la variable d'environnement BOT_TOKEN configurée dans Cloudflare
    const BOT_TOKEN = (env.BOT_TOKEN || '').trim().replace(/^Bot\s+/i, '');
    if (!BOT_TOKEN) return json({ message: 'BOT_TOKEN manquant dans les variables Cloudflare' }, 500, origin);

    const url = new URL(request.url);

    // Route de diagnostic /__check appelée par le dashboard pour valider le token du bot
    if (url.pathname === '/__check') {
      try {
        const discRes = await fetch(`${DISCORD}/users/@me`, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        const discData = discRes.ok ? await discRes.json() : null;
        const parts = BOT_TOKEN.split('.');
        let idFromToken = '';
        try {
          if (parts[0]) idFromToken = atob(parts[0].padEnd(Math.ceil(parts[0].length / 4) * 4, '='));
        } catch (e) {}

        return json({
          discordStatus: discRes.status,
          discordMessage: discRes.ok ? 'OK' : (discData?.message || discRes.statusText),
          nomDuBot: discData ? discData.username : 'Inconnu',
          longueur: BOT_TOKEN.length,
          morceaux: parts.length,
          longueurs: parts.map(p => p.length),
          idDansLeToken: idFromToken
        }, 200, origin);
      } catch (e) {
        return json({ discordStatus: 500, discordMessage: e.message }, 200, origin);
      }
    }

    // Route de statistiques globales /__stats
    if (url.pathname === '/__stats') {
      try {
        const discRes = await fetch(`${DISCORD}/users/@me`, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        if (!discRes.ok) return json({ ok: false }, 200, origin);
        const botIds = await getBotGuildIds(BOT_TOKEN);
        return json({ ok: true, serveurs: botIds.size }, 200, origin);
      } catch (e) {
        return json({ ok: false }, 200, origin);
      }
    }

    // Route de vérification de présence du bot sur les serveurs de l'utilisateur
    if (url.pathname === '/__presence') {
      const userTok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!userTok) return json({ message: 'Non connecté' }, 401, origin);
      try {
        const [mine, botIds] = await Promise.all([getUserAdminGuilds(userTok), getBotGuildIds(BOT_TOKEN)]);
        if (!mine) return json({ message: 'Session invalide' }, 401, origin);
        
        return json({ present: mine.filter(g => botIds.has(g.id)).map(g => g.id) }, 200, origin);
      } catch (e) {
        return json({ message: `Erreur: ${e.message}` }, 502, origin);
      }
    }

    return json({ message: 'Route non trouvée' }, 404, origin);
  }
};
