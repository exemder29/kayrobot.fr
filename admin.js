const firebaseConfig = { projectId: "kayrobot-fr" };
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const db = firebase.firestore();

window.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('admin_authenticated') === 'true') { showAdminPanel(); }
});

async function verifyAdminCode() {
  const enteredCode = document.getElementById('admin-code-input').value.trim();
  const errorEl = document.getElementById('auth-error');
  try {
    const docRef = db.collection('admin').doc('config');
    const docSnap = await docRef.get();
    if (docSnap.exists && docSnap.data()?.code) {
      if (enteredCode === docSnap.data().code) {
        localStorage.setItem('admin_authenticated', 'true');
        showAdminPanel();
        return;
      }
    }
    errorEl.classList.remove('hidden');
  } catch (err) {
    errorEl.classList.remove('hidden');
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
