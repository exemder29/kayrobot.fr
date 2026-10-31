# Brancher le site et le bot (à faire une seule fois)

Le site ne peut pas écrire dans les fichiers du bot. Le Worker Cloudflare sert donc de boîte aux lettres :
- la **config des tickets** y est stockée, le site et le bot la lisent et l'écrivent tous les deux ;
- les **tâches** du dashboard (avertissements, messages programmés, rappel de bump, apparence) y sont déposées, le bot les récupère et les exécute avec ses propres fichiers.

## 1. Worker Cloudflare

1. Workers & Pages > KV > **Create namespace** (nom : `kayrobot-config`).
2. Ton Worker > Settings > Bindings > **Add > KV namespace** : variable `CONFIG`, namespace `kayrobot-config`.
3. Ton Worker > Settings > Variables and Secrets > ajoute un secret `BOT_API_KEY` (longue chaîne aléatoire, la même que celle du bot).
4. Remplace le code du Worker par le nouveau `worker.js`, puis **Deploy**.

## 2. Bot

1. Remplace ton `index.js` par celui fourni (seule la synchronisation a été ajoutée, le reste est identique).
2. Dans le `.env` du bot, ajoute :

```
SYNC_URL=https://kayrobot-proxy.exem029.workers.dev
BOT_API_KEY=la-meme-cle-que-sur-le-worker
```

3. Redémarre le bot. Il affiche `[Sync] Activée` au démarrage. Sans ces deux lignes, il fonctionne comme avant.

## 3. Site

Remplace les fichiers du dépôt par ceux du zip, puis recharge la page avec Ctrl+F5 (le navigateur garde les anciens fichiers en cache).

## Comment ça marche

- Tickets : le bot lit la config du site toutes les 30 s ; quand tu fais `/ticket config`, `/ticket questions` ou `/ticket option-*` dans Discord, il l'envoie au site tout de suite. Au premier démarrage, la config déjà présente dans `tickets.json` est envoyée au site.
- Tâches : le bot interroge le Worker toutes les 4 s. Le dashboard attend sa réponse (quelques secondes) et l'affiche.
- Limites du plan gratuit de Cloudflare KV : 100 000 lectures et 1 000 écritures par jour. L'interrogation toutes les 4 s fait environ 21 600 lectures par jour, et la synchro des tickets 2 880 lectures par jour et par serveur. Au-delà d'une vingtaine de serveurs, passe au plan payant ou espace davantage les intervalles dans `startSync`.

## Pas sur le site

`/serveur` et `/serveur-annuler` restent à lancer dans Discord (création et suppression de toute la structure du serveur), ainsi que `/aide` et `/aide-plus`.

## Support (formulaire « Contacter le support »)

Le bouton « Contacter le support » au bas de la section Aide mène à la page `/support`, dont le formulaire envoie le message au Worker (route `/support`), qui le range dans le même KV `CONFIG`. Il suffit de redéployer le nouveau `worker.js` : rien d'autre à configurer.

- Les messages se lisent et se suppriment sur la page `/admin-support`, accessible depuis l'espace admin (`/admin`) après saisie du code administrateur.
- Le Worker vérifie ce code lui-même, en le comparant à celui de Firestore (`admin/config`). Tu peux aussi ajouter un secret `ADMIN_CODE` sur le Worker, qui sera alors utilisé à la place.
- Un message est supprimé automatiquement au bout de 90 jours. Un visiteur ne peut en envoyer qu'un par minute.
- Coût KV : 2 écritures par message envoyé, et 1 lecture par message affiché à chaque ouverture ou actualisation de la liste (100 messages au maximum).
