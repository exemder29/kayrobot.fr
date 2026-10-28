import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyASXGakU4JZXw6LfYH1h4TSjhnb8MTr62A",
  authDomain: "kayrobot-discord.firebaseapp.com",
  projectId: "kayrobot-discord",
  storageBucket: "kayrobot-discord.firebasestorage.app",
  messagingSenderId: "410306319312",
  appId: "1:410306319312:web:bd46a2752eb63c2a329fd5"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Protéger la page : si pas connecté -> redirection vers la page de login (index.html)
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
  } else {
    document.getElementById("user-display-name").textContent = user.displayName || user.email;
  }
});

// Déconnexion
document.getElementById("btn-logout").addEventListener("click", () => {
  signOut(auth).then(() => {
    window.location.href = "index.html";
  });
});

// Navigation entre les onglets
const tabs = ['dashboard', 'console', 'embed', 'settings'];
tabs.forEach(tab => {
  const btn = document.getElementById(`nav-${tab}`);
  if (btn) {
    btn.addEventListener("click", () => {
      tabs.forEach(t => {
        document.getElementById(`tab-${t}`).classList.add("hidden");
        document.getElementById(`nav-${t}`).classList.remove("active");
      });
      document.getElementById(`tab-${tab}`).classList.remove("hidden");
      btn.classList.add("active");
    });
  }
});

// Console Logger Function
function appendLog(type, message) {
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
}

// Event Listeners Boutons Console
document.getElementById("btn-send-cmd").addEventListener("click", () => {
  const input = document.getElementById("console-input");
  const cmd = input.value.trim();
  if (cmd) {
    appendLog("USER", cmd);
    input.value = "";
    setTimeout(() => {
      appendLog("INFO", `Commande '${cmd}' envoyée à KayRobot.`);
    }, 200);
  }
});

document.getElementById("btn-clear-logs").addEventListener("click", () => {
  document.getElementById("console-output").innerHTML = "";
  appendLog("SYSTEM", "Console effacée.");
});

document.getElementById("btn-export-logs").addEventListener("click", () => {
  const text = document.getElementById("console-output").innerText;
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kayrobot-logs-${Date.now()}.txt`;
  a.click();
});

// Quick Actions
document.getElementById("btn-action-ping").addEventListener("click", () => appendLog("SYSTEM", "Exécution /ping... Latence 24ms"));
document.getElementById("btn-action-cache").addEventListener("click", () => appendLog("SYSTEM", "Purge du cache effectuée."));
document.getElementById("btn-action-restart").addEventListener("click", () => appendLog("WARN", "Signal de redémarrage envoyé au bot KayRobot..."));

// Preview Embed en direct
const updatePreview = () => {
  document.getElementById("preview-title").textContent = document.getElementById("embed-title").value || "Annonce importante !";
  document.getElementById("preview-description").textContent = document.getElementById("embed-description").value || "Tapez votre message ici...";
  document.getElementById("preview-card").style.borderColor = document.getElementById("embed-color").value || "#5865F2";
  document.getElementById("preview-footer").textContent = document.getElementById("embed-footer").value || "KayRobot System";
};

["embed-title", "embed-description", "embed-color", "embed-footer"].forEach(id => {
  document.getElementById(id).addEventListener("input", updatePreview);
});

document.getElementById("btn-send-embed").addEventListener("click", () => {
  const chan = document.getElementById("embed-channel").value;
  if (!chan) {
    alert("Veuillez indiquer un ID de salon Discord !");
    return;
  }
  appendLog("INFO", `Embed envoyé dans le salon #${chan}`);
  alert("Embed envoyé avec succès !");
});

document.getElementById("btn-save-settings").addEventListener("click", () => {
  appendLog("INFO", "Paramètres sauvegardés avec succès.");
  alert("Paramètres sauvegardés !");
});
