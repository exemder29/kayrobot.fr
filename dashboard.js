const CLIENT_ID = '1563284812351938611';
let userGuilds = [];
let selectedGuild = null;
let rawChannelsList = [];

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

  // Charger le token bot s'il existe déjà
  const savedBotToken = localStorage.getItem('bot_secret_token');
  if (savedBotToken) {
    document.getElementById('bot-token-input').value = savedBotToken;
  }

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

function loadGuildChannels(guildId) {
  const botToken = localStorage.getItem('bot_secret_token');
  rawChannelsList = [];

  if (!botToken) {
    setChannelDropdownsMessage('⚠️ Ajoutez le token du bot (onglet Token Bot)');
    return;
  }

  setChannelDropdownsMessage('Chargement des salons...');
  fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` }
  })
  .then(async res => {
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) {}
      throw new Error(`${res.status} ${detail}`.trim());
    }
    return res.json();
  })
  .then(channels => {
    rawChannelsList = channels.filter(c => c.type === 0 || c.type === 5); // textuels + annonces
    populateAllChannelDropdowns(rawChannelsList);
  })
  .catch(err => {
    console.error(err);
    setChannelDropdownsMessage('❌ Impossible de charger les salons (bot absent du serveur ou token invalide)');
  });
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

window.saveBotToken = function() {
  const token = document.getElementById('bot-token-input').value.trim();
  if (!token) {
    alert("Veuillez entrer un token valide !");
    return;
  }
  localStorage.setItem('bot_secret_token', token);
  const status = document.getElementById('token-status');
  status.classList.remove('hidden');
  setTimeout(() => status.classList.add('hidden'), 4000);

  if (selectedGuild) {
    loadGuildChannels(selectedGuild.id);
  }
};

// ---------- Appels API Discord ----------

async function discordRequest(method, path, body, reason) {
  const botToken = localStorage.getItem('bot_secret_token');
  const headers = { Authorization: `Bot ${botToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);

  const res = await fetch(`${DISCORD_API}${path}`, {
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
    throw new Error(`Discord ${res.status} : ${detail || res.statusText}`);
  }
  if (res.status === 204) return null;
  try { return await res.json(); } catch (e) { return null; }
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

  const botToken = localStorage.getItem('bot_secret_token');
  if (!botToken) {
    alert("⚠️ Renseignez d'abord le Token de votre Bot dans l'onglet 'Token Bot (API)' !");
    switchTab('settings');
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
        await discordRequest('POST', `/channels/${channelId}/messages`, { content });
        okMsg = '✅ Message envoyé !';
        break;
      }

      case 'embed': {
        const title = val('embed-title');
        const description = val('embed-desc');
        if (!title && !description) throw new UserInputError('Entrez au moins un titre ou une description.');
        const color = parseInt((val('embed-color') || '#5865F2').replace('#', ''), 16);
        await discordRequest('POST', `/channels/${channelId}/messages`, {
          embeds: [{ title: title || undefined, description: description || undefined, color }]
        });
        okMsg = '✅ Embed posté !';
        break;
      }

      case 'bannir': {
        const user = requireSnowflake(val('ban-user'), 'ID du membre');
        const days = parseInt(val('ban-delete-days') || '0', 10);
        const reason = val('ban-reason') || 'Aucune raison';
        if (!confirm(`Bannir le membre ${user} ?`)) return;
        await discordRequest('PUT', `/guilds/${guildId}/bans/${user}`, { delete_message_seconds: days * 86400 }, reason);
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
          { communication_disabled_until: new Date(Date.now() + ms).toISOString() }, reason);
        okMsg = `✅ Membre ${user} mis en sourdine.`;
        break;
      }

      case 'expulser': {
        const user = requireSnowflake(val('kick-user'), 'ID du membre');
        const reason = val('kick-reason') || 'Aucune raison';
        if (!confirm(`Expulser le membre ${user} ?`)) return;
        await discordRequest('DELETE', `/guilds/${guildId}/members/${user}`, undefined, reason);
        okMsg = `✅ Membre ${user} expulsé.`;
        break;
      }

      case 'avertir': {
        const user = requireSnowflake(val('warn-user'), 'ID du membre');
        const reason = val('warn-reason') || 'Aucune raison';
        const dm = await discordRequest('POST', '/users/@me/channels', { recipient_id: user });
        await discordRequest('POST', `/channels/${dm.id}/messages`, {
          embeds: [{
            title: '⚠️ Avertissement',
            description: `Vous avez reçu un avertissement sur **${selectedGuild.name}**.\n**Raison :** ${reason}`,
            color: 0xFEE75C
          }]
        });
        okMsg = `✅ Avertissement envoyé en message privé à ${user}.`;
        break;
      }

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

      case 'serveur': {
        if (!confirm('Créer la structure par défaut (catégories + salons) sur ce serveur ?')) return;
        const structure = [
          { name: '📢 INFORMATIONS', channels: ['règlement', 'annonces'] },
          { name: '💬 COMMUNAUTÉ', channels: ['général', 'commandes-bot'] },
          { name: '🎫 SUPPORT', channels: ['support-tickets'] },
          { name: '🛡️ STAFF', channels: ['logs-moderation'] }
        ];
        for (const cat of structure) {
          const category = await discordRequest('POST', `/guilds/${guildId}/channels`, { name: cat.name, type: 4 });
          for (const ch of cat.channels) {
            await discordRequest('POST', `/guilds/${guildId}/channels`, { name: ch, type: 0, parent_id: category.id });
          }
        }
        okMsg = '✅ Structure du serveur créée.';
        loadGuildChannels(guildId);
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

      case 'ticket-config': {
        const staffRole = val('ticket-staff-role');
        if (staffRole) requireSnowflake(staffRole, 'ID du rôle staff');
        // Pas de base de données côté dashboard : la config est gardée dans ce navigateur
        localStorage.setItem(`ticket_config_${guildId}`, JSON.stringify({ requestChannel: channelId, staffRole }));
        okMsg = '✅ Configuration des tickets enregistrée (dans ce navigateur).';
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
            components: [{ type: 2, style: 1, label: 'Ouvrir un ticket', emoji: { name: '🎫' }, custom_id: 'ticket_create' }]
          }]
        });
        okMsg = '✅ Panneau de tickets posté (le bot doit gérer le bouton "ticket_create").';
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
      alert(`❌ Échec de /${cmdName}\n\n${error.message}\n\nVérifiez que le bot est bien sur ce serveur, qu'il a les permissions nécessaires, et que le token est correct.`);
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
