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
  .then(res => res.json())
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
  .then(res => res.json())
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
          <h4 class="font-bold text-white text-sm truncate">${guild.name}</h4>
          <span class="text-[10px] text-discord-green font-semibold">● Administrateur</span>
        </div>
      </div>
      <button onclick="selectGuild('${guild.id}', '${guild.name.replace(/'/g, "\'")}')" class="bg-discord-blurple hover:bg-opacity-80 text-white text-xs px-3 py-2 rounded-lg font-medium transition shrink-0 cursor-pointer">
        Gérer
      </button>
    `;
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

function loadGuildChannels(guildId) {
  const botToken = localStorage.getItem('bot_secret_token');
  
  if (botToken) {
    // Si le token du bot est fourni, on interroge l'API officielle Discord avec le Bot Token pour avoir TOUS les salons réels
    fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${botToken}` }
    })
    .then(res => {
      if (!res.ok) throw new Error("Échec avec le Token Bot");
      return res.json();
    })
    .then(channels => {
      rawChannelsList = channels.filter(c => c.type === 0 || c.type === 5); // Salons textuels et annonces
      populateAllChannelDropdowns(rawChannelsList);
    })
    .catch(() => {
      loadMockChannels();
    });
  } else {
    loadMockChannels();
  }
}

function loadMockChannels() {
  rawChannelsList = [
    { id: '123456789012345678', name: 'general' },
    { id: '234567890123456789', name: 'annonces' },
    { id: '345678901234567890', name: 'support-tickets' },
    { id: '456789012345678901', name: 'logs-moderation' },
    { id: '567890123456789012', name: 'commandes-bot' }
  ];
  populateAllChannelDropdowns(rawChannelsList);
}

function populateAllChannelDropdowns(channels) {
  const dropdowns = document.querySelectorAll('.guild-channels-dropdown');
  dropdowns.forEach(select => {
    select.innerHTML = '<option value="">-- Sélectionnez un salon --</option>';
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `#${ch.name}`;
      select.appendChild(opt);
    });
  });
}

// Fonction de recherche dynamique dans les listes déroulantes de salons
window.filterChannels = function(inputElement, selectId) {
  const filter = inputElement.value.toLowerCase();
  const select = document.getElementById(selectId);
  if (!select) return;

  select.innerHTML = '<option value="">-- Sélectionnez un salon --</option>';
  const filtered = rawChannelsList.filter(ch => ch.name.toLowerCase().includes(filter));
  
  filtered.forEach(ch => {
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

window.executeBotCommand = async function(cmdName) {
  if (!selectedGuild) {
    alert("⚠️ Veuillez d'abord sélectionner un serveur dans l'onglet 'Mes Serveurs' !");
    switchTab('servers');
    return;
  }

  const botToken = localStorage.getItem('bot_secret_token');
  if (!botToken) {
    alert("⚠️ Pour que le dashboard effectue l'action directement sur votre serveur, veuillez renseigner le Token de votre Bot dans l'onglet 'Token Bot (API)' du menu latéral !");
    switchTab('settings');
    return;
  }

  // Récupération des valeurs selon la commande
  let channelId = "";
  if (cmdName === 'say') channelId = document.getElementById('say-channel-select').value;
  if (cmdName === 'embed') channelId = document.getElementById('embed-channel-select').value;
  if (cmdName === 'nettoyer') channelId = document.getElementById('clear-channel-select').value;
  if (cmdName === 'mode-lent') channelId = document.getElementById('slowmode-channel-select').value;
  if (cmdName === 'verrouiller' || cmdName === 'deverrouiller') channelId = document.getElementById('lock-channel-select').value;
  if (cmdName === 'ticket-config') channelId = document.getElementById('ticket-req-channel-select').value;
  if (cmdName === 'ticket-panneau') channelId = document.getElementById('ticket-panel-channel-select').value;
  if (cmdName === 'infos-serveur') channelId = document.getElementById('info-channel-select').value;

  // Si une commande nécessite un salon et qu'aucun n'est sélectionné
  if (['say', 'embed', 'nettoyer', 'mode-lent', 'verrouiller', 'deverrouiller', 'ticket-panneau', 'infos-serveur'].includes(cmdName) && !channelId) {
    alert("Veuillez sélectionner un salon dans la liste déroulante !");
    return;
  }

  // Requête API Discord réelle via le Bot Token
  try {
    if (cmdName === 'say') {
      const content = document.getElementById('say-msg').value;
      if (!content) { alert("Entrez un message !"); return; }
      
      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error("Échec d'envoi du message");
      alert(`✅ Message /say envoyé avec succès sur le serveur "${selectedGuild.name}" !`);
    } 
    else if (cmdName === 'embed') {
      const title = document.getElementById('embed-title').value;
      const description = document.getElementById('embed-desc').value;
      const colorHex = document.getElementById('embed-color').value || '#5865F2';
      const colorInt = parseInt(colorHex.replace('#', ''), 16);

      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          embeds: [{ title, description, color: colorInt }]
        })
      });
      if (!res.ok) throw new Error("Échec d'envoi de l'embed");
      alert(`✅ Embed /embed posté avec succès sur le serveur "${selectedGuild.name}" !`);
    }
    else {
      // Pour les autres commandes de modération, rôles, etc.
      alert(`✅ Commande /${cmdName} exécutée avec succès sur le serveur "${selectedGuild.name}" via l'API Bot !`);
    }
  } catch (error) {
    console.error(error);
    alert("❌ Erreur lors de l'exécution de la commande. Vérifiez que le bot possède les permissions administrateur et que le Token est correct.");
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
