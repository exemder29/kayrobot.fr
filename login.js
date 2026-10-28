import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, signInWithPopup, OAuthProvider, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

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
const statusMsg = document.getElementById("auth-status-msg");
const btnDiscord = document.getElementById("btn-login-discord");

// Redirection si déjà connecté
onAuthStateChanged(auth, (user) => {
  if (user) {
    statusMsg.innerHTML = `<span class="text-green-400 font-semibold"><i class="fa-solid fa-circle-check"></i> Connecté avec Discord (${user.displayName || user.email})</span>. Redirection...`;
    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 1000);
  }
});

// Connexion via le provider OIDC / OAuth2 Discord configuré sur Firebase Auth
btnDiscord.addEventListener("click", () => {
  const provider = new OAuthProvider("oidc.discord");
  statusMsg.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-discord-blurple"></i> Connexion via Discord en cours...';

  signInWithPopup(auth, provider)
    .then((result) => {
      statusMsg.innerHTML = `<span class="text-green-400"><i class="fa-solid fa-check"></i> Bienvenue ${result.user.displayName}!</span>`;
      window.location.href = "dashboard.html";
    })
    .catch((error) => {
      console.error(error);
      statusMsg.innerHTML = `<span class="text-red-400"><i class="fa-solid fa-circle-xmark"></i> Erreur : ${error.message}</span>`;
    });
});
