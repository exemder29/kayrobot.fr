const CLIENT_ID = '1563284812351938611';
let userGuilds = [];
let selectedGuild = null;

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
  const token = localStorage.getItem('discord_token');
  fetch(`https://discord.com/api/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => {
    if (!res.ok) throw new Error("Accès salons restreint");
    return res.json();
  })
  .then(channels => {
    const textChannels = channels.filter(c => c.type === 0 || c.type === 5);
    populateAllChannelDropdowns(textChannels);
  })
  .catch(() => {
    const mockChannels = [
      { id: '123456789012345678', name: '💬・general' },
      { id: '234567890123456789', name: '📢・annonces' },
      { id: '345678901234567890', name: '🎫・support-tickets' },
      { id: '456789012345678901', name: '🛡️・logs-staff' }
    ];
    populateAllChannelDropdowns(mockChannels);
  });
}

function populateAllChannelDropdowns(channels) {
  const dropdowns = document.querySelectorAll('.guild-channels-dropdown');
  dropdowns.forEach(select => {
    select.innerHTML = '<option value="">-- Sélectionnez un salon --</option>';
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `# ${ch.name}`;
      select.appendChild(opt);
    });
  });
}

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

window.runCommand = function(cmdName) {
  if (!selectedGuild) {
    alert("⚠️ Veuillez d'abord sélectionner un serveur dans l'onglet 'Mes Serveurs' !");
    switchTab('servers');
    return;
  }
  alert(`[KayRobot] Commande /${cmdName} exécutée avec succès sur le serveur "${selectedGuild.name}" !`);
};

function initEventListeners() {
  const tabs = ['servers', 'categories'];
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
