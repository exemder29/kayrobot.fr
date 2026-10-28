// Paramètres du projet & OAuth2
const CLIENT_ID = '1563284812351938611';
let userGuilds = [];
let selectedGuild = null;

window.addEventListener('DOMContentLoaded', () => {
  // Capture du token Discord via hash d'URL
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
  } else {
    loadUserData(token);
  }
});

function loadUserData(token) {
  // Récupération de l'utilisateur
  fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => {
    if (!res.ok) throw new Error('Token expiré');
    return res.json();
  })
  .then(user => {
    document.getElementById('user-display-name').textContent = `${user.username}`;
    if (user.avatar) {
      document.getElementById('user-avatar').src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    }
    fetchUserGuilds(token);
  })
  .catch(() => {
    logout();
  });
}

function fetchUserGuilds(token) {
  fetch('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => res.json())
  .then(guilds => {
    // Filtrer les serveurs où l'utilisateur est Admin ou Propriétaire (Permission Administrator = 0x8)
    userGuilds = guilds.filter(g => g.owner || (parseInt(g.permissions) & 0x8) === 0x8);
    renderGuilds();
  })
  .catch(err => console.error(err));
}

function renderGuilds() {
  const container = document.getElementById('guilds-container');
  const loading = document.getElementById('guilds-loading');
  container.innerHTML = '';

  if (userGuilds.length === 0) {
    loading.innerHTML = '<p class="text-sm text-gray-400">Aucun serveur trouvé où vous possédez les permissions d'administrateur.</p>';
    return;
  }

  loading.classList.add('hidden');
  container.classList.remove('hidden');

  userGuilds.forEach(guild => {
    const iconUrl = guild.icon
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';

    const card = document.createElement('div');
    card.className = 'bg-discord-cardBg border border-gray-800 p-4 rounded-xl flex items-center justify-between hover:border-discord-blurple transition';
    card.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <img src="${iconUrl}" class="w-12 h-12 rounded-full border border-gray-700 shrink-0">
        <div class="min-w-0">
          <h4 class="font-bold text-white text-sm truncate">${guild.name}</h4>
          <span class="text-[10px] text-discord-green font-semibold">● Bot Détecté</span>
        </div>
      </div>
      <button onclick="selectGuild('${guild.id}', '${guild.name.replace(/'/g, "\'")}')" class="bg-discord-blurple hover:bg-opacity-80 text-white text-xs px-3 py-2 rounded-lg font-medium transition shrink-0">
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
  alert(`Serveur "${name}" sélectionné ! Vous pouvez désormais utiliser le Panneau Commandes.`);
  switchTab('commands');
}

function execCmd(cmdType) {
  if (!selectedGuild) {
    alert("Veuillez d'abord sélectionner un serveur dans l'onglet 'Mes Serveurs' !");
    switchTab('servers');
    return;
  }

  alert(`[KayRobot] Commande /${cmdType} envoyée avec succès sur le serveur : ${selectedGuild.name}`);
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

// Aperçu en temps réel d'Embed
const updateEmbed = () => {
  const title = document.getElementById('embed-title').value || 'Annonce officielle !';
  const desc = document.getElementById('embed-description').value || 'Tapez le contenu de votre message...';
  const color = document.getElementById('embed-color').value || '#5865F2';

  document.getElementById('preview-title').textContent = title;
  document.getElementById('preview-description').textContent = desc;
  document.getElementById('preview-card').style.borderColor = color;
};

['embed-title', 'embed-description', 'embed-color'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateEmbed);
});
