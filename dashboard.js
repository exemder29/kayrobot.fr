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

function renderGuilds(guilds) {
  const container = document.getElementById('guilds-container');
  const loading = document.getElementById('guilds-loading');
  container.innerHTML = '';
  loading.classList.add('hidden');
  container.classList.remove('hidden');

  if (guilds.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 col-span-full text-center py-6">Aucun serveur administrable trouvé.</p>';
    return;
  }

  guilds.forEach(guild => {
    const iconUrl = guild.icon
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';

    const card = document.createElement('div');
    card.className = 'bg-discord-cardBg border border-gray-800 p-4 rounded-xl flex items-center justify-between hover:border-discord-blurple transition shadow';
    card.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <img src="${iconUrl}" class="w-12 h-12 rounded-full border border-gray-700 shrink-0 object-cover">
        <div class="min-w-0">
          <h4 class="guild-name font-bold text-white text-sm truncate"></h4>
          <span class="text-[10px] text-discord-green font-semibold">● Administrateur</span>
        </div>
      </div>
      <button class="guild-manage bg-discord-blurple hover:bg-opacity-80 text-white text-xs px-3 py-2 rounded-lg font-medium transition shrink-0 cursor-pointer">
        Gérer
      </button>
    `;
    card.querySelector('.guild-name').textContent = guild.name;
    card.querySelector('.guild-manage').addEventListener('click', () => selectGuild(guild.id, guild.name));
    container.appendChild(card);
  });
}

function selectGuild(id, name) {
  selectedGuild = { id, name };
  document.getElementById('selected-guild-label').textContent = name;
  document.getElementById('active-server-badge').classList.remove('hidden');
  document.getElementById('active-server-badge').textContent = `Serveur : ${name}`;
  
  loadGuildChannels(id);
  switchTab('categories');
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
  if (!el) return;
  if (!proxyConfigured()) {
    el.innerHTML = '<span class="text-discord-red font-semibold">❌ URL du Worker non configurée (BOT_PROXY_URL dans dashboard.js)</span>';
    return;
  }
  try {
    const res = await fetch(`${BOT_PROXY_URL}/__check`);
    const d = await res.json();
    const ok = d.discordStatus === 200;
    el.innerHTML = `<span class="font-semibold ${ok ? 'text-discord-green' : 'text-discord-red'}"></span><pre class="mt-2 text-[11px] text-gray-400 whitespace-pre-wrap"></pre>`;
    el.querySelector('span').textContent = ok
      ? `✓ Connecté au bot "${d.nomDuBot}" via le Worker sécurisé`
      : '❌ Discord refuse le token du bot';
    el.querySelector('pre').textContent =
      `Longueur du token : ${d.longueur} (attendu : environ 70)\n` +
      `Morceaux séparés par des points : ${d.morceaux} (attendu : 3)\n` +
      `Longueur de chaque morceau : ${(d.longueurs || []).join(' / ')} (attendu : 27 / 6 / 38 environ)\n` +
      `Début du token (ID du bot encodé) : ${d.debutDuToken}\n` +
      `ID du bot dans le token : ${d.idDansLeToken || '(illisible)'} (attendu : 1563284812351938611)\n` +
      `Réponse de Discord : ${d.discordStatus} ${d.discordMessage || ''}`;
  } catch (e) {
    el.innerHTML = '<span class="text-discord-red font-semibold">❌ Worker injoignable</span><pre class="mt-2 text-[11px] text-gray-400 whitespace-pre-wrap"></pre>';
    el.querySelector('pre').textContent = e.message;
  }
}

function populateAllChannelDropdowns(channels) {
  document.querySelectorAll('.guild-channels-dropdown').forEach(select => {
    select.innerHTML = '<option value="">-- Sélectionnez un salon --</option>';
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

  select.innerHTML = '<option value="">-- Sélectionnez un salon --</option>';
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

async function discordRequest(method, path, body, reason) {
  if (!proxyConfigured()) throw new UserInputError('URL du Worker non configurée (BOT_PROXY_URL dans dashboard.js).');
  const headers = { Authorization: `Bearer ${localStorage.getItem('discord_token')}` };
  if (selectedGuild) headers['X-Guild-Id'] = selectedGuild.id;
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
    alert("⚠️ Veuillez d'abord sélectionner un serveur dans l'onglet 'Mes Serveurs' !");
    switchTab('servers');
    return;
  }

  if (!proxyConfigured()) {
    alert("⚠️ L'URL du Worker n'est pas configurée dans dashboard.js (BOT_PROXY_URL).");
    return;
  }

  const guildId = selectedGuild.id;
  const channelId = CHANNEL_FIELD[cmdName] ? val(CHANNEL_FIELD[cmdName]) : '';
  if (CHANNEL_FIELD[cmdName] && !channelId) {
    alert("Veuillez sélectionner un salon dans la liste déroulante !\n(Si la liste est vide : le bot doit être présent sur le serveur et le token correct.)");
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
        if (!confirm(`Bannir le membre ${user} ?`)) return;
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
        if (!confirm(`Expulser le membre ${user} ?`)) return;
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
        if (!confirm(`Supprimer les ${count} derniers messages de ce salon ?`)) return;
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

    alert(okMsg);
  } catch (error) {
    console.error(error);
    if (error instanceof UserInputError) {
      alert(`⚠️ ${error.message}`);
    } else {
      let hint = '';
      if (/50013|Missing Permissions/i.test(error.message)) hint = "\n\n👉 Le bot n'a pas la permission, ou son rôle est plus bas que celui du membre/rôle visé. Monte le rôle du bot dans Paramètres du serveur > Rôles.";
      else if (/10007|Unknown Member/i.test(error.message)) hint = "\n\n👉 Ce membre n'est pas sur le serveur (vérifie l'ID).";
      else if (/50007|Cannot send messages to this user/i.test(error.message)) hint = '';
      alert(`❌ Échec de /${cmdName}\n\n${error.message}${hint}\n\nVérifiez que le bot est bien sur ce serveur et qu'il a les permissions nécessaires.`);
    }
  }
};

window.switchCategory = function(cat) {
  document.querySelectorAll('.cmd-category-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.category-btn').forEach(el => {
    el.classList.remove('border-discord-blurple');
    el.classList.add('border-gray-800');
  });

  const targetCat = document.getElementById(`category-${cat}`);
  const targetBtn = document.getElementById(`cat-btn-${cat}`);
  if (targetCat) targetCat.classList.remove('hidden');
  if (targetBtn) {
    targetBtn.classList.remove('border-gray-800');
    targetBtn.classList.add('border-discord-blurple');
  }
};

function initEventListeners() {
  const tabs = ['servers', 'categories', 'settings'];
  tabs.forEach(tab => {
    const btn = document.getElementById(`nav-${tab}`);
    if (btn) {
      btn.addEventListener('click', () => {
        tabs.forEach(t => {
          document.getElementById(`tab-${t}`).classList.add('hidden');
          document.getElementById(`nav-${t}`).classList.remove('active');
        });
        document.getElementById(`tab-${tab}`).classList.remove('hidden');
        btn.classList.add('active');
      });
    }
  });

  document.getElementById('btn-refresh-guilds').addEventListener('click', () => {
    const token = localStorage.getItem('discord_token');
    if (token) fetchUserGuilds(token);
  });

  document.getElementById('btn-logout').addEventListener('click', logout);
}

function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.getElementById(`nav-${tab}`).classList.add('active');
}

function logout() {
  localStorage.removeItem('discord_token');
  window.location.href = 'index.html';
}
