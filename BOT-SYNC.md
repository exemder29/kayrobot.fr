# Config des tickets partagée entre le site et le bot

Le site ne peut pas écrire dans les fichiers de ton bot. La config des tickets est donc
stockée dans le Worker Cloudflare (KV), et le bot la lit et l'écrit via deux routes.

## 1. Activer le stockage sur le Worker (une seule fois)

1. Cloudflare > Workers & Pages > KV > **Create namespace** (nom : `kayrobot-config`).
2. Ton Worker > Settings > Bindings > **Add > KV namespace** : variable `CONFIG`, namespace `kayrobot-config`.
3. Ton Worker > Settings > Variables and Secrets > ajoute un secret `BOT_API_KEY` (une longue chaîne aléatoire).
4. Colle le nouveau `worker.js` dans le Worker et déploie.

## 2. Routes pour le bot (en-tête `X-Bot-Key: <BOT_API_KEY>`)

- `GET  https://kayrobot-proxy.exem029.workers.dev/bot/config/<guildId>/tickets` : renvoie le JSON, ou 404 si rien n'est configuré.
- `PUT  https://kayrobot-proxy.exem029.workers.dev/bot/config/<guildId>/tickets` : enregistre le JSON.

Format :

```json
{
  "requestChannelId": "123...",
  "staffRoleId": "123...",
  "categoryId": "123...",
  "questions": ["Quel est ton pseudo ?"],
  "options": ["Support", "Partenariat"]
}
```

## 3. Ce que le bot doit changer

- Le bouton / formulaire de ticket : lire la config avec le `GET` (cache de 30 à 60 s conseillé) au lieu de son fichier local.
- `/ticket config`, `/ticket questions`, `/ticket option-ajouter`, `/ticket option-retirer` : faire un `GET`, modifier le champ, puis un `PUT`.
  Ainsi, une modification faite sur le site ou dans Discord est vue des deux côtés.

Exemple Python (discord.py) :

```python
import aiohttp
BASE = "https://kayrobot-proxy.exem029.workers.dev/bot/config"
HEAD = {"X-Bot-Key": BOT_API_KEY}

async def get_ticket_cfg(guild_id):
    async with aiohttp.ClientSession() as s:
        async with s.get(f"{BASE}/{guild_id}/tickets", headers=HEAD) as r:
            return await r.json() if r.status == 200 else None

async def set_ticket_cfg(guild_id, cfg):
    async with aiohttp.ClientSession() as s:
        async with s.put(f"{BASE}/{guild_id}/tickets", headers=HEAD, json=cfg) as r:
            return await r.json()
```

Exemple JavaScript (discord.js, Node 18+) :

```js
const BASE = 'https://kayrobot-proxy.exem029.workers.dev/bot/config';
const HEAD = { 'X-Bot-Key': process.env.BOT_API_KEY, 'Content-Type': 'application/json' };

async function getTicketCfg(guildId) {
  const r = await fetch(`${BASE}/${guildId}/tickets`, { headers: HEAD });
  return r.ok ? r.json() : null;
}
async function setTicketCfg(guildId, cfg) {
  const r = await fetch(`${BASE}/${guildId}/tickets`, { method: 'PUT', headers: HEAD, body: JSON.stringify(cfg) });
  return r.json();
}
```

Garde `BOT_API_KEY` dans les variables d'environnement du bot, jamais dans le code du site.
