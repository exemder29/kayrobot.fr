// Projet Firebase qui contient la base Firestore (collection admin, document config)
const firebaseConfig = {
  apiKey: "AIzaSyASXGakU4JZXw6LfYH1h4TSjhnb8MTr62A",
  authDomain: "kayrobot-discord.firebaseapp.com",
  projectId: "kayrobot-discord",
  storageBucket: "kayrobot-discord.firebasestorage.app",
  messagingSenderId: "410306319312",
  appId: "1:410306319312:web:bd46a2752eb63c2a329fd5"
};
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const db = firebase.firestore();

// Worker Cloudflare qui reçoit et stocke les messages du support
const SUPPORT_API = 'https://kayrobot-proxy.exem029.workers.dev';

window.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('admin_authenticated') === 'true') {
    // Les messages du support demandent le code : s'il manque (ancienne session), on le redemande une fois
    if (localStorage.getItem('admin_code')) { showAdminPanel(); }
    else { window.logoutAdmin(); }
  }
});

async function verifyAdminCode() {
  const enteredCode = document.getElementById('admin-code-input').value.trim();
  const errorEl = document.getElementById('auth-error');
  const fail = msg => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
  try {
    const docSnap = await db.collection('admin').doc('config').get();
    if (!docSnap.exists) return fail(`Document admin/config introuvable dans le projet Firebase « ${firebaseConfig.projectId} ».`);
    const valid = docSnap.data()?.code;
    if (!valid) return fail('Le champ « code » est absent du document admin/config.');
    if (enteredCode === String(valid).trim()) {
      localStorage.setItem('admin_authenticated', 'true');
      localStorage.setItem('admin_code', enteredCode);
      showAdminPanel();
      return;
    }
    fail('Code incorrect. Réessaie.');
  } catch (err) {
    // Affiche la vraie cause (règles Firestore, mauvais projet, réseau…)
    fail(`Erreur Firebase (${err.code || 'inconnue'}) : ${err.message}`);
  }
}

function showAdminPanel() {
  document.getElementById('auth-modal').classList.add('hidden');
  document.getElementById('admin-panel').classList.remove('hidden');
  loadSupportMessages();
}

window.logoutAdmin = function() {
  localStorage.removeItem('admin_authenticated');
  localStorage.removeItem('admin_code');
  document.getElementById('admin-panel').classList.add('hidden');
  document.getElementById('auth-modal').classList.remove('hidden');
  document.getElementById('admin-code-input').value = '';
};

// ---------- Messages du support ----------
function supportHeaders() {
  return { 'X-Admin-Code': localStorage.getItem('admin_code') || '' };
}

// Code refusé par le Worker : on reverrouille pour le redemander
function relockAdmin(msg) {
  window.logoutAdmin();
  const errorEl = document.getElementById('auth-error');
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

window.loadSupportMessages = async function () {
  const status = document.getElementById('inbox-status');
  const list = document.getElementById('inbox-list');
  const count = document.getElementById('inbox-count');
  status.textContent = 'Chargement…';
  try {
    const res = await fetch(`${SUPPORT_API}/support`, { headers: supportHeaders() });
    const out = await res.json().catch(() => ({}));
    if (res.status === 403) return relockAdmin('Code refusé par le serveur. Saisis-le à nouveau.');
    if (!res.ok) throw new Error(out.message || `Erreur ${res.status}`);
    renderSupportMessages(out.messages || []);
    count.textContent = (out.messages || []).length + (out.more ? '+' : '');
    status.textContent = (out.messages || []).length ? '' : 'Aucun message pour le moment.';
  } catch (err) {
    list.replaceChildren();
    status.textContent = `Impossible de charger les messages : ${err.message}`;
  }
};

// Tout est inséré avec textContent : le contenu des messages vient du public et n'est jamais interprété comme du HTML
function renderSupportMessages(messages) {
  const list = document.getElementById('inbox-list');
  list.replaceChildren();
  messages.forEach(m => {
    const item = document.createElement('article');
    item.className = 'inbox-item';

    const meta = document.createElement('div');
    meta.className = 'inbox-meta';
    const tag = document.createElement('span');
    tag.className = 'inbox-tag';
    tag.textContent = m.subject;
    const contact = document.createElement('span');
    contact.className = 'inbox-contact';
    contact.textContent = m.contact;
    const date = document.createElement('span');
    date.className = 'inbox-date';
    date.textContent = new Date(m.createdAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
    meta.append(tag, contact, date);

    const text = document.createElement('p');
    text.className = 'inbox-text';
    text.textContent = m.message;

    const actions = document.createElement('div');
    actions.className = 'inbox-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-small';
    del.innerHTML = '<i class="fa-solid fa-trash"></i> Supprimer';
    del.addEventListener('click', () => deleteSupportMessage(m.id, del));
    actions.append(del);

    item.append(meta, text, actions);
    list.append(item);
  });
}

async function deleteSupportMessage(id, btn) {
  if (!confirm('Supprimer ce message définitivement ?')) return;
  btn.disabled = true;
  try {
    const res = await fetch(`${SUPPORT_API}/support/${encodeURIComponent(id)}`, { method: 'DELETE', headers: supportHeaders() });
    if (res.status === 403) return relockAdmin('Code refusé par le serveur. Saisis-le à nouveau.');
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    loadSupportMessages();
  } catch (err) {
    btn.disabled = false;
    alert(`Suppression impossible : ${err.message}`);
  }
}
