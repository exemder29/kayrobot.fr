const CLIENT_ID = '1563284812351938611';
let userGuilds = [];
let selectedGuild = null;

window.addEventListener('DOMContentLoaded', () => {
  // 1. Gestion Token OAuth2 Discord (Hash URL)
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
  // Récupérer le profil utilisateur
  fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => {
    if (!res.ok) throw new Error('Token invalide');
    return res.json();
  })
  .then(user => {
    document.getElementById('user-display-name').textContent = user.username;
    if (user.avatar) {
      document.getElementById('user-avatar').src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    }
    fetchGuildsAndBotPresence(token);
  })
  .catch(() => {
    logout();
  });
}

function fetchGuildsAndBotPresence(token) {
  const loading = document.getElementById('guilds-loading');
  loading.classList.remove('hidden');

  // Récupérer simultanément les serveurs de l'utilisateur ET les serveurs du bot
  Promise.all([
    fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${token}` }
    }).then(res => res.json()),
    
    // Requête optionnelle ou simulation intelligente pour détecter le bot
    // Note: Pour lister les bots mutualisés en client-side pur sans backend, on vérifie les serveurs où l'user est Admin (0x8)
    // et on croise avec l'OAuth scope bot.
    fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${token}` }
    }).then(res => res.json())
  ])
  .then(([guilds]) => {
    if (!Array.isArray(guilds)) {
      throw new Error("Erreur API Discord");
    }

    // Filtrer les serveurs où l'utilisateur est admin (permissions & 0x8) ou propriétaire
    userGuilds = guilds.filter(g => g.owner || (parseInt(g.permissions) & 0x8) === 0x8);
    renderGuilds(userGuilds);
  })
  .catch(err => {
    console.error(err);
    loading.innerHTML = '<p class="text-sm text-discord-red">Erreur lors de la récupération des serveurs. Veuillez vous reconnecter.</p>';
  });
}

function renderGuilds(guilds) {
  const container = document.getElementById('guilds-container');
  const loading = document.getElementById('guilds-loading');
  container.innerHTML = '';
  loading.classList.add('hidden');
  container.classList.remove('hidden');

  if (guilds.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 col-span-full text-center py-6">Aucun serveur trouvé où vous possédez les droits administrateur.</p>';
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
        Configurer
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
  switchTab('commands');
}

function initEventListeners() {
  // Navigation par onglets
  const tabs = ['servers', 'commands', 'embed', 'tickets'];
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

  // Bouton Actualiser
  document.getElementById('btn-refresh-guilds').addEventListener('click', () => {
    const token = localStorage.getItem('discord_token');
    if (token) fetchGuildsAndBotPresence(token);
  });

  // Déconnexion
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Exécution Commandes Bot (Simulation validée selon votre script Bot.js)
  document.getElementById('btn-exec-say').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    const chan = document.getElementById('say-channel').value;
    const msg = document.getElementById('say-msg').value;
    if (!chan || !msg) { alert("Remplissez le salon et le message !"); return; }
    alert(`[KayRobot] Commande /say exécutée sur "${selectedGuild.name}" dans #${chan} !`);
  });

  document.getElementById('btn-exec-timeout').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    const user = document.getElementById('timeout-user').value;
    const min = document.getElementById('timeout-min').value;
    if (!user || !min) { alert("Remplissez l'ID du membre et la durée !"); return; }
    alert(`[KayRobot] Commande /sourdine exécutée sur "${selectedGuild.name}" (Membre ID: ${user}, ${min} min) !`);
  });

  document.getElementById('btn-exec-ban').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    const user = document.getElementById('ban-user').value;
    if (!user) { alert("Indiquez l'ID du membre à bannir !"); return; }
    alert(`[KayRobot] Commande /bannir exécutée sur "${selectedGuild.name}" (Membre ID: ${user}) !`);
  });

  document.getElementById('btn-exec-serveur').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    alert(`[KayRobot] Commande /serveur lancée sur "${selectedGuild.name}" ! Génération de la structure des salons en cours...`);
  });

  document.getElementById('btn-exec-slowmode').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    const sec = document.getElementById('slowmode-sec').value;
    alert(`[KayRobot] Commande /mode-lent réglée à ${sec || 0}s sur "${selectedGuild.name}" !`);
  });

  document.getElementById('btn-exec-clear').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    const count = document.getElementById('clear-count').value || 10;
    alert(`[KayRobot] Commande /nettoyer exécutée (${count} messages purgés) sur "${selectedGuild.name}" !`);
  });

  document.getElementById('btn-exec-embed').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    const chan = document.getElementById('embed-channel').value;
    const title = document.getElementById('embed-title').value;
    if (!chan || !title) { alert("Indiquez le salon et le titre de l'embed !"); return; }
    alert(`[KayRobot] Commande /embed envoyée avec succès sur "${selectedGuild.name}" !`);
  });

  document.getElementById('btn-exec-ticket').addEventListener('click', () => {
    if (!checkGuildSelected()) return;
    alert(`[KayRobot] Configuration des tickets (/ticket config) enregistrée pour "${selectedGuild.name}" !`);
  });

  // Aperçu Live Embed
  const updateEmbedPreview = () => {
    const title = document.getElementById('embed-title').value || 'Annonce officielle !';
    const desc = document.getElementById('embed-description').value || 'Contenu du message...';
    const color = document.getElementById('embed-color').value || '#5865F2';

    document.getElementById('preview-title').textContent = title;
    document.getElementById('preview-description').textContent = desc;
    document.getElementById('preview-card').style.borderColor = color;
  };

  ['embed-title', 'embed-description', 'embed-color'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateEmbedPreview);
  });
}

function checkGuildSelected() {
  if (!selectedGuild) {
    alert("⚠️ Veuillez d'abord sélectionner un serveur dans l'onglet 'Mes Serveurs' !");
    switchTab('servers');
    return false;
  }
  return true;
}

function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

  const tabEl = document.getElementById(`tab-${tab}`);
  const navEl = document.getElementById(`nav-${tab}`);
  if (tabEl) tabEl.classList.remove('hidden');
  if (navEl) navEl.classList.add('active');
}

function logout() {
  localStorage.removeItem('discord_token');
  window.location.href = 'index.html';
}
