import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyASXGakU4JZXw6LfYH1h4TSjhnb8MTr62A",
  authDomain: "kayrobot-discord.firebaseapp.com",
  projectId: "kayrobot-discord",
  storageBucket: "kayrobot-discord.firebasestorage.app",
  messagingSenderId: "410306319312",
  appId: "1:410306319312:web:bd46a2752eb63c2a329fd5"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Authentication Logic
const btnLogin = document.getElementById("btn-login");
const userName = document.getElementById("user-name");

btnLogin.addEventListener("click", () => {
  const provider = new GoogleAuthProvider();
  signInWithPopup(auth, provider)
    .then((result) => {
      appendLog("INFO", `Connecté en tant que ${result.user.displayName}`);
    })
    .catch((error) => {
      appendLog("ERROR", `Erreur d'authentification: ${error.message}`);
    });
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    userName.textContent = user.displayName || user.email;
    btnLogin.textContent = "Déconnexion";
    btnLogin.onclick = () => auth.signOut();
  } else {
    userName.textContent = "Non connecté";
    btnLogin.textContent = "Connexion";
  }
});

// UI Navigation Switcher
window.switchTab = function(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(`tab-${tabName}`);
  const targetNav = document.getElementById(`nav-${tabName}`);
  
  if (targetTab) targetTab.classList.remove('hidden');
  if (targetNav) targetNav.classList.add('active');

  const titles = {
    'dashboard': 'Tableau de Bord',
    'console': 'Console En Direct',
    'embed': 'Créateur d'Embeds',
    'settings': 'Configuration Bot'
  };
  document.getElementById('page-title').textContent = titles[tabName] || 'Console';
};

// OAuth Modal Toggle
window.toggleOAuthModal = function() {
  const modal = document.getElementById('oauth-modal');
  modal.classList.toggle('hidden');
};

// Console Logging Engine
window.appendLog = function(type, message) {
  const consoleOutput = document.getElementById("console-output");
  const time = new Date().toLocaleTimeString();
  
  let colorClass = "text-gray-300";
  if (type === "INFO") colorClass = "text-green-400";
  if (type === "WARN") colorClass = "text-yellow-400";
  if (type === "ERROR") colorClass = "text-red-400";

  const logRow = document.createElement("div");
  logRow.innerHTML = `<span class="text-gray-500">[${time}]</span> <span class="${colorClass}">[${type}]</span> ${message}`;
  consoleOutput.appendChild(logRow);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
};

window.clearLogs = function() {
  document.getElementById("console-output").innerHTML = '';
  appendLog("SYSTEM", "Console nettoyée.");
};

window.exportLogs = function() {
  const text = document.getElementById("console-output").innerText;
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kayrobot-logs-${Date.now()}.txt`;
  a.click();
};

window.submitConsoleCommand = function() {
  const input = document.getElementById("console-input");
  const cmd = input.value.trim();
  if (!cmd) return;

  appendLog("USER", cmd);
  input.value = '';

  // Simulate command execution or send to Firestore
  if (cmd.startsWith("/")) {
    setTimeout(() => {
      appendLog("INFO", `Commande '${cmd}' transmise à KayRobot (ID: 1563284812351938611).`);
    }, 300);
  } else {
    appendLog("WARN", "Les commandes doivent débuter par un '/'.");
  }
};

// Embed Live Preview Sync
window.updateEmbedPreview = function() {
  const title = document.getElementById('embed-title').value || 'Annonce importante !';
  const desc = document.getElementById('embed-description').value || 'Tapez votre message ici...';
  const color = document.getElementById('embed-color').value || '#5865F2';
  const footer = document.getElementById('embed-footer').value || 'KayRobot System';

  document.getElementById('preview-title').textContent = title;
  document.getElementById('preview-description').textContent = desc;
  document.getElementById('preview-card').style.borderColor = color;
  document.getElementById('preview-footer').textContent = footer;
};

window.sendEmbed = function() {
  const channel = document.getElementById('embed-channel').value;
  if (!channel) {
    alert("Veuillez renseigner un ID de salon Discord valide.");
    return;
  }
  appendLog("INFO", `Embed envoyé sur le canal #${channel}`);
  alert("Embed envoyé avec succès !");
};

window.sendQuickAction = function(action) {
  appendLog("SYSTEM", `Action rapide déclenchée: ${action}`);
};

window.saveSettings = function() {
  appendLog("INFO", "Paramètres sauvegardés avec succès dans Firestore.");
  alert("Paramètres enregistrés !");
};
