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

window.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('admin_authenticated') === 'true') { showAdminPanel(); }
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
}

window.logoutAdmin = function() {
  localStorage.removeItem('admin_authenticated');
  document.getElementById('admin-panel').classList.add('hidden');
  document.getElementById('auth-modal').classList.remove('hidden');
  document.getElementById('admin-code-input').value = '';
};
