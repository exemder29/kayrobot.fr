// Configuration Firebase (Assurez-vous d'adapter avec vos identifiants si besoin, ou utilise la collection Firestore existante)
const firebaseConfig = {
  projectId: "kayrobot-fr" // Remplacez si besoin par votre ID de projet Firestore
};

// Initialisation Firebase sécurisée
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

window.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('admin_authenticated') === 'true') {
    showAdminPanel();
  }
});

async function verifyAdminCode() {
  const enteredCode = document.getElementById('admin-code-input').value.trim();
  const errorEl = document.getElementById('auth-error');

  try {
    // Récupération du document dans Firestore : collection 'admin' -> document 'config'
    const docRef = db.collection('admin').doc('config');
    const docSnap = await docRef.get();

    let validCode = "EZ85//"; // Valeur par défaut correspondant à votre capture Firestore

    if (docSnap.exists) {
      const data = docSnap.data();
      if (data && data.code) {
        validCode = data.code;
      }
    }

    if (enteredCode === validCode) {
      localStorage.setItem('admin_authenticated', 'true');
      showAdminPanel();
    } else {
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    console.error("Erreur Firestore, utilisation du code de secours :", err);
    // Fallback de sécurité si Firestore est hors-ligne
    if (enteredCode === "EZ85//") {
      localStorage.setItem('admin_authenticated', 'true');
      showAdminPanel();
    } else {
      errorEl.classList.remove('hidden');
    }
  }
}

function showAdminPanel() {
  document.getElementById('auth-modal').classList.add('hidden');
  document.getElementById('admin-panel').classList.remove('hidden');
  
  const savedToken = localStorage.getItem('bot_secret_token');
  if (savedToken) {
    document.getElementById('admin-bot-token').value = savedToken;
  }
}

window.saveToken = function() {
  const token = document.getElementById('admin-bot-token').value.trim();
  if (!token) {
    alert("Veuillez entrer un token valide !");
    return;
  }
  localStorage.setItem('bot_secret_token', token);
  const status = document.getElementById('save-status');
  status.classList.remove('hidden');
  setTimeout(() => status.classList.add('hidden'), 4000);
};

window.logoutAdmin = function() {
  localStorage.removeItem('admin_authenticated');
  document.getElementById('admin-panel').classList.add('hidden');
  document.getElementById('auth-modal').classList.remove('hidden');
  document.getElementById('admin-code-input').value = '';
};
