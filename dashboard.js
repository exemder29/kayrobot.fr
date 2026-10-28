// Gestion de la récupération du token OAuth2 Discord présent dans l'URL (#access_token=...)
window.addEventListener('DOMContentLoaded', () => {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');

  if (accessToken) {
    localStorage.setItem('discord_token', accessToken);
    // Nettoyer l'URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const token = localStorage.getItem('discord_token');
  if (!token) {
    // Rediriger vers la page de login si aucun token
    window.location.href = 'index.html';
  } else {
    fetchDiscordUser(token);
  }
});

function fetchDiscordUser(token) {
  fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
  .then(res => res.json())
  .then(data => {
    if (data.username) {
      document.getElementById('user-info').textContent = `Connecté en tant que ${data.username}#${data.discriminator || '0'}`;
    } else {
      window.location.href = 'index.html';
    }
  })
  .catch(() => {
    window.location.href = 'index.html';
  });
}

window.switchTab = function(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.getElementById(`nav-${tab}`).classList.add('active');
};

window.logout = function() {
  localStorage.removeItem('discord_token');
  window.location.href = 'index.html';
};

window.updatePreview = function() {
  document.getElementById('prev-title').textContent = document.getElementById('embed-title').value || 'Titre de l\'embed';
  document.getElementById('prev-desc').textContent = document.getElementById('embed-desc').value || 'Contenu du message...';
  document.getElementById('preview-box').style.borderColor = document.getElementById('embed-color').value || '#5865F2';
};

window.selectGuild = function(guildName) {
  alert(`Configuration du serveur : ${guildName}`);
};
