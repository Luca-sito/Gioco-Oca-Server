const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { v4: uuidv4 } = require("uuid");
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const app = express();

function pulisciTesto(testo, massimo = 500) {
  if (typeof testo !== "string") return "";
  return testo.trim().replace(/[<>]/g, "").substring(0, massimo);
}

app.set("trust proxy", 1);

const ORIGINI_CONSENTITE = [
  "https://solfriniluca1.wixstudio.com",
  "https://solfriniluca1-wixstudio-com.filesusr.com",
  "https://gioco-oca-server.onrender.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ORIGINI_CONSENTITE.includes(origin)) return callback(null, true);
    console.log("CORS bloccato:", origin);
    callback(null, false);
  },
  credentials: true
}));

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
  frameguard: false
}));

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const DOMINIO_SERVER = "https://gioco-oca-server.onrender.com";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET mancante: impostala nelle variabili d'ambiente su Render prima di avviare il server.");
}

const OPZIONI_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: 30 * 24 * 60 * 60 * 1000
};

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Il file deve essere un'immagine."));
    cb(null, true);
  }
});

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { errore: "Troppi tentativi, riprova tra qualche minuto." },
  standardHeaders: true,
  legacyHeaders: false
});
const limiteContatti = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { errore: "Hai inviato troppe richieste, riprova più tardi." }
});

// ===== FIREBASE ADMIN =====
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://giochi-societa-e8add-default-rtdb.europe-west1.firebasedatabase.app"
  });
  db = admin.database();
  console.log("Firebase Admin inizializzato correttamente.");
} catch (e) {
  console.error("ATTENZIONE: Firebase Admin NON inizializzato:", e.message);
}

function preparaGiocatoriPerFirebase(giocatori) {
  const risultato = {};
  for (const uid in giocatori) {
    risultato[uid] = {
      nome: giocatori[uid].nome,
      posizione: giocatori[uid].posizione,
      turniSaltati: giocatori[uid].turniSaltati
    };
  }
  return risultato;
}

async function salvaPartita(partita) {
  if (!db) return;
  await db.ref("partite/" + partita.id).set({
    id: partita.id,
    stanza: partita.stanza,
    creatore: partita.creatore,
    creatoDa: partita.creatoDa,
    tempo: partita.tempo,
    punti: partita.punti,
    modalita: partita.modalita,
    codicePrivato: partita.codicePrivato || null,
    maxGiocatori: partita.maxGiocatori,
    giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
    ordineGiocatori: partita.ordineGiocatori,
    turnoAttuale: partita.turnoAttuale,
    iniziata: partita.iniziata,
    aggiornataIl: Date.now()
  });
}

async function caricaPartite() {
  if (!db) return {};
  const snap = await db.ref("partite").once("value");
  return snap.val() || {};
}

async function aggiornaStatoPartita(partitaId, dati) {
  if (!db) return;
  await db.ref("partite/" + partitaId).update({ ...dati, aggiornataIl: Date.now() });
}

async function rimuoviPartita(nomeStanza, partitaId) {
  if (stanze[nomeStanza]) delete stanze[nomeStanza].partite[partitaId];
  if (db) {
    try { await db.ref("partite/" + partitaId).remove(); }
    catch (e) { console.error("Errore rimozione partita da Firebase:", e.message); }
  }
}

async function aggiornaStatistichePartitaConclusa(partita, vincitoreUid) {
  if (!db) return;
  try {
    const aggiornamenti = {};
    partita.ordineGiocatori.forEach(idGiocatore => {
      aggiornamenti["utenti/" + idGiocatore + "/partiteGiocate"] = admin.database.ServerValue.increment(1);
    });
    if (vincitoreUid) {
      aggiornamenti["utenti/" + vincitoreUid + "/partiteVinte"] = admin.database.ServerValue.increment(1);
    }
    await db.ref().update(aggiornamenti);
  } catch (e) {
    console.error("Errore aggiornamento statistiche:", e.message);
  }
}

// ===== TOKEN =====
function creaToken(uid, nickname, ruolo) {
  return jwt.sign({ uid, nickname, ruolo }, JWT_SECRET, { expiresIn: "30d" });
}
function verificaToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}
function estraiTokenHeader(req) {
  if (req.cookies && req.cookies.token) return req.cookies.token;
  const header = req.headers.authorization || "";
  const parti = header.split(" ");
  return parti.length === 2 ? parti[1] : null;
}
function estraiTokenDaCookieHeader(cookieHeaderGrezzo) {
  if (!cookieHeaderGrezzo) return null;
  const parti = cookieHeaderGrezzo.split(";").map(p => p.trim());
  for (const parte of parti) {
    const idx = parte.indexOf("=");
    if (idx === -1) continue;
    const chiave = parte.substring(0, idx);
    const valore = parte.substring(idx + 1);
    if (chiave === "token") return decodeURIComponent(valore);
  }
  return null;
}

async function richiediAuth(req, res, next) {
  const dati = verificaToken(estraiTokenHeader(req));
  if (!dati) return res.status(401).json({ errore: "Devi effettuare il login." });
  req.utente = dati;
  next();
}
async function richiediAdmin(req, res, next) {
  const dati = verificaToken(estraiTokenHeader(req));
  if (!dati) return res.status(401).json({ errore: "Devi effettuare il login." });
  if (dati.ruolo !== "admin") return res.status(403).json({ errore: "Accesso riservato agli amministratori." });
  req.utenteAdmin = dati;
  next();
}

async function trovaUtentePerEmail(emailLower) {
  const snap = await db.ref("utenti").orderByChild("emailLower").equalTo(emailLower).once("value");
  if (!snap.exists()) return null;
  const val = snap.val();
  const uid = Object.keys(val)[0];
  return { uid, ...val[uid] };
}
async function trovaUtentePerTokenVerifica(token) {
  const snap = await db.ref("utenti").orderByChild("tokenVerificaEmail").equalTo(token).once("value");
  if (!snap.exists()) return null;
  const dati = snap.val();
  const uid = Object.keys(dati)[0];
  return { uid, ...dati[uid] };
}
async function trovaUtentePerNickname(nicknameLower) {
  const snap = await db.ref("utenti").orderByChild("nicknameLower").equalTo(nicknameLower).once("value");
  if (!snap.exists()) return null;
  const val = snap.val();
  const uid = Object.keys(val)[0];
  return { uid, ...val[uid] };
}

async function inviaEmailVerifica(emailDestinatario, nickname, token) {
  if (!resend) return;
  const linkVerifica = DOMINIO_SERVER + "/api/verifica-email/" + token;
  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: emailDestinatario,
      subject: "Verifica il tuo account - Giochi Società",
      html: `
        <h2>Ciao ${nickname}</h2>
        <p>Per attivare il tuo account su Giochi Società clicca qui:</p>
        <a href="${linkVerifica}">Verifica la mia email</a>
        <p>Se non hai richiesto tu questa registrazione, ignora pure questa email.</p>
      `
    });
  } catch (erroreEmail) {
    console.error("Errore invio email verifica:", erroreEmail);
  }
}

// ===== API REGISTRAZIONE / LOGIN =====
app.post("/api/registrati", limiteLogin, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile al momento." });
  try {
    const { email, nickname, password } = req.body;

    if (!email || !nickname || !password) {
      return res.status(400).json({ errore: "Compila tutti i campi." });
    }

    const nicknamePulito = pulisciTesto(nickname, 20);

    if (nicknamePulito.length < 5 || nicknamePulito.length > 15) {
      return res.status(400).json({ errore: "Il nickname deve contenere da 5 a 15 caratteri." });
    }
    if (!/^[a-zA-Z0-9_ ]+$/.test(nicknamePulito)) {
      return res.status(400).json({ errore: "Il nickname contiene caratteri non consentiti." });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ errore: "La password deve avere tra 6 e 100 caratteri." });
    }

    const emailPulita = pulisciTesto(email, 100).toLowerCase();
    const formatoEmailValido = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(emailPulita);
    if (!formatoEmailValido) {
      return res.status(400).json({ errore: "Inserisci un indirizzo email valido." });
    }

    const nicknameLower = nicknamePulito.toLowerCase();

    if (await trovaUtentePerEmail(emailPulita)) return res.status(400).json({ errore: "Questa email è già registrata." });
    if (await trovaUtentePerNickname(nicknameLower)) return res.status(400).json({ errore: "Questo nickname è già in uso." });

    const passwordHash = await bcrypt.hash(password, 10);
    const nuovoRef = db.ref("utenti").push();
    const uid = nuovoRef.key;
    const tokenVerifica = uuidv4();

    await nuovoRef.set({
      partiteVinte: 0,
      partiteGiocate: 0,
      puntiTotali: 0,
      email: emailPulita,
      emailLower: emailPulita,
      emailVerificata: false,
      tokenVerificaEmail: tokenVerifica,
      nickname: nicknamePulito,
      nicknameLower,
      passwordHash,
      avatar: null,
      ruolo: "utente",
      stato: "attivo",
      sospesoFino: null,
      avvisi: [],
      creatoIl: Date.now()
    });

    await inviaEmailVerifica(emailPulita, nicknamePulito, tokenVerifica);

    res.json({ messaggio: "Registrazione completata! Controlla la tua email per attivare l'account.", email: emailPulita });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server, riprova." });
  }
});

app.get("/api/verifica-email/:token", async (req, res) => {
  if (!db) return res.send("Servizio non disponibile.");
  try {
    const utente = await trovaUtentePerTokenVerifica(req.params.token);

    const paginaBase = (titolo, testo) => `
      <!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>${titolo}</title>
      <style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101820;font-family:Arial,sans-serif;color:#e8e8e8;}
        .box{background:#1e2a38;border:2px solid #ffd700;border-radius:14px;padding:36px;max-width:400px;text-align:center;}
        h2{color:#ffd700;margin-top:0;}
        a{display:inline-block;margin-top:18px;padding:10px 20px;background:#ffd700;color:#111;text-decoration:none;border-radius:8px;font-weight:bold;}
      </style></head><body><div class="box"><h2>${titolo}</h2><p>${testo}</p>

    if (!utente) {
      return res.send(paginaBase("Link non valido", "Questo link di verifica non è valido o è già stato utilizzato."));
    }

    await db.ref("utenti/" + utente.uid).update({ emailVerificata: true, tokenVerificaEmail: null });

    res.send(paginaBase("Email verificata! 🎉", "Il tuo account è ora attivo. Puoi accedere ritornando nella pagina precedente e cliccando su Accedi"));
  } catch (err) {
    console.error(err);
    res.status(500).send("Errore durante la verifica.");
  }
});

app.post("/api/rinvia-verifica", limiteContatti, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ errore: "Inserisci la tua email." });

    const emailPulita = pulisciTesto(email, 100).toLowerCase();
    const utente = await trovaUtentePerEmail(emailPulita);

    const rispostaGenerica = { messaggio: "Se l'indirizzo è registrato e non ancora verificato, ti abbiamo inviato una nuova email." };

    // Stessa risposta sia che l'account esista o meno: evita di rivelare quali email sono registrate
    if (!utente || utente.emailVerificata) return res.json(rispostaGenerica);

    const nuovoToken = uuidv4();
    await db.ref("utenti/" + utente.uid).update({ tokenVerificaEmail: nuovoToken });
    await inviaEmailVerifica(utente.email, utente.nickname, nuovoToken);

    res.json(rispostaGenerica);
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server, riprova." });
  }
});

app.post("/api/login", limiteLogin, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile al momento." });
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ errore: "Inserisci email e password." });

    const emailLogin = pulisciTesto(email, 100).toLowerCase();
    const utente = await trovaUtentePerEmail(emailLogin);
    if (!utente) return res.status(400).json({ errore: "Email o password errati." });

    const passwordOk = await bcrypt.compare(password, utente.passwordHash);
    if (!passwordOk) return res.status(400).json({ errore: "Email o password errati." });

    if (utente.stato === "bannato") {
      return res.status(403).json({ errore: "Il tuo account è stato bannato." });
    }

    if (utente.stato === "sospeso") {
      if (utente.sospesoFino && utente.sospesoFino > Date.now()) {
        const dataFine = new Date(utente.sospesoFino).toLocaleString("it-IT");
        return res.status(403).json({ errore: "Account sospeso fino al " + dataFine + "." });
      } else {
        await db.ref("utenti/" + utente.uid).update({ stato: "attivo", sospesoFino: null });
        utente.stato = "attivo";
      }
    }

    // === false (non solo falsy): gli account creati PRIMA di questo sistema non hanno
    // questo campo affatto (undefined) e restano validi — solo chi si registra da ora
    // in poi e non ha ancora cliccato il link viene davvero bloccato qui.
    if (utente.emailVerificata === false) {
      return res.status(403).json({ errore: "Devi verificare la tua email prima di accedere.", nonVerificata: true });
    }

    const token = creaToken(utente.uid, utente.nickname, utente.ruolo || "utente");
    res.cookie("token", token, OPZIONI_COOKIE);
    res.json({ nickname: utente.nickname, ruolo: utente.ruolo || "utente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server, riprova." });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token", OPZIONI_COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile." });
  try {
    const snap = await db.ref("utenti/" + req.utente.uid).once("value");
    const utente = snap.val();
    if (!utente) return res.status(404).json({ errore: "Utente non trovato." });
    res.json({
      uid: req.utente.uid,
      nickname: utente.nickname,
      email: utente.email,
      avatar: utente.avatar || null,
      ruolo: utente.ruolo || "utente",
      stato: utente.stato || "attivo",
      sospesoFino: utente.sospesoFino || null,
      avvisi: utente.avvisi || [],
      partiteVinte: utente.partiteVinte || 0,
      partiteGiocate: utente.partiteGiocate || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server." });
  }
});

app.post("/api/modifica-nickname", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { nickname } = req.body;
    if (!nickname || !nickname.trim()) return res.status(400).json({ errore: "Inserisci un nickname." });

    const nuovoNickname = pulisciTesto(nickname, 20);

    if (nuovoNickname.length < 5 || nuovoNickname.length > 15) {
      return res.status(400).json({ errore: "Il nickname deve contenere da 5 a 15 caratteri." });
    }
    if (!/^[a-zA-Z0-9_ ]+$/.test(nuovoNickname)) {
      return res.status(400).json({ errore: "Nickname non valido." });
    }

    const nicknameLower = nuovoNickname.toLowerCase();

    const esistente = await trovaUtentePerNickname(nicknameLower);
    if (esistente && esistente.uid !== req.utente.uid) {
      return res.status(400).json({ errore: "Questo nickname è già in uso." });
    }

    await db.ref("utenti/" + req.utente.uid).update({ nickname: nuovoNickname, nicknameLower });

    const nuovoToken = creaToken(req.utente.uid, nuovoNickname, req.utente.ruolo);
    res.cookie("token", nuovoToken, OPZIONI_COOKIE);

    res.json({ nickname: nuovoNickname });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server, riprova." });
  }
});

app.post("/api/carica-avatar", richiediAuth, uploadAvatar.single("avatar"), async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    if (!req.file) return res.status(400).json({ errore: "Nessuna immagine ricevuta." });

    const base64 = req.file.buffer.toString("base64");
    const dataUri = `data:${req.file.mimetype};base64,${base64}`;

    await db.ref("utenti/" + req.utente.uid).update({ avatar: dataUri });

    res.json({ avatar: dataUri });
  } catch (err) {
    console.error(err);
    res.status(400).json({ errore: err.message || "Errore durante il caricamento." });
  }
});

app.get("/api/top-giocatori", async (req, res) => {
  try {
    if (!db) return res.json({ giocatori: [] });
    const snap = await db.ref("utenti").once("value");
    const utenti = snap.val() || {};
    const top = Object.values(utenti)
      .map(u => ({ nickname: u.nickname || "Sconosciuto", vinte: u.partiteVinte || 0, giocate: u.partiteGiocate || 0 }))
      .sort((a, b) => (b.vinte !== a.vinte ? b.vinte - a.vinte : b.giocate - a.giocate))
      .slice(0, 10);
    res.json({ giocatori: top });
  } catch (e) {
    console.error("Errore classifica:", e);
    res.status(500).json({ giocatori: [] });
  }
});

app.post("/api/contatti", limiteContatti, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile al momento." });
  try {
    const { categoria, messaggio } = req.body;
    let { nickname, email } = req.body;

    if (!messaggio || !messaggio.trim()) {
      return res.status(400).json({ errore: "Scrivi un messaggio prima di inviare." });
    }

    const messaggioPulito = pulisciTesto(messaggio, 1000);

    const datiToken = verificaToken(estraiTokenHeader(req));
    let uidMittente = null;
    if (datiToken) {
      uidMittente = datiToken.uid;
      const snap = await db.ref("utenti/" + datiToken.uid).once("value");
      const utenteDb = snap.val();
      if (utenteDb) { nickname = utenteDb.nickname; email = utenteDb.email; }
    }

    if (!nickname || !nickname.trim() || !email || !email.trim()) {
      return res.status(400).json({ errore: "Nickname ed email sono obbligatori." });
    }

    const nuovoRef = db.ref("contatti").push();
    await nuovoRef.set({
      nickname: nickname.trim(), email: email.trim(), categoria: categoria || "Altro",
      messaggio: messaggioPulito, uidMittente, letto: false, data: Date.now()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore durante l'invio, riprova." });
  }
});

// ===== API ADMIN =====
app.get("/api/admin/utenti", richiediAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Database non disponibile." });
  const snap = await db.ref("utenti").once("value");
  const val = snap.val() || {};
  const lista = Object.keys(val).map(uid => ({
    uid, email: val[uid].email, nickname: val[uid].nickname,
    stato: val[uid].stato, sospesoFino: val[uid].sospesoFino,
    avvisi: val[uid].avvisi || [], ruolo: val[uid].ruolo || "utente"
  }));
  res.json({ utenti: lista });
});

app.post("/api/admin/avviso", richiediAdmin, async (req, res) => {
  const { uid, motivo } = req.body;
  if (!uid || !motivo) return res.status(400).json({ errore: "Dati mancanti." });
  const ref = db.ref("utenti/" + uid + "/avvisi");
  const snap = await ref.once("value");
  const avvisiAttuali = snap.val() || [];
  avvisiAttuali.push({ data: Date.now(), motivo });
  await ref.set(avvisiAttuali);
  res.json({ ok: true });
});

app.post("/api/admin/sospendi", richiediAdmin, async (req, res) => {
  const { uid, giorni, motivo } = req.body;
  if (!uid || !giorni) return res.status(400).json({ errore: "Dati mancanti." });
  if (uid === req.utenteAdmin.uid) return res.status(400).json({ errore: "Non puoi sospendere il tuo stesso account." });
  const sospesoFino = Date.now() + (parseInt(giorni) * 24 * 60 * 60 * 1000);
  await db.ref("utenti/" + uid).update({ stato: "sospeso", sospesoFino, motivoSospensione: motivo || "" });
  res.json({ ok: true });
});

app.post("/api/admin/rimuovi-sospensione", richiediAdmin, async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ errore: "Dati mancanti." });
  await db.ref("utenti/" + uid).update({ stato: "attivo", sospesoFino: null });
  res.json({ ok: true });
});

app.post("/api/admin/banna", richiediAdmin, async (req, res) => {
  const { uid, motivo } = req.body;
  if (!uid) return res.status(400).json({ errore: "Dati mancanti." });
  if (uid === req.utenteAdmin.uid) return res.status(400).json({ errore: "Non puoi bannare il tuo stesso account." });
  await db.ref("utenti/" + uid).update({ stato: "bannato", motivoBan: motivo || "" });
  res.json({ ok: true });
});

app.post("/api/admin/riattiva", richiediAdmin, async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ errore: "Dati mancanti." });
  await db.ref("utenti/" + uid).update({ stato: "attivo", sospesoFino: null });
  res.json({ ok: true });
});

// ===== DADO VERO DA RANDOM.ORG (con fallback automatico) =====
function tiraDadoRandomOrg() {
  return new Promise((resolve) => {
    const url = "https://www.random.org/integers/?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";
    const richiesta = https.get(url, { timeout: 4000 }, (res) => {
      let dati = "";
      res.on("data", chunk => dati += chunk);
      res.on("end", () => {
        try {
          const numeri = dati.trim().split("\n").map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n) && n >= 1 && n <= 6);
          if (numeri.length === 2) resolve({ dado1: numeri[0], dado2: numeri[1] });
          else resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    richiesta.on("timeout", () => { richiesta.destroy(); resolve(null); });
    richiesta.on("error", () => resolve(null));
  });
}
async function lanciaDueDadiSicuri() {
  const risultato = await tiraDadoRandomOrg();
  if (risultato) return risultato;
  return { dado1: Math.floor(Math.random() * 6) + 1, dado2: Math.floor(Math.random() * 6) + 1 };
}

// ===== LOGICA DI GIOCO =====
const CASELLE_AVANZA_ANCORA = [9, 18, 27, 36, 45, 54];
const CASELLE_SALTA_TRE_TURNI = [19, 31];
const CASELLE_SALTA_UN_TURNO = [52];
const CASELLE_TORNA_A = { 42: 38, 50: 1, 58: 1 };
const CASELLA_TIRA_ANCORA = 6;
const CASELLA_VITTORIA = 63;

let stanze = {
  BAR: { giocatoriOnline: {}, partite: {} },
  PUB: { giocatoriOnline: {}, partite: {} },
  DISCOPUB: { giocatoriOnline: {}, partite: {} },
  SERATE: { giocatoriOnline: {}, partite: {} }
};

async function ripristinaPartiteDaFirebase() {
  const partiteFirebase = await caricaPartite();
  for (const id in partiteFirebase) {
    const p = partiteFirebase[id];
    if (!stanze[p.stanza]) continue;
    stanze[p.stanza].partite[id] = {
      ...p,
      codicePrivato: p.codicePrivato || null,
      maxGiocatori: p.maxGiocatori || (Object.keys(p.giocatori || {}).length || 2),
      giocatori: p.giocatori || {},
      ordineGiocatori: p.ordineGiocatori || [],
      turnoAttuale: p.turnoAttuale || 0,
      iniziata: p.iniziata || false,
      elaborandoTiro: false
    };
  }
  console.log("Partite ripristinate da Firebase:", Object.keys(partiteFirebase).length);
}

let contatoreId = 0;
const socketsPerId = {};

function calcolaMovimento(posizioneAttuale, valoreDado) {
  let percorso = [];
  let nuovaPosizione = posizioneAttuale + valoreDado;
  let messaggi = [];
  let turniDaSaltare = 0;
  let vittoria = false;
  let tiraAncora = false;

  if (nuovaPosizione > CASELLA_VITTORIA) {
    for (let p = posizioneAttuale + 1; p <= CASELLA_VITTORIA; p++) percorso.push(p);
    const eccesso = nuovaPosizione - CASELLA_VITTORIA;
    nuovaPosizione = CASELLA_VITTORIA - eccesso;
    for (let p = CASELLA_VITTORIA - 1; p >= nuovaPosizione; p--) percorso.push(p);
    messaggi.push("Hai superato il traguardo, rimbalzi indietro!");
  } else {
    for (let p = posizioneAttuale + 1; p <= nuovaPosizione; p++) percorso.push(p);
  }

  if (nuovaPosizione === CASELLA_VITTORIA) {
    vittoria = true;
    messaggi.push("🎉 Hai vinto!");
    return { nuovaPosizione, percorso, messaggi, turniDaSaltare, vittoria, tiraAncora };
  }
  if (nuovaPosizione === CASELLA_TIRA_ANCORA) {
    tiraAncora = true;
    messaggi.push("Sali sul ponte! Tira ancora i dadi.");
  }
  if (CASELLE_AVANZA_ANCORA.includes(nuovaPosizione)) {
    messaggi.push("Avanzi dello stesso numero di caselle!");
    const r = calcolaMovimento(nuovaPosizione, valoreDado);
    return {
      nuovaPosizione: r.nuovaPosizione, percorso: percorso.concat(r.percorso),
      messaggi: messaggi.concat(r.messaggi), turniDaSaltare: r.turniDaSaltare,
      vittoria: r.vittoria, tiraAncora: r.tiraAncora
    };
  }
  if (CASELLE_SALTA_TRE_TURNI.includes(nuovaPosizione)) { turniDaSaltare = 3; messaggi.push("Rimani fermo per 3 turni!"); }
  if (CASELLE_SALTA_UN_TURNO.includes(nuovaPosizione)) { turniDaSaltare = 1; messaggi.push("Salti un turno!"); }
  if (CASELLE_TORNA_A[nuovaPosizione] !== undefined) {
    const casellaFinale = CASELLE_TORNA_A[nuovaPosizione];
    messaggi.push(`Torni alla casella ${casellaFinale}!`);
    percorso.push(casellaFinale);
    nuovaPosizione = casellaFinale;
  }
  return { nuovaPosizione, percorso, messaggi, turniDaSaltare, vittoria, tiraAncora };
}

function lanciaDueDadi() { return (Math.floor(Math.random() * 6) + 1) + (Math.floor(Math.random() * 6) + 1); }

function determinaOrdineIniziale(idsGiocatori) {
  let risultati = idsGiocatori.map(id => ({ id, punteggio: lanciaDueDadi() }));
  risultati.sort((a, b) => b.punteggio - a.punteggio);
  let ordineFinale = [];
  let i = 0;
  while (i < risultati.length) {
    let gruppoPari = [risultati[i]];
    let j = i + 1;
    while (j < risultati.length && risultati[j].punteggio === risultati[i].punteggio) { gruppoPari.push(risultati[j]); j++; }
    if (gruppoPari.length > 1) ordineFinale = ordineFinale.concat(determinaOrdineIniziale(gruppoPari.map(g => g.id)));
    else ordineFinale.push(gruppoPari[0].id);
    i = j;
  }
  return ordineFinale;
}

async function avviaPartitaAutomaticamente(partita) {
  const idsGiocatori = Object.keys(partita.giocatori);
  const ordineDeterminato = determinaOrdineIniziale(idsGiocatori);
  partita.ordineGiocatori = ordineDeterminato;
  partita.turnoAttuale = 0;
  partita.iniziata = true;
  partita.elaborandoTiro = false;
  const nomiInOrdine = ordineDeterminato.map(id => partita.giocatori[id].nome);
  Object.values(partita.giocatori).forEach(g => {
    if (g.socket && g.socket.readyState === WebSocket.OPEN) {
      g.socket.send(JSON.stringify({ tipo: "partitaAvviata", partitaId: partita.id, ordineGiocatori: nomiInOrdine, turnoDiId: partita.ordineGiocatori[0] }));
    }
  });
  const trovato = trovaPartita(partita.id);
  await salvaPartita({ ...partita, stanza: trovato ? trovato.nomeStanza : partita.stanza });
}

function passaAlProssimoTurno(partita) {
  let tentativi = 0;
  do {
    partita.turnoAttuale = (partita.turnoAttuale + 1) % partita.ordineGiocatori.length;
    const idProssimo = partita.ordineGiocatori[partita.turnoAttuale];
    const giocatoreProssimo = partita.giocatori[idProssimo];
    if ((giocatoreProssimo.turniSaltati || 0) > 0) { giocatoreProssimo.turniSaltati--; tentativi++; } else break;
  } while (tentativi < partita.ordineGiocatori.length);
}

function trovaPartita(partitaId) {
  for (const nomeStanza in stanze) {
    if (stanze[nomeStanza].partite[partitaId]) return { partita: stanze[nomeStanza].partite[partitaId], nomeStanza };
  }
  return null;
}

function costruisciStatoGiocatori(partita) {
  return partita.ordineGiocatori.map(id => ({
    id,
    nome: partita.giocatori[id].nome,
    avatar: partita.giocatori[id].avatar || null,
    posizione: partita.giocatori[id].posizione
  }));
}

function inviaAllaStanza(nomeStanza, messaggio) {
  if (!stanze[nomeStanza]) return;
  Object.keys(stanze[nomeStanza].giocatoriOnline).forEach(id => {
    const s = socketsPerId[id];
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(messaggio));
  });
}

function inviaListaPartite(nomeStanza) {
  if (!stanze[nomeStanza]) return;
  const lista = Object.values(stanze[nomeStanza].partite).map(p => ({
    id: p.id, creatore: p.creatore, tempo: p.tempo, punti: p.punti,
    modalita: p.modalita, maxGiocatori: p.maxGiocatori, numGiocatoriAttuali: Object.keys(p.giocatori).length
  }));
  inviaAllaStanza(nomeStanza, { tipo: "listaPartite", partite: lista });
}

function inviaConteggioStanze() {
  const conteggi = {};
  const giocatoriPerStanza = {};
  for (const nome in stanze) {
    const valori = Object.values(stanze[nome].giocatoriOnline);
    conteggi[nome] = valori.length;
    giocatoriPerStanza[nome] = valori.map(g => ({ nickname: g.nickname, avatar: g.avatar || null }));
  }
  const messaggio = JSON.stringify({ tipo: "conteggioStanze", stanze: conteggi, giocatori: giocatoriPerStanza });
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(messaggio); });
}

const HEARTBEAT_MS = 1000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(socket => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeatInterval));

// ===== CONNESSIONI WEBSOCKET =====
wss.on("connection", (socket, request) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  const userAgent = request.headers["user-agent"] || "";

let dispositivo = "Sconosciuto";

if (/Android/i.test(userAgent)) {
  dispositivo = "Android";
} else if (/iPhone|iPad/i.test(userAgent)) {
  dispositivo = "iOS";
} else if (/Windows/i.test(userAgent)) {
  dispositivo = "Windows";
} else if (/Macintosh/i.test(userAgent)) {
  dispositivo = "Mac";
} else if (/Linux/i.test(userAgent)) {
  dispositivo = "Linux";
} else if (/PlayStation/i.test(userAgent)) {
  dispositivo = "PlayStation";
}

  const socketId = "s" + (contatoreId++);
  socketsPerId[socketId] = socket;

  let stanzaAttuale = null;
  let nickname = null;
  let mioAvatar = null;
  let dispositivo = "Sconosciuto";

  const tokenDalCookie = estraiTokenDaCookieHeader(request.headers.cookie);
  const datiTokenIniziali = verificaToken(tokenDalCookie);
  let uid = datiTokenIniziali ? datiTokenIniziali.uid : null;

  socket.on("message", async (message) => {
    try {
      let dati;
      try { dati = JSON.parse(message); } catch (e) { return; }

      if (dati.tipo === "richiediConteggio") { inviaConteggioStanze(); return; }

      if (dati.tipo === "entraLobby") {
        if (!db) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Servizio account non disponibile." })); return; }
        if (!uid) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }
        if (!dati.stanza) return;

        const snap = await db.ref("utenti/" + uid).once("value");
        const utenteDb = snap.val();
        if (!utenteDb) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }
        if (utenteDb.stato === "bannato") { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Il tuo account è stato bannato." })); return; }
        if (utenteDb.stato === "sospeso" && utenteDb.sospesoFino && utenteDb.sospesoFino > Date.now()) {
          const dataFine = new Date(utenteDb.sospesoFino).toLocaleString("it-IT");
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Account sospeso fino al " + dataFine + "." }));
          return;
        }

        stanzaAttuale = dati.stanza;
        nickname = utenteDb.nickname;
        mioAvatar = utenteDb.avatar || null;

        if (!stanze[stanzaAttuale]) stanze[stanzaAttuale] = { giocatoriOnline: {}, partite: {} };
        stanze[stanzaAttuale].giocatoriOnline[socketId] = { 
          nickname,
          avatar: mioAvatar,
          dispositivo
        };


        inviaConteggioStanze();
        inviaAllaStanza(stanzaAttuale, { tipo: "online", numero: Object.keys(stanze[stanzaAttuale].giocatoriOnline).length });
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "riprendiPartita") {
        if (!uid) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Partita non trovata." })); return; }
        const { partita, nomeStanza } = trovato;
        stanzaAttuale = nomeStanza;

        const mioGiocatore = partita.giocatori[uid];
        if (!mioGiocatore) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non fai parte di questa partita." })); return; }

        if (db) {
          try {
            const snapUtente = await db.ref("utenti/" + uid).once("value");
            const utenteDb = snapUtente.val();
            if (utenteDb) mioGiocatore.avatar = utenteDb.avatar || null;
          } catch (e) { /* se fallisce, tiene quello che c'era già in memoria */ }
        }

        mioGiocatore.socket = socket;
        nickname = mioGiocatore.nome;
        mioAvatar = mioGiocatore.avatar || null;

        socket.send(JSON.stringify({
          tipo: "statoPartita",
          giocatori: costruisciStatoGiocatori(partita),
          turnoDiId: partita.ordineGiocatori[partita.turnoAttuale]
        }));
        return;
      }

      if (dati.tipo === "creaPartita") {
        if (!stanzaAttuale || !uid) return;
        const haGiaCreato = Object.values(stanze[stanzaAttuale].partite).some(p => p.creatoDa === uid);
        if (haGiaCreato) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Hai già una partita attiva." })); return; }

        const partitaId = "p" + Date.now() + Math.floor(Math.random() * 1000);
        const max = parseInt(dati.maxGiocatori);

        stanze[stanzaAttuale].partite[partitaId] = {
          id: partitaId,
          creatore: nickname,
          creatoDa: uid,
          tempo: dati.tempo,
          punti: dati.punti,
          modalita: dati.modalita,
          codicePrivato: dati.modalita === "privata" ? dati.codicePrivato : null,
          maxGiocatori: (!max || max < 2 || max > 8 ? 2 : max),
          giocatori: { [uid]: { nome: nickname, avatar: mioAvatar, posizione: 0, socket, turniSaltati: 0 } },
          ordineGiocatori: [uid], turnoAttuale: 0, iniziata: false, elaborandoTiro: false
        };
        await salvaPartita({ ...stanze[stanzaAttuale].partite[partitaId], stanza: stanzaAttuale });
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "entraPartita") {
        if (!stanzaAttuale || !uid) return;
        const partita = stanze[stanzaAttuale].partite[dati.id];
        if (!partita) return;
        if (partita.giocatori[uid]) return;
        if (Object.keys(partita.giocatori).length >= partita.maxGiocatori) return;

        if (partita.modalita === "privata" && dati.codicePrivato !== partita.codicePrivato) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Codice partita non corretto." }));
          return;
        }

        partita.giocatori[uid] = { nome: nickname, avatar: mioAvatar, posizione: 0, socket, turniSaltati: 0 };
        partita.ordineGiocatori.push(uid);

        await aggiornaStatoPartita(partita.id, {
          giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
          ordineGiocatori: partita.ordineGiocatori
        });

        inviaListaPartite(stanzaAttuale);

        if (Object.keys(partita.giocatori).length === partita.maxGiocatori) await avviaPartitaAutomaticamente(partita);
        return;
      }

      if (dati.tipo === "eliminaPartita") {
        if (!stanzaAttuale || !uid) return;
        const partite = stanze[stanzaAttuale].partite;
        const idDaEliminare = Object.keys(partite).find(pid => partite[pid].creatoDa === uid);
        if (!idDaEliminare) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non hai nessuna partita da eliminare." })); return; }
        await rimuoviPartita(stanzaAttuale, idDaEliminare);
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "chat") {
        if (!stanzaAttuale) return;
        if (typeof dati.testo !== "string") return;
        const testo = pulisciTesto(dati.testo, 300);
        if (testo.length === 0) return;
        inviaAllaStanza(stanzaAttuale, { tipo: "chat", nome: nickname, testo });
        return;
      }

      if (dati.tipo === "chatPartita") {
        if (!uid) return;
        if (typeof dati.testo !== "string") return;
        const testo = pulisciTesto(dati.testo, 300);
        if (!testo) return;

        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const partita = trovato.partita;
        const mittente = partita.giocatori[uid];
        if (!mittente) return;

        Object.values(partita.giocatori).forEach(g => {
          if (g.socket && g.socket.readyState === WebSocket.OPEN) {
            g.socket.send(JSON.stringify({ tipo: "chatPartita", nome: mittente.nome, testo }));
          }
        });
        return;
      }

      if (dati.tipo === "tiraDadi") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const partita = trovato.partita;
        const nomeStanzaPartita = trovato.nomeStanza;

        const idDiTurno = partita.ordineGiocatori[partita.turnoAttuale];
        if (idDiTurno !== uid) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è il tuo turno!" })); return; }

        if (partita.elaborandoTiro) return;
        partita.elaborandoTiro = true;

        try {
          const { dado1, dado2 } = await lanciaDueDadiSicuri();
          const valoreDado = dado1 + dado2;

          const giocatore = partita.giocatori[uid];
          const risultato = calcolaMovimento(giocatore.posizione, valoreDado);
          giocatore.posizione = risultato.nuovaPosizione;
          if (risultato.turniDaSaltare > 0) giocatore.turniSaltati = risultato.turniDaSaltare;
          if (!risultato.tiraAncora && !risultato.vittoria) passaAlProssimoTurno(partita);

          const statoGiocatori = costruisciStatoGiocatori(partita);
          const idProssimo = partita.ordineGiocatori[partita.turnoAttuale];

          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({
                tipo: "aggiornamentoPartita", giocatori: statoGiocatori, dado1, dado2, valoreDado,
                percorso: risultato.percorso, idGiocatoreCheHaTirato: uid,
                messaggi: risultato.messaggi, turnoDiId: idProssimo,
                vittoria: risultato.vittoria, vincitore: risultato.vittoria ? giocatore.nome : null
              }));
            }
          });

          if (risultato.vittoria) {
            await aggiornaStatistichePartitaConclusa(partita, uid);
            await rimuoviPartita(nomeStanzaPartita, partita.id);
            inviaListaPartite(nomeStanzaPartita);
          } else {
            await aggiornaStatoPartita(partita.id, {
              giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
              ordineGiocatori: partita.ordineGiocatori,
              turnoAttuale: partita.turnoAttuale,
              iniziata: partita.iniziata
            });
          }
        } finally {
          partita.elaborandoTiro = false;
        }
        return;
      }

      if (dati.tipo === "abbandonaPartita") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        if (!partita.giocatori[uid]) return;

        const nomeUscente = partita.giocatori[uid].nome;
        delete partita.giocatori[uid];
        partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== uid);
        const restanti = Object.keys(partita.giocatori);

        if (restanti.length === 0) {
          await rimuoviPartita(nomeStanza, partita.id);
          inviaListaPartite(nomeStanza);
          return;
        }
        if (partita.turnoAttuale >= partita.ordineGiocatori.length) partita.turnoAttuale = 0;

        if (restanti.length === 1 && partita.iniziata) {
          const vincitoreId = restanti[0];
          const vincitoreNome = partita.giocatori[vincitoreId].nome;
          const statoGiocatori = costruisciStatoGiocatori(partita);
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({ tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: vincitoreId, vittoria: true, vincitore: vincitoreNome, messaggi: [nomeUscente + " ha abbandonato la partita."] }));
            }
          });
          await aggiornaStatistichePartitaConclusa(partita, vincitoreId);
          await rimuoviPartita(nomeStanza, partita.id);
        } else {
          const idAttuale = partita.ordineGiocatori[partita.turnoAttuale];
          const statoGiocatori = costruisciStatoGiocatori(partita);
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({ tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: idAttuale, messaggi: [nomeUscente + " ha abbandonato la partita."] }));
            }
          });
          await aggiornaStatoPartita(partita.id, {
            giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
            ordineGiocatori: partita.ordineGiocatori,
            turnoAttuale: partita.turnoAttuale
          });
        }
        inviaListaPartite(nomeStanza);
        return;
      }

    } catch (erroreInterno) {
      console.error("Errore nella gestione di un messaggio:", erroreInterno);
    }
  });

  socket.on("close", () => {
    try {
      delete socketsPerId[socketId];
      if (!stanzaAttuale || !stanze[stanzaAttuale]) return;

      delete stanze[stanzaAttuale].giocatoriOnline[socketId];
      inviaConteggioStanze();
      inviaAllaStanza(stanzaAttuale, { tipo: "online", numero: Object.keys(stanze[stanzaAttuale].giocatoriOnline).length });

      const partite = stanze[stanzaAttuale].partite;
      for (const pid in partite) {
        const partita = partite[pid];
        if (uid && partita.giocatori[uid] && !partita.iniziata) {
          delete partita.giocatori[uid];
          partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== uid);
          if (Object.keys(partita.giocatori).length === 0) delete partite[pid];
        }
      }
      inviaListaPartite(stanzaAttuale);
    } catch (erroreInterno) {
      console.error("Errore nella chiusura di una connessione:", erroreInterno);
    }
  });
});

server.listen(PORT, async () => {
  console.log("Server avviato sulla porta " + PORT);
  await ripristinaPartiteDaFirebase();
});
