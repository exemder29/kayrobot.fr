const CLIENT_ID = '1563284812351938611';
let userGuilds = [];
let selectedGuild = null;
let currentUserId = '';
let rawChannelsList = [];
let allChannelsList = [];
let guildRolesList = [];

// Les appels au bot passent par le Worker Cloudflare (le token du bot reste secret côté serveur).
// Colle ici l'URL de ton Worker (sans "/" à la fin), ex : https://kayrobot-proxy.moncompte.workers.dev
const BOT_PROXY_URL = 'https://kayrobot-proxy.exem029.workers.dev';

function proxyConfigured() {
  return /^https:\/\/.+/.test(BOT_PROXY_URL);
}

// ---------- Connexion Discord : mémorisée, renouvelée en silence ----------
const REDIRECT_URI = 'https://exemder29.github.io/kayrobot.fr/dashboard.html';
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const authUrl = silent =>
  `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=token&scope=identify%20guilds${silent ? '&prompt=none' : ''}`;

// Renvoie le token s'il est encore valable (les anciens tokens sans date sont gardés jusqu'à un refus de Discord)
function storedToken() {
  const t = localStorage.getItem('discord_token');
  const exp = Number(localStorage.getItem('discord_token_exp')) || 0;
  return t && (!exp || exp > Date.now() + 60_000) ? t : null;
}

// Va chercher un nouveau token. Si le compte a déjà été autorisé, Discord répond sans rien demander.
function startLogin() {
  const last = Number(sessionStorage.getItem('kayrobot_login_try')) || 0;
  if (Date.now() - last < 15_000) { window.location.href = 'index.html'; return; } // évite toute boucle
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

  if (accessToken) {
    localStorage.setItem('discord_token', accessToken);
    localStorage.setItem('discord_token_exp', String(Date.now() + (Number(hash.get('expires_in')) || 604800) * 1000));
    localStorage.setItem('discord_remember', '1');
    sessionStorage.removeItem('kayrobot_login_try');
    sessionStorage.removeItem('kayrobot_manual');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (authError) {
    window.history.replaceState({}, document.title, window.location.pathname);
    if (authError === 'access_denied') { localStorage.removeItem('discord_remember'); window.location.href = 'index.html'; return; }
    // La reconnexion silencieuse n'a pas abouti : on demande normalement, une seule fois
    if (!sessionStorage.getItem('kayrobot_manual')) {
      sessionStorage.setItem('kayrobot_manual', '1');
      window.location.href = authUrl(false);
    } else {
      window.location.href = 'index.html';
    }
    return;
  }

  const token = storedToken();
  if (!token) { startLogin(); return; }

  // Vérifier le Worker (affiche seulement son état)
  checkProxy();

  initDashboard(token);
  initEventListeners();
});

function initDashboard(token) {
  const headers = { Authorization: `Bearer ${token}` };
  // Profil, serveurs et présence du bot partent en même temps
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
    if (err.expired) startLogin(); // token refusé : on le renouvelle sans te déconnecter
    else toast('warn', 'Discord injoignable', 'Impossible de charger ton profil pour le moment.');
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
    console.error(err);
    loading.innerHTML = '<p class="text-sm text-discord-red">Erreur lors de la récupération des serveurs.</p>';
    if (IS_MOBILE) {
      loading.innerHTML += '<p class="fine" id="guilds-err"></p><p style="margin-top:10px"><button type="button" class="btn btn-primary btn-small" id="btn-guilds-retry">Réessayer</button> <button type="button" class="btn btn-ghost btn-small" id="btn-guilds-relogin">Se reconnecter</button></p>';
      document.getElementById('guilds-err').textContent = err.message || 'erreur réseau';
      document.getElementById('btn-guilds-retry').onclick = () => fetchUserGuilds(localStorage.getItem('discord_token') || token);
      document.getElementById('btn-guilds-relogin').onclick = () => { sessionStorage.removeItem('kayrobot_login_try'); startLogin(); };
    }
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

let showAbsentGuilds = IS_MOBILE;

function renderGuilds(guilds) {
  const container = document.getElementById('guilds-container');
  const loading = document.getElementById('guilds-loading');
  container.innerHTML = '';
  updateAbsentToggle();

  if (guilds.length === 0) {
    loading.classList.add('hidden');
    container.classList.remove('hidden');
    container.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>Aucun serveur trouvé</strong><p>Tu dois être propriétaire ou administrateur d\'un serveur pour le gérer ici.</p></div>';
    return;
  }
  // Tant que le bot n'est pas vérifié, on n'affiche rien d'autre que le chargement
  const known = guilds.every(g => presenceCache.has(g.id));
  if (!known) { loading.classList.remove('hidden'); loading.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><p>Recherche du bot sur tes serveurs…</p>'; container.classList.add('hidden'); }

  const queue = [];
  guilds.forEach(guild => {
    const card = document.createElement('article');
    card.className = 'guild hidden';
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

  const paint = (guild, card, present) => {
    const state = card.querySelector('.state');
    const btns = card.querySelector('.guild-btns');
    card.dataset.absent = present === false ? '1' : '';
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
    // Seuls les serveurs avec le bot sont montrés (les autres via le bouton sous la liste)
    card.classList.toggle('hidden', present === false && !showAbsentGuilds);
  };

  // Quand tout est vérifié : affiche la liste (ou un message s'il n'y a rien)
  const finish = () => {
    loading.classList.add('hidden');
    container.classList.remove('hidden');
    container.querySelectorAll('.empty').forEach(e => e.remove());
    if (!queue.some(({ card }) => !card.classList.contains('hidden'))) {
      const absent = queue.filter(({ card }) => card.dataset.absent === '1').length;
      container.insertAdjacentHTML('afterbegin', `<div class="empty" style="grid-column:1/-1"><strong>Le bot n'est sur aucun de ces serveurs</strong><p>${absent ? 'Affiche les serveurs sans le bot ci-dessous pour l\'y inviter.' : 'Aucun résultat.'}</p></div>`);
    }
    updateAbsentToggle();
  };

  loadPresence().then(async ok => {
    if (ok || known) {
      queue.forEach(({ guild, card }) => paint(guild, card, presenceCache.get(guild.id) === true));
      return finish();
    }
    // Repli (Worker pas encore mis à jour) : vérification serveur par serveur, 6 à la fois
    let next = 0;
    const run = async () => {
      while (next < queue.length) {
        const { guild, card } = queue[next++];
        let present = presenceCache.has(guild.id) ? presenceCache.get(guild.id) : null;
        if (present === null) {
          try {
            await discordRequest('GET', `/guilds/${guild.id}`, undefined, undefined, guild.id);
            present = true;
          } catch (e) {
            present = IS_MOBILE ? (/code (10004|50001)\)/.test(e.message) ? false : null) : (/\b(403|404)\b/.test(e.message) ? false : null);
          }
          if (present !== null) presenceCache.set(guild.id, present);
        }
        paint(guild, card, present);
        container.classList.remove('hidden'); loading.classList.add('hidden'); // les serveurs apparaissent au fur et à mesure
      }
    };
    await Promise.all([run(), run(), run(), run(), run(), run()]);
    finish();
  });
}

// Bouton « Afficher les serveurs sans le bot »
function updateAbsentToggle() {
  const box = document.getElementById('guilds-extra');
  if (!box) return;
  const n = userGuilds.filter(g => presenceCache.get(g.id) === false).length;
  box.classList.toggle('hidden', n === 0);
  const btn = document.getElementById('btn-show-absent');
  btn.textContent = showAbsentGuilds ? `Masquer les ${n} serveur(s) sans le bot` : `Afficher les ${n} serveur(s) sans le bot`;
}

// Une seule requête au Worker : la liste des serveurs (parmi les tiens) où le bot est présent
let presenceLoading = null;
function loadPresence() {
  if (presenceLoading) return presenceLoading;
  presenceLoading = (async () => {
    if (!proxyConfigured()) return false;
    try {
      const res = await fetch(`${BOT_PROXY_URL}/__presence`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('discord_token')}` }
      });
      if (!res.ok) return false;
      const d = await res.json();
      if (!Array.isArray(d.present)) return false;
      const set = new Set(d.present);
      userGuilds.forEach(g => presenceCache.set(g.id, set.has(g.id)));
      return true;
    } catch (e) { return false; }
  })();
  // on garde le résultat 30 s, comme le cache du Worker
  setTimeout(() => { presenceLoading = null; }, 30000);
  return presenceLoading;
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

// ---------- Configuration des tickets (partagée avec le bot via le Worker) ----------
async function loadTicketConfig(guildId) {
  const status = document.getElementById('ticket-cfg-status');
  if (!status) return;
  status.textContent = 'Chargement de la configuration…';

  const fill = (id, items, placeholder, current) => {
    const sel = document.getElementById(id);
    sel.innerHTML = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = placeholder; sel.appendChild(none);
    items.forEach(it => { const o = document.createElement('option'); o.value = it.id; o.textContent = it.label; sel.appendChild(o); });
    sel.value = items.some(i => i.id === current) ? current : '';
  };

  // 1) Salons et rôles : indépendants de la config enregistrée
  const rolesError = await loadGuildRoles(guildId);
  if (!selectedGuild || selectedGuild.id !== guildId) return;
  fill('tcfg-channel', rawChannelsList.map(c => ({ id: c.id, label: `#${c.name}` })), 'Choisis un salon', '');
  fill('tcfg-role', guildRolesList.map(r => ({ id: r.id, label: `@${r.name}` })), 'Choisis un rôle', '');
  fill('tcfg-category', allChannelsList.filter(c => c.type === 4).map(c => ({ id: c.id, label: c.name })), 'Aucune catégorie', '');

  // 2) Config déjà enregistrée (peut échouer sans bloquer les listes)
  try {
    const cfg = await discordRequest('GET', `/config/${guildId}/tickets`);
    if (!selectedGuild || selectedGuild.id !== guildId) return;
    document.getElementById('tcfg-channel').value = cfg.requestChannelId || '';
    document.getElementById('tcfg-role').value = cfg.staffRoleId || '';
    document.getElementById('tcfg-category').value = cfg.categoryId || '';
    refreshTicketUi(cfg);
    status.textContent = cfg.updatedAt
      ? `Dernière modification ${formatWhen(cfg.updatedAt)} (${cfg.updatedBy === 'discord' ? 'depuis Discord' : 'depuis le site'}).`
      : 'Pas encore configuré.';
  } catch (e) {
    status.textContent = rolesError || (/KV|CONFIG|500/.test(e.message)
      ? "Le stockage de configuration n'est pas encore activé sur le Worker : tu peux remplir le formulaire, mais l'enregistrement ne marchera qu'après la mise en place décrite dans BOT-SYNC.md."
      : `Configuration indisponible : ${e.message}`);
    return;
  }
  if (rolesError) status.textContent = rolesError;
}

// Met à jour les éléments qui dépendent de la config (questions, liste des types à retirer)
function refreshTicketUi(cfg) {
  const q = document.getElementById('tcfg-questions');
  if (q) q.value = (cfg.questions || []).join('\n');
  const sel = document.getElementById('topt-remove-select');
  if (sel) fillSelect(sel, (cfg.options || []).map(o => ({ id: o, label: o })), (cfg.options || []).length ? 'Choisis un type' : 'Aucun type de ticket');
}

// Lit la config à jour, la modifie, puis la réenregistre (évite d'écraser un changement fait dans Discord)
async function updateTicketCfg(mutate) {
  const cfg = await discordRequest('GET', `/config/${selectedGuild.id}/tickets`);
  const next = {
    requestChannelId: cfg.requestChannelId || '', staffRoleId: cfg.staffRoleId || '', categoryId: cfg.categoryId || '',
    questions: cfg.questions || [], options: cfg.options || []
  };
  mutate(next);
  const doc = await discordRequest('PUT', `/config/${selectedGuild.id}/tickets`, next);
  refreshTicketUi(doc);
  const st = document.getElementById('ticket-cfg-status');
  if (st) st.textContent = `Dernière modification ${formatWhen(doc.updatedAt)} (depuis le site).`;
  return doc;
}

// Nom d'un type sans son emoji de début, en minuscules (pour repérer les doublons)
const optionLabel = s => s.replace(/^(<a?:\w+:\d+>|\p{Extended_Pictographic}[\p{Extended_Pictographic}\u200d\ufe0f]*)\s*/u, '').trim().toLowerCase();

async function saveTicketConfig() {
  if (!selectedGuild) { toast('warn', 'Choisis un serveur', "Sélectionne d'abord un serveur dans « Mes serveurs »."); switchTab('servers'); return; }
  if (!val('tcfg-channel')) { toast('warn', 'Choisis un salon', 'Le salon des demandes est obligatoire.'); return; }
  if (!val('tcfg-role')) { toast('warn', 'Choisis un rôle', 'Le rôle du staff est obligatoire.'); return; }
  try {
    await updateTicketCfg(c => { c.requestChannelId = val('tcfg-channel'); c.staffRoleId = val('tcfg-role'); c.categoryId = val('tcfg-category'); });
    toast('ok', 'Tickets configurés', 'Configuration enregistrée. Le bot l\'applique sous 30 secondes.');
    logActivity(true, 'Tickets configurés', 'Configuration enregistrée depuis le site.');
  } catch (e) {
    toast('error', "L'enregistrement a échoué", e.message, 9000);
    logActivity(false, 'Tickets configurés', e.message);
  }
}
window.saveTicketConfig = saveTicketConfig;

// ---------- Tâches exécutées par le bot (avertissements, programmations, bump, apparence) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function botJob(type, args) {
  let created;
  try {
    created = await discordRequest('POST', `/jobs/${selectedGuild.id}`, { type, args: { ...args, modId: currentUserId } });
  } catch (e) {
    if (/KV|CONFIG|500/.test(e.message)) throw new UserInputError("Le stockage du Worker n'est pas activé (voir BOT-SYNC.md).");
    throw e;
  }
  for (let i = 0; i < 25; i++) {
    await sleep(1500);
    const r = await discordRequest('GET', `/jobs/${selectedGuild.id}/${created.id}`);
    if (r.done) {
      if (!r.ok) throw new UserInputError(r.message || 'Le bot a refusé la demande.');
      return r.message;
    }
  }
  throw new UserInputError("Le bot n'a pas répondu. Vérifie qu'il est démarré avec SYNC_URL et BOT_API_KEY dans son .env.");
}

const fmtDateFr = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

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
  rawChannelsList = []; allChannelsList = []; guildRolesList = [];
  if (!proxyConfigured()) {
    setChannelDropdownsMessage('⚠️ URL du Worker non configurée dans dashboard.js (BOT_PROXY_URL)');
    return;
  }
  setChannelDropdownsMessage('Chargement des salons...');

  try {
    const channels = await discordRequest('GET', `/guilds/${guildId}/channels`);
    allChannelsList = channels;
    rawChannelsList = channels.filter(c => c.type === 0 || c.type === 5); // textuels + annonces
    populateAllChannelDropdowns(rawChannelsList);
    fillVoiceAndRoleDropdowns();
    loadTicketConfig(guildId);
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

function fillSelect(select, items, placeholder) {
  select.innerHTML = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = placeholder; select.appendChild(none);
  items.forEach(it => { const o = document.createElement('option'); o.value = it.id; o.textContent = it.label; select.appendChild(o); });
}

function fillVoiceAndRoleDropdowns() {
  const voices = allChannelsList.filter(c => c.type === 2 || c.type === 13).map(c => ({ id: c.id, label: `🔊 ${c.name}` }));
  document.querySelectorAll('.guild-voice-dropdown').forEach(sel => fillSelect(sel, voices, 'Choisis un salon vocal'));
  const roles = guildRolesList.map(r => ({ id: r.id, label: `@${r.name}` }));
  document.querySelectorAll('.guild-roles-dropdown').forEach(sel => fillSelect(sel, roles, 'Choisis un rôle'));
}

async function loadGuildRoles(guildId) {
  try {
    const roles = await discordRequest('GET', `/guilds/${guildId}/roles`);
    guildRolesList = roles.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
    fillVoiceAndRoleDropdowns();
    return '';
  } catch (e) {
    guildRolesList = [];
    fillVoiceAndRoleDropdowns();
    return /403|Route non autoris/.test(e.message)
      ? 'Rôles indisponibles : redéploie la dernière version de worker.js sur Cloudflare.'
      : `Rôles indisponibles : ${e.message}`;
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
  'ticket-panneau': 'ticket-panel-channel-select',
  'programmer': 'prog-channel-select',
  'bump-activer': 'bump-channel-select',
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


      case 'avertir': {
        const user = requireSnowflake(val('warn-user'), 'ID du membre');
        const reason = val('warn-reason');
        if (!reason) throw new UserInputError('Entrez une raison.');
        okMsg = await botJob('avertir', { userId: user, reason });
        break;
      }
      case 'avertissements':
        okMsg = await botJob('avertissements', { userId: requireSnowflake(val('warns-user'), 'ID du membre') });
        break;
      case 'effacer-avertissements': {
        const user = requireSnowflake(val('clearwarns-user'), 'ID du membre');
        if (!(await askConfirm('Effacer les avertissements ?', `Tous les avertissements du membre ${user} seront supprimés.`, 'Effacer'))) return;
        okMsg = await botJob('effacer-avertissements', { userId: user });
        break;
      }
      case 'programmer': {
        const content = val('prog-msg');
        if (!content) throw new UserInputError('Entrez un message.');
        const date = fmtDateFr(val('prog-date'));
        if (!date || !val('prog-time')) throw new UserInputError('Choisis une date et une heure.');
        okMsg = await botJob('programmer', { content, date, time: val('prog-time'), channelId });
        break;
      }
      case 'programmations':
        okMsg = await botJob('programmations', {});
        break;
      case 'annuler-programmation': {
        const id = val('prog-cancel-id');
        if (!id) throw new UserInputError("Entrez l'ID du message programmé (voir la liste).");
        okMsg = await botJob('annuler-programmation', { id });
        break;
      }
      case 'bump-activer':
        okMsg = await botJob('bump-activer', { channelId, roleId: val('bump-role-select') });
        break;
      case 'bump-desactiver':
      case 'bump-statut':
        okMsg = await botJob(cmdName, {});
        break;
      case 'apparence': {
        const name = val('look-name'), imageUrl = val('look-image');
        if (!name && !imageUrl) throw new UserInputError('Entrez un nom ou le lien d\'une photo.');
        okMsg = await botJob('apparence', { name, imageUrl });
        break;
      }
      case 'apparence-reset':
        if (!(await askConfirm("Réinitialiser l'apparence ?", 'Le bot reprendra son nom et sa photo de base.', 'Réinitialiser'))) return;
        okMsg = await botJob('apparence', { reset: true });
        break;

      case 'debannir': {
        const user = requireSnowflake(val('unban-user'), "ID de l'utilisateur");
        await discordRequest('DELETE', `/guilds/${guildId}/bans/${user}`, undefined, `${modName()} : ${val('unban-reason') || 'Aucune raison'}`);
        okMsg = `✅ Utilisateur ${user} débanni.`;
        break;
      }
      case 'fin-sourdine': {
        const user = requireSnowflake(val('untimeout-user'), 'ID du membre');
        await discordRequest('PATCH', `/guilds/${guildId}/members/${user}`, { communication_disabled_until: null }, `${modName()} : fin de sourdine`);
        okMsg = `✅ Sourdine retirée pour ${user}.`;
        break;
      }
      case 'deconnecter': {
        const user = requireSnowflake(val('vdisc-user'), 'ID du membre');
        await discordRequest('PATCH', `/guilds/${guildId}/members/${user}`, { channel_id: null }, `${modName()} : déconnexion vocale`);
        okMsg = `✅ Membre ${user} déconnecté du vocal.`;
        break;
      }
      case 'deplacer': {
        const user = requireSnowflake(val('vmove-user'), 'ID du membre');
        const target = val('vmove-channel');
        if (!target) throw new UserInputError('Choisis un salon vocal.');
        await discordRequest('PATCH', `/guilds/${guildId}/members/${user}`, { channel_id: target }, `${modName()} : déplacement vocal`);
        okMsg = `✅ Membre ${user} déplacé.`;
        break;
      }
      case 'role-modifier': {
        const role = val('rolemod-select');
        if (!role) throw new UserInputError('Choisis un rôle.');
        const body = {};
        if (val('rolemod-name')) body.name = val('rolemod-name');
        if (document.getElementById('rolemod-usecolor').checked) body.color = parseInt(val('rolemod-color').replace('#', ''), 16);
        if (!Object.keys(body).length) throw new UserInputError('Entrez un nouveau nom ou coche « Changer la couleur ».');
        await discordRequest('PATCH', `/guilds/${guildId}/roles/${role}`, body, `${modName()} : modification du rôle`);
        okMsg = '✅ Rôle modifié.';
        loadGuildRoles(guildId);
        break;
      }
      case 'role-supprimer': {
        const role = val('roledel-select');
        if (!role) throw new UserInputError('Choisis un rôle.');
        const r = guildRolesList.find(x => x.id === role);
        if (!(await askConfirm('Supprimer ce rôle ?', `Le rôle « ${r ? r.name : role} » sera supprimé définitivement.`, 'Supprimer'))) return;
        await discordRequest('DELETE', `/guilds/${guildId}/roles/${role}`, undefined, `${modName()} : suppression du rôle`);
        okMsg = '✅ Rôle supprimé.';
        loadGuildRoles(guildId);
        break;
      }
      case 'role-remplacer': {
        const member = requireSnowflake(val('rolerep-member'), 'ID du membre');
        const oldRole = val('rolerep-old'), newRole = val('rolerep-new');
        if (!oldRole || !newRole) throw new UserInputError('Choisis le rôle à retirer et le rôle à donner.');
        if (oldRole === newRole) throw new UserInputError('Les deux rôles sont identiques.');
        await discordRequest('PUT', `/guilds/${guildId}/members/${member}/roles/${newRole}`);
        await discordRequest('DELETE', `/guilds/${guildId}/members/${member}/roles/${oldRole}`);
        okMsg = '✅ Rôle remplacé.';
        break;
      }
      case 'role-voir': {
        const roles = await discordRequest('GET', `/guilds/${guildId}/roles`);
        const list = roles.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
        okMsg = `${list.length} rôle(s) :\n` + list.slice(0, 40).map(r => `@${r.name}`).join(', ');
        break;
      }
      case 'infos-membre': {
        const user = requireSnowflake(val('minfo-user'), 'ID du membre');
        const m = await discordRequest('GET', `/guilds/${guildId}/members/${user}`);
        const created = new Date(Number((BigInt(user) >> 22n) + 1420070400000n));
        const names = (m.roles || []).map(id => { const r = guildRolesList.find(x => x.id === id); return r ? `@${r.name}` : id; });
        okMsg = `${m.user ? m.user.username : user} (${user})\nCompte créé : ${created.toLocaleDateString('fr-FR')}\nA rejoint : ${m.joined_at ? new Date(m.joined_at).toLocaleDateString('fr-FR') : '?'}\nRôles : ${names.join(', ') || 'aucun'}`;
        break;
      }

      case 'serveur':
        throw new UserInputError(`/serveur et /serveur-annuler restent à lancer dans Discord : ils créent (ou suppriment) toute la structure du serveur et demandent de suivre le résultat sur place.`);

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

      case 'ticket-option-ajouter': {
        const names = val('topt-add').split(/[;,\n]/).map(x => x.trim()).filter(Boolean);
        if (!names.length) throw new UserInputError('Entrez au moins un nom.');
        const added = [], skipped = [];
        await updateTicketCfg(c => {
          for (const n of names) {
            if (n.length > 100) { skipped.push(`${n.slice(0, 20)}… (100 caractères max)`); continue; }
            if (c.options.length >= 25) { skipped.push(`${n} (25 types maximum)`); continue; }
            if (c.options.some(o => optionLabel(o) === optionLabel(n))) { skipped.push(`${n} (existe déjà)`); continue; }
            c.options.push(n); added.push(n);
          }
        });
        if (!added.length) throw new UserInputError(`Rien d'ajouté : ${skipped.join(', ')}.`);
        document.getElementById('topt-add').value = '';
        okMsg = `✅ Ajouté : ${added.join(', ')}.${skipped.length ? `\nIgnoré : ${skipped.join(', ')}.` : ''}\nRepose le panneau pour mettre le menu à jour.`;
        break;
      }
      case 'ticket-option-retirer': {
        const opt = val('topt-remove-select');
        if (!opt) throw new UserInputError('Choisis le type à retirer.');
        await updateTicketCfg(c => { c.options = c.options.filter(o => o !== opt); });
        okMsg = `🗑️ Retiré : ${opt}.\nRepose le panneau pour mettre le menu à jour.`;
        break;
      }
      case 'ticket-options': {
        const cfg = await discordRequest('GET', `/config/${selectedGuild.id}/tickets`);
        refreshTicketUi(cfg);
        okMsg = (cfg.options || []).length
          ? `📋 Types de ticket :\n${cfg.options.join('\n')}`
          : 'ℹ️ Aucun type : le panneau affiche un simple bouton « Créer un ticket ».';
        break;
      }
      case 'ticket-questions': {
        const qs = val('tcfg-questions').split('\n').map(x => x.trim()).filter(Boolean);
        if (!qs.length) throw new UserInputError('Entrez au moins une question (ou utilise « Question par défaut »).');
        if (qs.length > 5) throw new UserInputError('5 questions maximum (limite de Discord).');
        const tooLong = qs.find(q => q.length > 45);
        if (tooLong) throw new UserInputError(`« ${tooLong} » fait ${tooLong.length} caractères : 45 maximum par question.`);
        await updateTicketCfg(c => { c.questions = qs; });
        okMsg = `✅ ${qs.length} question(s) enregistrée(s). Le bot les applique sous 30 secondes.`;
        break;
      }
      case 'ticket-questions-defaut':
        await updateTicketCfg(c => { c.questions = []; });
        okMsg = '✅ Question par défaut rétablie. Le bot l\'applique sous 30 secondes.';
        break;

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
        okMsg = '✅ Panneau posté. Pense à enregistrer la configuration des tickets ci-dessus pour que le bouton fonctionne.';
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

    toast('ok', COMMAND_LABELS[cmdName] || 'Terminé', okMsg.replace(/^[^\p{L}\p{N}]+/u, ''), okMsg.length > 90 ? 20000 : 5000);
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
  'role-ajouter': 'Rôle donné', 'role-retirer': 'Rôle retiré', 'ticket-panneau': 'Panneau de tickets posté', 'ticket-config': 'Tickets configurés', 'ticket-option-ajouter': 'Types de ticket ajoutés', 'ticket-option-retirer': 'Type de ticket retiré', 'ticket-options': 'Types de ticket', 'ticket-questions': 'Questions enregistrées', 'ticket-questions-defaut': 'Question par défaut',
  'ping': 'Latence mesurée', 'infos-serveur': 'Statistiques postées',
  'avertir': 'Membre averti', 'avertissements': 'Avertissements', 'effacer-avertissements': 'Avertissements effacés',
  'programmer': 'Message programmé', 'programmations': 'Messages programmés', 'annuler-programmation': 'Programmation annulée',
  'bump-activer': 'Rappel de bump activé', 'bump-desactiver': 'Rappel de bump arrêté', 'bump-statut': 'Rappel de bump',
  'apparence': 'Apparence enregistrée', 'apparence-reset': 'Apparence réinitialisée',
  'debannir': 'Membre débanni', 'fin-sourdine': 'Sourdine retirée', 'deconnecter': 'Membre déconnecté', 'deplacer': 'Membre déplacé',
  'role-modifier': 'Rôle modifié', 'role-supprimer': 'Rôle supprimé', 'role-remplacer': 'Rôle remplacé', 'role-voir': 'Rôles du serveur', 'infos-membre': 'Infos du membre'
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
    presenceCache.clear(); presenceLoading = null;
    if (token) { document.getElementById('guilds-loading').classList.remove('hidden'); document.getElementById('guilds-container').classList.add('hidden'); fetchUserGuilds(token); }
  });
  document.getElementById('guild-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    renderGuilds(userGuilds.filter(g => g.name.toLowerCase().includes(q)));
  });
  document.getElementById('btn-show-absent').addEventListener('click', () => {
    showAbsentGuilds = !showAbsentGuilds;
    document.querySelectorAll('#guilds-container .guild[data-absent="1"]').forEach(c => c.classList.toggle('hidden', !showAbsentGuilds));
    updateAbsentToggle();
  });
  document.getElementById('btn-logout').addEventListener('click', logout);
}

function logout() {
  localStorage.removeItem('discord_token');
  localStorage.removeItem('discord_token_exp');
  localStorage.removeItem('discord_remember');
  window.location.href = 'index.html';
}
