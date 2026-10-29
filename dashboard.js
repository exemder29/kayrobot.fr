const CLIENT_ID = '1563284812351938611';
let userGuilds = [];
let selectedGuild = null;
let rawChannelsList = [];

// Les appels au bot passent par le Worker Cloudflare (le token du bot reste secret côté serveur).
// Colle ici l'URL de ton Worker (sans "/" à la fin), ex : https://kayrobot-proxy.moncompte.workers.dev
const BOT_PROXY_URL = 'https://kayrobot-proxy.exem029.workers.dev';

function proxyConfigured() {
  return /^https:\/\/.+/.test(BOT_PROXY_URL);
}

window.addEventListener('DOMContentLoaded', () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');

  if (accessToken) {
    localStorage.setItem('discord_token', accessToken);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const token = localStorage.getItem('discord_token');
  if (!token) {
    window.location.href = 'index.html';
    return;
  }

  // Vérifier le Worker (affiche seulement son état)
  checkProxy();

  initDashboard(token);
  initEventListeners();
});

function initDashboard(token) {
  fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => {
    if (!res.ok) throw new Error('Token Discord invalide ou expiré');
    return res.json();
  })
  .then(user => {
    document.getElementById('user-display-name').textContent = user.username;
    if (user.avatar) {
      document.getElementById('user-avatar').src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    }
    fetchUserGuilds(token);
  })
  .catch(() => logout());
}

function fetchUserGuilds(token) {
  const loading = document.getElementById('guilds-loading');
  loading.classList.remove('hidden');

  fetch('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => {
    if (!res.ok) throw new Error('Token Discord invalide ou expiré');
    return res.json();
  })
  .then(guilds => {
    userGuilds = guilds.filter(g => g.owner || (parseInt(g.permissions) & 0x8) === 0x8);
    renderGuilds(userGuilds);
  })
  .catch(err => {
    console.error(err);
    loading.innerHTML = '<p class="text-sm text-discord-red">Erreur lors de la récupération des serveurs.</p>';
  });
}

const presenceCache = new Map(); // guildId -> bot présent ou non

const INVITE_URL = guildId =>
  `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&integration_type=0&scope=bot+applications.commands&guild_id=${guildId}&disable_guild_select=true`;

function guildIconUrl(g) {
  return g && g.icon
    ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
}

function renderGuilds(guilds) {
  const container = document.getElementById('guilds-container');
  const loading = document.getElementById('guilds-loading');
  container.innerHTML = '';
  loading.classList.add('hidden');
  container.classList.remove('hidden');

  if (guilds.length === 0) {
    container.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>Aucun serveur trouvé</strong><p>Tu dois être propriétaire ou administrateur d\'un serveur pour le gérer ici.</p></div>';
    return;
  }

  const queue = [];
  guilds.forEach(guild => {
    const card = document.createElement('article');
    card.className = 'guild';
    card.innerHTML = `
      <div class="guild-top">
        <img alt="">
        <div style="min-width:0">
          <h4 class="guild-name"></h4>
          <span class="role">${guild.owner ? 'Propriétaire' : 'Administrateur'}</span>
        </div>
      </div>
      <div class="guild-actions">
        <span class="state">Vérification du bot…</span>
        <span class="guild-btns"></span>
      </div>`;
    card.querySelector('img').src = guildIconUrl(guild);
    card.querySelector('.guild-name').textContent = guild.name;
    container.appendChild(card);
    queue.push({ guild, card });
  });

  // Vérifie, 3 à la fois, si le bot est présent sur chaque serveur
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { guild, card } = queue[next++];
      const state = card.querySelector('.state');
      const btns = card.querySelector('.guild-btns');
      let present = presenceCache.has(guild.id) ? presenceCache.get(guild.id) : null;
      if (present === null) {
        try {
          await discordRequest('GET', `/guilds/${guild.id}`, undefined, undefined, guild.id);
          present = true;
        } catch (e) {
          present = /\b(403|404)\b/.test(e.message) ? false : null;
        }
        if (present !== null) presenceCache.set(guild.id, present);
      }
      if (present === true) {
        state.textContent = 'Bot présent'; state.className = 'state ok';
        btns.innerHTML = '<button class="btn btn-primary btn-small">Gérer</button>';
        btns.firstChild.addEventListener('click', () => selectGuild(guild.id, guild.name));
      } else if (present === false) {
        state.textContent = 'Bot absent'; state.className = 'state bad';
        btns.innerHTML = '<a class="btn btn-ok btn-small" target="_blank" rel="noopener">Inviter le bot</a>';
        btns.firstChild.href = INVITE_URL(guild.id);
      } else {
        state.textContent = 'Bot non vérifié'; state.className = 'state';
        btns.innerHTML = '<button class="btn btn-ghost btn-small">Gérer</button>';
        btns.firstChild.addEventListener('click', () => selectGuild(guild.id, guild.name));
      }
    }
  };
  [worker(), worker(), worker()];
}

function selectGuild(id, name) {
  selectedGuild = { id, name };
  const g = userGuilds.find(x => x.id === id);
  document.getElementById('selected-guild-label').textContent = name;
  document.getElementById('rail-guild-icon').src = guildIconUrl(g);
  const badge = document.getElementById('active-server-badge');
  badge.classList.remove('hidden');
  badge.textContent = name;

  loadGuildChannels(id);
  loadOverview();
  switchTab('overview');
}

const DISCORD_API = 'https://discord.com/api/v10';

// Message dans les listes de salons quand on ne peut pas charger les vrais salons
function setChannelDropdownsMessage(msg) {
  document.querySelectorAll('.guild-channels-dropdown').forEach(select => {
    select.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = msg;
    select.appendChild(opt);
  });
}

async function loadGuildChannels(guildId) {
  rawChannelsList = [];
  if (!proxyConfigured()) {
    setChannelDropdownsMessage('⚠️ URL du Worker non configurée dans dashboard.js (BOT_PROXY_URL)');
    return;
  }
  setChannelDropdownsMessage('Chargement des salons...');

  try {
    const channels = await discordRequest('GET', `/guilds/${guildId}/channels`);
    rawChannelsList = channels.filter(c => c.type === 0 || c.type === 5); // textuels + annonces
    populateAllChannelDropdowns(rawChannelsList);
    if (selectedGuild && selectedGuild.id === guildId) {
      overviewStats.channels = rawChannelsList.length;
      if (overviewStats.roles != null || overviewStats.members != null) renderOverviewMeta();
    }
  } catch (err) {
    console.error(err);
    let hint = 'erreur réseau : le Worker est injoignable (URL incorrecte ?)';
    if (/Session Discord/.test(err.message)) hint = 'session Discord expirée : reconnecte-toi';
    else if (/401/.test(err.message)) hint = 'Discord refuse le token du bot : vérifie le secret BOT_TOKEN du Worker (token régénéré ? bien copié en entier ?)';
    else if (/403/.test(err.message)) hint = `le bot n'est pas sur ce serveur ou n'a pas accès : invite-le avec le bouton "Ajouter le bot à un serveur"`;
    else if (/404|10004/.test(err.message)) hint = `le bot n'est pas sur ce serveur`;
    else if (/500/.test(err.message)) hint = 'le Worker n\'a pas de BOT_TOKEN configuré';
    else if (/429/.test(err.message)) hint = 'trop de requêtes, réessaie dans quelques secondes';
    setChannelDropdownsMessage(`❌ ${hint} [${err.message}]`);
  }
}

async function checkProxy() {
  const el = document.getElementById('token-state');
  const chip = document.getElementById('bot-chip');
  const setChip = (ok, text) => { chip.textContent = text; chip.className = `chip ${ok ? 'ok' : 'bad'}`; };

  if (!proxyConfigured()) {
    setChip(false, 'Worker non configuré');
    el.innerHTML = '<div class="notice error">L\'URL du Worker n\'est pas configurée (BOT_PROXY_URL dans dashboard.js).</div>';
    return;
  }
  try {
    const res = await fetch(`${BOT_PROXY_URL}/__check`);
    const d = await res.json();
    const ok = d.discordStatus === 200;
    setChip(ok, ok ? `${d.nomDuBot} est connecté` : 'Token du bot refusé');
    el.innerHTML = `<div class="notice ${ok ? '' : 'error'}"></div><pre class="diag"></pre>`;
    el.querySelector('.notice').textContent = ok
      ? `Connecté au bot « ${d.nomDuBot} » via le Worker sécurisé.`
      : 'Discord refuse le token du bot. Vérifie le secret BOT_TOKEN du Worker.';
    el.querySelector('pre').textContent =
      `Longueur du token : ${d.longueur} (environ 70 attendu)\n` +
      `Morceaux : ${d.morceaux} (3 attendus), longueurs ${(d.longueurs || []).join(' / ')}\n` +
      `ID du bot dans le token : ${d.idDansLeToken || 'illisible'} (attendu : ${CLIENT_ID})\n` +
      `Réponse de Discord : ${d.discordStatus} ${d.discordMessage || ''}`;
  } catch (e) {
    setChip(false, 'Worker injoignable');
    el.innerHTML = '<div class="notice error">Le Worker est injoignable.</div><pre class="diag"></pre>';
    el.querySelector('pre').textContent = e.message;
  }
}

function populateAllChannelDropdowns(channels) {
  document.querySelectorAll('.guild-channels-dropdown').forEach(select => {
    select.innerHTML = '<option value="">Choisis un salon</option>';
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `#${ch.name}`;
      select.appendChild(opt);
    });
  });
}

// Recherche dynamique dans les listes déroulantes de salons
window.filterChannels = function(inputElement, selectId) {
  const filter = inputElement.value.toLowerCase();
  const select = document.getElementById(selectId);
  if (!select) return;

  select.innerHTML = '<option value="">Choisis un salon</option>';
  rawChannelsList
    .filter(ch => ch.name.toLowerCase().includes(filter))
    .forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `#${ch.name}`;
      select.appendChild(opt);
    });
};

// ---------- Appels API Discord ----------

async function discordRequest(method, path, body, reason, guildOverride) {
  if (!proxyConfigured()) throw new UserInputError('URL du Worker non configurée (BOT_PROXY_URL dans dashboard.js).');
  const headers = { Authorization: `Bearer ${localStorage.getItem('discord_token')}` };
  const gid = guildOverride || (selectedGuild && selectedGuild.id);
  if (gid) headers['X-Guild-Id'] = gid;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);

  const res = await fetch(`${BOT_PROXY_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.message || '';
      if (j.code) detail += ` (code ${j.code})`;
    } catch (e) {}
    throw new Error(`${res.status} : ${detail || res.statusText}`);
  }
  if (res.status === 204) return null;
  try { return await res.json(); } catch (e) { return null; }
}

function modName() {
  const el = document.getElementById('user-display-name');
  return (el && el.textContent.trim()) || 'dashboard';
}

// Comme le bot : on prévient le membre en message privé (silencieux si ses MP sont fermés)
async function tryDM(userId, content) {
  try {
    const dm = await discordRequest('POST', '/users/@me/channels', { recipient_id: userId });
    await discordRequest('POST', `/channels/${dm.id}/messages`, { content });
  } catch (e) { /* MP fermés : on ignore, comme le bot */ }
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function requireSnowflake(id, label) {
  if (!/^\d{15,25}$/.test(id)) {
    throw new UserInputError(`${label} invalide : entrez l'ID numérique (clic droit > Copier l'identifiant, mode développeur activé).`);
  }
  return id;
}

class UserInputError extends Error {}

const SEND_MESSAGES = 1n << 11n;

// Salon requis pour ces commandes
const CHANNEL_FIELD = {
  'say': 'say-channel-select',
  'embed': 'embed-channel-select',
  'nettoyer': 'clear-channel-select',
  'mode-lent': 'slowmode-channel-select',
  'verrouiller': 'lock-channel-select',
  'deverrouiller': 'lock-channel-select',
  'ticket-config': 'ticket-req-channel-select',
  'ticket-panneau': 'ticket-panel-channel-select',
  'infos-serveur': 'info-channel-select'
};

window.executeBotCommand = async function(cmdName) {
  if (!selectedGuild) {
    toast('warn', 'Choisis un serveur', "Sélectionne d'abord un serveur dans « Mes serveurs ».");
    switchTab('servers');
    return;
  }

  if (!proxyConfigured()) {
    toast('error', 'Worker non configuré', "L'URL du Worker manque dans dashboard.js (BOT_PROXY_URL).");
    return;
  }

  const guildId = selectedGuild.id;
  const channelId = CHANNEL_FIELD[cmdName] ? val(CHANNEL_FIELD[cmdName]) : '';
  if (CHANNEL_FIELD[cmdName] && !channelId) {
    toast('warn', 'Choisis un salon', "Sélectionne un salon dans la liste. S'il n'y en a aucun, le bot doit être présent sur ce serveur.");
    return;
  }

  try {
    let okMsg = `✅ /${cmdName} exécutée sur "${selectedGuild.name}".`;

    switch (cmdName) {

      case 'say': {
        const content = val('say-msg');
        if (!content) throw new UserInputError('Entrez un message !');
        await discordRequest('POST', `/channels/${channelId}/messages`, {
          content: content.replaceAll('\\n', '\n'),
          allowed_mentions: { parse: [] }
        });
        okMsg = '✅ Message envoyé !';
        break;
      }

      case 'embed': {
        const title = val('embed-title');
        const description = val('embed-desc');
        if (!title && !description) throw new UserInputError('Entrez au moins un titre ou une description.');
        const color = parseInt((val('embed-color') || '#5865F2').replace('#', ''), 16);
        await discordRequest('POST', `/channels/${channelId}/messages`, {
          embeds: [{ title: title || undefined, description: description ? description.replaceAll('\\n', '\n') : undefined, color }]
        });
        okMsg = '✅ Embed posté !';
        break;
      }

      case 'bannir': {
        const user = requireSnowflake(val('ban-user'), 'ID du membre');
        const days = parseInt(val('ban-delete-days') || '0', 10);
        const reason = val('ban-reason') || 'Aucune raison';
        if (!(await askConfirm('Bannir ce membre ?', `Le membre ${user} sera banni du serveur et recevra un message privé.`, 'Bannir'))) return;
        await tryDM(user, `🔨 Tu as été **banni** de **${selectedGuild.name}**.\nRaison : ${val('ban-reason') || 'Aucune'}`);
        await discordRequest('PUT', `/guilds/${guildId}/bans/${user}`, { delete_message_seconds: days * 86400 }, `${modName()} : ${reason}`);
        okMsg = `✅ Membre ${user} banni.`;
        break;
      }

      case 'sourdine': {
        const user = requireSnowflake(val('timeout-user'), 'ID du membre');
        const amount = parseInt(val('timeout-duration'), 10);
        if (!amount || amount < 1) throw new UserInputError('Entrez une durée valide.');
        const mult = { m: 60e3, h: 3600e3, d: 86400e3 }[val('timeout-unit')] || 60e3;
        const ms = amount * mult;
        if (ms > 28 * 86400e3) throw new UserInputError('Discord limite la sourdine à 28 jours maximum.');
        const reason = val('timeout-reason') || 'Aucune raison';
        await discordRequest('PATCH', `/guilds/${guildId}/members/${user}`,
          { communication_disabled_until: new Date(Date.now() + ms).toISOString() }, `${modName()} : ${reason}`);
        await tryDM(user, `🔇 Tu as été mis en sourdine **${amount} ${({ m: 'min', h: 'h', d: 'j' })[val('timeout-unit')] || 'min'}** sur **${selectedGuild.name}**.\nRaison : ${val('timeout-reason') || 'Aucune'}`);
        okMsg = `✅ Membre ${user} mis en sourdine.`;
        break;
      }

      case 'expulser': {
        const user = requireSnowflake(val('kick-user'), 'ID du membre');
        const reason = val('kick-reason') || 'Aucune raison';
        if (!(await askConfirm('Expulser ce membre ?', `Le membre ${user} sera expulsé. Il pourra revenir avec une invitation.`, 'Expulser'))) return;
        await tryDM(user, `👢 Tu as été **expulsé** de **${selectedGuild.name}**.\nRaison : ${val('kick-reason') || 'Aucune'}`);
        await discordRequest('DELETE', `/guilds/${guildId}/members/${user}`, undefined, `${modName()} : ${reason}`);
        okMsg = `✅ Membre ${user} expulsé.`;
        break;
      }

      case 'avertir':
      case 'serveur':
      case 'ticket-config':
        // Ces commandes enregistrent des données dans les fichiers du bot (avertissements, structure créée, config tickets).
        // Les faire depuis le site créerait des données que le bot ne verrait jamais.
        throw new UserInputError(`/${cmdName} doit être lancée directement dans Discord avec le bot : il garde ses données (compteur d'avertissements, annulation, configuration des tickets) de son côté.`);

      case 'nettoyer': {
        const count = parseInt(val('clear-count'), 10);
        if (!count || count < 1 || count > 100) throw new UserInputError('Entrez un nombre entre 1 et 100.');
        if (!(await askConfirm('Supprimer ces messages ?', `Les ${count} derniers messages de ce salon seront supprimés définitivement.`, 'Supprimer'))) return;
        const msgs = await discordRequest('GET', `/channels/${channelId}/messages?limit=${count}`);
        const limit = Date.now() - 14 * 86400e3; // Discord refuse le bulk-delete des messages > 14 jours
        const ids = msgs.filter(m => new Date(m.timestamp).getTime() > limit).map(m => m.id);
        if (ids.length === 0) throw new UserInputError('Aucun message supprimable (les messages de plus de 14 jours ne peuvent pas être purgés).');
        if (ids.length === 1) {
          await discordRequest('DELETE', `/channels/${channelId}/messages/${ids[0]}`);
        } else {
          await discordRequest('POST', `/channels/${channelId}/messages/bulk-delete`, { messages: ids });
        }
        okMsg = `✅ ${ids.length} message(s) supprimé(s).`;
        break;
      }

      case 'mode-lent': {
        const sec = parseInt(val('slowmode-sec') || '0', 10);
        if (isNaN(sec) || sec < 0 || sec > 21600) throw new UserInputError('Entrez un nombre de secondes entre 0 et 21600.');
        await discordRequest('PATCH', `/channels/${channelId}`, { rate_limit_per_user: sec });
        okMsg = sec === 0 ? '✅ Mode lent désactivé.' : `✅ Mode lent réglé sur ${sec}s.`;
        break;
      }

      case 'verrouiller':
      case 'deverrouiller': {
        // Le rôle @everyone a le même ID que le serveur
        const channel = await discordRequest('GET', `/channels/${channelId}`);
        const existing = (channel.permission_overwrites || []).find(o => o.id === guildId && o.type === 0);
        let allow = BigInt(existing ? existing.allow : 0);
        let deny = BigInt(existing ? existing.deny : 0);
        if (cmdName === 'verrouiller') {
          deny |= SEND_MESSAGES;
          allow &= ~SEND_MESSAGES;
        } else {
          deny &= ~SEND_MESSAGES;
          allow &= ~SEND_MESSAGES;
        }
        await discordRequest('PUT', `/channels/${channelId}/permissions/${guildId}`,
          { type: 0, allow: allow.toString(), deny: deny.toString() });
        okMsg = cmdName === 'verrouiller' ? '🔒 Salon verrouillé.' : '🔓 Salon déverrouillé.';
        break;
      }

      case 'role-creer': {
        const name = val('role-create-name');
        if (!name) throw new UserInputError('Entrez un nom de rôle.');
        const color = parseInt((val('role-create-color') || '#5865F2').replace('#', ''), 16);
        await discordRequest('POST', `/guilds/${guildId}/roles`, { name, color });
        okMsg = `✅ Rôle "${name}" créé.`;
        break;
      }

      case 'role-ajouter':
      case 'role-retirer': {
        const member = requireSnowflake(val('role-member-id'), 'ID du membre');
        const role = requireSnowflake(val('role-target-id'), 'ID du rôle');
        await discordRequest(cmdName === 'role-ajouter' ? 'PUT' : 'DELETE',
          `/guilds/${guildId}/members/${member}/roles/${role}`);
        okMsg = cmdName === 'role-ajouter' ? '✅ Rôle ajouté.' : '✅ Rôle retiré.';
        break;
      }

      case 'ticket-panneau': {
        const title = val('ticket-panel-title') || '🎫 Support';
        await discordRequest('POST', `/channels/${channelId}/messages`, {
          embeds: [{
            title,
            description: 'Cliquez sur le bouton ci-dessous pour ouvrir un ticket.',
            color: 0x5865F2
          }],
          components: [{
            type: 1,
            components: [{ type: 2, style: 1, label: 'Ouvrir un ticket', emoji: { name: '🎫' }, custom_id: 'ticket:open' }]
          }]
        });
        okMsg = '✅ Panneau posté. Pour que les tickets marchent, le salon des demandes doit être configuré avec /ticket config dans Discord.';
        break;
      }

      case 'ping': {
        const t0 = performance.now();
        await discordRequest('GET', '/users/@me');
        okMsg = `🏓 Pong ! Latence API Discord : ${Math.round(performance.now() - t0)} ms`;
        break;
      }

      case 'infos-serveur': {
        const g = await discordRequest('GET', `/guilds/${guildId}?with_counts=true`);
        await discordRequest('POST', `/channels/${channelId}/messages`, {
          embeds: [{
            title: `📊 ${g.name}`,
            color: 0x5865F2,
            fields: [
              { name: 'Membres', value: String(g.approximate_member_count ?? '?'), inline: true },
              { name: 'En ligne', value: String(g.approximate_presence_count ?? '?'), inline: true },
              { name: 'Rôles', value: String((g.roles || []).length), inline: true }
            ]
          }]
        });
        okMsg = '✅ Statistiques postées.';
        break;
      }

      default:
        throw new UserInputError(`Commande inconnue : ${cmdName}`);
    }

    toast('ok', COMMAND_LABELS[cmdName] || 'Terminé', okMsg.replace(/^[^\p{L}\p{N}]+/u, ''));
    logActivity(true, COMMAND_LABELS[cmdName] || cmdName, okMsg.replace(/^[^\p{L}\p{N}]+/u, ''));
  } catch (error) {
    console.error(error);
    if (error instanceof UserInputError) {
      toast('warn', 'Vérifie le formulaire', error.message);
    } else {
      let hint = '';
      if (/50013|Missing Permissions/i.test(error.message)) hint = "\nLe bot n'a pas la permission, ou son rôle est plus bas que celui de la cible. Monte le rôle du bot dans Paramètres du serveur > Rôles.";
      else if (/10007|Unknown Member/i.test(error.message)) hint = "\nCe membre n'est pas sur le serveur : vérifie l'ID.";
      else if (/403/.test(error.message) && /administrateur/i.test(error.message)) hint = '\nTu dois être administrateur de ce serveur.';
      toast('error', `${COMMAND_LABELS[cmdName] || cmdName} a échoué`, error.message + hint, 9000);
      logActivity(false, COMMAND_LABELS[cmdName] || cmdName, error.message);
    }
  }
};

const COMMAND_LABELS = {
  'say': 'Message envoyé', 'embed': 'Embed posté', 'bannir': 'Membre banni', 'sourdine': 'Membre en sourdine',
  'expulser': 'Membre expulsé', 'nettoyer': 'Salon nettoyé', 'mode-lent': 'Mode lent modifié',
  'verrouiller': 'Salon verrouillé', 'deverrouiller': 'Salon déverrouillé', 'role-creer': 'Rôle créé',
  'role-ajouter': 'Rôle donné', 'role-retirer': 'Rôle retiré', 'ticket-panneau': 'Panneau de tickets posté',
  'ping': 'Latence mesurée', 'infos-serveur': 'Statistiques postées'
};

// ---------- Notifications ----------
function toast(kind, title, text, ms = 5000) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : ''}`;
  const t = document.createElement('strong'); t.textContent = title;
  el.appendChild(t);
  if (text) { const p = document.createElement('p'); p.textContent = text; el.appendChild(p); }
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
  el.addEventListener('click', () => el.remove());
}

// ---------- Confirmation ----------
function askConfirm(title, text, yesLabel = 'Confirmer') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const yes = document.getElementById('confirm-yes');
    const no = document.getElementById('confirm-no');
    yes.textContent = yesLabel;
    modal.classList.remove('hidden');
    yes.focus();
    const done = value => {
      modal.classList.add('hidden');
      yes.onclick = no.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  });
}

// ---------- Journal des actions (stocké dans ce navigateur) ----------
function journalKey() { return `kay_journal_${selectedGuild ? selectedGuild.id : 'none'}`; }

function readJournal() {
  try { return JSON.parse(localStorage.getItem(journalKey()) || '[]'); } catch (e) { return []; }
}

function logActivity(ok, title, detail) {
  if (!selectedGuild) return;
  const list = readJournal();
  list.unshift({ ok, title, detail, at: Date.now() });
  try { localStorage.setItem(journalKey(), JSON.stringify(list.slice(0, 30))); } catch (e) {}
  renderJournal();
}

window.clearJournal = function() {
  try { localStorage.removeItem(journalKey()); } catch (e) {}
  renderJournal();
};

function formatWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `à ${hm}` : `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}, ${hm}`;
}

function renderJournal() {
  const box = document.getElementById('journal');
  if (!box) return;
  const list = readJournal();
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty"><strong>Aucune action pour l\'instant</strong><p>Les commandes que tu lances depuis ce site apparaîtront ici.</p></div>';
    return;
  }
  const ol = document.createElement('ol');
  list.forEach(item => {
    const li = document.createElement('li');
    if (!item.ok) li.className = 'fail';
    li.innerHTML = '<span class="dot"></span><div><strong></strong><span class="detail"></span></div><time></time>';
    li.querySelector('strong').textContent = item.ok ? item.title : `${item.title} : échec`;
    li.querySelector('.detail').textContent = item.detail || '';
    li.querySelector('time').textContent = formatWhen(item.at);
    ol.appendChild(li);
  });
  box.appendChild(ol);
}

// ---------- Vue d'ensemble ----------
let overviewStats = { members: null, online: null, roles: null, channels: null };

function renderOverviewMeta() {
  const s = overviewStats;
  const parts = [];
  if (s.members != null) parts.push(`<b>${s.members.toLocaleString('fr-FR')}</b> membres${s.online != null ? `, dont <b>${s.online.toLocaleString('fr-FR')}</b> en ligne` : ''}`);
  if (s.roles != null) parts.push(`<b>${s.roles}</b> rôles`);
  if (s.channels != null) parts.push(`<b>${s.channels}</b> salons textuels`);
  document.getElementById('ov-meta').innerHTML = parts.length ? parts.join(', ') : 'Chiffres indisponibles pour le moment.';
}

async function loadOverview() {
  if (!selectedGuild) return;
  const g = userGuilds.find(x => x.id === selectedGuild.id);
  document.getElementById('ov-empty').classList.add('hidden');
  document.getElementById('ov-body').classList.remove('hidden');
  document.getElementById('ov-icon').src = guildIconUrl(g);
  document.getElementById('ov-name').textContent = selectedGuild.name;
  document.getElementById('ov-meta').textContent = 'Chargement des chiffres…';
  overviewStats = { members: null, online: null, roles: null, channels: null };
  renderJournal();

  const id = selectedGuild.id;
  try {
    const info = await discordRequest('GET', `/guilds/${id}?with_counts=true`);
    if (!selectedGuild || selectedGuild.id !== id) return;
    overviewStats.members = info.approximate_member_count ?? null;
    overviewStats.online = info.approximate_presence_count ?? null;
    overviewStats.roles = (info.roles || []).length;
  } catch (e) {
    document.getElementById('ov-meta').textContent = /403|404/.test(e.message)
      ? "Le bot n'est pas sur ce serveur : invite-le depuis « Mes serveurs »."
      : 'Chiffres indisponibles pour le moment.';
    return;
  }
  renderOverviewMeta();
}

window.goCommand = function(cat) {
  switchTab('categories');
  switchCategory(cat);
};

// ---------- Navigation ----------
const TAB_TITLES = {
  overview: ['Vue d\'ensemble', 'Les chiffres du serveur et ce que tu as fait récemment.'],
  servers: ['Mes serveurs', 'Choisis le serveur à gérer.'],
  categories: ['Commandes', 'Lance une action sur le serveur sélectionné.'],
  settings: ['État du bot', 'Vérifie que le site communique bien avec le bot.']
};

function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.getElementById(`nav-${tab}`).classList.add('active');
  const [title, sub] = TAB_TITLES[tab] || ['', ''];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-sub').textContent = sub;

  const warn = document.getElementById('cmd-warning');
  if (tab === 'categories' && !selectedGuild) {
    warn.textContent = "Aucun serveur sélectionné. Choisis-en un dans « Mes serveurs » avant de lancer une commande.";
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
  window.scrollTo({ top: 0 });
}

window.switchCategory = function(cat) {
  document.querySelectorAll('.cmd-category-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.category-btn').forEach(el => el.classList.remove('active'));
  const targetCat = document.getElementById(`category-${cat}`);
  const targetBtn = document.getElementById(`cat-btn-${cat}`);
  if (targetCat) targetCat.classList.remove('hidden');
  if (targetBtn) targetBtn.classList.add('active');
};

function initEventListeners() {
  document.getElementById('btn-refresh-guilds').addEventListener('click', () => {
    const token = localStorage.getItem('discord_token');
    presenceCache.clear();
    if (token) { document.getElementById('guilds-loading').classList.remove('hidden'); document.getElementById('guilds-container').classList.add('hidden'); fetchUserGuilds(token); }
  });
  document.getElementById('guild-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    renderGuilds(userGuilds.filter(g => g.name.toLowerCase().includes(q)));
  });
  document.getElementById('btn-logout').addEventListener('click', logout);
}

function logout() {
  localStorage.removeItem('discord_token');
  window.location.href = 'index.html';
}
