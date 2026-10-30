async function resolveUser(input, guildId) {
  const str = (input || '').trim();
  if (!str) throw new UserInputError("Veuillez entrer un membre (pseudo ou ID).");
  if (/^\d{17,20}$/.test(str)) return str;
  const query = encodeURIComponent(str.replace(/^@/, ''));
  try {
    const members = await discordRequest('GET', `/guilds/${guildId}/members/search?query=${query}&limit=5`);
    if (Array.isArray(members) && members.length > 0) {
      const exact = members.find(m => 
        m.user.username.toLowerCase() === str.toLowerCase() || 
        (m.nick && m.nick.toLowerCase() === str.toLowerCase()) ||
        (m.user.global_name && m.user.global_name.toLowerCase() === str.toLowerCase())
      );
      if (exact) return exact.user.id;
      return members[0].user.id;
    }
  } catch (e) {}
  throw new UserInputError(`Membre introuvable pour "${str}".`);
}

const CLIENT_ID = '1563284812351938611';
const diagLines = [];
function dlog(msg) {
  diagLines.push(msg);
  const el = document.getElementById('diag-out');
  if (el) el.textContent = diagLines.join('\n');
}
let userGuilds = [];
let selectedGuild = null;
let currentUserId = '';
let rawChannelsList = [];
let allChannelsList = [];
let guildRolesList = [];

const BOT_PROXY_URL = 'https://kayrobot-proxy.exem029.workers.dev';

function proxyConfigured() {
  return /^https:\/\/.+/.test(BOT_PROXY_URL);
}

const REDIRECT_URI = 'https://exemder29.github.io/kayrobot.fr/dashboard.html';
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const authUrl = silent =>
  `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=identify%20guilds${silent ? '&prompt=none' : ''}`;

function storedToken() {
  const t = localStorage.getItem('discord_token');
  const exp = Number(localStorage.getItem('discord_token_exp')) || 0;
  return t && (!exp || exp > Date.now() + 60_000) ? t : null;
}

function startLogin() {
  const last = Number(sessionStorage.getItem('kayrobot_login_try')) || 0;
  if (Date.now() - last < 15_000) { window.location.href = './'; return; }
  sessionStorage.setItem('kayrobot_login_try', String(Date.now()));
  localStorage.removeItem('discord_token');
  localStorage.removeItem('discord_token_exp');
  window.location.href = authUrl(localStorage.getItem('discord_remember') === '1' && !IS_MOBILE);
}

window.addEventListener('DOMContentLoaded', () => {
  const hash = new URLSearchParams(window.location.hash.substring(1));
  const query = new URLSearchParams(window.location.search);
  const accessToken = hash.get('access_token');
  const authError = hash.get('error') || query.get('error');
  window.history.replaceState({}, document.title, window.location.pathname.replace(/index\.html$/, '').replace(/\.html$/, ''));

  if (accessToken) {
    localStorage.setItem('discord_token', accessToken);
    localStorage.setItem('discord_token_exp', String(Date.now() + (Number(hash.get('expires_in')) || 604800) * 1000));
    localStorage.setItem('discord_remember', '1');
    sessionStorage.removeItem('kayrobot_login_try');
    sessionStorage.removeItem('kayrobot_manual');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (authError) {
    window.history.replaceState({}, document.title, window.location.pathname);
    if (authError === 'access_denied') { localStorage.removeItem('discord_remember'); window.location.href = './'; return; }
    if (!sessionStorage.getItem('kayrobot_manual')) {
      sessionStorage.setItem('kayrobot_manual', '1');
      window.location.href = authUrl(false);
    } else {
      window.location.href = './';
    }
    return;
  }

  const token = storedToken();
  if (!token) { startLogin(); return; }

  checkProxy();
  initDashboard(token);
  initEventListeners();
});

function initDashboard(token) {
  const headers = { Authorization: `Bearer ${token}` };
  fetch('https://discord.com/api/users/@me', { headers }).then(res => {
    if (res.status === 401) { const e = new Error('Session expirée'); e.expired = true; throw e; }
    if (!res.ok) throw new Error(`Discord a répondu ${res.status}`);
    return res.json();
  }).then(user => {
    currentUserId = user.id;
    document.getElementById('user-display-name').textContent = user.username;
    if (user.avatar) {
      document.getElementById('user-avatar').src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    }
  }).catch(err => {
    if (err.expired) startLogin();
    else toast('warn', 'Discord injoignable', 'Impossible de charger ton profil.');
  });
  fetchUserGuilds(token);
}

function fetchUserGuilds(token) {
  const loading = document.getElementById('guilds-loading');
  loading.classList.remove('hidden');

  fetch('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(res => {
    if (res.status === 401) { startLogin(); throw new Error('Session expirée'); }
    if (!res.ok) throw new Error('Token Discord invalide ou expiré');
    return res.json();
  })
  .then(guilds => {
    userGuilds = guilds.filter(g => g.owner || (parseInt(g.permissions) & 0x8) === 0x8);
    renderGuilds(userGuilds);
  })
  .catch(err => {
    loading.innerHTML = '<p class="text-sm text-discord-red">Erreur lors de la récupération des serveurs.</p>';
  });
}

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
  if (guilds.length === 0) {
    loading.classList.add('hidden');
    container.classList.remove('hidden');
    container.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>Aucun serveur trouvé</strong></div>';
    return;
  }
  loading.classList.add('hidden');
  container.classList.remove('hidden');
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
        <span class="state ok">Gérer</span>
        <span class="guild-btns"><button class="btn btn-primary btn-small">Gérer</button></span>
      </div>`;
    card.querySelector('img').src = guildIconUrl(guild);
    card.querySelector('.guild-name').textContent = guild.name;
    card.querySelector('button').addEventListener('click', () => selectGuild(guild.id, guild.name));
    container.appendChild(card);
  });
}

function selectGuild(id, name) {
  selectedGuild = { id, name };
  const g = userGuilds.find(x => x.id === id);
  document.getElementById('selected-guild-label').textContent = name;
  document.getElementById('rail-guild-icon').src = guildIconUrl(g);
  const badge = document.getElementById('active-server-badge');
  badge.classList.remove('hidden');
  badge.textContent = name;
  loadOverview();
  switchTab('overview');
}

async function checkProxy() {
  const el = document.getElementById('token-state');
  const chip = document.getElementById('bot-chip');
  const setChip = (ok, text) => { if (chip) { chip.textContent = text; chip.className = `chip ${ok ? 'ok' : 'bad'}`; } };

  try {
    const res = await fetch(`${BOT_PROXY_URL}/__check`);
    const d = await res.json();
    const ok = d && d.discordStatus === 200;
    setChip(ok, ok ? `${d.nomDuBot || 'Bot'} est connecté` : 'Token du bot refusé');
    if (el) {
      el.innerHTML = `<div class="notice ${ok ? '' : 'error'}"></div><pre class="diag"></pre>`;
      el.querySelector('.notice').textContent = ok
        ? `Connecté au bot « ${d.nomDuBot || 'Bot'} » via le Worker sécurisé.`
        : (d.discordMessage || 'Discord refuse le token du bot.');
      el.querySelector('pre').textContent =
        `Longueur du token : ${d.longueur || 0}\n` +
        `ID du bot : ${d.idDansLeToken || 'non détecté'}\n` +
        `Réponse de Discord : ${d.discordStatus || 500}`;
    }
  } catch (e) {
    setChip(false, 'Worker injoignable');
  }
}

async function discordRequest(method, path, body, reason, guildOverride) {
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
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return null;
  try { return await res.json(); } catch (e) { return null; }
}

class UserInputError extends Error {}

window.executeBotCommand = async function(cmdName) {
  if (!selectedGuild) { switchTab('servers'); return; }
  try {
    if (cmdName === 'ping') {
      const t0 = performance.now();
      await discordRequest('GET', '/users/@me');
      toast('ok', 'Terminé', `Pong ! ${Math.round(performance.now() - t0)} ms`);
    }
  } catch (e) {
    toast('error', 'Erreur', e.message);
  }
};

function toast(kind, title, text) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.innerHTML = `<strong>${title}</strong><p>${text || ''}</p>`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function loadOverview() {
  if (!selectedGuild) return;
  const g = userGuilds.find(x => x.id === selectedGuild.id);
  document.getElementById('ov-empty').classList.add('hidden');
  document.getElementById('ov-body').classList.remove('hidden');
  document.getElementById('ov-icon').src = guildIconUrl(g);
  document.getElementById('ov-name').textContent = selectedGuild.name;
}

window.goCommand = function(cat) {
  switchTab('categories');
  switchCategory(cat);
};

function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.getElementById(`nav-${tab}`).classList.add('active');
  window.scrollTo({ top: 0 });
}

window.switchCategory = function(cat) {
  document.querySelectorAll('.cmd-category-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.category-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`category-${cat}`).classList.remove('hidden');
  document.getElementById(`cat-btn-${cat}`).classList.add('active');
};

function initEventListeners() {
  document.getElementById('btn-refresh-guilds')?.addEventListener('click', () => {
    fetchUserGuilds(localStorage.getItem('discord_token'));
  });
}
