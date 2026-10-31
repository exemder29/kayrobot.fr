// Worker Cloudflare qui reçoit et stocke les messages du support
const SUPPORT_API = 'https://kayrobot-proxy.exem029.workers.dev';

// Pas de session admin (ou code manquant) : retour à la page de saisie du code
function backToAdmin() {
  localStorage.removeItem('admin_authenticated');
  localStorage.removeItem('admin_code');
  window.location.replace('admin');
}

if (localStorage.getItem('admin_authenticated') !== 'true' || !localStorage.getItem('admin_code')) {
  backToAdmin();
}

function supportHeaders() {
  return { 'X-Admin-Code': localStorage.getItem('admin_code') || '' };
}

async function loadSupportMessages() {
  const status = document.getElementById('inbox-status');
  const list = document.getElementById('inbox-list');
  const count = document.getElementById('inbox-count');
  status.textContent = 'Chargement…';
  try {
    const res = await fetch(`${SUPPORT_API}/support`, { headers: supportHeaders() });
    const out = await res.json().catch(() => ({}));
    if (res.status === 403) return backToAdmin();
    if (!res.ok) throw new Error(out.message || `Erreur ${res.status}`);
    const messages = out.messages || [];
    renderSupportMessages(messages);
    count.textContent = messages.length + (out.more ? '+' : '');
    status.textContent = messages.length ? '' : 'Aucun message pour le moment.';
  } catch (err) {
    list.replaceChildren();
    status.textContent = `Impossible de charger les messages : ${err.message}`;
  }
}

// Tout est inséré avec textContent : le contenu des messages vient du public et n'est jamais interprété comme du HTML
function fmtDate(ms) {
  return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

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
    date.textContent = fmtDate(m.createdAt);
    meta.append(tag, contact, date);

    const text = document.createElement('p');
    text.className = 'inbox-text';
    text.textContent = m.message;
    item.append(meta, text);

    if (m.replies && m.replies.length) {
      const replies = document.createElement('div');
      replies.className = 'inbox-replies';
      m.replies.forEach(r => {
        const box = document.createElement('div');
        box.className = 'inbox-reply';
        const small = document.createElement('small');
        small.textContent = `Ta réponse · ${fmtDate(r.createdAt)}`;
        const t = document.createElement('p');
        t.className = 'inbox-text';
        t.textContent = r.text;
        box.append(small, t);
        replies.append(box);
      });
      item.append(replies);
    }

    // Zone de réponse
    const form = document.createElement('div');
    form.className = 'inbox-reply-form';
    const area = document.createElement('textarea');
    area.className = 'input';
    area.maxLength = 2000;
    area.placeholder = 'Écris ta réponse…';
    const row = document.createElement('div');
    row.className = 'row';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-primary btn-small';
    send.innerHTML = '<i class="fa-solid fa-reply"></i> Répondre';
    send.addEventListener('click', () => replySupportMessage(m.id, area, send));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-small';
    del.innerHTML = '<i class="fa-solid fa-trash"></i> Supprimer';
    del.addEventListener('click', () => deleteSupportMessage(m.id, del));
    row.append(send, del);
    form.append(area, row);
    item.append(form);

    list.append(item);
  });
}

async function replySupportMessage(id, area, btn) {
  const text = area.value.trim();
  if (!text) { area.focus(); return; }
  btn.disabled = true;
  try {
    const res = await fetch(`${SUPPORT_API}/support/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      headers: { ...supportHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 403) return backToAdmin();
    if (!res.ok) throw new Error(out.message || `Erreur ${res.status}`);
    loadSupportMessages();
  } catch (err) {
    btn.disabled = false;
    alert(`Réponse impossible : ${err.message}`);
  }
}

async function deleteSupportMessage(id, btn) {
  if (!confirm('Supprimer ce message et ses réponses définitivement ?')) return;
  btn.disabled = true;
  try {
    const res = await fetch(`${SUPPORT_API}/support/${encodeURIComponent(id)}`, { method: 'DELETE', headers: supportHeaders() });
    if (res.status === 403) return backToAdmin();
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    loadSupportMessages();
  } catch (err) {
    btn.disabled = false;
    alert(`Suppression impossible : ${err.message}`);
  }
}

document.getElementById('inbox-refresh').addEventListener('click', loadSupportMessages);
loadSupportMessages();
