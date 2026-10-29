require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActivityType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  time,
} = require('discord.js');

// Plusieurs bots depuis ce même dossier : DISCORD_TOKEN, DISCORD_TOKEN_2, DISCORD_TOKEN_3, DISCORD_TOKEN_4...
const TOKENS = [
  process.env.DISCORD_TOKEN,
  ...Object.keys(process.env)
    .filter((k) => /^DISCORD_TOKEN_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_')[2]) - Number(b.split('_')[2]))
    .map((k) => process.env[k]),
].filter(Boolean);
// IDs des "boss" qui ont accès à TOUTES les commandes, quel que soit leur rôle.
// Mets ton ID Discord ici (clic droit sur ton pseudo > Copier l'ID, mode développeur activé).
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
const isOwner = (userId) => OWNER_IDS.includes(userId);
// Commandes "ouvertes" : Discord ne les cache plus selon les permissions, la vérification se fait dans le code.
// Les boss (OWNER_IDS) y ont accès sans être admin ; les autres doivent avoir la permission indiquée ici.
const OPEN_COMMANDS = new Map([
  ['say', PermissionFlagsBits.ManageMessages],
  ['apparence', PermissionFlagsBits.ManageMessages],
  ['embed', PermissionFlagsBits.ManageMessages],
  ['programmer', PermissionFlagsBits.ManageMessages],
  ['programmations', PermissionFlagsBits.ManageMessages],
  ['annuler-programmation', PermissionFlagsBits.ManageMessages],
  ['bump-auto', PermissionFlagsBits.ManageMessages],
  ['role', PermissionFlagsBits.ManageRoles],
  ['ticket', PermissionFlagsBits.ManageChannels],
  ['serveur', PermissionFlagsBits.Administrator],
  ['serveur-annuler', PermissionFlagsBits.Administrator],
  ['deconnecter', PermissionFlagsBits.MoveMembers],
  ['deplacer', PermissionFlagsBits.MoveMembers],
]);
// Sous-commandes accessibles à tout le monde (même si la commande parente est restreinte)
const PUBLIC_SUBCOMMANDS = new Set(['role:voir']);
const AUTO_TIMEOUT_WARNS = 3; // avertissements avant sourdine automatique d'1h
const WARNS_FILE = './warns.json';

// ------------------------------------------------------------ Stockage
const loadWarns = () => (fs.existsSync(WARNS_FILE) ? JSON.parse(fs.readFileSync(WARNS_FILE, 'utf8')) : {});
const saveWarns = (data) => fs.writeFileSync(WARNS_FILE, JSON.stringify(data, null, 2));

// ------------------------------------------------------------ Utilitaires
const EPH = MessageFlags.Ephemeral;

function canModerate(interaction, target) {
  if (isOwner(interaction.user.id)) return null;
  if (target.id === interaction.user.id) return 'Tu ne peux pas te sanctionner toi-même.';
  if (target.id === interaction.guild.ownerId) return 'Tu ne peux pas sanctionner le propriétaire.';
  if (target.id === interaction.client.user.id) return 'Je ne vais pas me sanctionner moi-même 😅';
  if (
    interaction.user.id !== interaction.guild.ownerId &&
    target.roles.highest.position >= interaction.member.roles.highest.position
  )
    return 'Ce membre a un rôle égal ou supérieur au tien.';
  if (target.roles.highest.position >= interaction.guild.members.me.roles.highest.position)
    return 'Ce membre a un rôle égal ou supérieur au mien. Monte mon rôle dans la liste.';
  return null;
}

function modEmbed(title, color, target, moderator, reason) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Membre', value: `${target.tag ?? target.user?.tag} (\`${target.id}\`)` },
      { name: 'Modérateur', value: `${moderator}` },
      { name: 'Raison', value: reason || 'Aucune raison fournie' },
    )
    .setTimestamp();
}

const tryDM = (user, text) => user.send(text).catch(() => {});


// ------------------------------------------------------------ Messages programmés
const SCHEDULE_FILE = './programmes.json';
const loadSchedule = () => (fs.existsSync(SCHEDULE_FILE) ? JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) : []);
const saveSchedule = (list) => fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(list, null, 2));

// Décalage (en ms) entre l'heure de Paris et UTC à un instant donné
function parisOffset(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts;
}

// Convertit une date/heure saisie à l'heure de Paris en timestamp réel
function parisToTimestamp(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - parisOffset(guess);
  ts = guess - parisOffset(ts); // 2e passe pour les changements d'heure
  return ts;
}

async function runSchedule(botClient) {
  const now = Date.now();
  const mine = (m) => (m.botId ? m.botId === botClient.user.id : botClient.guilds.cache.has(m.guildId));
  const due = loadSchedule().filter((m) => m.timestamp <= now && mine(m));
  if (!due.length) return;
  for (const item of due) {
    try {
      const channel = await botClient.channels.fetch(item.channelId);
      await sendAs(botClient, channel, { content: item.content, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error(`Message programmé ${item.id} impossible à envoyer :`, err.message);
    }
  }
  const doneIds = new Set(due.map((m) => m.id));
  saveSchedule(loadSchedule().filter((m) => !doneIds.has(m.id)));
}

// ------------------------------------------------------------ Mémoire de /serveur (pour pouvoir l'annuler)
const SERVEUR_FILE = './serveur.json';
const loadServeur = () => {
  try { return fs.existsSync(SERVEUR_FILE) ? JSON.parse(fs.readFileSync(SERVEUR_FILE, 'utf8')) : {}; } catch { return {}; }
};
const saveServeur = (data) => fs.writeFileSync(SERVEUR_FILE, JSON.stringify(data, null, 2));

// ------------------------------------------------------------ Rappel de bump automatique
const BUMP_FILE = './bump.json';
const BUMP_INTERVAL = 2 * 60 * 60 * 1000; // toutes les 2 heures
const loadBump = () => {
  try { return fs.existsSync(BUMP_FILE) ? JSON.parse(fs.readFileSync(BUMP_FILE, 'utf8')) : {}; } catch { return {}; }
};
const saveBump = (data) => fs.writeFileSync(BUMP_FILE, JSON.stringify(data, null, 2));

async function runBump(botClient) {
  const data = loadBump();
  const now = Date.now();
  let changed = false;
  for (const [guildId, cfg] of Object.entries(data)) {
    if (cfg.botId !== botClient.user.id || cfg.next > now) continue;
    // on avance l'horaire d'abord pour ne jamais envoyer en double
    cfg.next = now + BUMP_INTERVAL;
    changed = true;
    try {
      const channel = await botClient.channels.fetch(cfg.channelId);
      await sendAs(botClient, channel, {
        content: `${cfg.roleId ? `<@&${cfg.roleId}> ` : ''}⏰ **Il faut faire un bump !** Lance \`/bump\` avec tes bots de bump.`,
        allowedMentions: cfg.roleId ? { roles: [cfg.roleId] } : { parse: [] },
      });
    } catch (err) {
      console.error(`Rappel de bump impossible (serveur ${guildId}) :`, err.message);
    }
  }
  if (changed) saveBump(data);
}


// ------------------------------------------------------------ Apparence du bot (nom + photo via webhook)
// On ne touche PAS au vrai profil du bot : ses messages sont envoyés via un webhook avec un autre nom / une autre photo.
// Résultat : dans la liste des membres, le bot reste le même ; dans les salons, ses messages ont la nouvelle apparence (avec le badge APP).
const APPARENCE_FILE = './apparence.json';
const APPARENCE_DIR = './apparence-images';
const loadApparence = () => {
  try { return fs.existsSync(APPARENCE_FILE) ? JSON.parse(fs.readFileSync(APPARENCE_FILE, 'utf8')) : {}; } catch { return {}; }
};
const saveApparence = (data) => fs.writeFileSync(APPARENCE_FILE, JSON.stringify(data, null, 2));
const apparenceKey = (botId, guildId) => `${botId}:${guildId}`;
const webhookCache = new Map(); // channelId -> { webhook, version }

async function getAppearanceWebhook(botClient, channel, look) {
  if (!channel.guild || typeof channel.fetchWebhooks !== 'function') return null;
  let entry = webhookCache.get(channel.id);
  if (!entry) {
    const hooks = await channel.fetchWebhooks();
    let webhook = hooks.find((w) => w.owner?.id === botClient.user.id && w.token);
    if (!webhook) webhook = await channel.createWebhook({ name: look.name || botClient.user.username });
    entry = { webhook, version: null };
    webhookCache.set(channel.id, entry);
  }
  if (entry.version !== look.version) {
    const imgPath = look.image ? `${APPARENCE_DIR}/${look.image}` : null;
    const avatar = imgPath && fs.existsSync(imgPath) ? fs.readFileSync(imgPath) : botClient.user.displayAvatarURL({ extension: 'png', size: 512 });
    entry.webhook = await entry.webhook.edit({ name: look.name || botClient.user.username, avatar });
    entry.version = look.version;
  }
  return entry.webhook;
}

// Envoie un message avec l'apparence choisie (si /apparence a été utilisé), sinon comme d'habitude
async function sendAs(botClient, channel, payload) {
  const look = loadApparence()[apparenceKey(botClient.user.id, channel.guildId)];
  if (look) {
    try {
      const webhook = await getAppearanceWebhook(botClient, channel, look);
      if (webhook) return await webhook.send(payload);
    } catch (err) {
      webhookCache.delete(channel.id);
      console.error(`Apparence impossible dans #${channel.name ?? channel.id} (envoi normal à la place) :`, err.message);
    }
  }
  return channel.send(payload);
}

// Modifie un message du bot, qu'il ait été envoyé normalement ou via le webhook d'apparence
async function editAs(message, payload) {
  if (message.webhookId) {
    const webhook = await message.fetchWebhook();
    return webhook.editMessage(message.id, payload);
  }
  return message.edit(payload);
}

// ------------------------------------------------------------ Rôles
const parseHex = (s, def = '5865f2') => {
  const h = (s ?? def).replace('#', '');
  return /^[0-9a-fA-F]{6}$/.test(h) ? parseInt(h, 16) : null;
};

// Vérifie qu'un rôle peut être attribué / retiré (par le bot ET par la personne qui lance la commande)
function checkRole(i, role) {
  if (role.id === i.guildId) return 'Tu ne peux pas utiliser le rôle @everyone.';
  if (role.managed) return "Ce rôle est géré par une intégration (bot) : impossible de l'attribuer à la main.";
  if (role.position >= i.guild.members.me.roles.highest.position)
    return 'Ce rôle est égal ou supérieur au mien. Monte mon rôle dans la liste (Paramètres du serveur → Rôles).';
  if (!isOwner(i.user.id) && i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position)
    return 'Ce rôle est égal ou supérieur au tien.';
  return null;
}

function checkRoleChange(i, member, role) {
  const err = checkRole(i, role);
  if (err) return err;
  if (!member.manageable)
    return "Je ne peux pas modifier les rôles de ce membre (son plus haut rôle est au-dessus du mien, ou c'est le propriétaire).";
  if (
    !isOwner(i.user.id) &&
    i.user.id !== i.guild.ownerId &&
    member.id !== i.user.id &&
    member.roles.highest.position >= i.member.roles.highest.position
  )
    return 'Ce membre a un rôle égal ou supérieur au tien.';
  return null;
}

// Position d'un rôle : 1 = tout en haut (juste sous mon rôle, ou sous le rôle le plus haut de la personne),
// plus le nombre est grand, plus le rôle descend. Si c'est trop haut, il est placé au plus haut possible.
function targetPosition(i, rank, bypass) {
  const botTop = i.guild.members.me.roles.highest.position;
  const userTop = bypass || i.user.id === i.guild.ownerId ? Infinity : i.member.roles.highest.position;
  const maxPos = Math.min(botTop, userTop) - 1;
  return { target: Math.max(1, maxPos - (rank - 1)), maxPos };
}

// Personne ne peut donner une permission qu'il n'a pas lui-même (sauf admin / propriétaire du bot)
function missingPerms(i, perms, bypass) {
  if (bypass || i.memberPermissions.has(PermissionFlagsBits.Administrator)) return [];
  return perms.filter((p) => !i.memberPermissions.has(p.bit));
}

// Un rôle peut-il être modifié par le bot ET par la personne ?
function checkRoleManage(i, role, bypass) {
  if (role.id === i.guildId) return 'Tu ne peux pas modifier le rôle @everyone.';
  if (role.managed) return "Ce rôle est géré par une intégration (bot) : impossible de le modifier à la main.";
  if (role.position >= i.guild.members.me.roles.highest.position)
    return 'Ce rôle est égal ou supérieur au mien. Monte mon rôle dans la liste (Paramètres du serveur → Rôles).';
  if (!bypass && i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position)
    return 'Ce rôle est égal ou supérieur au tien.';
  return null;
}

// ------------------------------------------------------------ Tickets
const TICKETS_FILE = './tickets.json';
const loadTickets = () => (fs.existsSync(TICKETS_FILE) ? JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8')) : {});
const saveTickets = (data) => fs.writeFileSync(TICKETS_FILE, JSON.stringify(data, null, 2));
const defaultTicketConf = () => ({
  options: [],
  staffRoleId: null,
  categoryId: null,
  requestChannelId: null, // salon réservé au staff où arrivent les demandes
  questions: ['Pourquoi veux-tu ouvrir un ticket ?'], // questions du formulaire (5 max, 45 caractères max chacune)
  pending: {}, // demandes en attente : { idMembre: timestamp }
  pendingMsgs: {}, // message de la demande côté staff : { idMembre: { channelId, messageId } }
});
const ticketConf = (guildId) => ({ ...defaultTicketConf(), ...loadTickets()[guildId] });
function updateTicketConf(guildId, fn) {
  const data = loadTickets();
  data[guildId] = { ...defaultTicketConf(), ...data[guildId] };
  const before = syncedFields(data[guildId]);
  fn(data[guildId]);
  saveTickets(data);
  // si la config (salon, rôle, catégorie, questions, options) a changé, on prévient le site
  if (SYNC_ON && syncedFields(data[guildId]) !== before) pushTicketConf(guildId).catch((e) => console.error('Sync tickets :', e.message));
  return data[guildId];
}


// ------------------------------------------------------------ Synchronisation avec le site (Worker Cloudflare)
// Active si SYNC_URL et BOT_API_KEY sont dans le .env. Sans eux, le bot fonctionne comme avant.
const SYNC_URL = (process.env.SYNC_URL || '').replace(/\/$/, '');
const SYNC_KEY = process.env.BOT_API_KEY || '';
const SYNC_ON = !!(SYNC_URL && SYNC_KEY);
const syncFetch = (path, opts = {}) =>
  fetch(`${SYNC_URL}${path}`, {
    ...opts,
    headers: { 'X-Bot-Key': SYNC_KEY, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
const optionToText = (o) => (o.emoji ? `${o.emoji} ${o.label}` : o.label);
const syncedFields = (c) => JSON.stringify([c.requestChannelId, c.staffRoleId, c.categoryId, c.questions, c.options.map(optionToText)]);

async function pushTicketConf(guildId) {
  const c = ticketConf(guildId);
  const r = await syncFetch(`/bot/config/${guildId}/tickets`, {
    method: 'PUT',
    body: JSON.stringify({
      requestChannelId: c.requestChannelId || '',
      staffRoleId: c.staffRoleId || '',
      categoryId: c.categoryId || '',
      questions: c.questions,
      options: c.options.map(optionToText),
    }),
  });
  if (!r.ok) throw new Error(`Worker ${r.status}`);
  const doc = await r.json();
  const data = loadTickets();
  data[guildId] = { ...defaultTicketConf(), ...data[guildId], syncedAt: doc.updatedAt };
  saveTickets(data);
}

// Applique une config venue du site (sans la renvoyer au site)
function applySiteTicketConf(guildId, doc) {
  const data = loadTickets();
  const cur = { ...defaultTicketConf(), ...data[guildId] };
  cur.requestChannelId = doc.requestChannelId || null;
  cur.staffRoleId = doc.staffRoleId || null;
  cur.categoryId = doc.categoryId || null;
  cur.questions = doc.questions?.length ? doc.questions : defaultTicketConf().questions;
  const old = new Map(cur.options.map((o) => [o.id, o]));
  const seen = new Set();
  cur.options = [];
  for (const raw of doc.options ?? []) {
    const it = parseOptionItem(raw);
    const id = slug(it.label).slice(0, 80);
    if (!it.label || seen.has(id) || cur.options.length >= 25) continue;
    seen.add(id);
    cur.options.push({ id, label: it.label, description: old.get(id)?.description ?? null, emoji: it.emoji });
  }
  cur.syncedAt = doc.updatedAt;
  data[guildId] = cur;
  saveTickets(data);
}

async function pullTicketConfs(botClient) {
  for (const guildId of botClient.guilds.cache.keys()) {
    try {
      const r = await syncFetch(`/bot/config/${guildId}/tickets`);
      if (r.status === 404) {
        // rien côté site : on y envoie la config qui existe déjà dans tickets.json
        const c = loadTickets()[guildId];
        if (c && (c.requestChannelId || c.staffRoleId || c.categoryId || c.options?.length)) await pushTicketConf(guildId);
        continue;
      }
      if (!r.ok) continue;
      const doc = await r.json();
      if (doc.updatedAt > (ticketConf(guildId).syncedAt || 0)) applySiteTicketConf(guildId, doc);
    } catch (err) {
      console.error(`Sync tickets (${guildId}) :`, err.message);
    }
  }
}

// Tâches demandées depuis le dashboard : le bot les exécute avec ses propres fichiers
const handledJobs = new Set();
const fr = (ts) => new Date(ts).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
const isId = (v) => typeof v === 'string' && /^\d{15,25}$/.test(v);

async function runSiteJob(botClient, job) {
  const guild = botClient.guilds.cache.get(job.guildId);
  const a = job.args ?? {};
  const fail = (message) => ({ ok: false, message });
  const done = (message) => ({ ok: true, message });

  switch (job.type) {
    case 'avertir': {
      if (!isId(a.userId) || !a.reason) return fail('Membre ou raison manquants.');
      const member = await guild.members.fetch(a.userId).catch(() => null);
      if (!member) return fail('Membre introuvable sur le serveur.');
      if (member.id === guild.ownerId) return fail('Tu ne peux pas avertir le propriétaire.');
      if (member.id === botClient.user.id) return fail('Je ne vais pas m\'avertir moi-même 😅');
      if (member.roles.highest.position >= guild.members.me.roles.highest.position)
        return fail('Ce membre a un rôle égal ou supérieur au mien. Monte mon rôle dans la liste.');
      const reason = String(a.reason).slice(0, 500);
      const data = loadWarns();
      data[guild.id] ??= {};
      data[guild.id][member.id] ??= [];
      data[guild.id][member.id].push({ raison: reason, moderateur: isId(a.modId) ? a.modId : botClient.user.id, date: new Date().toLocaleString('fr-FR') });
      saveWarns(data);
      const total = data[guild.id][member.id].length;
      await tryDM(member.user, `⚠️ Tu as reçu un **avertissement** sur **${guild.name}**.\nRaison : ${reason}\nTotal : ${total}`);
      let msg = `Avertissement enregistré pour ${member.user.tag} (total : ${total}).`;
      if (total >= AUTO_TIMEOUT_WARNS && member.moderatable) {
        await member.timeout(3_600_000, `${total} avertissements`).catch(() => {});
        msg += ` Sourdine automatique d'1 heure (${total} avertissements).`;
      }
      return done(msg);
    }

    case 'avertissements': {
      if (!isId(a.userId)) return fail('ID de membre invalide.');
      const list = loadWarns()[guild.id]?.[a.userId] ?? [];
      if (!list.length) return done("Ce membre n'a aucun avertissement.");
      return done(list.slice(-10).map((w, n) => `#${n + 1} • ${w.date} : ${w.raison}`).join('\n'));
    }

    case 'effacer-avertissements': {
      if (!isId(a.userId)) return fail('ID de membre invalide.');
      const data = loadWarns();
      if (data[guild.id]) delete data[guild.id][a.userId];
      saveWarns(data);
      return done('Avertissements effacés.');
    }

    case 'programmer': {
      const message = String(a.content ?? '').replaceAll('\\n', '\n');
      if (!message) return fail('Message vide.');
      if (message.length > 2000) return fail('Message trop long (2000 caractères max).');
      const channel = guild.channels.cache.get(a.channelId);
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return fail('Salon invalide.');
      const d = String(a.date ?? '').trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
      const h = String(a.time ?? '').trim().replace('h', ':').match(/^(\d{1,2}):(\d{2})$/);
      if (!d || !h) return fail('Format invalide : date JJ/MM/AAAA et heure HH:MM.');
      const [day, month, year] = [+d[1], +d[2], +d[3]];
      const [hour, minute] = [+h[1], +h[2]];
      const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
      if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59)
        return fail("Cette date ou cette heure n'existe pas.");
      const timestamp = parisToTimestamp(year, month, day, hour, minute);
      if (timestamp <= Date.now()) return fail('Cette date est déjà passée.');
      const list = loadSchedule();
      const id = Date.now().toString(36);
      list.push({ id, botId: botClient.user.id, guildId: guild.id, channelId: channel.id, content: message, timestamp, authorId: isId(a.modId) ? a.modId : botClient.user.id });
      saveSchedule(list);
      return done(`Message programmé dans #${channel.name} pour le ${fr(timestamp)} (heure de Paris). ID : ${id}`);
    }

    case 'programmations': {
      const list = loadSchedule().filter((m) => m.guildId === guild.id).sort((x, y) => x.timestamp - y.timestamp);
      if (!list.length) return done('Aucun message programmé.');
      return done(list.slice(0, 15).map((m) => `${m.id} • ${fr(m.timestamp)} • #${guild.channels.cache.get(m.channelId)?.name ?? '?'} : ${m.content.slice(0, 80)}`).join('\n'));
    }

    case 'annuler-programmation': {
      const id = String(a.id ?? '').trim();
      const list = loadSchedule();
      const found = list.find((m) => m.id === id && m.guildId === guild.id);
      if (!found) return fail('Aucun message programmé avec cet ID.');
      saveSchedule(list.filter((m) => m !== found));
      return done(`Message programmé ${id} annulé.`);
    }

    case 'bump-activer': {
      const channel = guild.channels.cache.get(a.channelId);
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return fail('Salon invalide.');
      const perms = channel.permissionsFor(guild.members.me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) return fail(`Je ne peux pas écrire dans #${channel.name}.`);
      const role = isId(a.roleId) ? guild.roles.cache.get(a.roleId) : null;
      const data = loadBump();
      data[guild.id] = { botId: botClient.user.id, channelId: channel.id, roleId: role?.id ?? null, next: Date.now() + BUMP_INTERVAL };
      saveBump(data);
      return done(`Rappel de bump activé dans #${channel.name}${role ? ` (mention de @${role.name})` : ''}. Premier rappel à ${fr(data[guild.id].next)}.`);
    }

    case 'bump-desactiver': {
      const data = loadBump();
      if (!data[guild.id]) return fail("Le rappel n'est pas activé.");
      delete data[guild.id];
      saveBump(data);
      return done('Rappel de bump arrêté.');
    }

    case 'bump-statut': {
      const cfg = loadBump()[guild.id];
      if (!cfg) return done("Le rappel de bump n'est pas activé.");
      return done(`Rappel actif dans #${guild.channels.cache.get(cfg.channelId)?.name ?? '?'}. Prochain rappel : ${fr(cfg.next)}.`);
    }

    case 'apparence': {
      const key = apparenceKey(botClient.user.id, guild.id);
      const data = loadApparence();
      if (a.reset) {
        delete data[key];
        saveApparence(data);
        for (const [id, entry] of webhookCache) if (entry.webhook.guildId === guild.id) webhookCache.delete(id);
        return done('Apparence réinitialisée : le bot reprend son nom et sa photo de base.');
      }
      const nom = String(a.name ?? '').trim().slice(0, 80);
      const url = String(a.imageUrl ?? '').trim();
      if (!nom && !url) return fail('Indique un nom, une URL de photo, ou réinitialiser.');
      if (nom && /discord|clyde/i.test(nom)) return fail('Discord interdit les noms contenant « discord » ou « clyde ».');
      const look = data[key] ?? {};
      if (nom) look.name = nom;
      if (url) {
        if (!/^https:\/\//i.test(url)) return fail("L'URL de la photo doit commencer par https://");
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
        if (!res?.ok) return fail('Impossible de télécharger cette image.');
        if (!res.headers.get('content-type')?.startsWith('image/')) return fail("Le lien n'est pas une image.");
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) return fail('Image trop lourde (8 Mo maximum).');
        fs.mkdirSync(APPARENCE_DIR, { recursive: true });
        look.image = `${botClient.user.id}-${guild.id}`;
        fs.writeFileSync(`${APPARENCE_DIR}/${look.image}`, buf);
      }
      look.version = Date.now();
      data[key] = look;
      saveApparence(data);
      return done(`Apparence enregistrée${look.name ? ` : ${look.name}` : ''}${url ? ' + photo' : ''}. (Le bot a besoin de la permission « Gérer les webhooks ».)`);
    }

    default:
      return fail(`Tâche inconnue : ${job.type}`);
  }
}

async function pollJobs(botClient) {
  const r = await syncFetch('/bot/jobs');
  if (!r.ok) return;
  for (const job of await r.json()) {
    if (handledJobs.has(job.id) || !botClient.guilds.cache.has(job.guildId)) continue;
    handledJobs.add(job.id);
    if (handledJobs.size > 500) handledJobs.delete(handledJobs.values().next().value);
    let res;
    try {
      res = await runSiteJob(botClient, job);
    } catch (err) {
      console.error(`Tâche ${job.type} :`, err);
      res = { ok: false, message: err.message };
    }
    await syncFetch(`/bot/jobs/${job.id}/result`, { method: 'POST', body: JSON.stringify(res) }).catch(() => {});
  }
}

function startSync(botClient) {
  if (!SYNC_ON) return console.log('[Sync] Désactivée (SYNC_URL / BOT_API_KEY absents du .env).');
  let pulling = false;
  let polling = false;
  const pull = async () => { if (pulling) return; pulling = true; try { await pullTicketConfs(botClient); } finally { pulling = false; } };
  const poll = async () => { if (polling) return; polling = true; try { await pollJobs(botClient); } catch (e) { console.error('Sync tâches :', e.message); } finally { polling = false; } };
  pull();
  setInterval(pull, 30_000);
  setInterval(poll, 4_000);
  console.log('[Sync] Activée : config des tickets et tâches du dashboard.');
}

const slug = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';

// Emoji unicode ("🎫") ou personnalisé ("<:nom:123456>") -> objet attendu par Discord
function toEmoji(str) {
  const m = str.trim().match(/^<(a?):(\w+):(\d+)>$/);
  return m ? { id: m[3], name: m[2], animated: !!m[1] } : { name: str.trim() };
}

// Panneau : menu déroulant s'il y a des options, sinon simple bouton
function ticketPanelComponents(conf) {
  if (conf.options.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket:menu')
      .setPlaceholder('Choisis le type de ticket…')
      .addOptions(
        conf.options.map((o) => {
          const opt = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.id);
          if (o.description) opt.setDescription(o.description);
          if (o.emoji) opt.setEmoji(toEmoji(o.emoji));
          return opt;
        }),
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:open').setLabel('Créer un ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    ),
  ];
}

const TICKET_MEMBER_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

const isTicketStaff = (i, conf) =>
  isOwner(i.user.id) ||
  i.memberPermissions.has(PermissionFlagsBits.ManageChannels) ||
  Boolean(conf.staffRoleId && i.member.roles.cache.has(conf.staffRoleId));

const findOpenTicket = (guild, userId) => guild.channels.cache.find((c) => c.topic?.startsWith(`ticket:${userId}:`));

// Une demande en attente expire au bout de 24 h (au cas où le message du staff aurait été supprimé)
const PENDING_TTL = 24 * 3600 * 1000;
const isPending = (conf, userId) => Boolean(conf.pending[userId] && Date.now() - conf.pending[userId] < PENDING_TTL);

// Bouton « Annuler ma demande » (affiché en éphémère au membre)
const cancelRequestRow = (userId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:cancelreq:${userId}`).setLabel('Annuler ma demande').setEmoji('🚫').setStyle(ButtonStyle.Danger),
  );

const requestChannelOf = (guild, conf) => (conf.requestChannelId ? guild.channels.cache.get(conf.requestChannelId) : null);

// Cherche un emoji au début d'un nom : "🛠️ Aide" -> { emoji: "🛠️", label: "Aide" }
const EMOJI_LEAD = /^(<a?:\w+:\d+>|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*️?)\s*(.+)$/u;
function parseOptionItem(raw) {
  const t = raw.trim();
  const m = t.match(EMOJI_LEAD);
  return m ? { emoji: m[1], label: m[2].trim() } : { emoji: null, label: t };
}

// Crée le salon privé du ticket (appelé quand le staff accepte la demande)
async function createTicketChannel(guild, user, typeLabel, conf, botUser, answersEmbed) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: TICKET_MEMBER_PERMS },
    { id: botUser.id, allow: [...TICKET_MEMBER_PERMS, PermissionFlagsBits.ManageChannels] },
  ];
  const staffRole = conf.staffRoleId ? guild.roles.cache.get(conf.staffRoleId) : null;
  if (staffRole) overwrites.push({ id: staffRole.id, allow: TICKET_MEMBER_PERMS });

  const category = conf.categoryId ? guild.channels.cache.get(conf.categoryId) : null;
  const channel = await guild.channels.create({
    name: `${slug(typeLabel)}-${slug(user.username)}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: category?.type === ChannelType.GuildCategory ? category.id : null,
    topic: `ticket:${user.id}:${typeLabel}`,
    permissionOverwrites: overwrites,
    reason: `Ticket de ${user.tag}`,
  });

  const welcome = new EmbedBuilder()
    .setTitle(`🎫 Ticket — ${typeLabel}`)
    .setColor(0x5865f2)
    .setDescription(
      `Bienvenue ${user} !\nTa demande a été acceptée, un membre de l'équipe va te répondre ici.\nQuand c'est réglé, clique sur **Fermer le ticket**.`,
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
  const embeds = [welcome];
  if (answersEmbed) embeds.push(answersEmbed.setTitle('📋 Réponses du formulaire').setColor(0x5865f2));
  await sendAs(guild.client, channel, {
    content: `${user}${staffRole ? ` ${staffRole}` : ''}`,
    embeds,
    components: [row],
    allowedMentions: { users: [user.id], roles: staffRole ? [staffRole.id] : [] },
  });
  return channel;
}

// 1) Clic sur le bouton / le menu : on ouvre le formulaire de questions
async function startTicketRequest(i, optionId) {
  const conf = ticketConf(i.guildId);
  if (!requestChannelOf(i.guild, conf))
    return i.reply({
      content: "❌ Le système de tickets n'est pas encore configuré (salon des demandes manquant). Préviens un admin.",
      flags: EPH,
    });
  const opt = optionId ? conf.options.find((o) => o.id === optionId) : null;
  if (optionId && !opt)
    return i.reply({ content: "❌ Cette option n'existe plus. Demande à un admin de reposter le panneau.", flags: EPH });
  const existing = findOpenTicket(i.guild, i.user.id);
  if (existing) return i.reply({ content: `❌ Tu as déjà un ticket ouvert : ${existing}`, flags: EPH });
  if (isPending(conf, i.user.id))
    return i.reply({
      content: "⏳ Tu as déjà une demande en attente de réponse de l'équipe.\nTu t'es trompé(e) ? Tu peux l'annuler ci-dessous.",
      components: [cancelRequestRow(i.user.id)],
      flags: EPH,
    });

  const modal = new ModalBuilder()
    .setCustomId(`ticket:form:${opt?.id ?? '-'}`)
    .setTitle(`Ticket — ${opt?.label ?? 'Général'}`.slice(0, 45));
  conf.questions.slice(0, 5).forEach((q, idx) =>
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q${idx}`)
          .setLabel(q.slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    ),
  );
  await i.showModal(modal);
}

// 2) Formulaire envoyé : la demande part dans le salon du staff avec Accepter / Refuser
async function submitTicketRequest(i) {
  const optionId = i.customId.split(':')[2];
  const conf = ticketConf(i.guildId);
  const reqChannel = requestChannelOf(i.guild, conf);
  if (!reqChannel) return i.reply({ content: '❌ Le salon des demandes est introuvable. Préviens un admin.', flags: EPH });
  const opt = optionId !== '-' ? conf.options.find((o) => o.id === optionId) : null;
  const typeLabel = opt?.label ?? 'Général';

  const existing = findOpenTicket(i.guild, i.user.id);
  if (existing) return i.reply({ content: `❌ Tu as déjà un ticket ouvert : ${existing}`, flags: EPH });
  if (isPending(conf, i.user.id))
    return i.reply({
      content: "⏳ Tu as déjà une demande en attente de réponse de l'équipe.\nTu t'es trompé(e) ? Tu peux l'annuler ci-dessous.",
      components: [cancelRequestRow(i.user.id)],
      flags: EPH,
    });

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Demande de ticket — ${typeLabel}`)
    .setColor(0xfee75c)
    .setAuthor({ name: i.user.tag, iconURL: i.user.displayAvatarURL() })
    .addFields({ name: 'Membre', value: `${i.user} (\`${i.user.id}\`)` }, { name: 'Type', value: typeLabel })
    .setTimestamp();
  conf.questions.slice(0, 5).forEach((q, idx) => {
    let answer = '—';
    try {
      answer = i.fields.getTextInputValue(`q${idx}`).trim() || '—';
    } catch {}
    embed.addFields({ name: q.slice(0, 256), value: answer.slice(0, 1024) });
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:accept:${i.user.id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket:refuse:${i.user.id}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
  const staffRole = conf.staffRoleId ? i.guild.roles.cache.get(conf.staffRoleId) : null;
  const sent = await sendAs(i.client, reqChannel, {
    content: staffRole ? `${staffRole} nouvelle demande de ticket` : undefined,
    embeds: [embed],
    components: [row],
    allowedMentions: { roles: staffRole ? [staffRole.id] : [] },
  });
  updateTicketConf(i.guildId, (c) => {
    c.pending[i.user.id] = Date.now();
    c.pendingMsgs[i.user.id] = { channelId: sent.channelId ?? reqChannel.id, messageId: sent.id };
  });
  await i.reply({
    content:
      "✅ Ta demande a été envoyée à l'équipe. Tu seras prévenu(e) en message privé dès qu'elle sera traitée.\nEnvoyée par erreur ? Tu peux l'annuler ci-dessous.",
    components: [cancelRequestRow(i.user.id)],
    flags: EPH,
  });
}

// 3a) Le staff accepte : le salon privé est créé
async function acceptTicket(i) {
  const conf = ticketConf(i.guildId);
  if (!isTicketStaff(i, conf)) return i.reply({ content: "❌ Seule l'équipe peut traiter les demandes.", flags: EPH });
  const userId = i.customId.split(':')[2];
  await i.deferUpdate();

  const clearPending = () =>
    updateTicketConf(i.guildId, (c) => {
      delete c.pending[userId];
      delete c.pendingMsgs[userId];
    });
  const closeRequest = (color, status) => {
    clearPending();
    const embed = EmbedBuilder.from(i.message.embeds[0]).setColor(color).addFields({ name: 'Statut', value: status });
    return i.editReply({ embeds: [embed], components: [] });
  };

  const member = await i.guild.members.fetch(userId).catch(() => null);
  if (!member) return closeRequest(0x99aab5, '⚠️ Le membre a quitté le serveur.');
  const existing = findOpenTicket(i.guild, userId);
  if (existing) return closeRequest(0x99aab5, `ℹ️ Ce membre a déjà un ticket ouvert : ${existing}`);

  const typeLabel = i.message.embeds[0].fields.find((f) => f.name === 'Type')?.value ?? 'Général';
  const channel = await createTicketChannel(
    i.guild,
    member.user,
    typeLabel,
    conf,
    i.client.user,
    EmbedBuilder.from(i.message.embeds[0]),
  );
  await closeRequest(0x57f287, `✅ Accepté par ${i.user} → ${channel}`);
  tryDM(member.user, `✅ Ta demande de ticket sur **${i.guild.name}** a été acceptée : ${channel}`);
}

// 3b) Le staff refuse : on demande une raison (facultative) dans un petit formulaire
async function askRefuseReason(i) {
  const conf = ticketConf(i.guildId);
  if (!isTicketStaff(i, conf)) return i.reply({ content: "❌ Seule l'équipe peut traiter les demandes.", flags: EPH });
  const userId = i.customId.split(':')[2];
  const modal = new ModalBuilder()
    .setCustomId(`ticket:refuseform:${userId}`)
    .setTitle('Refuser la demande')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Raison (facultatif)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
  await i.showModal(modal);
}

async function refuseTicket(i) {
  const conf = ticketConf(i.guildId);
  if (!isTicketStaff(i, conf)) return i.reply({ content: "❌ Seule l'équipe peut traiter les demandes.", flags: EPH });
  if (!i.isFromMessage()) return i.reply({ content: '❌ Demande introuvable.', flags: EPH });
  const userId = i.customId.split(':')[2];
  const reason = i.fields.getTextInputValue('reason').trim();
  updateTicketConf(i.guildId, (c) => {
    delete c.pending[userId];
    delete c.pendingMsgs[userId];
  });
  const embed = EmbedBuilder.from(i.message.embeds[0])
    .setColor(0xed4245)
    .addFields({ name: 'Statut', value: `❌ Refusé par ${i.user}${reason ? ` — ${reason}` : ''}` });
  await i.update({ embeds: [embed], components: [] });
  const user = await i.client.users.fetch(userId).catch(() => null);
  if (user)
    tryDM(user, `❌ Ta demande de ticket sur **${i.guild.name}** a été refusée.${reason ? `\nRaison : ${reason}` : ''}`);
}

// 4) Le membre annule sa propre demande en attente (bouton éphémère)
async function cancelTicketRequest(i) {
  const userId = i.customId.split(':')[2];
  if (i.user.id !== userId) return i.reply({ content: "❌ Ce n'est pas ta demande.", flags: EPH });

  const conf = ticketConf(i.guildId);
  if (!isPending(conf, userId))
    return i.update({ content: "ℹ️ Cette demande a déjà été traitée par l'équipe (ou n'existe plus).", components: [] });

  const ref = conf.pendingMsgs[userId];
  updateTicketConf(i.guildId, (c) => {
    delete c.pending[userId];
    delete c.pendingMsgs[userId];
  });

  // on met à jour le message de la demande côté staff (plus de boutons Accepter / Refuser)
  if (ref) {
    try {
      const channel = await i.guild.channels.fetch(ref.channelId);
      const msg = await channel.messages.fetch(ref.messageId);
      const embed = EmbedBuilder.from(msg.embeds[0])
        .setColor(0x99aab5)
        .addFields({ name: 'Statut', value: `🚫 Annulée par ${i.user}` });
      await editAs(msg, { content: null, embeds: [embed], components: [] });
    } catch (err) {
      console.error('Impossible de mettre à jour la demande annulée :', err.message);
    }
  }
  await i.update({ content: '🚫 Ta demande de ticket a été annulée. Tu peux en refaire une quand tu veux.', components: [] });
}

async function closeTicket(i) {
  const topic = i.channel?.topic ?? '';
  if (!topic.startsWith('ticket:')) return i.reply({ content: "❌ Ce salon n'est pas un ticket.", flags: EPH });
  const ownerId = topic.split(':')[1];
  if (i.user.id !== ownerId && !isTicketStaff(i, ticketConf(i.guildId)))
    return i.reply({ content: "❌ Seul l'auteur du ticket ou l'équipe peut le fermer.", flags: EPH });
  await i.deferUpdate();
  await sendAs(i.client, i.channel, { content: `🔒 Ticket fermé par ${i.user}. Suppression du salon dans 5 secondes…`, allowedMentions: { parse: [] } });
  webhookCache.delete(i.channel.id);
  setTimeout(() => i.channel.delete(`Ticket fermé par ${i.user.tag}`).catch(() => {}), 5000);
}

async function handleTicketInteraction(i) {
  if (!i.inGuild()) return;
  const action = i.customId.split(':')[1];
  if (i.isModalSubmit()) {
    if (action === 'form') return submitTicketRequest(i);
    if (action === 'refuseform') return refuseTicket(i);
    return;
  }
  if (action === 'close') return closeTicket(i);
  if (action === 'cancelreq') return cancelTicketRequest(i);
  if (action === 'accept') return acceptTicket(i);
  if (action === 'refuse') return askRefuseReason(i);
  if (i.isStringSelectMenu()) {
    await startTicketRequest(i, i.values[0]);
    // remet le menu à zéro (sinon le choix reste affiché sur le panneau)
    editAs(i.message, { components: ticketPanelComponents(ticketConf(i.guildId)) }).catch(() => {});
    return;
  }
  return startTicketRequest(i, null);
}

// ------------------------------------------------------------ Commandes
const P = PermissionFlagsBits;

// ---------- Permissions proposables dans /role creer (option « permissions »)
const PERM_LABELS = {
  Administrator: 'Administrateur',
  ManageGuild: 'Gérer le serveur',
  ManageRoles: 'Gérer les rôles',
  ManageChannels: 'Gérer les salons',
  ManageMessages: 'Gérer les messages',
  ManageNicknames: 'Gérer les pseudos',
  ManageWebhooks: 'Gérer les webhooks',
  ManageEvents: 'Gérer les évènements',
  ManageThreads: 'Gérer les fils',
  ManageGuildExpressions: 'Gérer les expressions',
  CreateGuildExpressions: 'Créer des expressions',
  ViewAuditLog: "Voir les logs du serveur",
  ViewGuildInsights: 'Voir les analyses du serveur',
  ViewCreatorMonetizationAnalytics: 'Voir les analyses de monétisation',
  KickMembers: 'Expulser des membres',
  BanMembers: 'Bannir des membres',
  ModerateMembers: 'Exclure temporairement des membres',
  CreateInstantInvite: 'Créer une invitation',
  ChangeNickname: 'Changer de pseudo',
  ViewChannel: 'Voir les salons',
  SendMessages: 'Envoyer des messages',
  SendMessagesInThreads: 'Envoyer des messages dans les fils',
  CreatePublicThreads: 'Créer des fils publics',
  CreatePrivateThreads: 'Créer des fils privés',
  EmbedLinks: 'Intégrer des liens',
  AttachFiles: 'Joindre des fichiers',
  AddReactions: 'Ajouter des réactions',
  UseExternalEmojis: 'Utiliser des émojis externes',
  UseExternalStickers: 'Utiliser des stickers externes',
  MentionEveryone: 'Mentionner @everyone',
  ReadMessageHistory: "Voir les anciens messages",
  SendTTSMessages: 'Envoyer des messages TTS',
  UseApplicationCommands: 'Utiliser les commandes',
  SendVoiceMessages: 'Envoyer des messages vocaux',
  SendPolls: 'Créer des sondages',
  CreateEvents: 'Créer des évènements',
  PinMessages: 'Épingler des messages',
  BypassSlowmode: 'Ignorer le mode lent',
  Connect: 'Se connecter (vocal)',
  Speak: 'Parler (vocal)',
  Stream: 'Vidéo / partage d’écran',
  UseVAD: 'Utiliser la détection de voix',
  PrioritySpeaker: 'Voix prioritaire',
  MuteMembers: 'Couper le micro des membres',
  DeafenMembers: 'Mettre en sourdine des membres',
  MoveMembers: 'Déplacer des membres',
  UseSoundboard: 'Utiliser la soundboard',
  UseExternalSounds: 'Utiliser des sons externes',
  UseEmbeddedActivities: 'Lancer des activités',
  RequestToSpeak: 'Demander à parler',
  SetVoiceChannelStatus: 'Définir le statut du salon vocal',
};
const norm = (t) =>
  String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// [clé Discord, nom français, bit] — uniquement les permissions que cette version de discord.js connaît
const PERM_LIST = Object.entries(PERM_LABELS)
  .filter(([key]) => PermissionFlagsBits[key] !== undefined)
  .map(([key, label]) => ({ key, label, bit: PermissionFlagsBits[key], nk: norm(key), nl: norm(label) }));

// "Bannir des membres, Expulser des membres" → { bits, inconnus }
function parsePermissions(text) {
  const bits = [];
  const unknown = [];
  for (const part of String(text || '').split(',')) {
    const n = norm(part);
    if (!n) continue;
    const found = PERM_LIST.find((p) => p.nk === n || p.nl === n);
    if (found) bits.push(found);
    else unknown.push(part.trim());
  }
  return { perms: [...new Map(bits.map((p) => [p.key, p])).values()], unknown };
}
// ------------------------------------------------------------ Noms multiples (noms, noms2, ... noms10)
// Discord interdit deux options avec le même nom : on crée donc noms, noms2, noms3, ...
const NB_NOMS = 10;
const nomsOption = (n) => (o) =>
  o.setName(`noms${n}`).setDescription('Un autre nom (emoji possible devant)').setMaxLength(1000);
function collectNoms(i) {
  const raw = [i.options.getString('noms')];
  for (let n = 2; n <= NB_NOMS; n++) raw.push(i.options.getString(`noms${n}`));
  return raw.filter(Boolean).flatMap((s) => s.split(/[,;\n]/)); // la virgule marche toujours aussi
}

// ---------- Texte de /aide-plus : [commande, ce qu'elle fait]
const HELP_CATEGORIES = [
  {
    id: 'messages',
    title: '💬 Messages',
    lines: [
      ['/say', 'Le bot envoie le message que tu écris dans le salon de ton choix.'],
      ['/embed', 'Le bot envoie un message avec titre, texte et couleur dans un salon.'],
      ['/programmer', 'Planifie un message à envoyer à une date et une heure précises.'],
      ['/programmations', 'Affiche les messages programmés du serveur avec leur ID.'],
      ['/annuler-programmation', 'Annule un message programmé grâce à son ID.'],
      ['/bump-auto', 'Rappel toutes les 2 heures pour bumper le serveur (activer, desactiver, statut).'],
    ],
  },
  {
    id: 'moderation',
    title: '🔨 Modération',
    lines: [
      ['/bannir', "Bannit un membre, avec une raison, et peut supprimer ses messages des 7 derniers jours."],
      ['/debannir', "Lève le bannissement d'un utilisateur grâce à son ID."],
      ['/expulser', "Expulse un membre du serveur : il peut revenir avec une invitation."],
      ['/sourdine', "Rend un membre muet pendant la durée choisie (jusqu'à 28 jours)."],
      ['/fin-sourdine', "Retire la sourdine d'un membre avant la fin du temps prévu."],
      ['/deconnecter', "Déconnecte un membre de son salon vocal."],
      ['/deplacer', "Déplace un membre vers un autre salon vocal."],
    ],
  },
  {
    id: 'avertissements',
    title: '⚠️ Avertissements',
    lines: [
      ['/avertir', `Donne un avertissement à un membre. Au ${AUTO_TIMEOUT_WARNS}e, il est mis en sourdine 1 h automatiquement.`],
      ['/avertissements', "Affiche la liste des avertissements d'un membre."],
      ['/effacer-avertissements', "Supprime tous les avertissements d'un membre."],
    ],
  },
  {
    id: 'salon',
    title: '🛠️ Salon',
    lines: [
      ['/nettoyer', "Supprime jusqu'à 100 messages du salon, ou seulement ceux d'un membre."],
      ['/mode-lent', "Impose un délai entre deux messages dans le salon (0 pour l'enlever)."],
      ['/verrouiller', "Empêche tout le monde d'écrire dans le salon."],
      ['/deverrouiller', "Redonne à tout le monde le droit d'écrire dans le salon."],
      ['/serveur', 'Crée d\'un coup toute la structure du serveur : catégories, salons publics et privés, vocaux, tickets et staff (salons vides).'],
      ['/serveur-annuler', 'Annule /serveur : supprime les salons, catégories et le rôle staff qu\'il a créés (avec confirmation).'],
    ],
  },
  {
    id: 'roles',
    title: '🎭 Rôles',
    lines: [
      ['/role creer', 'Crée un rôle avec son nom, sa couleur, ses permissions et sa position.'],
      ['/role modifier', "Change le nom, la couleur, les permissions ou la position d'un rôle."],
      ['/role supprimer', 'Supprime définitivement un rôle du serveur.'],
      ['/role ajouter', "Donne un rôle à un membre sans toucher à ses autres rôles."],
      ['/role retirer', "Enlève un rôle à un membre sans toucher à ses autres rôles."],
      ['/role remplacer', "Échange un rôle d'un membre contre un autre."],
      ['/role voir', "Affiche les rôles d'un membre, ou tous les rôles du serveur avec leur nombre de membres."],
    ],
  },
  {
    id: 'tickets',
    title: '🎫 Tickets',
    lines: [
      ['/ticket panneau', 'Poste le message avec le menu pour ouvrir un ticket.'],
      ['/ticket option-ajouter', 'Ajoute des choix (ex : Signalement) au menu des tickets.'],
      ['/ticket option-retirer', 'Retire des choix du menu des tickets.'],
      ['/ticket options', 'Affiche les choix actuels du menu.'],
      ['/ticket questions', 'Définit les questions du formulaire (5 max), ou les affiche / les réinitialise.'],
      ['/ticket config', "Règle le salon des demandes, le rôle de l'équipe et la catégorie des tickets."],
    ],
  },
  {
    id: 'infos',
    title: 'ℹ️ Infos',
    lines: [
      ['/infos-membre', "Affiche les infos d'un membre (les tiennes par défaut)."],
      ['/infos-serveur', 'Affiche les infos du serveur.'],
      ['/ping', 'Montre la vitesse de réponse du bot.'],
      ['/aide', 'Affiche la liste rapide des commandes.'],
      ['/aide-plus', 'Affiche cette liste détaillée.'],
    ],
  },
];

// ------------------------------------------------------------ Variations discrètes pour /serveur
// Même ossature à chaque lancement (catégories et salons utiles), mais plein de petits détails changent :
// synonymes, emojis pertinents, séparateur, cadre des catégories, salons optionnels, ordre, nombre de vocaux.
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const chance = (p) => Math.random() < p;
const shuffle = (arr) => {
  const a = [...arr];
  for (let k = a.length - 1; k > 0; k--) {
    const j = rnd(k + 1);
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
};
// Mélange léger : quelques éléments voisins sont échangés (les `fixed` premiers restent en place)
const nudge = (arr, fixed = 0, swaps = 1) => {
  const a = [...arr];
  for (let n = 0; n < swaps; n++) {
    if (a.length - fixed >= 2 && chance(0.6)) {
      const k = fixed + rnd(a.length - fixed - 1);
      [a[k], a[k + 1]] = [a[k + 1], a[k]];
    }
  }
  return a;
};
const takeSome = (arr, min, max) => shuffle(arr).slice(0, Math.min(arr.length, min + rnd(max - min + 1)));
const S = (names, emojis) => ({ names, emojis });

const SEPARATORS = ['・', '・', '│', '┃', '｜', '›', '・', '┊', '»'];
const CAT_FRAMES = ['{e} {t}', '{e} {t}', '{e}・{t}', '{e} │ {t}', '{e} {t} {e}', '「{e}」{t}', '{e} ┃ {t}', '〔{e}〕{t}'];
const CAT_CASES = [(s) => s.toUpperCase(), (s) => s.toUpperCase(), (s) => s.charAt(0) + s.slice(1).toLowerCase(), (s) => s.toUpperCase()];

const CAT_POOL = {
  info: S(['Informations', 'Infos', 'Accueil', 'Bienvenue', 'Infos du serveur'], ['📌', '📢', '📍', '🏠', '📣']),
  community: S(['Communauté', 'Discussions', 'Espace communauté', 'Le coin des membres', 'Général'], ['💬', '🗨️', '👥', '🌍']),
  voice: S(['Vocaux', 'Salons vocaux', 'Vocal', 'Zone vocale', 'Espace vocal'], ['🔊', '🎙️', '🎧', '📞']),
  tickets: S(['Tickets', 'Support', 'Aide', 'Assistance', 'Besoin d’aide'], ['🎫', '🆘', '📩', '🛟']),
  staff: S(['Staff', 'Équipe', 'Modération', 'Espace staff', 'Équipe de modération'], ['🛡️', '⚔️', '🔐', '👮']),
  open: S(['Tickets ouverts', 'Tickets en cours', 'Demandes ouvertes', 'Support en cours'], ['📁', '📂', '🗂️', '📥']),
  logs: S(['Logs', 'Journaux', 'Historique', 'Archives', 'Logs du serveur'], ['📝', '📋', '📜', '🗃️']),
};

const CH = {
  bienvenue: S(['bienvenue', 'accueil', 'arrivée', 'nouveaux-membres'], ['👋', '🙌', '🎊', '🏠']),
  regles: S(['règles', 'règlement', 'charte', 'règles-du-serveur'], ['📜', '📖', '📕', '⚖️']),
  annonces: S(['annonces', 'actualités', 'infos-importantes', 'news'], ['📢', '📣', '📰', '🔔']),
  evenements: S(['évènements', 'events', 'animations', 'agenda'], ['🎉', '📅', '🎊', '🗓️']),
  partenariats: S(['partenariats', 'partenaires', 'nos-partenaires'], ['🤝', '🔗', '🌐']),
  infos: S(['infos', 'informations', 'à-savoir', 'faq'], ['ℹ️', '💡', '❓', '📌']),
  roles: S(['rôles', 'choix-des-rôles', 'prendre-ses-rôles'], ['🎭', '🏷️', '✨']),
  maj: S(['nouveautés', 'mises-à-jour', 'changelog'], ['🆕', '🔧', '📦']),
  giveaways: S(['giveaways', 'concours', 'cadeaux'], ['🎁', '🏆', '🍀']),
  general: S(['général', 'discussion', 'discussion-générale', 'chat', 'blabla'], ['💬', '🗨️', '🗣️', '☕']),
  medias: S(['médias', 'galerie', 'photos', 'partages'], ['🖼️', '📸', '🎞️']),
  memes: S(['mèmes', 'humour', 'memes', 'délires'], ['😂', '🤣', '😹', '🐸']),
  suggestions: S(['suggestions', 'idées', 'boîte-à-idées'], ['💡', '🧠', '🗳️']),
  botcmd: S(['commandes-bots', 'bots', 'zone-bots', 'commandes'], ['🤖', '⚙️', '🦾']),
  presentations: S(['présentations', 'présente-toi', 'faisons-connaissance'], ['🙋', '😊', '🪪']),
  questions: S(['questions', 'entraide', 'aide-entre-membres'], ['❓', '🙏', '🧩']),
  sondages: S(['sondages', 'votes'], ['📊', '🗳️', '✅']),
  jeux: S(['jeux', 'gaming', 'on-joue'], ['🎮', '🕹️', '🎲']),
  musique: S(['musique', 'playlist'], ['🎵', '🎶', '🎧']),
  ticket: S(['ouvrir-un-ticket', 'créer-un-ticket', 'ticket', 'contacter-le-staff'], ['🎫', '📩', '🆘', '📮']),
  staffGen: S(['staff-général', 'staff-chat', 'équipe', 'qg-staff'], ['🛡️', '👑', '🔐', '⚔️']),
  staffRules: S(['règles-staff', 'consignes-staff', 'charte-staff'], ['📋', '📘', '📜']),
  staffNews: S(['annonces-staff', 'infos-staff', 'briefing'], ['📣', '📌', '🗒️']),
  staffChat: S(['discussion-staff', 'staff-discussion', 'pause-café-staff'], ['💬', '🗨️', '☕']),
  sanctions: S(['sanctions', 'modération', 'rapports', 'casier'], ['🔨', '⚖️', '🚨']),
  requests: S(['demandes-tickets', 'tickets-à-traiter', 'nouvelles-demandes'], ['📨', '📥', '🔔']),
  staffBots: S(['commandes-staff', 'bots-staff', 'console'], ['🤖', '⚙️', '🖥️']),
  staffPlan: S(['planning-staff', 'organisation', 'to-do-staff'], ['📆', '📝', '✅']),
  logMod: S(['logs-modération', 'mod-logs', 'journal-modération'], ['📝', '🔨', '📜']),
  logMembers: S(['logs-membres', 'arrivées-départs', 'journal-membres'], ['👥', '🚪', '🧑‍🤝‍🧑']),
  logMessages: S(['logs-messages', 'messages-supprimés', 'journal-messages'], ['✉️', '🗑️', '💭']),
  logVoice: S(['logs-vocal', 'logs-voix', 'journal-vocal'], ['🔊', '🎙️', '📡']),
  logChannels: S(['logs-salons', 'changements-salons'], ['📚', '🧱', '🗂️']),
  logRoles: S(['logs-rôles', 'changements-rôles'], ['🎭', '🏷️', '🔖']),
};

const V = {
  general: S(['Général', 'Salon principal', 'Lounge', 'Discussion'], ['🔊', '🎙️', '💬', '☕']),
  disc: S(['Discussion', 'Salon', 'Table'], ['💬', '🗣️', '🪑']),
  gaming: S(['Gaming', 'Jeux', 'Arcade', 'Game room'], ['🎮', '🕹️', '👾']),
  musique: S(['Musique', 'Radio', 'Écoute'], ['🎵', '📻', '🎧']),
  detente: S(['Détente', 'Chill', 'Tranquille'], ['😌', '🌿', '🛋️']),
  cinema: S(['Cinéma', 'Stream', 'Projection'], ['🎬', '🍿', '📽️']),
  etude: S(['Étude', 'Focus', 'Travail'], ['📚', '🧠', '✏️']),
  duo: S(['Duo', 'Trio', 'Squad'], ['👥', '🤝', '🎯']),
  afk: S(['AFK', 'Pause', 'Absent', 'Sieste'], ['😴', '💤', '🌙']),
  staff: S(['Staff vocal', 'Réunion staff', 'Salle de réunion', 'Briefing vocal'], ['🔊', '🎙️', '🏛️']),
};

const STAFF_ROLE_NAMES = ['Staff', 'Équipe', 'Modérateurs', 'Modération', 'Team'];
const STAFF_ROLE_EMOJIS = ['🛡️', '🛡️', '⚔️', '🔰', '🛠️'];
const STAFF_ROLE_COLORS = [0xed4245, 0xe67e22, 0x5865f2, 0x9b59b6, 0x3498db, 0x1abc9c, 0xe91e63];

// Construit le plan : [titre catégorie, accès, [[nom, 'text'|'voice'], ...]]
function buildPlan() {
  const T = 'text';
  const VC = 'voice';
  const sep = pick(SEPARATORS);
  const frame = pick(CAT_FRAMES);
  const caseFn = pick(CAT_CASES);
  // une fois sur quatre, les salons texte n'ont pas d'emoji devant mais derrière
  const emojiAfter = chance(0.2);

  const chan = (slot) => {
    const name = pick(slot.names).toLowerCase().replace(/\s+/g, '-');
    const e = pick(slot.emojis);
    return emojiAfter ? `${name}${sep}${e}` : `${e}${sep}${name}`;
  };
  const voice = (slot, suffix = '') => `${pick(slot.emojis)} ${pick(slot.names)}${suffix}`;
  const cat = (key) => {
    const slot = CAT_POOL[key];
    return frame.split('{e}').join(pick(slot.emojis)).replace('{t}', caseFn(pick(slot.names)));
  };
  // list : [slot, probabilité d'être gardé]
  const texts = (list) => list.filter(([, p]) => chance(p)).map(([s]) => [chan(s), T]);
  const extras = (slots, min, max) => takeSome(slots, min, max).map((s) => [s, 1]);

  const info = texts([
    [CH.bienvenue, 1], [CH.regles, 1], [CH.annonces, 1],
    ...nudge([[CH.evenements, 0.75], [CH.partenariats, 0.7], [CH.infos, 0.8]], 0, 2),
    ...extras([CH.roles, CH.maj, CH.giveaways], 0, 2),
  ]);
  const community = texts([
    [CH.general, 1],
    ...nudge([[CH.medias, 0.75], [CH.memes, 0.75], [CH.suggestions, 0.8], [CH.botcmd, 1]], 0, 2),
    ...extras([CH.presentations, CH.questions, CH.sondages, CH.jeux, CH.musique], 1, 3),
  ]);

  const nbDisc = 1 + rnd(3);
  const discName = pick(V.disc.names);
  const discEmoji = pick(V.disc.emojis);
  const voices = [
    [voice(V.general), VC],
    ...Array.from({ length: nbDisc }, (_, k) => [`${discEmoji} ${discName} ${k + 1}`, VC]),
    ...nudge([V.gaming, V.musique]).map((s) => [voice(s), VC]),
    ...takeSome([V.detente, V.cinema, V.etude, V.duo], 0, 2).map((s) => [voice(s), VC]),
    [voice(V.afk), VC],
  ];
  const tickets = texts([[CH.ticket, 1]]);
  const staff = [
    ...texts([[CH.staffGen, 1], ...nudge([[CH.staffRules, 0.85], [CH.staffNews, 0.85], [CH.staffChat, 1], [CH.sanctions, 1]], 0, 2)]),
    ...texts([[CH.requests, 1], [CH.staffBots, 0.9], ...extras([CH.staffPlan], 0, 1)]),
    [voice(V.staff), VC],
  ];
  const logs = texts([
    [CH.logMod, 1], ...nudge([[CH.logMembers, 1], [CH.logMessages, 1], [CH.logVoice, 0.85]], 0, 1),
    ...extras([CH.logChannels, CH.logRoles], 0, 2),
  ]);

  const midBlocks = [
    [cat('community'), 'public', community],
    [cat('voice'), 'public', voices],
  ];
  if (chance(0.3)) midBlocks.reverse();
  // le bloc tickets peut passer avant ou après les salons communautaires
  const ticketBlock = [cat('tickets'), 'readonly', tickets];
  const head = chance(0.2) ? [ticketBlock, ...midBlocks] : [...midBlocks, ticketBlock];

  const plan = [
    [cat('info'), 'readonly', info],
    ...head,
    [cat('staff'), 'private', staff],
    [cat('open'), 'private', []],
    [cat('logs'), 'private', logs],
  ];
  const staffLook = { name: `${pick(STAFF_ROLE_EMOJIS)} ${pick(STAFF_ROLE_NAMES)}`, color: pick(STAFF_ROLE_COLORS) };
  return { plan, staffLook, styleText: `séparateur « ${sep} »` };
}

const commands = [
  // ---------- /apparence
  {
    data: new SlashCommandBuilder()
      .setName('apparence')
      .setDescription('Change le nom et la photo du bot dans ses messages (/say, /embed, messages programmés…)')
      .addStringOption((o) => o.setName('nom').setDescription('Le nom que le bot affichera').setMaxLength(80))
      .addAttachmentOption((o) => o.setName('photo').setDescription('Image de profil du bot (png, jpg, gif, webp)'))
      .addBooleanOption((o) => o.setName('reinitialiser').setDescription('Remettre le nom et la photo de base du bot'))
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const nom = i.options.getString('nom')?.trim();
      const photo = i.options.getAttachment('photo');
      const reset = i.options.getBoolean('reinitialiser');
      const key = apparenceKey(i.client.user.id, i.guildId);

      if (!nom && !photo && !reset)
        return i.reply({ content: '❌ Indique au moins un **nom**, une **photo**, ou **réinitialiser**.', flags: EPH });

      const data = loadApparence();

      if (reset) {
        delete data[key];
        saveApparence(data);
        for (const [id, entry] of webhookCache) if (entry.webhook.guildId === i.guildId) webhookCache.delete(id);
        return i.reply({ content: '✅ Apparence réinitialisée : le bot reprend son nom et sa photo de base.', flags: EPH });
      }

      if (nom && /discord|clyde/i.test(nom))
        return i.reply({ content: '❌ Discord interdit les noms contenant « discord » ou « clyde ».', flags: EPH });
      if (photo && !photo.contentType?.startsWith('image/'))
        return i.reply({ content: "❌ Le fichier doit être une image (png, jpg, gif, webp).", flags: EPH });
      if (photo && photo.size > 8 * 1024 * 1024)
        return i.reply({ content: '❌ Image trop lourde (8 Mo maximum).', flags: EPH });

      await i.deferReply({ flags: EPH });

      const look = data[key] ?? {};
      if (nom) look.name = nom;
      if (photo) {
        const res = await fetch(photo.url);
        if (!res.ok) return i.editReply('❌ Impossible de télécharger cette image.');
        fs.mkdirSync(APPARENCE_DIR, { recursive: true });
        look.image = `${i.client.user.id}-${i.guildId}`;
        fs.writeFileSync(`${APPARENCE_DIR}/${look.image}`, Buffer.from(await res.arrayBuffer()));
      }
      look.version = Date.now();
      data[key] = look;
      saveApparence(data);

      // test immédiat dans ce salon pour détecter un problème de permission (Gérer les webhooks)
      try {
        await getAppearanceWebhook(i.client, i.channel, look);
      } catch (err) {
        return i.editReply(`⚠️ Apparence enregistrée, mais je n'arrive pas à créer de webhook ici : \`${err.message}\`\nDonne-moi la permission **Gérer les webhooks**.`);
      }
      await i.editReply(
        `✅ Apparence enregistrée${look.name ? ` : **${look.name}**` : ''}${look.image ? ' + photo' : ''}.\nÇa s'applique à \`/say\`, \`/embed\`, aux messages programmés, aux rappels de bump et au système de tickets (panneau, demandes, messages dans les tickets). Dans la liste des membres, le bot reste normal.`,
      );
    },
  },

  // ---------- /say
  {
    data: new SlashCommandBuilder()
      .setName('say')
      .setDescription('Fait parler le bot')
      .addStringOption((o) => o.setName('message').setDescription('Le message à envoyer').setRequired(true))
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon de destination').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const channel = i.options.getChannel('salon') ?? i.channel;
      const message = i.options.getString('message').replaceAll('\\n', '\n');
      await sendAs(i.client, channel, { content: message, allowedMentions: { parse: [] } });
      await i.reply({ content: `✅ Message envoyé dans ${channel}.`, flags: EPH });
    },
  },

  // ---------- /embed
  {
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Envoie un message dans un embed')
      .addStringOption((o) => o.setName('titre').setDescription('Titre').setRequired(true))
      .addStringOption((o) => o.setName('description').setDescription('Contenu').setRequired(true))
      .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: ff0000)'))
      .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText))
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const hex = (i.options.getString('couleur') ?? '5865f2').replace('#', '');
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) return i.reply({ content: '❌ Couleur invalide (ex: `ff0000`).', flags: EPH });
      const channel = i.options.getChannel('salon') ?? i.channel;
      const embed = new EmbedBuilder()
        .setTitle(i.options.getString('titre'))
        .setDescription(i.options.getString('description').replaceAll('\\n', '\n'))
        .setColor(parseInt(hex, 16));
      await sendAs(i.client, channel, { embeds: [embed] });
      await i.reply({ content: `✅ Embed envoyé dans ${channel}.`, flags: EPH });
    },
  },

  // ---------- /ban
  {
    data: new SlashCommandBuilder()
      .setName('bannir')
      .setDescription('Bannir un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre à bannir').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison'))
      .addIntegerOption((o) => o.setName('supprimer_jours').setDescription('Jours de messages à supprimer (0-7)').setMinValue(0).setMaxValue(7))
      .setDefaultMemberPermissions(P.BanMembers)
      .setDMPermission(false),
    async execute(i) {
      const user = i.options.getUser('membre');
      const reason = i.options.getString('raison');
      const days = i.options.getInteger('supprimer_jours') ?? 0;
      const member = i.options.getMember('membre');
      if (member) {
        const err = canModerate(i, member);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
        await tryDM(user, `🔨 Tu as été **banni** de **${i.guild.name}**.\nRaison : ${reason ?? 'Aucune'}`);
      }
      await i.guild.members.ban(user, { reason: `${i.user.tag} : ${reason}`, deleteMessageSeconds: days * 86400 });
      await i.reply({ embeds: [modEmbed('🔨 Membre banni', 0xed4245, user, i.user, reason)] });
    },
  },

  // ---------- /unban
  {
    data: new SlashCommandBuilder()
      .setName('debannir')
      .setDescription("Débannir un utilisateur (via son ID)")
      .addStringOption((o) => o.setName('id_utilisateur').setDescription("ID de l'utilisateur").setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison'))
      .setDefaultMemberPermissions(P.BanMembers)
      .setDMPermission(false),
    async execute(i) {
      const id = i.options.getString('id_utilisateur');
      const reason = i.options.getString('raison');
      try {
        const user = await i.guild.members.unban(id, `${i.user.tag} : ${reason}`);
        await i.reply({ embeds: [modEmbed('✅ Membre débanni', 0x57f287, user, i.user, reason)] });
      } catch {
        await i.reply({ content: '❌ Utilisateur introuvable ou non banni.', flags: EPH });
      }
    },
  },

  // ---------- /kick
  {
    data: new SlashCommandBuilder()
      .setName('expulser')
      .setDescription('Expulser un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison'))
      .setDefaultMemberPermissions(P.KickMembers)
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre');
      const reason = i.options.getString('raison');
      if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });
      const err = canModerate(i, member);
      if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
      await tryDM(member.user, `👢 Tu as été **expulsé** de **${i.guild.name}**.\nRaison : ${reason ?? 'Aucune'}`);
      await member.kick(`${i.user.tag} : ${reason}`);
      await i.reply({ embeds: [modEmbed('👢 Membre expulsé', 0xe67e22, member.user, i.user, reason)] });
    },
  },

  // ---------- /timeout
  {
    data: new SlashCommandBuilder()
      .setName('sourdine')
      .setDescription('Rendre muet un membre temporairement')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Durée en minutes (max 40320)').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption((o) => o.setName('raison').setDescription('Raison'))
      .setDefaultMemberPermissions(P.ModerateMembers)
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre');
      const minutes = i.options.getInteger('minutes');
      const reason = i.options.getString('raison');
      if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });
      const err = canModerate(i, member);
      if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
      await member.timeout(minutes * 60_000, `${i.user.tag} : ${reason}`);
      await tryDM(member.user, `🔇 Tu as été mis en sourdine **${minutes} min** sur **${i.guild.name}**.\nRaison : ${reason ?? 'Aucune'}`);
      const embed = modEmbed('🔇 Membre mis en sourdine', 0xd35400, member.user, i.user, reason).addFields({
        name: 'Durée',
        value: `${minutes} minute(s)`,
      });
      await i.reply({ embeds: [embed] });
    },
  },

  // ---------- /untimeout
  {
    data: new SlashCommandBuilder()
      .setName('fin-sourdine')
      .setDescription("Retirer la sourdine d'un membre")
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre');
      if (!member) return i.reply({ content: '❌ Membre introuvable.', flags: EPH });
      await member.timeout(null);
      await i.reply(`🔊 ${member} peut de nouveau parler.`);
    },
  },

  // ---------- /warn
  {
    data: new SlashCommandBuilder()
      .setName('avertir')
      .setDescription('Avertir un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription("Raison de l'avertissement").setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre');
      const reason = i.options.getString('raison');
      if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });
      const err = canModerate(i, member);
      if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });

      const data = loadWarns();
      data[i.guildId] ??= {};
      data[i.guildId][member.id] ??= [];
      data[i.guildId][member.id].push({
        raison: reason,
        moderateur: i.user.id,
        date: new Date().toLocaleString('fr-FR'),
      });
      saveWarns(data);
      const total = data[i.guildId][member.id].length;

      await tryDM(member.user, `⚠️ Tu as reçu un **avertissement** sur **${i.guild.name}**.\nRaison : ${reason}\nTotal : ${total}`);
      const embed = modEmbed('⚠️ Avertissement', 0xfee75c, member.user, i.user, reason).addFields({
        name: "Total d'avertissements",
        value: String(total),
      });
      await i.reply({ embeds: [embed] });

      if (total >= AUTO_TIMEOUT_WARNS && member.moderatable) {
        await member.timeout(3_600_000, `${total} avertissements`).catch(() => {});
        await i.followUp(`🔇 ${member} a atteint ${total} avertissements : sourdine automatique d'1 heure.`);
      }
    },
  },

  // ---------- /warnings
  {
    data: new SlashCommandBuilder()
      .setName('avertissements')
      .setDescription("Voir les avertissements d'un membre")
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .setDefaultMemberPermissions(P.ModerateMembers)
      .setDMPermission(false),
    async execute(i) {
      const user = i.options.getUser('membre');
      const list = loadWarns()[i.guildId]?.[user.id] ?? [];
      if (!list.length) return i.reply({ content: `✅ ${user} n'a aucun avertissement.`, flags: EPH });
      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Avertissements de ${user.tag}`)
        .setColor(0xfee75c)
        .addFields(
          list.slice(-25).map((w, idx) => ({
            name: `#${idx + 1} • ${w.date}`,
            value: `${w.raison}\n*par <@${w.moderateur}>*`,
          })),
        );
      await i.reply({ embeds: [embed], flags: EPH });
    },
  },

  // ---------- /clearwarns
  {
    data: new SlashCommandBuilder()
      .setName('effacer-avertissements')
      .setDescription("Effacer les avertissements d'un membre")
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
      .setDefaultMemberPermissions(P.Administrator)
      .setDMPermission(false),
    async execute(i) {
      const user = i.options.getUser('membre');
      const data = loadWarns();
      if (data[i.guildId]) delete data[i.guildId][user.id];
      saveWarns(data);
      await i.reply(`🧹 Avertissements de ${user} effacés.`);
    },
  },

  // ---------- /clear
  {
    data: new SlashCommandBuilder()
      .setName('nettoyer')
      .setDescription('Supprimer des messages')
      .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre de messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName('membre').setDescription('Supprimer seulement ceux de ce membre'))
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      await i.deferReply({ flags: EPH });
      const n = i.options.getInteger('nombre');
      const user = i.options.getUser('membre');
      let messages = await i.channel.messages.fetch({ limit: 100 });
      if (user) messages = messages.filter((m) => m.author.id === user.id);
      const toDelete = [...messages.values()].slice(0, n);
      const deleted = await i.channel.bulkDelete(toDelete, true);
      await i.editReply(`🧹 ${deleted.size} message(s) supprimé(s).`);
    },
  },

  // ---------- /slowmode
  {
    data: new SlashCommandBuilder()
      .setName('mode-lent')
      .setDescription('Définir le mode lent du salon')
      .addIntegerOption((o) => o.setName('secondes').setDescription('0 pour désactiver (max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600))
      .setDefaultMemberPermissions(P.ManageChannels)
      .setDMPermission(false),
    async execute(i) {
      const s = i.options.getInteger('secondes');
      await i.channel.setRateLimitPerUser(s);
      await i.reply(s === 0 ? '🐢 Mode lent désactivé.' : `🐢 Mode lent réglé sur ${s}s.`);
    },
  },

  // ---------- /lock
  {
    data: new SlashCommandBuilder()
      .setName('verrouiller')
      .setDescription('Verrouiller le salon')
      .setDefaultMemberPermissions(P.ManageChannels)
      .setDMPermission(false),
    async execute(i) {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false });
      await i.reply('🔒 Salon verrouillé.');
    },
  },

  // ---------- /unlock
  {
    data: new SlashCommandBuilder()
      .setName('deverrouiller')
      .setDescription('Déverrouiller le salon')
      .setDefaultMemberPermissions(P.ManageChannels)
      .setDMPermission(false),
    async execute(i) {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null });
      await i.reply('🔓 Salon déverrouillé.');
    },
  },

  // ---------- /userinfo
  {
    data: new SlashCommandBuilder()
      .setName('infos-membre')
      .setDescription('Infos sur un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre (par défaut : toi)'))
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre') ?? i.member;
      const roles = member.roles.cache.filter((r) => r.id !== i.guildId).map((r) => `${r}`);
      const embed = new EmbedBuilder()
        .setTitle(member.user.tag)
        .setColor(member.displayColor || 0x5865f2)
        .setThumbnail(member.displayAvatarURL())
        .addFields(
          { name: 'ID', value: member.id, inline: true },
          { name: 'Compte créé', value: time(member.user.createdAt, 'R'), inline: true },
          { name: 'A rejoint', value: time(member.joinedAt, 'R'), inline: true },
          { name: 'Rôles', value: roles.join(' ') || 'Aucun' },
        );
      await i.reply({ embeds: [embed] });
    },
  },

  // ---------- /serverinfo
  {
    data: new SlashCommandBuilder().setName('infos-serveur').setDescription('Infos sur le serveur').setDMPermission(false),
    async execute(i) {
      const g = i.guild;
      const embed = new EmbedBuilder()
        .setTitle(g.name)
        .setColor(0x5865f2)
        .setThumbnail(g.iconURL())
        .addFields(
          { name: 'Propriétaire', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Membres', value: String(g.memberCount), inline: true },
          { name: 'Salons', value: String(g.channels.cache.size), inline: true },
          { name: 'Rôles', value: String(g.roles.cache.size), inline: true },
          { name: 'Créé', value: time(g.createdAt, 'R'), inline: true },
        );
      await i.reply({ embeds: [embed] });
    },
  },

  // ---------- /ping
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Latence du bot'),
    async execute(i) {
      await i.reply(`🏓 Pong ! ${i.client.ws.ping} ms`);
    },
  },

  // ---------- /deconnecter
  {
    data: new SlashCommandBuilder()
      .setName('deconnecter')
      .setDescription("Déconnecter un membre de son salon vocal")
      .addUserOption((o) => o.setName('membre').setDescription('Le membre à déconnecter').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison'))
      .setDefaultMemberPermissions(P.MoveMembers)
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre');
      const reason = i.options.getString('raison');
      if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });
      if (member.id !== i.user.id) {
        const err = canModerate(i, member);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
      }
      const channel = member.voice.channel;
      if (!channel) return i.reply({ content: "❌ Ce membre n'est dans aucun salon vocal.", flags: EPH });
      if (!channel.permissionsFor(i.guild.members.me).has(PermissionFlagsBits.MoveMembers))
        return i.reply({ content: `❌ Il me manque la permission « Déplacer des membres » dans ${channel}.`, flags: EPH });

      await member.voice.disconnect(`${i.user.tag} : ${reason}`);
      const embed = modEmbed('🔌 Membre déconnecté du vocal', 0x95a5a6, member.user, i.user, reason).addFields({
        name: 'Salon',
        value: `${channel}`,
      });
      await i.reply({ embeds: [embed], flags: EPH });
    },
  },

  // ---------- /deplacer
  {
    data: new SlashCommandBuilder()
      .setName('deplacer')
      .setDescription('Déplacer un membre vers un autre salon vocal')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre à déplacer').setRequired(true))
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon vocal de destination').setRequired(true).addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      )
      .addStringOption((o) => o.setName('raison').setDescription('Raison'))
      .setDefaultMemberPermissions(P.MoveMembers)
      .setDMPermission(false),
    async execute(i) {
      const member = i.options.getMember('membre');
      const target = i.options.getChannel('salon');
      const reason = i.options.getString('raison');
      if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });
      if (member.id !== i.user.id) {
        const err = canModerate(i, member);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
      }
      const from = member.voice.channel;
      if (!from) return i.reply({ content: "❌ Ce membre n'est dans aucun salon vocal.", flags: EPH });
      if (from.id === target.id) return i.reply({ content: '❌ Ce membre est déjà dans ce salon.', flags: EPH });

      const me = i.guild.members.me;
      if (!from.permissionsFor(me).has(PermissionFlagsBits.MoveMembers))
        return i.reply({ content: `❌ Il me manque la permission « Déplacer des membres » dans ${from}.`, flags: EPH });
      if (!target.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers]))
        return i.reply({ content: `❌ Je ne peux pas accéder à ${target} (il me faut « Voir le salon », « Se connecter » et « Déplacer des membres »).`, flags: EPH });

      await member.voice.setChannel(target, `${i.user.tag} : ${reason}`);
      const embed = modEmbed('🔀 Membre déplacé', 0x3498db, member.user, i.user, reason).addFields(
        { name: 'De', value: `${from}`, inline: true },
        { name: 'Vers', value: `${target}`, inline: true },
      );
      await i.reply({ embeds: [embed], flags: EPH });
    },
  },

  // ---------- /aide
  {
    data: new SlashCommandBuilder().setName('aide').setDescription('Liste des commandes'),
    async execute(i) {
      const embed = new EmbedBuilder()
        .setTitle('📖 Commandes')
        .setColor(0x5865f2)
        .addFields(
          { name: '💬 Messages', value: '`/say` `/embed` `/apparence` `/programmer` `/programmations` `/annuler-programmation` `/bump-auto`' },
          { name: '🎭 Rôles', value: '`/role creer` `/role ajouter` `/role retirer` `/role remplacer` `/role modifier` `/role supprimer` `/role voir`' },
          { name: '🎫 Tickets', value: '`/ticket panneau` `/ticket option-ajouter` `/ticket option-retirer` `/ticket options` `/ticket questions` `/ticket config`' },
          { name: '🔨 Modération', value: '`/bannir` `/debannir` `/expulser` `/sourdine` `/fin-sourdine` `/deconnecter` `/deplacer`' },
          { name: '⚠️ Avertissements', value: '`/avertir` `/avertissements` `/effacer-avertissements`' },
          { name: '🛠️ Salon', value: '`/nettoyer` `/mode-lent` `/verrouiller` `/deverrouiller` `/serveur` `/serveur-annuler`' },
          { name: 'ℹ️ Infos', value: '`/infos-membre` `/infos-serveur` `/ping` `/aide-plus`' },
        );
      await i.reply({ embeds: [embed], flags: EPH });
    },
  },

  // ---------- /serveur : crée d'un coup les catégories et salons (vides) d'un serveur
  {
    data: new SlashCommandBuilder()
      .setName('serveur')
      .setDescription('Crée d\'un coup les catégories et salons du serveur (publics, privés, vocaux, tickets, staff)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addRoleOption((o) => o.setName('role-staff').setDescription('Rôle staff à utiliser (par défaut : un rôle « 🛡️ Staff » est créé)')),
    async execute(i) {
      const me = i.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles))
        return i.reply({ content: '❌ Il me faut les permissions « Gérer les salons » et « Gérer les rôles ».', flags: EPH });

      await i.deferReply({ flags: EPH });

      // Rôle staff : celui choisi, sinon on le crée
      let staff = i.options.getRole('role-staff');
      let staffCreated = false;
      // On note tout ce qui est créé pour que /serveur-annuler puisse le supprimer
      const rec = { categories: [], channels: [], roleId: null };
      // La mémoire est REMPLACÉE à chaque lancement : /serveur-annuler ne supprime que la dernière version générée.
      const startedAt = Date.now();
      const persist = () => {
        const all = loadServeur();
        all[i.guildId] = { categories: [...rec.categories], channels: [...rec.channels], roleId: rec.roleId, at: startedAt };
        saveServeur(all);
      };
      // Structure aléatoire : différente à chaque lancement, validée par l'admin avant toute création
      let { plan, staffLook, styleText } = buildPlan();
      const staffChosen = staff;
      const previous = loadServeur()[i.guildId];
      const preview = () => {
        const lines = plan.map(([title, access, kids]) => {
          const lock = access === 'private' ? '🔒 ' : access === 'readonly' ? '👁️ ' : '';
          return `**${lock}${title}**${kids.length ? `\n${kids.map(([n]) => `› ${n}`).join('\n')}` : '\n› *(vide)*'}`;
        });
        const total = plan.reduce((n, p) => n + p[2].length, 0);
        let body = lines.join('\n\n');
        if (body.length > 3500) body = body.slice(0, 3500) + '\n…';
        return new EmbedBuilder()
          .setTitle('🧩 Aperçu de la structure')
          .setColor(0x5865f2)
          .setDescription(body)
          .setFooter({ text: `${plan.length} catégories • ${total} salons • rôle staff : ${staffChosen ? staffChosen.name : staffLook.name}` });
      };
      const confirmRow = () => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('serv:yes').setLabel('Créer cette structure').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('serv:re').setLabel('Autre version').setEmoji('🎲').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('serv:no').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
      );
      const warn = previous && (previous.categories.length || previous.channels.length)
        ? '⚠️ Un lot créé par un précédent `/serveur` existe encore : fais `/serveur-annuler` avant si tu ne veux pas de doublons.\n\n'
        : '';
      const msg = await i.editReply({ content: `${warn}**Confirmer la création ?** Rien n'est créé tant que tu n'as pas cliqué sur « Créer ».`, embeds: [preview()], components: [confirmRow()] });
      for (;;) {
        let btn;
        try {
          btn = await msg.awaitMessageComponent({ filter: (b) => b.user.id === i.user.id, time: 120_000 });
        } catch {
          return i.editReply({ content: '⌛ Temps écoulé, rien n\'a été créé.', embeds: [], components: [] });
        }
        if (btn.customId === 'serv:no') return btn.update({ content: '👍 Annulé, rien n\'a été créé.', embeds: [], components: [] });
        if (btn.customId === 'serv:re') {
          ({ plan, staffLook, styleText } = buildPlan());
          await btn.update({ content: `${warn}**Confirmer la création ?** Rien n'est créé tant que tu n'as pas cliqué sur « Créer ».`, embeds: [preview()], components: [confirmRow()] });
          continue;
        }
        await btn.update({ content: '⏳ Création en cours…', embeds: [], components: [] });
        break;
      }
      let staffReused = false;
      if (!staff) {
        // On réutilise le rôle staff du lancement précédent (renommé) pour ne pas laisser de rôles orphelins
        const prevId = loadServeur()[i.guildId]?.roleId;
        const prevRole = prevId ? i.guild.roles.cache.get(prevId) : null;
        if (prevRole && prevRole.editable && !prevRole.managed) {
          staff = await prevRole.edit({ name: staffLook.name, color: staffLook.color, reason: `/serveur par ${i.user.tag}` });
          staffReused = true;
        } else {
          staff = await i.guild.roles.create({ name: staffLook.name, color: staffLook.color, hoist: true, mentionable: true, reason: `/serveur par ${i.user.tag}` });
          staffCreated = true;
        }
        rec.roleId = staff.id;
        persist();
      }

      const V = PermissionFlagsBits.ViewChannel;
      const S = PermissionFlagsBits.SendMessages;
      const staffAllow = [V, S, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ManageMessages];
      const botAllow = { id: me.id, allow: [V, S, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] };
      const overwrites = {
        // visible par tous, tout le monde peut écrire / parler
        public: [],
        // visible par tous, lecture seule (le staff peut écrire)
        readonly: [
          { id: i.guildId, deny: [S, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads] },
          { id: staff.id, allow: [S] },
          botAllow,
        ],
        // invisible pour tout le monde sauf le staff
        private: [{ id: i.guildId, deny: [V] }, { id: staff.id, allow: staffAllow }, botAllow],
      };

      const made = [];
      const skipped = [];
      let channels = 0;
      try {
        for (const [title, access, kids] of plan) {
          // déjà existante ? on ne la recrée pas (évite les doublons si tu relances la commande)
          if (i.guild.channels.cache.some((c) => c.type === ChannelType.GuildCategory && c.name === title)) {
            skipped.push(title);
            continue;
          }
          const ow = overwrites[access];
          const cat = await i.guild.channels.create({ name: title, type: ChannelType.GuildCategory, permissionOverwrites: ow });
          rec.categories.push(cat.id);
          for (const [name, kind] of kids) {
            const ch = await i.guild.channels.create({
              name,
              type: kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
              parent: cat.id,
              permissionOverwrites: ow,
            });
            rec.channels.push(ch.id);
            channels++;
          }
          made.push(title);
        }
      } catch (err) {
        persist();
        return i.editReply({
          content: `⚠️ Arrêté en cours de route : ${err.message}\n${made.length ? `Déjà créé : ${made.join(', ')}.` : 'Rien n\'a été créé.'} Tu peux relancer, les catégories déjà faites seront ignorées.`,
        });
      }

      persist();
      const embed = new EmbedBuilder()
        .setTitle('✅ Serveur mis en place')
        .setColor(0x57f287)
        .setDescription(
          [
            `**${made.length}** catégorie(s) et **${channels}** salon(s) créés (tous vides).`,
            `Rôle staff : ${staff}${staffCreated ? ' (créé)' : staffReused ? ' (réutilisé et renommé)' : ''}`,
            `🎲 Style de cette version : ${styleText}`,
            skipped.length ? `Déjà existantes, ignorées : ${skipped.join(', ')}` : null,
            '',
            "Les salons « 🛡️ STAFF », « 📁 TICKETS OUVERTS » et « 📝 LOGS » sont privés : seul le staff les voit.",
            "Les salons d'informations et de tickets sont en lecture seule pour les membres.",
            'Pour brancher les tickets : `/ticket config`, puis `/ticket panneau` dans #🎫・ouvrir-un-ticket.',
            'Pas satisfait ? `/serveur-annuler` supprime uniquement ce lot-ci (le dernier généré), puis relance `/serveur` pour une nouvelle version.',
          ]
            .filter((l) => l !== null)
            .join('\n'),
        );
      return i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    },
  },

  // ---------- /serveur-annuler : supprime ce que /serveur a créé
  {
    data: new SlashCommandBuilder()
      .setName('serveur-annuler')
      .setDescription('Annule /serveur : supprime les catégories, salons et le rôle staff qu\'il a créés')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false),
    async execute(i) {
      const me = i.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles))
        return i.reply({ content: '❌ Il me faut les permissions « Gérer les salons » et « Gérer les rôles ».', flags: EPH });

      const all = loadServeur();
      const rec = all[i.guildId];
      if (!rec || (!rec.categories.length && !rec.channels.length && !rec.roleId))
        return i.reply({ content: "ℹ️ Rien à annuler : `/serveur` n'a rien créé ici (ou c'est déjà annulé).", flags: EPH });

      const nbCat = rec.categories.filter((id) => i.guild.channels.cache.has(id)).length;
      const nbChan = rec.channels.filter((id) => i.guild.channels.cache.has(id)).length;
      const role = rec.roleId ? i.guild.roles.cache.get(rec.roleId) : null;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('annul:yes').setLabel('Oui, tout supprimer').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('annul:no').setLabel('Garder').setStyle(ButtonStyle.Secondary),
      );
      const msg = await i.reply({
        content: `⚠️ **Annuler /serveur ?**\nÇa supprime **${nbCat}** catégorie(s) et **${nbChan}** salon(s) créés par le dernier /serveur${rec.at ? ` (${time(Math.floor(rec.at / 1000), 'R')})` : ''}${role ? `, ainsi que le rôle **${role.name}**` : ''}.\nC'est définitif.`,
        components: [row],
        flags: EPH,
        fetchReply: true,
      });

      let btn;
      try {
        btn = await msg.awaitMessageComponent({ filter: (b) => b.user.id === i.user.id, time: 30_000 });
      } catch {
        return i.editReply({ content: '⌛ Temps écoulé, rien n\'a été supprimé.', components: [] });
      }
      if (btn.customId !== 'annul:yes') return btn.update({ content: '👍 Annulé, rien n\'a été supprimé.', components: [] });

      await btn.update({ content: '⏳ Suppression en cours…', components: [] });

      let delChan = 0;
      let delCat = 0;
      const keptCats = [];
      const reason = `/serveur-annuler par ${i.user.tag}`;
      try {
        for (const id of rec.channels) {
          const ch = i.guild.channels.cache.get(id);
          if (ch) { await ch.delete(reason); delChan++; }
        }
        for (const id of rec.categories) {
          const cat = i.guild.channels.cache.get(id);
          if (!cat) continue;
          // une catégorie qui contient encore d'autres salons (ex. tickets ouverts) est gardée
          if (i.guild.channels.cache.some((c) => c.parentId === id)) { keptCats.push(cat.name); continue; }
          await cat.delete(reason);
          delCat++;
        }
        let roleDeleted = false;
        if (role && !role.managed && role.editable) { await role.delete(reason); roleDeleted = true; }

        const left = rec.categories.filter((id) => i.guild.channels.cache.has(id));
        if (left.length) all[i.guildId] = { categories: left, channels: [], roleId: null };
        else delete all[i.guildId];
        saveServeur(all);

        return btn.editReply({
          content: [
            `✅ Annulé : **${delCat}** catégorie(s) et **${delChan}** salon(s) supprimés${roleDeleted ? `, rôle **${role.name}** supprimé` : ''}.`,
            keptCats.length ? `⚠️ Gardées car elles contiennent encore d'autres salons : ${keptCats.join(', ')}` : null,
          ].filter(Boolean).join('\n'),
        });
      } catch (err) {
        saveServeur(all);
        return btn.editReply({ content: `⚠️ Arrêté en cours de route : ${err.message}\n${delCat} catégorie(s) et ${delChan} salon(s) déjà supprimés. Relance \`/serveur-annuler\` pour finir.` });
      }
    },
  },

  // ---------- /aide-plus : toutes les commandes, avec ce que fait chacune
  {
    data: new SlashCommandBuilder()
      .setName('aide-plus')
      .setDescription('Toutes les commandes, avec une phrase qui explique ce que fait chacune')
      .addStringOption((o) =>
        o
          .setName('categorie')
          .setDescription('Voir une seule catégorie (par défaut : tout)')
          .addChoices(...HELP_CATEGORIES.map((c) => ({ name: c.title, value: c.id }))),
      ),
    async execute(i) {
      const only = i.options.getString('categorie');
      const cats = only ? HELP_CATEGORIES.filter((c) => c.id === only) : HELP_CATEGORIES;
      const embeds = cats.map((c) =>
        new EmbedBuilder()
          .setTitle(c.title)
          .setColor(0x5865f2)
          .setDescription(c.lines.map(([cmd, text]) => `**${cmd}**\n${text}`).join('\n\n')),
      );
      embeds[embeds.length - 1].setFooter({ text: 'Certaines commandes demandent une permission (bannir, gérer les rôles, etc.).' });
      // Un seul message : une carte par catégorie (le tout reste sous la limite de Discord)
      await i.reply({ embeds, flags: EPH });
    },
  },

  // ---------- /bump-auto
  {
    data: new SlashCommandBuilder()
      .setName('bump-auto')
      .setDescription('Rappel automatique de bump toutes les 2 heures')
      .addSubcommand((sc) =>
        sc
          .setName('activer')
          .setDescription('Activer le rappel de bump toutes les 2 heures')
          .addChannelOption((o) =>
            o.setName('salon').setDescription('Salon du rappel (par défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner (optionnel)')),
      )
      .addSubcommand((sc) => sc.setName('desactiver').setDescription('Arrêter le rappel de bump'))
      .addSubcommand((sc) => sc.setName('statut').setDescription('Voir si le rappel est actif'))
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const sub = i.options.getSubcommand();
      const data = loadBump();

      if (sub === 'activer') {
        const channel = i.options.getChannel('salon') ?? i.channel;
        const role = i.options.getRole('role');
        const me = i.guild.members.me;
        const perms = channel.permissionsFor(me);
        if (!perms?.has(P.ViewChannel) || !perms.has(P.SendMessages)) {
          return i.reply({ content: `❌ Je ne peux pas écrire dans ${channel}.`, flags: EPH });
        }
        data[i.guildId] = {
          botId: i.client.user.id,
          channelId: channel.id,
          roleId: role?.id ?? null,
          next: Date.now() + BUMP_INTERVAL,
        };
        saveBump(data);
        return i.reply({
          content: `✅ Rappel de bump activé dans ${channel}${role ? ` (mention de ${role})` : ''}.\nPremier rappel ${time(Math.floor(data[i.guildId].next / 1000), 'R')}, puis toutes les 2 heures.`,
          flags: EPH,
        });
      }

      if (sub === 'desactiver') {
        if (!data[i.guildId]) return i.reply({ content: "❌ Le rappel n'est pas activé.", flags: EPH });
        delete data[i.guildId];
        saveBump(data);
        return i.reply({ content: '🛑 Rappel de bump arrêté.', flags: EPH });
      }

      const cfg = data[i.guildId];
      if (!cfg) return i.reply({ content: "ℹ️ Le rappel de bump n'est pas activé. Utilise `/bump-auto activer`.", flags: EPH });
      return i.reply({
        content: `✅ Rappel actif dans <#${cfg.channelId}>${cfg.roleId ? ` (mention de <@&${cfg.roleId}>)` : ''}.\nProchain rappel ${time(Math.floor(cfg.next / 1000), 'R')}.`,
        flags: EPH,
      });
    },
  },

  // ---------- /programmer
  {
    data: new SlashCommandBuilder()
      .setName('programmer')
      .setDescription('Programmer un message à une date et une heure précises')
      .addStringOption((o) => o.setName('message').setDescription('Le message à envoyer').setRequired(true))
      .addStringOption((o) => o.setName('date').setDescription('Date au format JJ/MM/AAAA (ex: 25/12/2026)').setRequired(true))
      .addStringOption((o) => o.setName('heure').setDescription('Heure au format HH:MM (ex: 18:30)').setRequired(true))
      .addChannelOption((o) =>
        o.setName('salon').setDescription('Salon de destination (par défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const message = i.options.getString('message').replaceAll('\\n', '\n');
      const dateStr = i.options.getString('date').trim();
      const heureStr = i.options.getString('heure').trim().replace('h', ':');
      const channel = i.options.getChannel('salon') ?? i.channel;

      if (message.length > 2000) return i.reply({ content: '❌ Message trop long (2000 caractères max).', flags: EPH });

      const d = dateStr.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
      const h = heureStr.match(/^(\d{1,2}):(\d{2})$/);
      if (!d || !h) {
        return i.reply({ content: '❌ Format invalide. Exemple : date `25/12/2026` et heure `18:30`.', flags: EPH });
      }
      const [day, month, year] = [+d[1], +d[2], +d[3]];
      const [hour, minute] = [+h[1], +h[2]];
      const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
      if (
        check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
        hour > 23 || minute > 59
      ) {
        return i.reply({ content: "❌ Cette date ou cette heure n'existe pas.", flags: EPH });
      }

      const timestamp = parisToTimestamp(year, month, day, hour, minute);
      if (timestamp <= Date.now()) return i.reply({ content: '❌ Cette date est déjà passée.', flags: EPH });

      const list = loadSchedule();
      const id = Date.now().toString(36);
      list.push({ id, botId: i.client.user.id, guildId: i.guildId, channelId: channel.id, content: message, timestamp, authorId: i.user.id });
      saveSchedule(list);

      await i.reply({
        content: `✅ Message programmé dans ${channel} pour ${time(Math.floor(timestamp / 1000), 'F')} (${time(Math.floor(timestamp / 1000), 'R')}).\nID : \`${id}\` (heure de Paris)`,
        flags: EPH,
      });
    },
  },

  // ---------- /programmations
  {
    data: new SlashCommandBuilder()
      .setName('programmations')
      .setDescription('Voir les messages programmés du serveur')
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const list = loadSchedule()
        .filter((m) => m.guildId === i.guildId)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (!list.length) return i.reply({ content: '📭 Aucun message programmé.', flags: EPH });
      const embed = new EmbedBuilder()
        .setTitle('🕐 Messages programmés')
        .setColor(0x5865f2)
        .addFields(
          list.slice(0, 25).map((m) => ({
            name: `${m.id} • ${time(Math.floor(m.timestamp / 1000), 'f')}`,
            value: `<#${m.channelId}>\n${m.content.length > 150 ? m.content.slice(0, 150) + '…' : m.content}`,
          })),
        );
      await i.reply({ embeds: [embed], flags: EPH });
    },
  },

  // ---------- /annuler-programmation
  {
    data: new SlashCommandBuilder()
      .setName('annuler-programmation')
      .setDescription('Annuler un message programmé')
      .addStringOption((o) => o.setName('id').setDescription('ID du message (voir /programmations)').setRequired(true))
      .setDefaultMemberPermissions(P.ManageMessages)
      .setDMPermission(false),
    async execute(i) {
      const id = i.options.getString('id').trim();
      const list = loadSchedule();
      const found = list.find((m) => m.id === id && m.guildId === i.guildId);
      if (!found) return i.reply({ content: '❌ Aucun message programmé avec cet ID.', flags: EPH });
      saveSchedule(list.filter((m) => m !== found));
      await i.reply({ content: `🗑️ Message programmé \`${id}\` annulé.`, flags: EPH });
    },
  },

  // ---------- /role
  {
    data: new SlashCommandBuilder()
      .setName('role')
      .setDescription('Gérer les rôles')
      .addSubcommand((s) =>
        s
          .setName('creer')
          .setDescription('Créer un nouveau rôle')
          .addStringOption((o) => o.setName('nom').setDescription('Nom du rôle').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: ff0000)'))
          .addBooleanOption((o) => o.setName('separer').setDescription('Afficher les membres du rôle séparément'))
          .addBooleanOption((o) => o.setName('mentionnable').setDescription('Tout le monde peut mentionner ce rôle'))
          .addStringOption((o) =>
            o
              .setName('permissions')
              .setDescription('Permissions du rôle : commence à taper, plusieurs possibles (séparées par une virgule)')
              .setAutocomplete(true),
          )
          .addIntegerOption((o) =>
            o
              .setName('position')
              .setDescription('Hauteur du rôle : 1 = tout en haut (sous mon rôle), plus le nombre est grand, plus il descend')
              .setMinValue(1),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('modifier')
          .setDescription("Modifier un rôle (nom, couleur, permissions, position…)")
          .addRoleOption((o) => o.setName('role').setDescription('Le rôle à modifier').setRequired(true))
          .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setMaxLength(100))
          .addStringOption((o) => o.setName('couleur').setDescription('Nouvelle couleur hex (ex: ff0000)'))
          .addBooleanOption((o) => o.setName('separer').setDescription('Afficher les membres du rôle séparément'))
          .addBooleanOption((o) => o.setName('mentionnable').setDescription('Tout le monde peut mentionner ce rôle'))
          .addStringOption((o) =>
            o
              .setName('permissions')
              .setDescription('Permissions à ajouter / retirer / définir : commence à taper, plusieurs possibles (virgule)')
              .setAutocomplete(true),
          )
          .addStringOption((o) =>
            o
              .setName('mode_permissions')
              .setDescription('Que faire des permissions choisies ? (par défaut : ajouter)')
              .addChoices(
                { name: 'Ajouter à celles du rôle', value: 'ajouter' },
                { name: 'Retirer du rôle', value: 'retirer' },
                { name: 'Remplacer toutes les permissions', value: 'remplacer' },
              ),
          )
          .addIntegerOption((o) =>
            o
              .setName('position')
              .setDescription('Hauteur du rôle : 1 = tout en haut (sous mon rôle), plus le nombre est grand, plus il descend')
              .setMinValue(1),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('supprimer')
          .setDescription('Supprimer un rôle du serveur')
          .addRoleOption((o) => o.setName('role').setDescription('Le rôle à supprimer').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('ajouter')
          .setDescription('Ajouter un rôle à un membre (il garde ses autres rôles)')
          .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('Le rôle à ajouter').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('retirer')
          .setDescription('Retirer un rôle à un membre (il garde ses autres rôles)')
          .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('Le rôle à retirer').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('remplacer')
          .setDescription('Remplacer un rôle par un autre (ex: Administrateur → Normal)')
          .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true))
          .addRoleOption((o) => o.setName('ancien').setDescription('Le rôle à retirer').setRequired(true))
          .addRoleOption((o) => o.setName('nouveau').setDescription('Le rôle à mettre à la place').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('voir')
          .setDescription("Voir les rôles d'un membre, ou tous les rôles du serveur")
          .addUserOption((o) => o.setName('membre').setDescription('Le membre (sans membre : tous les rôles du serveur)')),
      )
      .setDefaultMemberPermissions(P.ManageRoles)
      .setDMPermission(false),
    async execute(i, { bypass } = {}) {
      const sub = i.options.getSubcommand();
      const noPing = { parse: [] };

      if (sub === 'creer') {
        const color = parseHex(i.options.getString('couleur'), '99aab5');
        if (color === null) return i.reply({ content: '❌ Couleur invalide (ex: `ff0000`).', flags: EPH });
        const { perms, unknown } = parsePermissions(i.options.getString('permissions'));
        if (unknown.length)
          return i.reply({
            content: `❌ Permission inconnue : ${unknown.map((u) => `\`${u}\``).join(', ')}. Choisis dans la liste qui apparaît quand tu tapes.`,
            flags: EPH,
          });
        const missing = missingPerms(i, perms, bypass);
        if (missing.length)
          return i.reply({
            content: `❌ Tu ne peux pas donner une permission que tu n'as pas toi-même : ${missing.map((p) => p.label).join(', ')}.`,
            flags: EPH,
          });
        const role = await i.guild.roles.create({
          name: i.options.getString('nom'),
          permissions: perms.map((p) => p.bit),
          color,
          hoist: i.options.getBoolean('separer') ?? false,
          mentionable: i.options.getBoolean('mentionnable') ?? false,
          reason: `Créé par ${i.user.tag}`,
        });
        let placement = ' Il est tout en bas de la liste : utilise l\'option `position` ou déplace-le dans les paramètres du serveur.';
        const rank = i.options.getInteger('position');
        if (rank !== null) {
          const { target, maxPos } = targetPosition(i, rank, bypass);
          try {
            await role.setPosition(target);
            placement = target >= maxPos ? ' Placé tout en haut (juste sous mon rôle).' : ` Placé en position ${rank} depuis le haut.`;
            if (rank > 1 && target >= maxPos) placement = ' Placé au plus haut possible (juste sous mon rôle).';
          } catch (err) {
            placement = ` ⚠️ Je n'ai pas pu le déplacer (${err.message}).`;
          }
        }
        return i.reply({
          content: `✅ Rôle ${role} créé${perms.length ? ` avec ${perms.length} permission(s) : ${perms.map((p) => p.label).join(', ')}` : ''}.${placement}`,
          flags: EPH,
          allowedMentions: noPing,
        });
      }

      if (sub === 'modifier') {
        const role = i.options.getRole('role');
        const err = checkRoleManage(i, role, bypass);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });

        const newName = i.options.getString('nom');
        const colorText = i.options.getString('couleur');
        const hoist = i.options.getBoolean('separer');
        const mentionable = i.options.getBoolean('mentionnable');
        const permText = i.options.getString('permissions');
        const rank = i.options.getInteger('position');
        const mode = i.options.getString('mode_permissions') ?? 'ajouter';

        if (newName === null && colorText === null && hoist === null && mentionable === null && permText === null && rank === null)
          return i.reply({ content: "❌ Rien à modifier : choisis au moins une option (nom, couleur, permissions, position…).", flags: EPH });

        const edits = {};
        const done = [];
        if (newName !== null) {
          edits.name = newName;
          done.push(`nom → **${newName}**`);
        }
        if (colorText !== null) {
          const color = parseHex(colorText);
          if (color === null) return i.reply({ content: '❌ Couleur invalide (ex: `ff0000`).', flags: EPH });
          edits.color = color;
          done.push(`couleur → #${colorText.replace('#', '').toLowerCase()}`);
        }
        if (hoist !== null) {
          edits.hoist = hoist;
          done.push(hoist ? 'affiché séparément' : 'plus affiché séparément');
        }
        if (mentionable !== null) {
          edits.mentionable = mentionable;
          done.push(mentionable ? 'mentionnable' : 'non mentionnable');
        }
        if (permText !== null) {
          const { perms, unknown } = parsePermissions(permText);
          if (unknown.length)
            return i.reply({
              content: `❌ Permission inconnue : ${unknown.map((u) => `\`${u}\``).join(', ')}. Choisis dans la liste qui apparaît quand tu tapes.`,
              flags: EPH,
            });
          if (!perms.length) return i.reply({ content: '❌ Aucune permission valide choisie.', flags: EPH });
          if (mode !== 'retirer') {
            const missing = missingPerms(i, perms, bypass);
            if (missing.length)
              return i.reply({
                content: `❌ Tu ne peux pas donner une permission que tu n'as pas toi-même : ${missing.map((p) => p.label).join(', ')}.`,
                flags: EPH,
              });
          }
          let bits = mode === 'remplacer' ? 0n : BigInt(role.permissions.bitfield);
          for (const p of perms) bits = mode === 'retirer' ? bits & ~BigInt(p.bit) : bits | BigInt(p.bit);
          edits.permissions = bits;
          const names = perms.map((p) => p.label).join(', ');
          done.push(
            mode === 'retirer' ? `permissions retirées : ${names}` : mode === 'remplacer' ? `permissions remplacées par : ${names}` : `permissions ajoutées : ${names}`,
          );
        }

        if (Object.keys(edits).length) await role.edit({ ...edits, reason: `Modifié par ${i.user.tag}` });

        if (rank !== null) {
          const { target, maxPos } = targetPosition(i, rank, bypass);
          try {
            await role.setPosition(target);
            done.push(target >= maxPos ? 'placé au plus haut possible (sous mon rôle)' : `placé en position ${rank} depuis le haut`);
          } catch (e) {
            done.push(`⚠️ position non changée (${e.message})`);
          }
        }
        return i.reply({
          content: `✅ Rôle ${role} modifié :\n${done.map((d) => `• ${d}`).join('\n')}`,
          flags: EPH,
          allowedMentions: noPing,
        });
      }

      if (sub === 'supprimer') {
        const role = i.options.getRole('role');
        if (role.id === i.guildId) return i.reply({ content: '❌ Tu ne peux pas supprimer le rôle @everyone.', flags: EPH });
        if (role.managed)
          return i.reply({ content: "❌ Ce rôle est géré par une intégration (bot) : il disparaît quand tu retires le bot.", flags: EPH });
        if (role.position >= i.guild.members.me.roles.highest.position)
          return i.reply({
            content: '❌ Ce rôle est égal ou supérieur au mien. Monte mon rôle dans la liste (Paramètres du serveur → Rôles).',
            flags: EPH,
          });
        if (!bypass && i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position)
          return i.reply({ content: '❌ Ce rôle est égal ou supérieur au tien.', flags: EPH });
        const name = role.name;
        const count = role.members.size;
        await role.delete(`Supprimé par ${i.user.tag}`);
        return i.reply({
          content: `🗑️ Rôle **${name}** supprimé${count ? ` (il était porté par ${count} membre(s))` : ''}.`,
          flags: EPH,
          allowedMentions: noPing,
        });
      }

      if (sub === 'voir') {
        // Sans membre : liste de tous les rôles du serveur avec le nombre de membres de chacun
        if (!i.options.getUser('membre')) {
          await i.deferReply({ flags: EPH });
          await i.guild.members.fetch().catch(() => {});
          const list = [...i.guild.roles.cache.values()].filter((r) => r.id !== i.guildId).sort((a, b) => b.position - a.position);
          let text = '';
          let shown = 0;
          for (const r of list) {
            const line = `${r} — ${r.members.size} membre(s)\n`;
            if ((text + line).length > 3900) break;
            text += line;
            shown++;
          }
          if (shown < list.length) text += `… et ${list.length - shown} autre(s) rôle(s)`;
          const embed = new EmbedBuilder()
            .setTitle(`🎭 Rôles de ${i.guild.name}`)
            .setColor(0x5865f2)
            .setDescription(text || 'Aucun rôle')
            .setFooter({ text: `${list.length} rôle(s) • ${i.guild.memberCount} membres sur le serveur` });
          return i.editReply({ embeds: [embed], allowedMentions: noPing });
        }

        const member = i.options.getMember('membre');
        if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });
        const roles = member.roles.cache
          .filter((r) => r.id !== i.guildId)
          .sort((a, b) => b.position - a.position)
          .map((r) => `${r}`);
        const embed = new EmbedBuilder()
          .setTitle(`🎭 Rôles de ${member.displayName}`)
          .setColor(member.displayColor || 0x5865f2)
          .setThumbnail(member.displayAvatarURL())
          .setDescription(roles.length ? roles.join(' ').slice(0, 4000) : 'Aucun rôle')
          .setFooter({ text: `${roles.length} rôle(s)` });
        return i.reply({ embeds: [embed], flags: EPH, allowedMentions: noPing });
      }

      const member = i.options.getMember('membre');
      if (!member) return i.reply({ content: '❌ Membre introuvable sur le serveur.', flags: EPH });

      if (sub === 'ajouter') {
        const role = i.options.getRole('role');
        const err = checkRoleChange(i, member, role);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
        if (member.roles.cache.has(role.id))
          return i.reply({ content: `ℹ️ ${member} a déjà le rôle ${role}.`, flags: EPH, allowedMentions: noPing });
        await member.roles.add(role, `Par ${i.user.tag}`);
        return i.reply({ content: `✅ Rôle ${role} ajouté à ${member}.`, flags: EPH, allowedMentions: noPing });
      }

      if (sub === 'retirer') {
        const role = i.options.getRole('role');
        const err = checkRoleChange(i, member, role);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
        if (!member.roles.cache.has(role.id))
          return i.reply({ content: `ℹ️ ${member} n'a pas le rôle ${role}.`, flags: EPH, allowedMentions: noPing });
        await member.roles.remove(role, `Par ${i.user.tag}`);
        return i.reply({ content: `✅ Rôle ${role} retiré à ${member}.`, flags: EPH, allowedMentions: noPing });
      }

      if (sub === 'remplacer') {
        const oldRole = i.options.getRole('ancien');
        const newRole = i.options.getRole('nouveau');
        if (oldRole.id === newRole.id)
          return i.reply({ content: '❌ Les deux rôles sont identiques.', flags: EPH });
        const err = checkRoleChange(i, member, oldRole) || checkRoleChange(i, member, newRole);
        if (err) return i.reply({ content: `❌ ${err}`, flags: EPH });
        if (!member.roles.cache.has(oldRole.id))
          return i.reply({ content: `ℹ️ ${member} n'a pas le rôle ${oldRole}.`, flags: EPH, allowedMentions: noPing });
        await member.roles.add(newRole, `Remplacement par ${i.user.tag}`);
        await member.roles.remove(oldRole, `Remplacement par ${i.user.tag}`);
        return i.reply({ content: `🔁 ${member} : ${oldRole} → ${newRole}`, flags: EPH, allowedMentions: noPing });
      }
    },
  },

  // ---------- /ticket
  {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Système de tickets')
      .addSubcommand((s) =>
        s
          .setName('panneau')
          .setDescription('Poster le panneau pour créer des tickets')
          .addStringOption((o) => o.setName('titre').setDescription('Titre du panneau').setMaxLength(200))
          .addStringOption((o) => o.setName('description').setDescription('Texte du panneau (\\n pour aller à la ligne)'))
          .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: ff0000)'))
          .addChannelOption((o) =>
            o.setName('salon').setDescription('Salon du panneau (par défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('option-ajouter')
          .setDescription('Ajouter une ou plusieurs options au menu')
          .addStringOption((o) =>
            o
              .setName('noms')
              .setDescription("Un nom (emoji devant possible : 🚨 Signalement). Autres : noms2, noms3…")
              .setRequired(true)
              .setMaxLength(1000),
          )
          .addStringOption(nomsOption(2))
          .addStringOption(nomsOption(3))
          .addStringOption(nomsOption(4))
          .addStringOption(nomsOption(5))
          .addStringOption(nomsOption(6))
          .addStringOption(nomsOption(7))
          .addStringOption(nomsOption(8))
          .addStringOption(nomsOption(9))
          .addStringOption(nomsOption(10))
          .addStringOption((o) => o.setName('description').setDescription("Description sous l'option (si tu n'en ajoutes qu'une seule)").setMaxLength(100)),
      )
      .addSubcommand((s) =>
        s
          .setName('option-retirer')
          .setDescription('Retirer une ou plusieurs options du menu')
          .addStringOption((o) => o.setName('noms').setDescription("Un nom à retirer. Autres : noms2, noms3…").setRequired(true).setMaxLength(1000))
          .addStringOption(nomsOption(2))
          .addStringOption(nomsOption(3))
          .addStringOption(nomsOption(4))
          .addStringOption(nomsOption(5))
          .addStringOption(nomsOption(6))
          .addStringOption(nomsOption(7))
          .addStringOption(nomsOption(8))
          .addStringOption(nomsOption(9))
          .addStringOption(nomsOption(10)),
      )
      .addSubcommand((s) => s.setName('options').setDescription('Voir les options du menu'))
      .addSubcommand((s) =>
        s
          .setName('questions')
          .setDescription('Définir les questions du formulaire (5 max)')
          .addStringOption((o) =>
            o.setName('liste').setDescription('Questions séparées par ; — vide : voir la liste — « defaut » : réinitialiser').setMaxLength(1000),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('config')
          .setDescription("Régler l'équipe, la catégorie et le salon des demandes")
          .addChannelOption((o) =>
            o.setName('salon_demandes').setDescription('Salon réservé au staff où arrivent les demandes').addChannelTypes(ChannelType.GuildText),
          )
          .addRoleOption((o) => o.setName('role_staff').setDescription('Rôle qui voit et gère tous les tickets'))
          .addChannelOption((o) =>
            o.setName('categorie').setDescription('Catégorie où créer les salons de tickets').addChannelTypes(ChannelType.GuildCategory),
          ),
      )
      .setDefaultMemberPermissions(P.ManageChannels)
      .setDMPermission(false),
    async execute(i) {
      const sub = i.options.getSubcommand();
      const noPing = { parse: [] };

      if (sub === 'panneau') {
        const color = parseHex(i.options.getString('couleur'));
        if (color === null) return i.reply({ content: '❌ Couleur invalide (ex: `ff0000`).', flags: EPH });
        const channel = i.options.getChannel('salon') ?? i.channel;
        const conf = ticketConf(i.guildId);
        if (!requestChannelOf(i.guild, conf))
          return i.reply({
            content: "❌ Définis d'abord le salon où arriveront les demandes : `/ticket config salon_demandes:#ton-salon-staff`",
            flags: EPH,
          });
        const embed = new EmbedBuilder()
          .setTitle(i.options.getString('titre') ?? '🎫 Support')
          .setDescription(
            (i.options.getString('description') ?? 'Besoin d\'aide ? Ouvre un ticket et un membre de l\'équipe te répondra.').replaceAll('\\n', '\n'),
          )
          .setColor(color);
        await sendAs(i.client, channel, { embeds: [embed], components: ticketPanelComponents(conf) });
        const tips = [];
        if (!conf.staffRoleId) tips.push("Pense à régler le rôle de l'équipe : `/ticket config`.");
        return i.reply({ content: `✅ Panneau envoyé dans ${channel}.${tips.length ? `\n${tips.join('\n')}` : ''}`, flags: EPH });
      }

      if (sub === 'option-ajouter') {
        const items = collectNoms(i).map(parseOptionItem).filter((it) => it.label);
        if (!items.length) return i.reply({ content: '❌ Aucun nom valide.', flags: EPH });
        const description = items.length === 1 ? i.options.getString('description')?.trim() || null : null;

        const options = [...ticketConf(i.guildId).options];
        const added = [];
        const skipped = [];
        for (const it of items) {
          const id = slug(it.label).slice(0, 80);
          if (options.length >= 25) {
            skipped.push(`${it.label} (25 options maximum)`);
            continue;
          }
          if (options.some((o) => o.id === id)) {
            skipped.push(`${it.label} (existe déjà)`);
            continue;
          }
          try {
            // vérifie que l'option (et son emoji) sont valides pour Discord
            const test = new StringSelectMenuOptionBuilder().setLabel(it.label).setValue(id);
            if (description) test.setDescription(description);
            if (it.emoji) test.setEmoji(toEmoji(it.emoji));
            test.toJSON();
          } catch {
            skipped.push(`${it.label} (nom ou emoji invalide, 100 caractères max)`);
            continue;
          }
          options.push({ id, label: it.label, description, emoji: it.emoji });
          added.push(`${it.emoji ? `${it.emoji} ` : ''}${it.label}`);
        }
        if (added.length)
          updateTicketConf(i.guildId, (c) => {
            c.options = options;
          });
        const lines = [];
        if (added.length) lines.push(`✅ Ajouté : ${added.join(', ')}.\nReposte le panneau avec \`/ticket panneau\` pour mettre le menu à jour.`);
        if (skipped.length) lines.push(`⚠️ Ignoré : ${skipped.join(', ')}.`);
        return i.reply({ content: lines.join('\n'), flags: EPH });
      }

      if (sub === 'option-retirer') {
        const names = collectNoms(i).map((s) => s.trim()).filter(Boolean);
        const conf = ticketConf(i.guildId);
        const removedIds = new Set();
        const removed = [];
        const notFound = [];
        for (const raw of names) {
          const lower = raw.toLowerCase();
          const found = conf.options.find(
            (o) => o.label.toLowerCase() === lower || o.id === slug(raw) || o.label.toLowerCase() === parseOptionItem(raw).label.toLowerCase(),
          );
          if (found) {
            removedIds.add(found.id);
            removed.push(found.label);
          } else notFound.push(raw);
        }
        if (removedIds.size)
          updateTicketConf(i.guildId, (c) => {
            c.options = c.options.filter((o) => !removedIds.has(o.id));
          });
        const lines = [];
        if (removed.length) lines.push(`🗑️ Retiré : ${removed.join(', ')}.\nReposte le panneau pour mettre le menu à jour.`);
        if (notFound.length) {
          const list = conf.options.map((o) => o.label).join(', ') || 'aucune option';
          lines.push(`⚠️ Introuvable : ${notFound.join(', ')}. (Options actuelles : ${list})`);
        }
        return i.reply({ content: lines.join('\n'), flags: EPH });
      }

      if (sub === 'options') {
        const conf = ticketConf(i.guildId);
        if (!conf.options.length)
          return i.reply({
            content: 'Aucune option : le panneau affiche un simple bouton « Créer un ticket ».\nAjoutes-en avec `/ticket option-ajouter`.',
            flags: EPH,
          });
        const lines = conf.options.map((o) => `${o.emoji ? `${o.emoji} ` : ''}**${o.label}**${o.description ? ` — ${o.description}` : ''}`);
        return i.reply({ content: `📋 Options du menu :\n${lines.join('\n')}`, flags: EPH });
      }

      if (sub === 'questions') {
        const raw = i.options.getString('liste');
        if (raw !== null) {
          if (raw.trim().toLowerCase() === 'defaut') {
            updateTicketConf(i.guildId, (c) => {
              c.questions = defaultTicketConf().questions;
            });
          } else {
            const qs = raw.split(';').map((s) => s.trim()).filter(Boolean);
            if (!qs.length) return i.reply({ content: '❌ Aucune question valide.', flags: EPH });
            if (qs.length > 5) return i.reply({ content: '❌ 5 questions maximum (limite de Discord).', flags: EPH });
            const tooLong = qs.find((q) => q.length > 45);
            if (tooLong)
              return i.reply({
                content: `❌ « ${tooLong} » fait ${tooLong.length} caractères : 45 maximum par question (limite de Discord).`,
                flags: EPH,
              });
            updateTicketConf(i.guildId, (c) => {
              c.questions = qs;
            });
          }
        }
        const list = ticketConf(i.guildId).questions.map((q, n) => `${n + 1}. ${q}`).join('\n');
        return i.reply({
          content: `${raw !== null ? '✅ Questions enregistrées.\n' : ''}📝 Questions du formulaire :\n${list}\n\n*Pour les changer : \`/ticket questions liste:Question 1 ; Question 2\`*`,
          flags: EPH,
        });
      }

      if (sub === 'config') {
        const requestChannel = i.options.getChannel('salon_demandes');
        const role = i.options.getRole('role_staff');
        const category = i.options.getChannel('categorie');
        if (requestChannel || role || category) {
          updateTicketConf(i.guildId, (c) => {
            if (requestChannel) c.requestChannelId = requestChannel.id;
            if (role) c.staffRoleId = role.id;
            if (category) c.categoryId = category.id;
          });
        }
        const conf = ticketConf(i.guildId);
        return i.reply({
          content:
            `${requestChannel || role || category ? '✅ Config enregistrée.\n' : ''}` +
            `📨 Salon des demandes : ${conf.requestChannelId ? `<#${conf.requestChannelId}>` : '*non défini (obligatoire)*'}\n` +
            `👥 Rôle équipe : ${conf.staffRoleId ? `<@&${conf.staffRoleId}>` : '*non défini (seuls les admins voient les tickets)*'}\n` +
            `📁 Catégorie : ${conf.categoryId ? `<#${conf.categoryId}>` : '*non définie (salons créés à la racine)*'}`,
          flags: EPH,
          allowedMentions: noPing,
        });
      }
    },
  },
];

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

// ------------------------------------------------------------ Démarrage des bots
function startBot(token, numero) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
  });

  client.once('clientReady', async () => {
    await client.application.commands.set(
      commands.map((c) => {
        const json = c.data.toJSON();
        if (OPEN_COMMANDS.has(json.name)) delete json.default_member_permissions;
        return json;
      }),
    );
    client.user.setActivity('/aide', { type: ActivityType.Playing });
    runSchedule(client);
    runBump(client);
    setInterval(() => { runSchedule(client); runBump(client); }, 20_000);
    startSync(client);
    console.log(`[Bot ${numero}] Connecté en tant que ${client.user.tag} — ${commands.length} commandes enregistrées`);
    console.log(
      `[Bot ${numero}] Lien d'invitation : https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`,
    );
  });

  client.on('interactionCreate', async (interaction) => {
    // Boutons, menus et formulaires du système de tickets
    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith('ticket:')) return;
      try {
        await handleTicketInteraction(interaction);
      } catch (err) {
        console.error(err);
        const msg = { content: `❌ Une erreur est survenue : \`${err.message}\``, flags: EPH };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      }
      return;
    }

    // Suggestions de l'option « permissions » de /role creer
    if (interaction.isAutocomplete()) {
      try {
        if (interaction.commandName !== 'role') return;
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'permissions') return;
        const parts = String(focused.value).split(',');
        const current = norm(parts.pop());
        const chosen = parts.map((x) => x.trim()).filter(Boolean);
        const already = new Set(parsePermissions(chosen.join(',')).perms.map((p) => p.key));
        const prefix = chosen.length ? `${chosen.join(', ')}, ` : '';
        const results = PERM_LIST.filter((p) => !already.has(p.key) && (!current || p.nl.includes(current) || p.nk.includes(current)))
          .slice(0, 25)
          .map((p) => ({ name: (prefix + p.label).slice(-100), value: (prefix + p.label).slice(0, 100) }));
        await interaction.respond(results);
      } catch {}
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const cmd = commandMap.get(interaction.commandName);
    if (!cmd) return;

    const needed = OPEN_COMMANDS.get(interaction.commandName);
    if (needed !== undefined) {
      const sub = interaction.options.getSubcommand(false);
      const isPublic = sub && PUBLIC_SUBCOMMANDS.has(`${interaction.commandName}:${sub}`);
      const allowed = isPublic || isOwner(interaction.user.id) || interaction.memberPermissions?.has(needed);
      if (!allowed)
        return interaction.reply({ content: "❌ Tu n'as pas la permission d'utiliser cette commande.", flags: EPH });
    }

    try {
      await cmd.execute(interaction, { bypass: isOwner(interaction.user.id) });
    } catch (err) {
      console.error(err);
      const msg = { content: `❌ Une erreur est survenue : \`${err.message}\``, flags: EPH };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  });

  client.login(token).catch((err) => console.error(`[Bot ${numero}] Connexion impossible :`, err.message));
}

if (!TOKENS.length) {
  console.error('❌ Aucun token trouvé : mets DISCORD_TOKEN (et DISCORD_TOKEN_2, DISCORD_TOKEN_3...) dans le fichier .env');
  process.exit(1);
}
TOKENS.forEach((token, idx) => startBot(token, idx + 1));
