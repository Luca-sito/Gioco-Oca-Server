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
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

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

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false, frameguard: false }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use(passport.initialize());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 });
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET mancante: impostala nelle variabili d'ambiente su Render prima di avviare il server.");

const OPZIONI_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000
};

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { if (!file.mimetype.startsWith("image/")) return cb(new Error("Il file deve essere un'immagine.")); cb(null, true); }
});

const limiteLogin = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { errore: "Troppi tentativi, riprova tra qualche minuto." }, standardHeaders: true, legacyHeaders: false });
const limiteContatti = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { errore: "Hai inviato troppe richieste, riprova più tardi." } });
const limiteMessaggiPrivati = rateLimit({ windowMs: 60 * 1000, max: 20, message: { errore: "Stai inviando messaggi troppo velocemente, rallenta un po'." } });
const limiteAmici = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: { errore: "Troppe richieste di amicizia in poco tempo, rallenta un po'." } });
const limiteSegnalazioni = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { errore: "Troppe segnalazioni in poco tempo. Riprova più tardi." },
  standardHeaders: true,
  legacyHeaders: false
});

// ===== FIREBASE ADMIN =====
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: "https://giochi-societa-e8add-default-rtdb.europe-west1.firebasedatabase.app" });
  db = admin.database();
  console.log("Firebase Admin inizializzato correttamente.");
} catch (e) {
  console.error("ATTENZIONE: Firebase Admin NON inizializzato:", e.message);
}

// ===== LOG CHAT MODERAZIONE — CONSERVAZIONE MASSIMA 90 GIORNI =====
const DURATA_LOG_CHAT_MS = 90 * 24 * 60 * 60 * 1000;
const INTERVALLO_PULIZIA_LOG_CHAT_MS = 24 * 60 * 60 * 1000;

async function registraLogChat({ uid, nome, testo, ambito, stanza = null, partitaId = null }) {
  if (!db || !uid || !testo) return;

  const ref = db.ref(`logChat/${uid}`).push();
  await ref.set({
    id: ref.key,
    uid: String(uid),
    nome: pulisciTesto(String(nome || "Utente"), 30),
    testo: pulisciTesto(String(testo), 300),
    ambito: ambito === "partita" ? "partita" : "lobby",
    stanza: stanza ? pulisciTesto(String(stanza), 40) : null,
    partitaId: partitaId ? pulisciTesto(String(partitaId), 128) : null,
    data: Date.now()
  });
}

async function leggiLogChatUltimi90Giorni(uid) {
  if (!db || !uid) return [];
  const limite = Date.now() - DURATA_LOG_CHAT_MS;
  const snap = await db.ref(`logChat/${uid}`)
    .orderByChild("data")
    .startAt(limite)
    .once("value");

  const valore = snap.val() || {};
  return Object.values(valore)
    .filter(r => r && Number(r.data) >= limite)
    .sort((a, b) => Number(a.data || 0) - Number(b.data || 0));
}

async function pulisciLogChatScaduti() {
  if (!db) return;
  const limite = Date.now() - DURATA_LOG_CHAT_MS;

  try {
    const utentiSnap = await db.ref("logChat").once("value");
    const utenti = utentiSnap.val() || {};
    const aggiornamenti = {};

    for (const [uid, registri] of Object.entries(utenti)) {
      if (!registri || typeof registri !== "object") continue;
      for (const [id, registro] of Object.entries(registri)) {
        if (!registro || !Number.isFinite(Number(registro.data)) || Number(registro.data) < limite) {
          aggiornamenti[`logChat/${uid}/${id}`] = null;
        }
      }
    }

    if (Object.keys(aggiornamenti).length) {
      await db.ref().update(aggiornamenti);
      console.log(`Pulizia log chat: rimossi ${Object.keys(aggiornamenti).length} record scaduti.`);
    }
  } catch (errore) {
    console.error("Errore pulizia log chat 90 giorni:", errore.message);
  }
}

if (db) {
  setTimeout(() => pulisciLogChatScaduti().catch(() => {}), 15 * 1000);
  const timerPuliziaLogChat = setInterval(
    () => pulisciLogChatScaduti().catch(() => {}),
    INTERVALLO_PULIZIA_LOG_CHAT_MS
  );
  if (typeof timerPuliziaLogChat.unref === "function") timerPuliziaLogChat.unref();
}


function preparaGiocatoriPerFirebase(giocatori) {
  const risultato = {};
  for (const uid in giocatori) {
    risultato[uid] = {
      nome: giocatori[uid].nome,
      posizione: giocatori[uid].posizione,
      turniSaltati: giocatori[uid].turniSaltati,
      tiriRealiEffettuati: numeroTiriRealiEffettuati(giocatori[uid])
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
    modalita: partita.modalita,
    classificata: partita.classificata !== false,
    maxGiocatori: partita.maxGiocatori,
    chatAttiva: partita.chatAttiva !== false,
    mediaAttiva: partita.mediaAttiva === true,
    fase: partita.fase || "in_corso",
    giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
    ordineGiocatori: partita.ordineGiocatori || [],
    turnoAttuale: partita.turnoAttuale || 0,
    punteggiOrdineIniziale: partita.punteggiOrdineIniziale || null,
    ordineDeterminazione: partita.ordineDeterminazione || [],
    risultatiDeterminazione: partita.risultatiDeterminazione || {},
    codaDeterminazione: partita.codaDeterminazione || [],
    turnoInCorsoDeterminazione: partita.turnoInCorsoDeterminazione || null,
    gruppoSpareggioAttuale: partita.gruppoSpareggioAttuale || null,
    iniziata: partita.iniziata === true,
    iniziataIl: partita.iniziataIl || null,
    tiriEffettuatiNelTurno: Number(partita.tiriEffettuatiNelTurno || 0),
    tiriConsentitiNelTurno: Number(partita.tiriConsentitiNelTurno || 1),
    tempoInizioTurno: partita.tempoInizioTurno || null,
    scadenzaTurno: partita.scadenzaTurno || null,
    aggiornataIl: Date.now()
  });
}
async function caricaPartite() { if (!db) return {}; const snap = await db.ref("partite").once("value"); return snap.val() || {}; }
async function aggiornaStatoPartita(partitaId, dati) { if (!db) return; await db.ref("partite/" + partitaId).update({ ...dati, aggiornataIl: Date.now() }); }
async function rimuoviPartita(nomeStanza, partitaId) {
  if (stanze[nomeStanza]) {
    const p = stanze[nomeStanza].partite[partitaId];
    if (p) fermaTimerTurno(p);
    delete stanze[nomeStanza].partite[partitaId];

    // La Lobby deve vedere sparire il tavolo subito: Firebase viene pulito
    // dopo, senza tenere bloccato l'aggiornamento WebSocket dell'interfaccia.
    inviaListaPartite(nomeStanza);
    inviaConteggioStanze();
  }
  if (db) {
    try { await db.ref("partite/" + partitaId).remove(); }
    catch (e) { console.error("Errore rimozione partita da Firebase:", e.message); }
  }
}

// ===== ELO E BADGE =====
const ELO_INIZIALE = 1500;
const ELO_K = 32;
const SOGLIA_VELOCISTA_SECONDI = 300;

function ottieniElo(utente) {
  const elo = Number(utente && utente.elo);
  return Number.isFinite(elo) ? Math.round(elo) : ELO_INIZIALE;
}

function probabilitaVittoriaElo(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function calcolaNuovoElo(elo, eloAvversari, risultatoMedio) {
  if (!Array.isArray(eloAvversari) || eloAvversari.length === 0) {
    return Math.max(100, Math.round(elo));
  }

  const aspettativaMedia = eloAvversari.reduce(
    (somma, eloAvversario) => somma + probabilitaVittoriaElo(elo, eloAvversario),
    0
  ) / eloAvversari.length;

  return Math.max(
    100,
    Math.round(elo + ELO_K * (risultatoMedio - aspettativaMedia))
  );
}

function calcolaBadge(utente) {
  const badge = [];
  const vinte = utente.partiteVinte || 0;
  const giocate = utente.partiteGiocate || 0;
  const elo = ottieniElo(utente);
  const streakMax = utente.streakVittorieMassima || 0;
  const vittoriaVeloce = utente.vittoriaPiuVeloceSecondi;

  if (vinte >= 10) badge.push({ icona: "🥉", nome: "Prime 10 vittorie" });
  if (giocate >= 100) badge.push({ icona: "🥈", nome: "100 partite giocate" });
  if (elo >= 1600) badge.push({ icona: "🥇", nome: "1600 ELO" });
  if (streakMax >= 20) badge.push({ icona: "👑", nome: "20 vittorie consecutive" });
  if (vittoriaVeloce != null && vittoriaVeloce < SOGLIA_VELOCISTA_SECONDI) {
    badge.push({ icona: "🏃", nome: "Velocista" });
  }
  return badge;
}

function idConversazione(uidA, uidB) { return [uidA, uidB].sort().join("_"); }

async function concludiPartita(partita, vincitoreUid, nomeStanza, elencoPartecipanti, escludiUid) {
  if (!db) return;

  try {
    const partecipanti = elencoPartecipanti || (partita.ordineGiocatori || []).map(id => ({
      uid: id,
      nome: partita.giocatori[id] ? partita.giocatori[id].nome : "?"
    }));
    const esclusi = escludiUid || new Set();
    const partitaClassificata = partita.classificata !== false;
    const durataSecondi = partita.iniziataIl
      ? Math.round((Date.now() - partita.iniziataIl) / 1000)
      : null;
    const nomeVincitore = (partecipanti.find(p => p.uid === vincitoreUid) || {}).nome || null;
    const profili = [];

    for (const partecipante of partecipanti) {
      if (esclusi.has(partecipante.uid)) continue;
      const utente = (await db.ref("utenti/" + partecipante.uid).once("value")).val();
      if (!utente) continue;
      profili.push({
        uid: partecipante.uid,
        nome: partecipante.nome || utente.nickname || "?",
        utente,
        eloPrima: ottieniElo(utente)
      });
    }

    const aggiornamentiElo = new Map();

    for (const profilo of profili) {
      const eloAvversari = profili
        .filter(altro => altro.uid !== profilo.uid)
        .map(altro => altro.eloPrima);
      const risultato = profilo.uid === vincitoreUid ? 1 : 0;
      const eloDopo = partitaClassificata
        ? calcolaNuovoElo(profilo.eloPrima, eloAvversari, risultato)
        : profilo.eloPrima;

      aggiornamentiElo.set(profilo.uid, {
        eloPrima: profilo.eloPrima,
        eloDopo,
        variazione: eloDopo - profilo.eloPrima
      });
    }

    for (const profilo of profili) {
      const utente = profilo.utente;
      const risultatoElo = aggiornamentiElo.get(profilo.uid);
      const aggiornamenti = {
        elo: risultatoElo ? risultatoElo.eloDopo : profilo.eloPrima,
        partiteGiocate: admin.database.ServerValue.increment(1)
      };

      if (profilo.uid === vincitoreUid) {
        const nuovoStreak = (utente.streakVittorieAttuale || 0) + 1;
        aggiornamenti.partiteVinte = admin.database.ServerValue.increment(1);
        aggiornamenti.streakVittorieAttuale = nuovoStreak;
        aggiornamenti.streakVittorieMassima = Math.max(
          utente.streakVittorieMassima || 0,
          nuovoStreak
        );

        if (
          durataSecondi !== null &&
          (utente.vittoriaPiuVeloceSecondi == null || durataSecondi < utente.vittoriaPiuVeloceSecondi)
        ) {
          aggiornamenti.vittoriaPiuVeloceSecondi = durataSecondi;
        }
      } else {
        aggiornamenti.streakVittorieAttuale = 0;
      }

      await db.ref("utenti/" + profilo.uid).update(aggiornamenti);
    }

    const risultatiElo = {};
    for (const profilo of profili) {
      const risultatoElo = aggiornamentiElo.get(profilo.uid);
      risultatiElo[profilo.uid] = {
        nome: profilo.nome,
        eloPrima: risultatoElo ? risultatoElo.eloPrima : profilo.eloPrima,
        eloDopo: risultatoElo ? risultatoElo.eloDopo : profilo.eloPrima,
        variazione: risultatoElo ? risultatoElo.variazione : 0
      };
    }

    await db.ref("storicoPartite").push().set({
      data: Date.now(),
      stanza: nomeStanza,
      vincitoreUid,
      vincitoreNome: nomeVincitore,
      durataSecondi,
      classificata: partitaClassificata,
      risultatiElo,
      partecipanti
    });
  } catch (e) {
    console.error("Errore conclusione partita ELO:", e.message);
  }
}

// ===== TOKEN =====
function creaToken(uid, nickname, ruolo) { return jwt.sign({ uid, nickname, ruolo }, JWT_SECRET, { expiresIn: "30d" }); }
function verificaToken(token) { if (!token) return null; try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; } }
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
    if (parte.substring(0, idx) === "token") return decodeURIComponent(parte.substring(idx + 1));
  }
  return null;
}
async function richiediAuth(req, res, next) {
  const dati = verificaToken(estraiTokenHeader(req));
  if (!dati) return res.status(401).json({ errore: "Devi effettuare il login." });
  req.utente = dati; next();
}
async function richiediAdmin(req, res, next) {
  const dati = verificaToken(estraiTokenHeader(req));
  if (!dati) return res.status(401).json({ errore: "Devi effettuare il login." });
  if (dati.ruolo !== "admin") return res.status(403).json({ errore: "Accesso riservato agli amministratori." });
  req.utenteAdmin = dati; next();
}
async function trovaUtentePerEmail(emailLower) {
  const snap = await db.ref("utenti").orderByChild("emailLower").equalTo(emailLower).once("value");
  if (!snap.exists()) return null;
  const val = snap.val(); const uid = Object.keys(val)[0];
  return { uid, ...val[uid] };
}
async function trovaUtentePerGoogleId(googleId) {
  if (!db || !googleId) return null;
  const snap = await db.ref("utenti").orderByChild("googleId").equalTo(googleId).once("value");
  if (!snap.exists()) return null;
  const val = snap.val();
  const uid = Object.keys(val)[0];
  return { uid, ...val[uid] };
}
async function trovaUtentePerNickname(nicknameLower) {
  const snap = await db.ref("utenti").orderByChild("nicknameLower").equalTo(nicknameLower).once("value");
  if (!snap.exists()) return null;
  const val = snap.val(); const uid = Object.keys(val)[0];
  return { uid, ...val[uid] };
}
async function statoAmicizia(mioUid, altroUid) {
  if (mioUid === altroUid) return "se_stesso";
  const [snapAmici, snapInviata, snapRicevuta] = await Promise.all([
    db.ref(`utenti/${mioUid}/amici/${altroUid}`).once("value"),
    db.ref(`utenti/${mioUid}/richiesteInviate/${altroUid}`).once("value"),
    db.ref(`utenti/${mioUid}/richiesteRicevute/${altroUid}`).once("value")
  ]);
  if (snapAmici.exists()) return "amici";
  if (snapInviata.exists()) return "richiesta_inviata";
  if (snapRicevuta.exists()) return "richiesta_ricevuta";
  return "nessuno";
}


// ===== BLOCCHI / NEMICI =====
// Il blocco è creato da un utente, ma gli effetti di interazione sono reciproci:
// se A blocca B, A e B non possono scriversi, invitarsi o stare nella stessa partita.
const CACHE_BLOCCHI_TTL_MS = 60 * 1000;
const cacheBlocchi = new Map();

function chiaveCoppiaBlocco(uidA, uidB) {
  return [String(uidA || ""), String(uidB || "")].sort().join("::");
}

function invalidaCacheBlocco(uidA, uidB) {
  cacheBlocchi.delete(chiaveCoppiaBlocco(uidA, uidB));
}

async function statoBloccoTra(mioUid, altroUid) {
  if (!db || !mioUid || !altroUid || mioUid === altroUid) return "nessuno";

  const [mioVersoAltro, altroVersoMe] = await Promise.all([
    db.ref(`blocchi/${mioUid}/${altroUid}`).once("value"),
    db.ref(`blocchi/${altroUid}/${mioUid}`).once("value")
  ]);

  if (mioVersoAltro.exists()) return "bloccato_da_me";
  if (altroVersoMe.exists()) return "mi_ha_bloccato";
  return "nessuno";
}

async function sonoBloccatiTraLoro(uidA, uidB) {
  if (!db || !uidA || !uidB || uidA === uidB) return false;

  const chiave = chiaveCoppiaBlocco(uidA, uidB);
  const ora = Date.now();
  const cached = cacheBlocchi.get(chiave);

  if (cached && ora - cached.lettoIl < CACHE_BLOCCHI_TTL_MS) {
    return cached.bloccati;
  }

  const [ab, ba] = await Promise.all([
    db.ref(`blocchi/${uidA}/${uidB}`).once("value"),
    db.ref(`blocchi/${uidB}/${uidA}`).once("value")
  ]);

  const bloccati = ab.exists() || ba.exists();
  cacheBlocchi.set(chiave, { bloccati, lettoIl: ora });
  return bloccati;
}

async function partitaContieneUtenteBloccato(partita, uid) {
  if (!partita || !uid) return false;

  const altriUid = Object.keys(partita.giocatori || {})
    .filter(altroUid => altroUid !== uid);

  if (!altriUid.length) return false;

  // I controlli sono indipendenti: eseguirli in parallelo evita una
  // sequenza di letture Firebase che, con più giocatori, poteva durare secondi.
  const risultati = await Promise.all(
    altriUid.map(altroUid => sonoBloccatiTraLoro(uid, altroUid))
  );

  return risultati.some(Boolean);
}

const URL_SERVER_PUBBLICO =
  String(process.env.PUBLIC_SERVER_URL || "https://gioco-oca-server.onrender.com")
    .replace(/\/$/, "");

function creaUrlAvatarRealtime(uid, avatarPresente, avatarVersione) {
  if (!avatarPresente || !uid) return null;
  const versione = Math.max(1, Number(avatarVersione) || 1);
  return URL_SERVER_PUBBLICO +
    "/api/avatar/" +
    encodeURIComponent(String(uid)) +
    "?v=" +
    encodeURIComponent(String(versione));
}

async function caricaUtenteRealtimeLeggero(uid, nicknameFallback = "Utente") {
  if (!db || !uid) return null;

  const refUtente = db.ref("utenti/" + uid);

  // Leggiamo solo i campi necessari alla presenza realtime. In precedenza
  // veniva scaricato l'intero /utenti/{uid}, compresi avatar base64 e dati
  // annidati non utili al WebSocket.
  const [
    snapNickname,
    snapStato,
    snapSospesoFino,
    snapAvatarPresente,
    snapAvatarAggiornatoIl
  ] = await Promise.all([
    refUtente.child("nickname").once("value"),
    refUtente.child("stato").once("value"),
    refUtente.child("sospesoFino").once("value"),
    refUtente.child("avatarPresente").once("value"),
    refUtente.child("avatarAggiornatoIl").once("value")
  ]);

  if (!snapNickname.exists()) return null;

  let avatarPresente = snapAvatarPresente.val();
  let avatarAggiornatoIl = Number(snapAvatarAggiornatoIl.val()) || 0;

  // Compatibilità con account creati prima dei metadati avatar.
  if (typeof avatarPresente !== "boolean") {
    const snapAvatar = await refUtente.child("avatar").once("value");
    avatarPresente = Boolean(snapAvatar.val());
    if (avatarPresente && !avatarAggiornatoIl) avatarAggiornatoIl = 1;

    refUtente.update({
      avatarPresente,
      avatarAggiornatoIl
    }).catch(() => {});
  }

  return {
    nickname: snapNickname.val() || nicknameFallback,
    stato: snapStato.val() || "attivo",
    sospesoFino: snapSospesoFino.val() || null,
    avatar: creaUrlAvatarRealtime(uid, avatarPresente, avatarAggiornatoIl)
  };
}

function preparaNicknameGoogle(nome, email) {
  let base = pulisciTesto(nome || "", 15).replace(/[^a-zA-Z0-9_ ]/g, "").trim();
  if (!base) base = "Google";
  if (base.length < 5) {
    const parteEmail = String(email || "").split("@")[0].replace(/[^a-zA-Z0-9_]/g, "");
    base = (base + parteEmail).substring(0, 15);
  }
  if (base.length < 5) base = "GoogleUser";
  return base.substring(0, 15);
}

async function generaNicknameGoogleUnico(nome, email) {
  let base = preparaNicknameGoogle(nome, email);
  if (!(await trovaUtentePerNickname(base.toLowerCase()))) return base;
  for (let i = 1; i <= 99; i++) {
    const suffisso = String(i);
    const massimoBase = 15 - suffisso.length;
    const candidato = base.substring(0, massimoBase) + suffisso;
    if (!(await trovaUtentePerNickname(candidato.toLowerCase()))) return candidato;
  }
  return "Google" + Date.now().toString().slice(-8);
}

// ===== REDIRECT AUTENTICAZIONE / OAUTH =====
const URL_HOME_WIX = "https://solfriniluca1.wixstudio.com/giochisocieta";

function normalizzaRedirectAutenticazione(valore) {
  if (typeof valore !== "string" || !valore.trim()) return null;
  try {
    const url = new URL(valore);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!ORIGINI_CONSENTITE.includes(url.origin)) return null;
    return url.href;
  } catch (e) {
    return null;
  }
}

function creaStatoOAuth(redirectRichiesto) {
  return jwt.sign(
    {
      tipo: "oauth_redirect",
      redirect: normalizzaRedirectAutenticazione(redirectRichiesto)
    },
    JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function leggiStatoOAuth(state) {
  if (!state || typeof state !== "string") return null;
  try {
    const dati = jwt.verify(state, JWT_SECRET);
    if (!dati || dati.tipo !== "oauth_redirect") return null;
    return normalizzaRedirectAutenticazione(dati.redirect);
  } catch (e) {
    return null;
  }
}

function aggiungiTokenAlFrammento(urlDestinazione, token) {
  const destinazione = normalizzaRedirectAutenticazione(urlDestinazione);
  if (!destinazione || !token) return destinazione || URL_HOME_WIX;
  const url = new URL(destinazione);
  const parametriHash = new URLSearchParams(url.hash.replace(/^#/, ""));
  parametriHash.set("auth_token", token);
  url.hash = parametriHash.toString();
  return url.href;
}

// ===== LOGIN CON GOOGLE =====
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL;

if (!GOOGLE_CLIENT_ID) console.warn("GOOGLE_CLIENT_ID non configurato su Render.");
if (!GOOGLE_CLIENT_SECRET) console.warn("GOOGLE_CLIENT_SECRET non configurato su Render.");
if (!GOOGLE_CALLBACK_URL) console.warn("GOOGLE_CALLBACK_URL non configurato su Render.");

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      if (!db) return done(new Error("Database non disponibile."));

      const googleId = profile.id;
      const email = profile.emails?.[0]?.value?.trim().toLowerCase();
      const emailVerificata = profile.emails?.[0]?.verified;

      if (!googleId) return done(new Error("Google non ha restituito un ID valido."));
      if (!email) return done(new Error("Google non ha restituito un indirizzo email."));
      if (emailVerificata === false) return done(new Error("L'indirizzo email Google non è verificato."));

      let utente = await trovaUtentePerGoogleId(googleId);
      if (!utente) utente = await trovaUtentePerEmail(email);

      if (utente) {
        if (utente.stato === "bannato") return done(new Error("Il tuo account è stato bannato."));
        if (utente.stato === "sospeso" && utente.sospesoFino && utente.sospesoFino > Date.now()) {
          return done(new Error("Account sospeso fino al " + new Date(utente.sospesoFino).toLocaleString("it-IT") + "."));
        }
        await db.ref("utenti/" + utente.uid).update({ googleId, providerGoogle: true, elo: ottieniElo(utente), ultimoAccesso: Date.now() });
        return done(null, { uid: utente.uid, nickname: utente.nickname, ruolo: utente.ruolo || "utente" });
      }

      const nickname = await generaNicknameGoogleUnico(profile.displayName, email);
      const nuovoRef = db.ref("utenti").push();
      const uid = nuovoRef.key;

      await nuovoRef.set({
        partiteVinte: 0, partiteGiocate: 0, puntiTotali: 0, elo: ELO_INIZIALE,
        streakVittorieAttuale: 0, streakVittorieMassima: 0, vittoriaPiuVeloceSecondi: null,
        email, emailLower: email,
        nickname, nicknameLower: nickname.toLowerCase(),
        passwordHash: null,
        googleId, providerGoogle: true,
        avatar: profile.photos?.[0]?.value || null,
        avatarPresente: Boolean(profile.photos?.[0]?.value),
        avatarAggiornatoIl: profile.photos?.[0]?.value ? Date.now() : 0,
        ruolo: "utente", stato: "attivo", sospesoFino: null,
        avvisi: [], creatoIl: Date.now(), ultimoAccesso: Date.now()
      });

      return done(null, { uid, nickname, ruolo: "utente" });
    } catch (errore) {
      console.error("Errore verifica account Google:", errore);
      return done(errore);
    }
  }));
}

app.get("/auth/google", (req, res, next) => {
  const state = creaStatoOAuth(req.query.redirect);
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state
  })(req, res, next);
});

app.get("/auth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/login.html?errore=google" }),
  async (req, res) => {
    try {
      const utente = req.user;
      if (!utente || !utente.uid) return res.redirect("/login.html?errore=google");

      const token = creaToken(utente.uid, utente.nickname, utente.ruolo || "utente");
      res.cookie("token", token, OPZIONI_COOKIE);

      const redirectRichiesto = leggiStatoOAuth(req.query.state);
      if (redirectRichiesto) {
        return res.redirect(aggiungiTokenAlFrammento(redirectRichiesto, token));
      }

      return res.redirect(URL_HOME_WIX);
    } catch (errore) {
      console.error("Errore callback Google:", errore);
      return res.redirect("/login.html?errore=google");
    }
  }
);

// ===== API REGISTRAZIONE / LOGIN =====
app.post("/api/registrati", limiteLogin, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile al momento." });
  try {
    const { email, nickname, password } = req.body;
    if (!email || !nickname || !password) return res.status(400).json({ errore: "Compila tutti i campi." });
    const nicknamePulito = pulisciTesto(nickname, 20);
    if (nicknamePulito.length < 5 || nicknamePulito.length > 15) return res.status(400).json({ errore: "Il nickname deve contenere da 5 a 15 caratteri." });
    if (!/^[a-zA-Z0-9_ ]+$/.test(nicknamePulito)) return res.status(400).json({ errore: "Il nickname contiene caratteri non consentiti." });
    if (password.length < 6 || password.length > 100) return res.status(400).json({ errore: "La password deve avere tra 6 e 100 caratteri." });
    const emailPulita = pulisciTesto(email, 100).toLowerCase();
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(emailPulita)) return res.status(400).json({ errore: "Inserisci un indirizzo email valido." });
    const nicknameLower = nicknamePulito.toLowerCase();
    if (await trovaUtentePerEmail(emailPulita)) return res.status(400).json({ errore: "Questa email è già registrata." });
    if (await trovaUtentePerNickname(nicknameLower)) return res.status(400).json({ errore: "Questo nickname è già in uso." });
    const passwordHash = await bcrypt.hash(password, 10);
    const nuovoRef = db.ref("utenti").push();
    const uid = nuovoRef.key;
    await nuovoRef.set({
      partiteVinte: 0, partiteGiocate: 0, puntiTotali: 0, elo: ELO_INIZIALE, streakVittorieAttuale: 0, streakVittorieMassima: 0, vittoriaPiuVeloceSecondi: null,
      email: emailPulita, emailLower: emailPulita, nickname: nicknamePulito, nicknameLower, passwordHash,
      avatar: null, avatarPresente: false, avatarAggiornatoIl: 0, ruolo: "utente", stato: "attivo", sospesoFino: null, avvisi: [], creatoIl: Date.now(), ultimoAccesso: Date.now()
    });
    const token = creaToken(uid, nicknamePulito, "utente");
    res.cookie("token", token, OPZIONI_COOKIE);
    res.json({ nickname: nicknamePulito, ruolo: "utente", token });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.post("/api/login", limiteLogin, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile al momento." });
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ errore: "Inserisci email e password." });
    const utente = await trovaUtentePerEmail(pulisciTesto(email, 100).toLowerCase());
    if (!utente) return res.status(400).json({ errore: "Email o password errati." });
    if (!utente.passwordHash) return res.status(400).json({ errore: "Questo account è stato creato con Google. Usa 'Accedi con Google'." });
    if (!(await bcrypt.compare(password, utente.passwordHash))) return res.status(400).json({ errore: "Email o password errati." });
    if (utente.stato === "bannato") return res.status(403).json({ errore: "Il tuo account è stato bannato." });
    if (utente.stato === "sospeso") {
      if (utente.sospesoFino && utente.sospesoFino > Date.now()) return res.status(403).json({ errore: "Account sospeso fino al " + new Date(utente.sospesoFino).toLocaleString("it-IT") + "." });
      await db.ref("utenti/" + utente.uid).update({ stato: "attivo", sospesoFino: null });
    }
    await db.ref("utenti/" + utente.uid).update({ ultimoAccesso: Date.now(), elo: ottieniElo(utente) });
    const token = creaToken(utente.uid, utente.nickname, utente.ruolo || "utente");
    res.cookie("token", token, OPZIONI_COOKIE);
    res.json({ nickname: utente.nickname, ruolo: utente.ruolo || "utente", token });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.post("/api/cambia-password", richiediAuth, async (req, res) => {

  if (!db) {
    return res.status(500).json({
      errore: "Servizio account non disponibile."
    });
  }

  try {

    const {
      vecchiaPassword,
      nuovaPassword
    } = req.body || {};

    // =========================================
    // CONTROLLO CAMPI
    // =========================================

    if (
      typeof vecchiaPassword !== "string" ||
      typeof nuovaPassword !== "string" ||
      !vecchiaPassword ||
      !nuovaPassword
    ) {
      return res.status(400).json({
        errore: "Inserisci la password attuale e quella nuova."
      });
    }

    // Stessa regola usata nella registrazione
    if (
      nuovaPassword.length < 6 ||
      nuovaPassword.length > 100
    ) {
      return res.status(400).json({
        errore:
          "La nuova password deve contenere da 6 a 100 caratteri."
      });
    }

    if (vecchiaPassword === nuovaPassword) {
      return res.status(400).json({
        errore:
          "La nuova password deve essere diversa da quella attuale."
      });
    }

    // =========================================
    // RECUPERO UTENTE
    // =========================================

    const riferimentoUtente =
      db.ref("utenti/" + req.utente.uid);

    const snapshot =
      await riferimentoUtente.once("value");

    const utente =
      snapshot.val();

    if (!utente) {
      return res.status(404).json({
        errore: "Utente non trovato."
      });
    }

    // =========================================
    // ACCOUNT GOOGLE
    // =========================================

    if (!utente.passwordHash) {
      return res.status(400).json({
        errore:
          "Questo account non dispone di una password locale. Se hai creato l'account con Google, accedi tramite Google."
      });
    }

    // =========================================
    // VERIFICA PASSWORD ATTUALE
    // =========================================

    const passwordCorretta =
      await bcrypt.compare(
        vecchiaPassword,
        utente.passwordHash
      );

    if (!passwordCorretta) {
      return res.status(400).json({
        errore: "La password attuale non è corretta."
      });
    }

    // =========================================
    // CREA NUOVO HASH
    // =========================================

    const nuovoPasswordHash =
      await bcrypt.hash(
        nuovaPassword,
        10
      );

    // =========================================
    // SALVATAGGIO
    // =========================================

    await riferimentoUtente.update({
      passwordHash: nuovoPasswordHash,
      passwordAggiornataIl: Date.now()
    });

    return res.json({
      ok: true,
      messaggio: "Password modificata correttamente."
    });

  } catch (errore) {

    console.error(
      "Errore /api/cambia-password:",
      errore
    );

    return res.status(500).json({
      errore:
        "Errore durante la modifica della password."
    });

  }

});

app.post("/api/elimina-avatar", richiediAuth, async (req, res) => {
  if (!db) {
    return res.status(500).json({
      errore: "Servizio account non disponibile."
    });
  }

  try {
    const riferimentoUtente =
      db.ref("utenti/" + req.utente.uid);

    const snapshot =
      await riferimentoUtente.once("value");

    const utente = snapshot.val();

    if (!utente) {
      return res.status(404).json({
        errore: "Utente non trovato."
      });
    }

    const avatarAggiornatoIl = Date.now();

    await riferimentoUtente.update({
      avatar: null,
      avatarPresente: false,
      avatarAggiornatoIl
    });

    return res.json({
      ok: true,
      avatar: null,
      avatarPresente: false,
      avatarAggiornatoIl,
      messaggio: "Avatar eliminato correttamente."
    });

  } catch (errore) {
    console.error(
      "Errore /api/elimina-avatar:",
      errore
    );

    return res.status(500).json({
      errore: "Errore durante l'eliminazione dell'avatar."
    });
  }
});

// ============================================================
// ALBUM FOTO PROFILO
// Massimo 15 foto pubbliche + 15 foto private per utente.
// Le immagini vengono salvate fuori da /utenti/{uid} per non
// appesantire /api/me.
// ============================================================

const MAX_FOTO_ALBUM_PER_TIPO = 15;

const uploadFotoAlbum = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const tipiConsentiti = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!tipiConsentiti.includes(file.mimetype)) {
      return cb(
        new Error(
          "Puoi caricare solo immagini JPG, PNG o WEBP."
        )
      );
    }

    cb(null, true);
  }
});

function normalizzaVisibilitaFoto(valore) {
  return valore === "privata"
    ? "privata"
    : valore === "pubblica"
      ? "pubblica"
      : null;
}

function fotoAlbumMetadata(uid, id, foto) {
  const creataIl = Number(foto.creataIl) || 0;

  return {
    id,
    uid,
    visibilita: foto.visibilita,
    creataIl,
    url:
      `/api/album-foto/immagine/${encodeURIComponent(uid)}/${encodeURIComponent(id)}?v=${creataIl || 1}`
  };
}

async function puoVedereFotoAlbum(mioUid, proprietarioUid, visibilita) {
  if (visibilita === "pubblica") {
    return true;
  }

  if (!mioUid) {
    return false;
  }

  if (mioUid === proprietarioUid) {
    return true;
  }

  if (await sonoBloccatiTraLoro(mioUid, proprietarioUid)) {
    return false;
  }

  return (
    await statoAmicizia(
      mioUid,
      proprietarioUid
    )
  ) === "amici";
}

// ------------------------------------------------------------
// Album personale completo
// ------------------------------------------------------------
app.get(
  "/api/album-foto/mio",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(503).json({
        errore: "Servizio album foto non disponibile."
      });
    }

    try {
      const uid = req.utente.uid;
      const snap = await db
        .ref(`albumFoto/${uid}`)
        .once("value");

      const valori = snap.val() || {};

      const foto = Object.entries(valori)
        .map(([id, item]) =>
          fotoAlbumMetadata(uid, id, item || {})
        )
        .filter(item =>
          item.visibilita === "pubblica" ||
          item.visibilita === "privata"
        )
        .sort((a, b) => a.creataIl - b.creataIl);

      res.set("Cache-Control", "no-store");
      return res.json({
        foto,
        limiti: {
          pubbliche: MAX_FOTO_ALBUM_PER_TIPO,
          private: MAX_FOTO_ALBUM_PER_TIPO
        }
      });
    } catch (errore) {
      console.error("Errore GET /api/album-foto/mio:", errore);
      return res.status(500).json({
        errore: "Errore durante il caricamento dell'album foto."
      });
    }
  }
);

// ------------------------------------------------------------
// Album di un altro utente.
// Pubbliche: tutti.
// Private: solo proprietario e amici.
// ------------------------------------------------------------
app.get(
  "/api/album-foto/utente/:uid",
  async (req, res) => {
    if (!db) {
      return res.status(503).json({
        errore: "Servizio album foto non disponibile."
      });
    }

    try {
      const proprietarioUid =
        String(req.params.uid || "").trim();

      if (!proprietarioUid || proprietarioUid.length > 128) {
        return res.status(400).json({
          errore: "Utente non valido."
        });
      }

      const token = estraiTokenHeader(req);
      const autenticato = verificaToken(token);
      const mioUid = autenticato ? autenticato.uid : null;

      const snap = await db
        .ref(`albumFoto/${proprietarioUid}`)
        .once("value");

      const valori = snap.val() || {};
      const risultato = [];

      let puoVederePrivate =
        mioUid === proprietarioUid;

      if (
        !puoVederePrivate &&
        mioUid
      ) {
        puoVederePrivate =
          !(await sonoBloccatiTraLoro(mioUid, proprietarioUid)) &&
          (await statoAmicizia(
            mioUid,
            proprietarioUid
          )) === "amici";
      }

      for (const [id, itemGrezz] of Object.entries(valori)) {
        const item = itemGrezz || {};
        const visibilita = normalizzaVisibilitaFoto(
          item.visibilita
        );

        if (!visibilita) {
          continue;
        }

        if (
          visibilita === "privata" &&
          !puoVederePrivate
        ) {
          continue;
        }

        risultato.push(
          fotoAlbumMetadata(
            proprietarioUid,
            id,
            item
          )
        );
      }

      risultato.sort(
        (a, b) => a.creataIl - b.creataIl
      );

      res.set("Cache-Control", "no-store");
      return res.json({ foto: risultato });
    } catch (errore) {
      console.error(
        "Errore GET /api/album-foto/utente/:uid:",
        errore
      );

      return res.status(500).json({
        errore: "Errore durante il caricamento dell'album foto."
      });
    }
  }
);

// ------------------------------------------------------------
// Caricamento foto
// ------------------------------------------------------------
app.post(
  "/api/album-foto/carica",
  richiediAuth,
  uploadFotoAlbum.single("foto"),
  async (req, res) => {
    if (!db) {
      return res.status(503).json({
        errore: "Servizio album foto non disponibile."
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          errore: "Nessuna immagine ricevuta."
        });
      }

      const visibilita = normalizzaVisibilitaFoto(
        req.body && req.body.visibilita
      );

      if (!visibilita) {
        return res.status(400).json({
          errore: "Visibilità della foto non valida."
        });
      }

      const uid = req.utente.uid;
      const refAlbum = db.ref(`albumFoto/${uid}`);
      const snap = await refAlbum.once("value");
      const album = snap.val() || {};

      const numeroStessoTipo = Object.values(album)
        .filter(
          foto =>
            foto &&
            foto.visibilita === visibilita
        )
        .length;

      if (
        numeroStessoTipo >=
        MAX_FOTO_ALBUM_PER_TIPO
      ) {
        return res.status(400).json({
          errore:
            visibilita === "pubblica"
              ? "Hai già raggiunto il limite di 15 foto pubbliche."
              : "Hai già raggiunto il limite di 15 foto private."
        });
      }

      const dataUri =
        `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

      const creataIl = Date.now();
      const nuovaRef = refAlbum.push();
      const id = nuovaRef.key;

      await nuovaRef.set({
        immagine: dataUri,
        visibilita,
        creataIl
      });

      return res.status(201).json({
        ok: true,
        foto: fotoAlbumMetadata(
          uid,
          id,
          {
            visibilita,
            creataIl
          }
        )
      });
    } catch (errore) {
      console.error(
        "Errore POST /api/album-foto/carica:",
        errore
      );

      return res.status(400).json({
        errore:
          errore.message ||
          "Errore durante il caricamento della foto."
      });
    }
  }
);

// ------------------------------------------------------------
// Eliminazione di una propria foto
// ------------------------------------------------------------
app.delete(
  "/api/album-foto/:fotoId",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(503).json({
        errore: "Servizio album foto non disponibile."
      });
    }

    try {
      const fotoId = String(
        req.params.fotoId || ""
      ).trim();

      if (!fotoId || fotoId.length > 128) {
        return res.status(400).json({
          errore: "Foto non valida."
        });
      }

      const refFoto = db.ref(
        `albumFoto/${req.utente.uid}/${fotoId}`
      );

      const snap = await refFoto.once("value");

      if (!snap.exists()) {
        return res.status(404).json({
          errore: "Foto non trovata."
        });
      }

      await refFoto.remove();

      return res.json({
        ok: true,
        fotoId
      });
    } catch (errore) {
      console.error(
        "Errore DELETE /api/album-foto/:fotoId:",
        errore
      );

      return res.status(500).json({
        errore: "Errore durante l'eliminazione della foto."
      });
    }
  }
);

// ------------------------------------------------------------
// File immagine album con controllo privacy
// ------------------------------------------------------------
app.get(
  "/api/album-foto/immagine/:uid/:fotoId",
  async (req, res) => {
    if (!db) {
      return res.status(503).end();
    }

    try {
      const uid = String(req.params.uid || "").trim();
      const fotoId = String(req.params.fotoId || "").trim();

      if (
        !uid ||
        !fotoId ||
        uid.length > 128 ||
        fotoId.length > 128
      ) {
        return res.status(400).end();
      }

      const foto = (
        await db
          .ref(`albumFoto/${uid}/${fotoId}`)
          .once("value")
      ).val();

      if (!foto) {
        return res.status(404).end();
      }

      const visibilita = normalizzaVisibilitaFoto(
        foto.visibilita
      );

      if (!visibilita) {
        return res.status(404).end();
      }

      const token = estraiTokenHeader(req);
      const autenticato = verificaToken(token);
      const mioUid = autenticato ? autenticato.uid : null;

      const consentita = await puoVedereFotoAlbum(
        mioUid,
        uid,
        visibilita
      );

      if (!consentita) {
        return res.status(403).end();
      }

      const valore = String(foto.immagine || "").trim();
      const match = valore.match(
        /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i
      );

      if (!match) {
        return res.status(415).end();
      }

      const mime = match[1].toLowerCase();
      const base64 = match[2].replace(/\s/g, "");
      const buffer = Buffer.from(base64, "base64");

      if (!buffer.length) {
        return res.status(404).end();
      }

      res.set({
        "Content-Type": mime,
        "Content-Length": String(buffer.length),
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cache-Control":
          visibilita === "pubblica"
            ? "public, max-age=86400"
            : "private, max-age=3600"
      });

      return res.send(buffer);
    } catch (errore) {
      console.error(
        "Errore GET /api/album-foto/immagine/:uid/:fotoId:",
        errore
      );

      return res.status(500).end();
    }
  }
);

app.post("/api/logout", (req, res) => { res.clearCookie("token", OPZIONI_COOKIE); res.json({ ok: true }); });

app.get("/api/me", richiediAuth, async (req, res) => {
  if (!db) {
    return res.status(500).json({
      errore: "Servizio account non disponibile."
    });
  }

  try {
    const utente = (
      await db
        .ref("utenti/" + req.utente.uid)
        .once("value")
    ).val();

    if (!utente) {
      return res.status(404).json({
        errore: "Utente non trovato."
      });
    }

    if (utente.elo == null) {
      utente.elo = ELO_INIZIALE;

      await db
        .ref("utenti/" + req.utente.uid)
        .update({
          elo: ELO_INIZIALE
        });
    }

    res.json({
      uid: req.utente.uid,

      nickname: utente.nickname,
      email: utente.email,
      avatar: utente.avatar || null,

      // =========================================
      // DATI PERSONALI
      // =========================================
      nome: utente.nome || "",
      cognome: utente.cognome || "",
      dataNascita: utente.dataNascita || "",
      sesso: utente.sesso || "",
      citta: utente.citta || "",
      provincia: utente.provincia || "",

      ruolo: utente.ruolo || "utente",
      stato: utente.stato || "attivo",
      sospesoFino: utente.sospesoFino || null,
      avvisi: utente.avvisi || [],

      partiteVinte: utente.partiteVinte || 0,
      partiteGiocate: utente.partiteGiocate || 0,

      creatoIl: utente.creatoIl || null,
      ultimoAccesso: utente.ultimoAccesso || null,

      elo: ottieniElo(utente),

      streakVittorieMassima:
        utente.streakVittorieMassima || 0,

      vittoriaPiuVeloceSecondi:
        utente.vittoriaPiuVeloceSecondi ?? null,

      badge: calcolaBadge(utente)
    });

  } catch (err) {
    console.error(
      "Errore /api/me:",
      err
    );

    res.status(500).json({
      errore: "Errore del server."
    });
  }
});

app.post("/api/modifica-profilo", richiediAuth, async (req, res) => {

  if (!db) {
    return res.status(500).json({
      errore: "Servizio account non disponibile."
    });
  }

  try {

    const {
      nome,
      cognome,
      dataNascita,
      sesso,
      citta,
      provincia
    } = req.body || {};

    const datiAggiornati = {

      nome: pulisciTesto(nome || "", 60),

      cognome: pulisciTesto(cognome || "", 60),

      dataNascita: pulisciTesto(
        dataNascita || "",
        10
      ),

      sesso: pulisciTesto(
        sesso || "",
        20
      ),

      citta: pulisciTesto(
        citta || "",
        80
      ),

      provincia: pulisciTesto(
        provincia || "",
        80
      ),

      profiloAggiornatoIl: Date.now()

    };

    const sessiConsentiti = [
      "",
      "M",
      "F",
      "Altro"
    ];

    if (
      !sessiConsentiti.includes(
        datiAggiornati.sesso
      )
    ) {
      return res.status(400).json({
        errore: "Valore del sesso non valido."
      });
    }

    if (
      datiAggiornati.dataNascita &&
      !/^\d{4}-\d{2}-\d{2}$/.test(
        datiAggiornati.dataNascita
      )
    ) {
      return res.status(400).json({
        errore: "Data di nascita non valida."
      });
    }

    await db
      .ref(
        "utenti/" + req.utente.uid
      )
      .update(
        datiAggiornati
      );

    res.json({
      ok: true,
      ...datiAggiornati
    });

  } catch (errore) {

    console.error(
      "Errore modifica profilo:",
      errore
    );

    res.status(500).json({
      errore:
        "Errore durante il salvataggio del profilo."
    });

  }

});

app.post("/api/modifica-nickname", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { nickname } = req.body;
    if (!nickname || !nickname.trim()) return res.status(400).json({ errore: "Inserisci un nickname." });
    const nuovoNickname = pulisciTesto(nickname, 20);
    if (nuovoNickname.length < 5 || nuovoNickname.length > 15) return res.status(400).json({ errore: "Il nickname deve contenere da 5 a 15 caratteri." });
    if (!/^[a-zA-Z0-9_ ]+$/.test(nuovoNickname)) return res.status(400).json({ errore: "Nickname non valido." });
    const nicknameLower = nuovoNickname.toLowerCase();
    const esistente = await trovaUtentePerNickname(nicknameLower);
    if (esistente && esistente.uid !== req.utente.uid) return res.status(400).json({ errore: "Questo nickname è già in uso." });
    await db.ref("utenti/" + req.utente.uid).update({ nickname: nuovoNickname, nicknameLower });
    res.cookie("token", creaToken(req.utente.uid, nuovoNickname, req.utente.ruolo), OPZIONI_COOKIE);
    res.json({ nickname: nuovoNickname });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.post("/api/carica-avatar", richiediAuth, uploadAvatar.single("avatar"), async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    if (!req.file) return res.status(400).json({ errore: "Nessuna immagine ricevuta." });
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const avatarAggiornatoIl = Date.now();
    await db.ref("utenti/" + req.utente.uid).update({
      avatar: dataUri,
      avatarPresente: true,
      avatarAggiornatoIl
    });
    res.json({ avatar: dataUri, avatarAggiornatoIl });
  } catch (err) { console.error(err); res.status(400).json({ errore: err.message || "Errore durante il caricamento." }); }
});


// Dati minimi per l'HTML Embed dell'account.
// Evita di trasferire il pesante campo avatar base64 ad ogni controllo sessione.
app.get("/api/me-menu", richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio account non disponibile." });

  try {
    const refUtente = db.ref("utenti/" + req.utente.uid);

    const [snapNickname, snapAvatarPresente, snapAvatarAggiornatoIl] = await Promise.all([
      refUtente.child("nickname").once("value"),
      refUtente.child("avatarPresente").once("value"),
      refUtente.child("avatarAggiornatoIl").once("value")
    ]);

    const nickname = snapNickname.val() || req.utente.nickname || "Utente";
    let avatarPresente = snapAvatarPresente.val();
    let avatarAggiornatoIl = Number(snapAvatarAggiornatoIl.val()) || 0;

    // Compatibilita con gli avatar caricati prima dell'introduzione
    // dei metadati avatarPresente/avatarAggiornatoIl. Questa lettura pesante
    // avviene solo una volta per gli account vecchi; poi i flag vengono salvati.
    if (typeof avatarPresente !== "boolean") {
      const snapAvatar = await refUtente.child("avatar").once("value");
      avatarPresente = Boolean(snapAvatar.val());
      if (avatarPresente && !avatarAggiornatoIl) avatarAggiornatoIl = 1;

      await refUtente.update({
        avatarPresente,
        avatarAggiornatoIl
      });
    }

    res.set("Cache-Control", "no-store");
    return res.json({
      uid: req.utente.uid,
      nickname,
      avatarPresente,
      avatarVersione: avatarAggiornatoIl || 1
    });
  } catch (err) {
    console.error("Errore /api/me-menu:", err);
    return res.status(500).json({ errore: "Errore del server." });
  }
});

// Restituisce l'avatar come una normale immagine HTTPS.
// Serve a evitare i problemi di data: URI / Blob URL dentro gli HTML Embed Wix.
app.get("/api/avatar/:uid", async (req, res) => {
  if (!db) return res.status(503).end();

  try {
    const uid = String(req.params.uid || "").trim();
    if (!uid || uid.length > 128) return res.status(400).end();

    const avatar = (await db.ref("utenti/" + uid + "/avatar").once("value")).val();
    if (!avatar || typeof avatar !== "string") return res.status(404).end();

    const valore = avatar.trim();

    // Avatar Google o altro URL HTTPS già remoto.
    if (/^https:\/\//i.test(valore)) {
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.set("Cache-Control", "private, max-age=86400");
      return res.redirect(302, valore);
    }

    // Avatar caricato dal sito e memorizzato in Firebase come data URI.
    const match = valore.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return res.status(415).end();

    const mime = match[1].toLowerCase();
    const base64 = match[2].replace(/\s/g, "");
    const buffer = Buffer.from(base64, "base64");

    if (!buffer.length) return res.status(404).end();

    res.set({
      "Content-Type": mime,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin"
    });

    return res.send(buffer);
  } catch (err) {
    console.error("Errore lettura avatar:", err);
    return res.status(500).end();
  }
});

app.get("/api/top-giocatori", async (req, res) => {
  try {
    if (!db) return res.json({ giocatori: [] });
    const utenti = (await db.ref("utenti").once("value")).val() || {};
    const top = Object.values(utenti).map(u => ({ nickname: u.nickname || "Sconosciuto", vinte: u.partiteVinte || 0, giocate: u.partiteGiocate || 0 }))
      .sort((a, b) => (b.vinte !== a.vinte ? b.vinte - a.vinte : b.giocate - a.giocate)).slice(0, 10);
    res.json({ giocatori: top });
  } catch (e) { console.error("Errore classifica:", e); res.status(500).json({ giocatori: [] }); }
});

// ============================================================
// COMMUNITY - API REALI (Firebase Realtime Database)
// ============================================================

const COMMUNITY_CATEGORIE = new Set([
  "discussioni",
  "giocatori",
  "strategie",
  "eventi",
  "supporto"
]);

const limiteCommunityPost = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore: "Stai pubblicando troppo velocemente. Riprova tra poco."
  }
});

const limiteCommunityCommenti = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore: "Stai commentando troppo velocemente. Rallenta un po'."
  }
});

const limiteCommunityAzioni = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore: "Troppe azioni in poco tempo. Riprova tra qualche secondo."
  }
});


function communityCategoria(categoria) {

  const valore =
    String(categoria || "")
      .trim()
      .toLowerCase();

  return COMMUNITY_CATEGORIE.has(valore)
    ? valore
    : "discussioni";

}


function communityNumero(valore) {

  const n =
    Number(valore || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;

}


function communityId(valore) {

  return String(valore || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .substring(0, 100);

}


async function communityProfilo(uid) {

  if (!db || !uid) {
    return null;
  }

  const snapshot =
    await db
      .ref("utenti/" + uid)
      .once("value");

  const u =
    snapshot.val();

  if (!u) {
    return null;
  }

  return {
    uid,
    nickname:
      u.nickname || "Giocatore",

    avatar:
      u.avatar || null,

    ruolo:
      u.ruolo || "utente",

    stato:
      u.stato || "attivo",

    sospesoFino:
      u.sospesoFino || null
  };

}


async function communityUtenteScrittura(
  req,
  res
) {

  const u =
    await communityProfilo(
      req.utente &&
      req.utente.uid
    );


  if (!u) {

    res.status(404).json({
      errore: "Utente non trovato."
    });

    return null;

  }


  if (
    u.stato ===
    "bannato"
  ) {

    res.status(403).json({
      errore:
        "Il tuo account è stato bannato."
    });

    return null;

  }


  if (
    u.stato === "sospeso" &&
    u.sospesoFino &&
    Number(u.sospesoFino) >
      Date.now()
  ) {

    res.status(403).json({
      errore:
        "Il tuo account è sospeso fino al " +
        new Date(
          u.sospesoFino
        ).toLocaleString(
          "it-IT"
        ) +
        "."
    });

    return null;

  }


  return u;

}


async function communityAggiornaContatore(
  ref,
  delta
) {

  const risultato =
    await ref.transaction(
      valore =>
        Math.max(
          0,
          communityNumero(
            valore
          ) + delta
        )
    );


  return communityNumero(
    risultato.snapshot.val()
  );

}


function communityPostJson(
  id,
  post,
  profilo,
  stato = {}
) {

  return {

    id,

    uidAutore:
      post.uidAutore ||
      null,

    nicknameAutore:
      (
        profilo &&
        profilo.nickname
      ) ||
      post.nicknameAutore ||
      "Giocatore",

    avatarAutore:
      (
        profilo &&
        profilo.avatar
      ) ||
      null,

    ruoloAutore:
      (
        profilo &&
        profilo.ruolo
      ) ||
      post.ruoloAutore ||
      "utente",

    categoria:
      communityCategoria(
        post.categoria
      ),

    titolo:
      String(
        post.titolo || ""
      ),

    testo:
      String(
        post.testo || ""
      ),

    creatoIl:
      Number(
        post.creatoIl || 0
      ),

    aggiornatoIl:
      Number(
        post.aggiornatoIl ||
        post.creatoIl ||
        0
      ),

    conteggioReazioni:
      communityNumero(
        post.conteggioReazioni
      ),

    conteggioCommenti:
      communityNumero(
        post.conteggioCommenti
      ),

    conteggioCondivisioni:
      communityNumero(
        post.conteggioCondivisioni
      ),

    mioLike:
      stato.mioLike === true,

    salvato:
      stato.salvato === true,

    puoEliminare:
      stato.puoEliminare === true

  };

}


// ============================================================
// GET FEED COMMUNITY
// ============================================================

app.get(
  "/api/community/posts",
  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const token =
        verificaToken(
          estraiTokenHeader(req)
        );


      const mioUid =
        token?.uid ||
        null;


      const mioRuolo =
        token?.ruolo ||
        "utente";


      const limite =
        Math.min(
          100,
          Math.max(
            1,
            parseInt(
              req.query.limit,
              10
            ) || 60
          )
        );


      const snapshot =
        await db
          .ref(
            "community/posts"
          )
          .orderByChild(
            "creatoIl"
          )
          .limitToLast(
            limite
          )
          .once(
            "value"
          );


      const posts =
        Object.entries(
          snapshot.val() ||
          {}
        )
          .map(
            ([id, post]) => ({
              id,
              ...post
            })
          )
          .sort(
            (a, b) =>
              Number(
                b.creatoIl ||
                0
              ) -
              Number(
                a.creatoIl ||
                0
              )
          );


      const autori =
        [
          ...new Set(
            posts
              .map(
                post =>
                  post.uidAutore
              )
              .filter(
                Boolean
              )
          )
        ];


      const profili =
        {};


      await Promise.all(

        autori.map(

          async uid => {

            try {

              profili[uid] =
                await communityProfilo(
                  uid
                );

            } catch (
              errore
            ) {

              profili[uid] =
                null;

            }

          }

        )

      );


      let mieiLike =
        {};

      let mieiSalvati =
        {};


      if (
        mioUid
      ) {

        const [
          snapshotLike,
          snapshotSalvati
        ] =
          await Promise.all([

            db
              .ref(
                "community/reazioniUtente/" +
                mioUid
              )
              .once(
                "value"
              ),

            db
              .ref(
                "community/salvati/" +
                mioUid
              )
              .once(
                "value"
              )

          ]);


        mieiLike =
          snapshotLike.val() ||
          {};


        mieiSalvati =
          snapshotSalvati.val() ||
          {};

      }


      res.json({

        posts:
          posts.map(

            post =>
              communityPostJson(

                post.id,

                post,

                profili[
                  post.uidAutore
                ],

                {

                  mioLike:
                    mieiLike[
                      post.id
                    ] === true,

                  salvato:
                    mieiSalvati[
                      post.id
                    ] === true,

                  puoEliminare:
                    !!(
                      mioUid &&
                      (
                        post.uidAutore ===
                          mioUid
                        ||
                        mioRuolo ===
                          "admin"
                      )
                    )

                }

              )

          )

      });


    } catch (
      errore
    ) {

      console.error(
        "Errore GET Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante il caricamento della Community."
        });

    }

  }
);


// ============================================================
// CREA NUOVO POST
// ============================================================

app.post(
  "/api/community/posts",

  limiteCommunityPost,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const categoria =
        communityCategoria(
          req.body?.categoria
        );


      const titolo =
        pulisciTesto(
          req.body?.titolo,
          100
        );


      const testo =
        pulisciTesto(
          req.body?.testo,
          1200
        );


      if (
        titolo.length < 3
      ) {

        return res
          .status(400)
          .json({
            errore:
              "Il titolo deve contenere almeno 3 caratteri."
          });

      }


      if (
        !testo
      ) {

        return res
          .status(400)
          .json({
            errore:
              "Scrivi un messaggio prima di pubblicare."
          });

      }


      const riferimento =
        db
          .ref(
            "community/posts"
          )
          .push();


      const ora =
        Date.now();


      const post = {

        uidAutore:
          req.utente.uid,

        nicknameAutore:
          profilo.nickname,

        ruoloAutore:
          profilo.ruolo,

        categoria,

        titolo,

        testo,

        creatoIl:
          ora,

        aggiornatoIl:
          ora,

        conteggioReazioni:
          0,

        conteggioCommenti:
          0,

        conteggioCondivisioni:
          0

      };


      await riferimento.set(
        post
      );


      res
        .status(201)
        .json({

          ok:
            true,

          post:
            communityPostJson(
              riferimento.key,
              post,
              profilo,
              {
                puoEliminare:
                  true
              }
            )

        });


    } catch (
      errore
    ) {

      console.error(
        "Errore creazione post Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante la pubblicazione del post."
        });

    }

  }
);


// ============================================================
// ELIMINA POST
// Autore del post oppure amministratore
// ============================================================

app.delete(
  "/api/community/posts/:postId",

  limiteCommunityAzioni,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      if (
        !postId
      ) {

        return res
          .status(400)
          .json({
            errore:
              "ID post non valido."
          });

      }


      const riferimentoPost =
        db.ref(
          "community/posts/" +
          postId
        );


      const post =
        (
          await riferimentoPost
            .once(
              "value"
            )
        ).val();


      if (
        !post
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      if (
        post.uidAutore !==
          req.utente.uid
        &&
        profilo.ruolo !==
          "admin"
      ) {

        return res
          .status(403)
          .json({
            errore:
              "Non puoi eliminare questo post."
          });

      }


      const [
        snapshotReazioni,
        snapshotSalvati
      ] =
        await Promise.all([

          db
            .ref(
              "community/reazioni/" +
              postId
            )
            .once(
              "value"
            ),

          db
            .ref(
              "community/salvatiPost/" +
              postId
            )
            .once(
              "value"
            )

        ]);


      const aggiornamenti = {

        [
          "community/posts/" +
          postId
        ]:
          null,

        [
          "community/commenti/" +
          postId
        ]:
          null,

        [
          "community/reazioni/" +
          postId
        ]:
          null,

        [
          "community/condivisioni/" +
          postId
        ]:
          null,

        [
          "community/segnalazioni/" +
          postId
        ]:
          null,

        [
          "community/salvatiPost/" +
          postId
        ]:
          null

      };


      Object.keys(
        snapshotReazioni.val() ||
        {}
      ).forEach(
        uid => {

          aggiornamenti[
            `community/reazioniUtente/${uid}/${postId}`
          ] =
            null;

        }
      );


      Object.keys(
        snapshotSalvati.val() ||
        {}
      ).forEach(
        uid => {

          aggiornamenti[
            `community/salvati/${uid}/${postId}`
          ] =
            null;

        }
      );


      await db
        .ref()
        .update(
          aggiornamenti
        );


      res.json({
        ok:
          true
      });


    } catch (
      errore
    ) {

      console.error(
        "Errore eliminazione post Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante l'eliminazione del post."
        });

    }

  }
);


// ============================================================
// LIKE / TOGLI LIKE
// ============================================================

app.post(
  "/api/community/posts/:postId/reazione",

  limiteCommunityAzioni,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      const riferimentoPost =
        db.ref(
          "community/posts/" +
          postId
        );


      if (
        !(
          await riferimentoPost
            .once(
              "value"
            )
        ).exists()
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      const riferimentoLike =
        db.ref(
          `community/reazioni/${postId}/${req.utente.uid}`
        );


      const transazione =
        await riferimentoLike
          .transaction(
            valore =>
              valore === true
                ? null
                : true
          );


      const attiva =
        transazione
          .snapshot
          .val() ===
        true;


      await db
        .ref(
          `community/reazioniUtente/${req.utente.uid}/${postId}`
        )
        .set(
          attiva
            ? true
            : null
        );


      const conteggio =
        await communityAggiornaContatore(

          riferimentoPost.child(
            "conteggioReazioni"
          ),

          attiva
            ? 1
            : -1

        );


      res.json({

        ok:
          true,

        attiva,

        conteggio

      });


    } catch (
      errore
    ) {

      console.error(
        "Errore reazione Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante l'aggiornamento della reazione."
        });

    }

  }
);


// ============================================================
// SALVA / RIMUOVI POST SALVATO
// ============================================================

app.post(
  "/api/community/posts/:postId/salva",

  limiteCommunityAzioni,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      const esiste =
        (
          await db
            .ref(
              "community/posts/" +
              postId
            )
            .once(
              "value"
            )
        ).exists();


      if (
        !esiste
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      const riferimento =
        db.ref(
          `community/salvati/${req.utente.uid}/${postId}`
        );


      const transazione =
        await riferimento
          .transaction(
            valore =>
              valore === true
                ? null
                : true
          );


      const salvato =
        transazione
          .snapshot
          .val() ===
        true;


      await db
        .ref(
          `community/salvatiPost/${postId}/${req.utente.uid}`
        )
        .set(
          salvato
            ? true
            : null
        );


      res.json({

        ok:
          true,

        salvato

      });


    } catch (
      errore
    ) {

      console.error(
        "Errore salvataggio Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante il salvataggio del post."
        });

    }

  }
);


// ============================================================
// CARICA COMMENTI DI UN POST
// ============================================================

app.get(
  "/api/community/posts/:postId/commenti",

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const postId =
        communityId(
          req.params.postId
        );


      const postEsiste =
        (
          await db
            .ref(
              "community/posts/" +
              postId
            )
            .once(
              "value"
            )
        ).exists();


      if (
        !postEsiste
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      const token =
        verificaToken(
          estraiTokenHeader(req)
        );


      const mioUid =
        token?.uid ||
        null;


      const mioRuolo =
        token?.ruolo ||
        "utente";


      const snapshot =
        await db
          .ref(
            "community/commenti/" +
            postId
          )
          .orderByChild(
            "creatoIl"
          )
          .limitToLast(
            100
          )
          .once(
            "value"
          );


      const commenti =
        Object.entries(
          snapshot.val() ||
          {}
        )
          .map(
            ([id, commento]) => ({
              id,
              ...commento
            })
          )
          .sort(
            (a, b) =>
              Number(
                a.creatoIl ||
                0
              ) -
              Number(
                b.creatoIl ||
                0
              )
          );


      const autori =
        [
          ...new Set(
            commenti
              .map(
                commento =>
                  commento.uidAutore
              )
              .filter(
                Boolean
              )
          )
        ];


      const profili =
        {};


      await Promise.all(

        autori.map(

          async uid => {

            try {

              profili[uid] =
                await communityProfilo(
                  uid
                );

            } catch (
              errore
            ) {

              profili[uid] =
                null;

            }

          }

        )

      );


      res.json({

        commenti:
          commenti.map(
            commento => ({

              id:
                commento.id,

              uidAutore:
                commento.uidAutore ||
                null,

              nicknameAutore:
                profili[
                  commento.uidAutore
                ]?.nickname ||
                commento.nicknameAutore ||
                "Giocatore",

              avatarAutore:
                profili[
                  commento.uidAutore
                ]?.avatar ||
                null,

              testo:
                String(
                  commento.testo ||
                  ""
                ),

              creatoIl:
                Number(
                  commento.creatoIl ||
                  0
                ),

              puoEliminare:
                !!(
                  mioUid &&
                  (
                    commento.uidAutore ===
                      mioUid
                    ||
                    mioRuolo ===
                      "admin"
                  )
                )

            })
          )

      });


    } catch (
      errore
    ) {

      console.error(
        "Errore caricamento commenti Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante il caricamento dei commenti."
        });

    }

  }
);


// ============================================================
// CREA COMMENTO
// ============================================================

app.post(
  "/api/community/posts/:postId/commenti",

  limiteCommunityCommenti,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      const testo =
        pulisciTesto(
          req.body?.testo,
          600
        );


      if (
        !testo
      ) {

        return res
          .status(400)
          .json({
            errore:
              "Scrivi un commento prima di inviare."
          });

      }


      const riferimentoPost =
        db.ref(
          "community/posts/" +
          postId
        );


      const post =
        (
          await riferimentoPost
            .once(
              "value"
            )
        ).val();


      if (
        !post
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      const riferimentoCommento =
        db
          .ref(
            "community/commenti/" +
            postId
          )
          .push();


      const ora =
        Date.now();


      const commento = {

        uidAutore:
          req.utente.uid,

        nicknameAutore:
          profilo.nickname,

        testo,

        creatoIl:
          ora

      };


      await riferimentoCommento.set(
        commento
      );


      const conteggio =
        await communityAggiornaContatore(

          riferimentoPost.child(
            "conteggioCommenti"
          ),

          1

        );


      // Notifica l'autore del post.
      // Se la notifica fallisce, il commento rimane comunque valido.

      if (
        post.uidAutore &&
        post.uidAutore !==
          req.utente.uid
      ) {

        try {

          await db
            .ref(
              `utenti/${post.uidAutore}/notifiche`
            )
            .push({

              tipo:
                "commentoCommunity",

              testo:
                `${profilo.nickname} ha commentato il tuo post nella Community`,

              data:
                ora,

              letta:
                false,

              daUid:
                req.utente.uid,

              daNome:
                profilo.nickname,

              postId

            });


        } catch (
          erroreNotifica
        ) {

          console.warn(
            "Notifica commento Community non inviata:",
            erroreNotifica.message
          );

        }

      }


      res
        .status(201)
        .json({

          ok:
            true,

          conteggio,

          commento: {

            id:
              riferimentoCommento.key,

            uidAutore:
              req.utente.uid,

            nicknameAutore:
              profilo.nickname,

            avatarAutore:
              profilo.avatar,

            testo,

            creatoIl:
              ora,

            puoEliminare:
              true

          }

        });


    } catch (
      errore
    ) {

      console.error(
        "Errore nuovo commento Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante la pubblicazione del commento."
        });

    }

  }
);


// ============================================================
// ELIMINA COMMENTO
// ============================================================

app.delete(
  "/api/community/posts/:postId/commenti/:commentoId",

  limiteCommunityAzioni,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      const commentoId =
        communityId(
          req.params.commentoId
        );


      const riferimento =
        db.ref(
          `community/commenti/${postId}/${commentoId}`
        );


      const commento =
        (
          await riferimento
            .once(
              "value"
            )
        ).val();


      if (
        !commento
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Commento non trovato."
          });

      }


      if (
        commento.uidAutore !==
          req.utente.uid
        &&
        profilo.ruolo !==
          "admin"
      ) {

        return res
          .status(403)
          .json({
            errore:
              "Non puoi eliminare questo commento."
          });

      }


      await riferimento.remove();


      const conteggio =
        await communityAggiornaContatore(

          db.ref(
            `community/posts/${postId}/conteggioCommenti`
          ),

          -1

        );


      res.json({

        ok:
          true,

        conteggio

      });


    } catch (
      errore
    ) {

      console.error(
        "Errore eliminazione commento Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante l'eliminazione del commento."
        });

    }

  }
);


// ============================================================
// REGISTRA CONDIVISIONE
// Una condivisione conteggiata una sola volta per account
// ============================================================

app.post(
  "/api/community/posts/:postId/condivisione",

  limiteCommunityAzioni,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      const riferimentoPost =
        db.ref(
          "community/posts/" +
          postId
        );


      const post =
        (
          await riferimentoPost
            .once(
              "value"
            )
        ).val();


      if (
        !post
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      const riferimento =
        db.ref(
          `community/condivisioni/${postId}/${req.utente.uid}`
        );


      const giaCondiviso =
        (
          await riferimento
            .once(
              "value"
            )
        ).val() ===
        true;


      let conteggio =
        communityNumero(
          post.conteggioCondivisioni
        );


      if (
        !giaCondiviso
      ) {

        await riferimento.set(
          true
        );


        conteggio =
          await communityAggiornaContatore(

            riferimentoPost.child(
              "conteggioCondivisioni"
            ),

            1

          );

      }


      res.json({

        ok:
          true,

        conteggio

      });


    } catch (
      errore
    ) {

      console.error(
        "Errore condivisione Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante la registrazione della condivisione."
        });

    }

  }
);


// ============================================================
// SEGNALA POST
// ============================================================

app.post(
  "/api/community/posts/:postId/segnala",

  limiteCommunityAzioni,

  richiediAuth,

  async (req, res) => {

    if (!db) {

      return res
        .status(500)
        .json({
          errore:
            "Servizio Community non disponibile."
        });

    }


    try {

      const profilo =
        await communityUtenteScrittura(
          req,
          res
        );


      if (
        !profilo
      ) {
        return;
      }


      const postId =
        communityId(
          req.params.postId
        );


      const motivo =
        pulisciTesto(
          req.body?.motivo,
          300
        );


      if (
        !motivo
      ) {

        return res
          .status(400)
          .json({
            errore:
              "Inserisci il motivo della segnalazione."
          });

      }


      const post =
        (
          await db
            .ref(
              "community/posts/" +
              postId
            )
            .once(
              "value"
            )
        ).val();


      if (
        !post
      ) {

        return res
          .status(404)
          .json({
            errore:
              "Post non trovato."
          });

      }


      if (
        post.uidAutore ===
        req.utente.uid
      ) {

        return res
          .status(400)
          .json({
            errore:
              "Non puoi segnalare un tuo post."
          });

      }


      await db
        .ref(
          `community/segnalazioni/${postId}/${req.utente.uid}`
        )
        .set({

          uid:
            req.utente.uid,

          nickname:
            profilo.nickname,

          motivo,

          data:
            Date.now()

        });


      res.json({
        ok:
          true
      });


    } catch (
      errore
    ) {

      console.error(
        "Errore segnalazione Community:",
        errore
      );


      res
        .status(500)
        .json({
          errore:
            "Errore durante l'invio della segnalazione."
        });

    }

  }
);

app.post("/api/contatti", limiteContatti, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile al momento." });
  try {
    const { categoria, messaggio } = req.body;
    let { nickname, email } = req.body;
    if (!messaggio || !messaggio.trim()) return res.status(400).json({ errore: "Scrivi un messaggio prima di inviare." });
    const messaggioPulito = pulisciTesto(messaggio, 1000);
    const datiToken = verificaToken(estraiTokenHeader(req));
    let uidMittente = null;
    if (datiToken) {
      uidMittente = datiToken.uid;
      const utenteDb = (await db.ref("utenti/" + datiToken.uid).once("value")).val();
      if (utenteDb) { nickname = utenteDb.nickname; email = utenteDb.email; }
    }
    if (!nickname || !nickname.trim() || !email || !email.trim()) return res.status(400).json({ errore: "Nickname ed email sono obbligatori." });
    await db.ref("contatti").push().set({ nickname: nickname.trim(), email: email.trim(), categoria: categoria || "Altro", messaggio: messaggioPulito, uidMittente, letto: false, data: Date.now() });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore durante l'invio, riprova." }); }
});


// ===== UTENTI BLOCCATI =====
app.get("/api/blocchi", richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio blocchi non disponibile." });

  try {
    const mioUid = req.utente.uid;
    const tuttiBlocchi = (await db.ref("blocchi").once("value")).val() || {};
    const miei = tuttiBlocchi[mioUid] || {};
    const bloccatiDaMe = [];
    const interazioniBloccateUid = new Set(Object.keys(miei));

    for (const [uid, datiBlocco] of Object.entries(miei)) {
      const utente = (await db.ref(`utenti/${uid}`).once("value")).val();

      bloccatiDaMe.push({
        uid,
        nickname:
          utente && utente.nickname
            ? utente.nickname
            : (datiBlocco && datiBlocco.nickname) || "Utente",
        avatar: utente && utente.avatar ? utente.avatar : null,
        bloccatoIl: Number(datiBlocco && datiBlocco.bloccatoIl) || 0
      });
    }

    for (const [bloccanteUid, mappa] of Object.entries(tuttiBlocchi)) {
      if (
        bloccanteUid !== mioUid &&
        mappa &&
        mappa[mioUid]
      ) {
        interazioniBloccateUid.add(bloccanteUid);
      }
    }

    bloccatiDaMe.sort((a, b) => b.bloccatoIl - a.bloccatoIl);

    res.set("Cache-Control", "no-store");
    return res.json({
      bloccatiDaMe,
      interazioniBloccateUid: Array.from(interazioniBloccateUid)
    });
  } catch (err) {
    console.error("Errore GET /api/blocchi:", err);
    return res.status(500).json({
      errore: "Errore durante il caricamento degli utenti bloccati."
    });
  }
});

app.post("/api/blocchi", richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio blocchi non disponibile." });

  try {
    const mioUid = req.utente.uid;
    const utenteUid = pulisciTesto(
      String((req.body || {}).utenteUid || ""),
      128
    );

    if (!utenteUid) {
      return res.status(400).json({ errore: "Utente non valido." });
    }

    if (utenteUid === mioUid) {
      return res.status(400).json({ errore: "Non puoi bloccare te stesso." });
    }

    const altroUtente = (
      await db.ref(`utenti/${utenteUid}`).once("value")
    ).val();

    if (!altroUtente) {
      return res.status(404).json({ errore: "Utente non trovato." });
    }

    const ora = Date.now();

    await db.ref().update({
      [`blocchi/${mioUid}/${utenteUid}`]: {
        bloccatoIl: ora,
        nickname: altroUtente.nickname || "Utente"
      },

      // Il blocco interrompe sempre amicizia e richieste pendenti.
      [`utenti/${mioUid}/amici/${utenteUid}`]: null,
      [`utenti/${utenteUid}/amici/${mioUid}`]: null,
      [`utenti/${mioUid}/richiesteInviate/${utenteUid}`]: null,
      [`utenti/${mioUid}/richiesteRicevute/${utenteUid}`]: null,
      [`utenti/${utenteUid}/richiesteInviate/${mioUid}`]: null,
      [`utenti/${utenteUid}/richiesteRicevute/${mioUid}`]: null
    });

    invalidaCacheBlocco(mioUid, utenteUid);

    return res.json({
      ok: true,
      statoBlocco: "bloccato_da_me",
      bloccatoIl: ora
    });
  } catch (err) {
    console.error("Errore POST /api/blocchi:", err);
    return res.status(500).json({
      errore: "Errore durante il blocco dell'utente."
    });
  }
});

app.delete("/api/blocchi/:utenteUid", richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio blocchi non disponibile." });

  try {
    const mioUid = req.utente.uid;
    const utenteUid = pulisciTesto(String(req.params.utenteUid || ""), 128);

    if (!utenteUid || utenteUid === mioUid) {
      return res.status(400).json({ errore: "Utente non valido." });
    }

    const mioBlocco = db.ref(`blocchi/${mioUid}/${utenteUid}`);
    const snap = await mioBlocco.once("value");

    if (!snap.exists()) {
      return res.status(404).json({
        errore: "Non hai bloccato questo utente."
      });
    }

    await mioBlocco.remove();
    invalidaCacheBlocco(mioUid, utenteUid);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Errore DELETE /api/blocchi/:utenteUid:", err);
    return res.status(500).json({
      errore: "Errore durante lo sblocco dell'utente."
    });
  }
});


// ===== SEGNALAZIONI GIOCATORI =====
app.post("/api/segnalazioni", limiteSegnalazioni, richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio segnalazioni non disponibile." });

  try {
    const uidSegnalante = String(req.utente.uid || "");
    const uidSegnalato = pulisciTesto(String(req.body?.uidSegnalato || ""), 128);
    const categoria = pulisciTesto(String(req.body?.categoria || ""), 20);
    const descrizione = pulisciTesto(String(req.body?.descrizione || ""), 500);
    const categorieConsentite = new Set(["Chat", "Avatar", "Nickname"]);

    if (!uidSegnalato) return res.status(400).json({ errore: "Giocatore da segnalare non valido." });
    if (uidSegnalato === uidSegnalante) return res.status(400).json({ errore: "Non puoi segnalare il tuo stesso profilo." });
    if (!categorieConsentite.has(categoria)) return res.status(400).json({ errore: "Categoria di segnalazione non valida." });

    const [snapSegnalato, snapSegnalante] = await Promise.all([
      db.ref(`utenti/${uidSegnalato}`).once("value"),
      db.ref(`utenti/${uidSegnalante}`).once("value")
    ]);

    if (!snapSegnalato.exists()) return res.status(404).json({ errore: "Giocatore non trovato." });

    const utenteSegnalato = snapSegnalato.val() || {};
    const utenteSegnalante = snapSegnalante.val() || {};
    const ora = Date.now();

    // Per una segnalazione Chat viene congelata una copia dei log ancora
    // disponibili nel periodo di conservazione di 90 giorni.
    const logChat = categoria === "Chat"
      ? await leggiLogChatUltimi90Giorni(uidSegnalato)
      : [];

    const nuovaSegnalazione = db.ref("segnalazioni").push();
    await nuovaSegnalazione.set({
      id: nuovaSegnalazione.key,
      uidSegnalante,
      nicknameSegnalante: utenteSegnalante.nickname || req.utente.nickname || "Utente",
      uidSegnalato,
      nicknameSegnalato: utenteSegnalato.nickname || "Utente",
      avatarSegnalato: utenteSegnalato.avatar || null,
      categoria,
      descrizione,
      stato: "da_esaminare",
      data: ora,
      periodoLogGiorni: categoria === "Chat" ? 90 : null,
      numeroLogChat: logChat.length,
      logChat: categoria === "Chat" ? logChat : null
    });

    return res.json({
      ok: true,
      id: nuovaSegnalazione.key,
      logChatAllegati: categoria === "Chat" ? logChat.length : 0
    });
  } catch (errore) {
    console.error("Errore invio segnalazione giocatore:", errore);
    return res.status(500).json({ errore: "Errore durante l'invio della segnalazione." });
  }
});

// Consultazione staff delle segnalazioni giocatori.
app.get("/api/admin/segnalazioni", richiediAuth, richiediAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio segnalazioni non disponibile." });

  try {
    const snap = await db.ref("segnalazioni").once("value");
    const elenco = Object.values(snap.val() || {})
      .filter(Boolean)
      .sort((a, b) => Number(b.data || 0) - Number(a.data || 0));

    return res.json({ segnalazioni: elenco });
  } catch (errore) {
    console.error("Errore lettura segnalazioni admin:", errore);
    return res.status(500).json({ errore: "Errore durante il caricamento delle segnalazioni." });
  }
});

// ===== PROFILO PUBBLICO, STORICO =====
app.get("/api/profilo-pubblico/:nickname", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const utente = await trovaUtentePerNickname(pulisciTesto(req.params.nickname, 20).toLowerCase());
    if (!utente) return res.status(404).json({ errore: "Utente non trovato." });

    if (utente.elo == null) {
      utente.elo = ELO_INIZIALE;
      await db.ref("utenti/" + utente.uid).update({ elo: ELO_INIZIALE });
    }

    const giocate = utente.partiteGiocate || 0;
    const vinte = utente.partiteVinte || 0;
    const statoBlocco = await statoBloccoTra(req.utente.uid, utente.uid);
    const statoAmiciziaCorrente =
      statoBlocco === "nessuno"
        ? await statoAmicizia(req.utente.uid, utente.uid)
        : "nessuno";

    res.json({
      uid: utente.uid,
      nickname: utente.nickname,
      avatar: utente.avatar || null,
      creatoIl: utente.creatoIl || null,
      ultimoAccesso: utente.ultimoAccesso || null,
      partiteVinte: vinte,
      partiteGiocate: giocate,
      winRate: giocate > 0 ? Math.round((vinte / giocate) * 100) : 0,
      elo: ottieniElo(utente),
      streakVittorieMassima: utente.streakVittorieMassima || 0,
      vittoriaPiuVeloceSecondi: utente.vittoriaPiuVeloceSecondi ?? null,
      badge: calcolaBadge(utente),
      statoAmicizia: statoAmiciziaCorrente,
      statoBlocco
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server." });
  }
});

app.get("/api/storico", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    let uidFiltro = req.utente.uid, nicknameFiltro = req.utente.nickname;
    if (req.query.nickname) {
      const u = await trovaUtentePerNickname(pulisciTesto(req.query.nickname, 20).toLowerCase());
      if (!u) return res.status(404).json({ errore: "Utente non trovato." });
      uidFiltro = u.uid; nicknameFiltro = u.nickname;
    }
    const tutte = (await db.ref("storicoPartite").once("value")).val() || {};
    const partite = Object.values(tutte).filter(m => m.partecipanti && m.partecipanti.some(p => p.uid === uidFiltro)).sort((a, b) => b.data - a.data).slice(0, 50);
    res.json({ uid: uidFiltro, nickname: nicknameFiltro, partite });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server." }); }
});

// ===== MESSAGGI PRIVATI =====
app.get("/api/messaggi-privati/:altroUid", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    if (await sonoBloccatiTraLoro(req.utente.uid, req.params.altroUid)) {
      return res.status(403).json({
        errore: "Non puoi scambiare messaggi privati con questo utente."
      });
    }

    const idConv = idConversazione(req.utente.uid, req.params.altroUid);
    const messaggi = (await db.ref("messaggiPrivati/" + idConv).once("value")).val() || {};
    const lista = Object.entries(messaggi).map(([id, m]) => ({ id, ...m })).sort((a, b) => a.data - b.data);
    const aggiornamenti = {};
    Object.entries(messaggi).forEach(([id, m]) => { if (m.aUid === req.utente.uid && !m.letto) aggiornamenti[id + "/letto"] = true; });
    if (Object.keys(aggiornamenti).length) await db.ref("messaggiPrivati/" + idConv).update(aggiornamenti);
    res.json({ messaggi: lista });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server." }); }
});

app.post("/api/messaggi-privati", limiteMessaggiPrivati, richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { destinatarioUid, testo } = req.body;
    if (!destinatarioUid || !testo || !testo.trim()) return res.status(400).json({ errore: "Dati mancanti." });
    if (destinatarioUid === req.utente.uid) return res.status(400).json({ errore: "Non puoi scrivere a te stesso." });
    if (await sonoBloccatiTraLoro(req.utente.uid, destinatarioUid)) {
      return res.status(403).json({
        errore: "Non puoi scambiare messaggi privati con questo utente."
      });
    }
    const testoPulito = pulisciTesto(testo, 500);
    if (!testoPulito) return res.status(400).json({ errore: "Messaggio vuoto." });
    const mittente = (await db.ref("utenti/" + req.utente.uid).once("value")).val();
    const destinatario = (await db.ref("utenti/" + destinatarioUid).once("value")).val();
    if (!mittente || !destinatario) return res.status(404).json({ errore: "Utente non trovato." });
    const idConv = idConversazione(req.utente.uid, destinatarioUid);
    const nuovoRef = db.ref("messaggiPrivati/" + idConv).push();
    const messaggio = { daUid: req.utente.uid, daNome: mittente.nickname, aUid: destinatarioUid, aNome: destinatario.nickname, testo: testoPulito, data: Date.now(), letto: false };
    await nuovoRef.set(messaggio);
    res.json({ ok: true, messaggio: { id: nuovoRef.key, ...messaggio } });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore durante l'invio, riprova." }); }
});

app.get("/api/conversazioni", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });

  try {
    const [snapMessaggi, snapBlocchi] = await Promise.all([
      db.ref("messaggiPrivati").once("value"),
      db.ref("blocchi").once("value")
    ]);

    const tutte = snapMessaggi.val() || {};
    const blocchi = snapBlocchi.val() || {};
    const mioUid = req.utente.uid;
    const conversazioni = {};

    const coppiaBloccata = altroUid => Boolean(
      (blocchi[mioUid] && blocchi[mioUid][altroUid]) ||
      (blocchi[altroUid] && blocchi[altroUid][mioUid])
    );

    Object.entries(tutte).forEach(([idConv, messaggi]) => {
      if (!idConv.split("_").includes(mioUid)) return;

      const lista = Object.values(messaggi || {});
      if (!lista.length) return;

      const ultimo = [...lista].sort((a, b) => b.data - a.data)[0];
      const altroUid = ultimo.daUid === mioUid ? ultimo.aUid : ultimo.daUid;

      if (coppiaBloccata(altroUid)) return;

      const altroNome = ultimo.daUid === mioUid ? ultimo.aNome : ultimo.daNome;

      conversazioni[altroUid] = {
        altroUid,
        altroNome,
        ultimoTesto: ultimo.testo,
        ultimaData: ultimo.data,
        nonLetti: lista.filter(m => m.aUid === mioUid && !m.letto).length
      };
    });

    return res.json({
      conversazioni: Object.values(conversazioni)
        .sort((a, b) => b.ultimaData - a.ultimaData)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ errore: "Errore del server." });
  }
});

// ===== AMICI =====
app.post("/api/amici/richiedi", limiteAmici, richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { destinatarioUid } = req.body;
    if (!destinatarioUid) return res.status(400).json({ errore: "Dati mancanti." });
    if (destinatarioUid === req.utente.uid) return res.status(400).json({ errore: "Non puoi inviare una richiesta a te stesso." });
    if (await sonoBloccatiTraLoro(req.utente.uid, destinatarioUid)) {
      return res.status(403).json({
        errore: "Non puoi inviare una richiesta di amicizia a un utente bloccato."
      });
    }
    const destinatario = (await db.ref("utenti/" + destinatarioUid).once("value")).val();
    if (!destinatario) return res.status(404).json({ errore: "Utente non trovato." });
    const stato = await statoAmicizia(req.utente.uid, destinatarioUid);
    if (stato === "amici") return res.status(400).json({ errore: "Siete già amici." });
    if (stato === "richiesta_inviata") return res.json({ ok: true });
    if (stato === "richiesta_ricevuta") return res.status(400).json({ errore: "Questo utente ti ha già inviato una richiesta: accettala dal suo profilo." });
    const mioNickname = req.utente.nickname, ora = Date.now();
    await db.ref().update({
      [`utenti/${req.utente.uid}/richiesteInviate/${destinatarioUid}`]: { aNome: destinatario.nickname, data: ora },
      [`utenti/${destinatarioUid}/richiesteRicevute/${req.utente.uid}`]: { daNome: mioNickname, data: ora }
    });
    await db.ref("utenti/" + destinatarioUid + "/notifiche").push({ tipo: "richiestaAmicizia", testo: `${mioNickname} ti ha inviato una richiesta di amicizia`, data: ora, letta: false, daUid: req.utente.uid, daNome: mioNickname });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.post("/api/amici/accetta", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { daUid } = req.body;
    if (!daUid) return res.status(400).json({ errore: "Dati mancanti." });
    if (await sonoBloccatiTraLoro(req.utente.uid, daUid)) {
      return res.status(403).json({
        errore: "Non puoi accettare l'amicizia con un utente bloccato."
      });
    }
    if (!(await db.ref("utenti/" + req.utente.uid + "/richiesteRicevute/" + daUid).once("value")).exists()) return res.status(400).json({ errore: "Nessuna richiesta da questo utente." });
    const mioNickname = req.utente.nickname;
    await db.ref().update({
      [`utenti/${req.utente.uid}/richiesteRicevute/${daUid}`]: null, [`utenti/${daUid}/richiesteInviate/${req.utente.uid}`]: null,
      [`utenti/${req.utente.uid}/amici/${daUid}`]: true, [`utenti/${daUid}/amici/${req.utente.uid}`]: true
    });
    await db.ref("utenti/" + daUid + "/notifiche").push({ tipo: "amiciziaAccettata", testo: `${mioNickname} ha accettato la tua richiesta di amicizia`, data: Date.now(), letta: false });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.post("/api/amici/rifiuta", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { daUid } = req.body;
    if (!daUid) return res.status(400).json({ errore: "Dati mancanti." });
    await db.ref().update({ [`utenti/${req.utente.uid}/richiesteRicevute/${daUid}`]: null, [`utenti/${daUid}/richiesteInviate/${req.utente.uid}`]: null });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.post("/api/amici/rimuovi", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const { altroUid } = req.body;
    if (!altroUid) return res.status(400).json({ errore: "Dati mancanti." });
    await db.ref().update({ [`utenti/${req.utente.uid}/amici/${altroUid}`]: null, [`utenti/${altroUid}/amici/${req.utente.uid}`]: null });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server, riprova." }); }
});

app.get("/api/amici", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const uids = Object.keys((await db.ref("utenti/" + req.utente.uid + "/amici").once("value")).val() || {});
    const amici = await Promise.all(uids.map(async (uidAmico) => {
      const u = (await db.ref("utenti/" + uidAmico).once("value")).val();
      return u ? { uid: uidAmico, nickname: u.nickname, avatar: u.avatar || null } : null;
    }));
    res.json({ amici: amici.filter(Boolean) });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server." }); }
});

// ===== NOTIFICHE =====
app.get("/api/notifiche", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const lista = Object.entries((await db.ref("utenti/" + req.utente.uid + "/notifiche").once("value")).val() || {}).map(([id, n]) => ({ id, ...n })).sort((a, b) => b.data - a.data).slice(0, 30);
    res.json({ notifiche: lista, nonLette: lista.filter(n => !n.letta).length });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server." }); }
});

app.post("/api/notifiche/segna-lette", richiediAuth, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio non disponibile." });
  try {
    const tutte = (await db.ref("utenti/" + req.utente.uid + "/notifiche").once("value")).val() || {};
    const aggiornamenti = {};
    Object.keys(tutte).forEach(id => { if (!tutte[id].letta) aggiornamenti[id + "/letta"] = true; });
    if (Object.keys(aggiornamenti).length) await db.ref("utenti/" + req.utente.uid + "/notifiche").update(aggiornamenti);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ errore: "Errore del server." }); }
});

// ===== AVVISI PUBBLICI DELLA PIATTAFORMA =====
const TIPI_AVVISO_PIATTAFORMA = new Set([
  "Informazione",
  "Aggiornamento",
  "Importante",
  "Manutenzione",
  "Novità"
]);

app.get("/api/avvisi", async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio avvisi non disponibile." });

  try {
    const valore = (await db.ref("avvisiPiattaforma").once("value")).val() || {};
    const avvisi = Object.entries(valore)
      .map(([id, avviso]) => ({ id, ...(avviso || {}) }))
      .sort((a, b) => Number(b.data || 0) - Number(a.data || 0));

    res.set("Cache-Control", "no-store");
    return res.json({ avvisi });
  } catch (errore) {
    console.error("Errore GET /api/avvisi:", errore);
    return res.status(500).json({ errore: "Errore durante il caricamento degli avvisi." });
  }
});

function contaAvvisiNonLetti(valoreAvvisi, ultimoLettoIl) {
  const ultimoLetto = Math.max(0, Number(ultimoLettoIl) || 0);
  return Object.values(valoreAvvisi || {}).reduce((totale, avviso) => {
    const data = Number(avviso && avviso.data) || 0;
    return totale + (data > ultimoLetto ? 1 : 0);
  }, 0);
}

app.get("/api/avvisi/non-letti", richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio avvisi non disponibile." });

  try {
    const [snapAvvisi, snapUltimoLetto] = await Promise.all([
      db.ref("avvisiPiattaforma").once("value"),
      db.ref(`utenti/${req.utente.uid}/ultimoAvvisoPiattaformaLettoIl`).once("value")
    ]);

    const valoreAvvisi = snapAvvisi.val() || {};
    const ultimoLettoIl = Math.max(0, Number(snapUltimoLetto.val()) || 0);
    const ultimoAvvisoIl = Object.values(valoreAvvisi).reduce(
      (massimo, avviso) => Math.max(massimo, Number(avviso && avviso.data) || 0),
      0
    );

    res.set("Cache-Control", "no-store");
    return res.json({
      nonLetti: contaAvvisiNonLetti(valoreAvvisi, ultimoLettoIl),
      ultimoLettoIl,
      ultimoAvvisoIl
    });
  } catch (errore) {
    console.error("Errore GET /api/avvisi/non-letti:", errore);
    return res.status(500).json({ errore: "Errore durante il conteggio degli avvisi non letti." });
  }
});

app.post("/api/avvisi/segna-letti", richiediAuth, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio avvisi non disponibile." });

  try {
    const [snapAvvisi, snapUltimoLetto] = await Promise.all([
      db.ref("avvisiPiattaforma").once("value"),
      db.ref(`utenti/${req.utente.uid}/ultimoAvvisoPiattaformaLettoIl`).once("value")
    ]);

    const valoreAvvisi = snapAvvisi.val() || {};
    const ultimoDisponibileIl = Object.values(valoreAvvisi).reduce(
      (massimo, avviso) => Math.max(massimo, Number(avviso && avviso.data) || 0),
      0
    );

    const finoARichiesto = Number(req.body && req.body.finoA);
    let nuovoUltimoLettoIl;

    if (ultimoDisponibileIl > 0) {
      nuovoUltimoLettoIl = Number.isFinite(finoARichiesto) && finoARichiesto > 0
        ? Math.min(Math.floor(finoARichiesto), ultimoDisponibileIl)
        : ultimoDisponibileIl;
    } else {
      // Se non esistono ancora avvisi, inizializziamo il marcatore a ora:
      // il primo avviso futuro risulterà comunque non letto.
      nuovoUltimoLettoIl = Date.now();
    }

    const ultimoGiaLettoIl = Math.max(0, Number(snapUltimoLetto.val()) || 0);
    nuovoUltimoLettoIl = Math.max(ultimoGiaLettoIl, nuovoUltimoLettoIl);

    await db
      .ref(`utenti/${req.utente.uid}/ultimoAvvisoPiattaformaLettoIl`)
      .set(nuovoUltimoLettoIl);

    return res.json({
      ok: true,
      ultimoLettoIl: nuovoUltimoLettoIl,
      nonLetti: contaAvvisiNonLetti(valoreAvvisi, nuovoUltimoLettoIl)
    });
  } catch (errore) {
    console.error("Errore POST /api/avvisi/segna-letti:", errore);
    return res.status(500).json({ errore: "Errore durante l'aggiornamento degli avvisi letti." });
  }
});

app.post("/api/admin/avvisi", richiediAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio avvisi non disponibile." });

  try {
    const titolo = pulisciTesto(req.body && req.body.titolo, 120);
    const messaggio = pulisciTesto(req.body && req.body.messaggio, 2000);
    const tipo = pulisciTesto(req.body && req.body.tipo, 30) || "Informazione";

    if (!titolo) return res.status(400).json({ errore: "Inserisci un titolo." });
    if (!messaggio) return res.status(400).json({ errore: "Inserisci il testo dell'avviso." });
    if (!TIPI_AVVISO_PIATTAFORMA.has(tipo)) {
      return res.status(400).json({ errore: "Tipo di avviso non valido." });
    }

    const data = Date.now();
    const nuovoRef = db.ref("avvisiPiattaforma").push();
    const avviso = {
      titolo,
      tipo,
      messaggio,
      data,
      pubblicatoDa: req.utenteAdmin.nickname || "Staff",
      pubblicatoDaUid: req.utenteAdmin.uid
    };

    await nuovoRef.set(avviso);
    return res.status(201).json({ ok: true, avviso: { id: nuovoRef.key, ...avviso } });
  } catch (errore) {
    console.error("Errore POST /api/admin/avvisi:", errore);
    return res.status(500).json({ errore: "Errore durante la pubblicazione dell'avviso." });
  }
});

app.delete("/api/admin/avvisi/:id", richiediAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Servizio avvisi non disponibile." });

  try {
    const id = String(req.params.id || "").trim();
    if (!id || id.length > 128 || /[.#$\[\]\/]/.test(id)) {
      return res.status(400).json({ errore: "Avviso non valido." });
    }

    const ref = db.ref("avvisiPiattaforma/" + id);
    const snap = await ref.once("value");
    if (!snap.exists()) return res.status(404).json({ errore: "Avviso non trovato." });

    await ref.remove();
    return res.json({ ok: true, id });
  } catch (errore) {
    console.error("Errore DELETE /api/admin/avvisi/:id:", errore);
    return res.status(500).json({ errore: "Errore durante l'eliminazione dell'avviso." });
  }
});

// ===== API ADMIN =====
app.get("/api/admin/utenti", richiediAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Database non disponibile." });
  const val = (await db.ref("utenti").once("value")).val() || {};
  res.json({ utenti: Object.keys(val).map(uid => ({ uid, email: val[uid].email, nickname: val[uid].nickname, stato: val[uid].stato, sospesoFino: val[uid].sospesoFino, avvisi: val[uid].avvisi || [], ruolo: val[uid].ruolo || "utente" })) });
});
app.post("/api/admin/avviso", richiediAdmin, async (req, res) => {
  if (!db) return res.status(503).json({ errore: "Database non disponibile." });
  try {
    const uid = String(req.body && req.body.uid || "").trim();
    const motivo = pulisciTesto(req.body && req.body.motivo, 1000);
    if (!uid || !motivo) return res.status(400).json({ errore: "Dati mancanti." });

    const utenteSnap = await db.ref("utenti/" + uid).once("value");
    if (!utenteSnap.exists()) return res.status(404).json({ errore: "Utente non trovato." });

    const ref = db.ref("utenti/" + uid + "/avvisi");
    const avvisiAttuali = (await ref.once("value")).val() || [];
    const lista = Array.isArray(avvisiAttuali) ? avvisiAttuali : Object.values(avvisiAttuali);
    lista.push({ data: Date.now(), motivo });
    await ref.set(lista);
    await db.ref("utenti/" + uid + "/notifiche").push({
      tipo: "avviso",
      testo: "Hai ricevuto un avviso dallo staff",
      data: Date.now(),
      letta: false
    });
    return res.json({ ok: true });
  } catch (errore) {
    console.error("Errore POST /api/admin/avviso:", errore);
    return res.status(500).json({ errore: "Errore durante l'invio dell'avviso all'utente." });
  }
});
app.post("/api/admin/sospendi", richiediAdmin, async (req, res) => {
  const { uid, giorni, motivo } = req.body;
  if (!uid || !giorni) return res.status(400).json({ errore: "Dati mancanti." });
  if (uid === req.utenteAdmin.uid) return res.status(400).json({ errore: "Non puoi sospendere il tuo stesso account." });
  await db.ref("utenti/" + uid).update({ stato: "sospeso", sospesoFino: Date.now() + (parseInt(giorni) * 24 * 60 * 60 * 1000), motivoSospensione: motivo || "" });
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

// ===== DADI: PRIMO TIRO REALE LOCALE, POI RANDOM.ORG =====
const randomOrgAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 4
});

function attendiRandomOrg(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tiraDadoRandomOrg(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const url =
      "https://www.random.org/integers/" +
      "?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";

    let conclusa = false;

    const termina = valore => {
      if (conclusa) return;
      conclusa = true;
      resolve(valore);
    };

    const richiesta = https.get(
      url,
      {
        timeout: timeoutMs,
        agent: randomOrgAgent,
        headers: {
          "Accept": "text/plain",
          "Cache-Control": "no-cache",
          "User-Agent": "Giochi-Societa/1.0"
        }
      },
      res => {
        let dati = "";

        if (res.statusCode !== 200) {
          res.resume();
          termina(null);
          return;
        }

        res.setEncoding("utf8");

        res.on("data", chunk => {
          // La risposta attesa contiene solo due numeri: limitiamo comunque
          // quanto accumuliamo per evitare risposte anomale.
          if (dati.length < 128) dati += chunk;
        });

        res.on("end", () => {
          const numeri = dati
            .trim()
            .split(/\s+/)
            .map(valore => Number.parseInt(valore, 10))
            .filter(valore => Number.isInteger(valore) && valore >= 1 && valore <= 6);

          if (numeri.length !== 2) {
            termina(null);
            return;
          }

          termina({
            dado1: numeri[0],
            dado2: numeri[1]
          });
        });

        res.on("error", () => termina(null));
      }
    );

    richiesta.on("timeout", () => {
      richiesta.destroy();
      termina(null);
    });

    richiesta.on("error", () => termina(null));
  });
}

// Dal secondo tiro reale del giocatore, RANDOM.ORG resta l'unica fonte.
// Se per un problema di rete non risponde, il tiro fallisce e il giocatore può
// riprovare senza che venga alterata la posizione.
async function lanciaDueDadiSicuri() {
  const NUMERO_TENTATIVI = 3;

  for (let tentativo = 1; tentativo <= NUMERO_TENTATIVI; tentativo++) {
    const risultato = await tiraDadoRandomOrg(2500);

    if (
      risultato &&
      Number.isInteger(risultato.dado1) &&
      Number.isInteger(risultato.dado2) &&
      risultato.dado1 >= 1 &&
      risultato.dado1 <= 6 &&
      risultato.dado2 >= 1 &&
      risultato.dado2 <= 6
    ) {
      return risultato;
    }

    if (tentativo < NUMERO_TENTATIVI) {
      await attendiRandomOrg(120 * tentativo);
    }
  }

  throw new Error(
    "RANDOM.ORG non raggiungibile: nessun risultato dei dadi è stato generato."
  );
}

// Le 32 coppie ordinate possibili con due dadi, escluso il totale 9.
// La scelta di una coppia intera mantiene la stessa probabilità per ogni coppia
// consentita ed evita qualsiasi ciclo di rigenerazione.
const COPPIE_PRIMO_TIRO_SENZA_NOVE = [];
for (let dado1 = 1; dado1 <= 6; dado1++) {
  for (let dado2 = 1; dado2 <= 6; dado2++) {
    if (dado1 + dado2 !== 9) COPPIE_PRIMO_TIRO_SENZA_NOVE.push([dado1, dado2]);
  }
}

function lanciaDueDadiPrimoTiroLocale() {
  const indice = Math.floor(Math.random() * COPPIE_PRIMO_TIRO_SENZA_NOVE.length);
  const [dado1, dado2] = COPPIE_PRIMO_TIRO_SENZA_NOVE[indice];
  return { dado1, dado2 };
}

function numeroTiriRealiEffettuati(giocatore) {
  const valoreSalvato = Number(giocatore && giocatore.tiriRealiEffettuati);
  if (Number.isInteger(valoreSalvato) && valoreSalvato >= 0) return valoreSalvato;

  // Compatibilità con partite già salvate prima dell'introduzione del contatore:
  // una pedina oltre la partenza ha certamente già effettuato almeno un tiro.
  const posizione = Number(giocatore && giocatore.posizione);
  return Number.isFinite(posizione) && posizione > 0 ? 1 : 0;
}

async function lanciaDueDadiPerGiocatore(giocatore) {
  if (numeroTiriRealiEffettuati(giocatore) === 0) {
    return lanciaDueDadiPrimoTiroLocale();
  }
  return lanciaDueDadiSicuri();
}

// ===== LOGICA DI GIOCO =====
const CASELLE_AVANZA_ANCORA = [9, 18, 27, 36, 45, 54];
const CASELLE_SALTA_TRE_TURNI = [19, 31];
const CASELLE_SALTA_UN_TURNO = [52];
const CASELLE_TORNA_A = { 42: 38, 50: 1, 58: 1 };
const CASELLA_TIRA_ANCORA = 6;
const CASELLA_VITTORIA = 63;

let stanze = { BAR: { giocatoriOnline: {}, partite: {} }, PUB: { giocatoriOnline: {}, partite: {} }, DISCOPUB: { giocatoriOnline: {}, partite: {} }, SERATE: { giocatoriOnline: {}, partite: {} } };

async function ripristinaPartiteDaFirebase() {
  const partiteFirebase = await caricaPartite();
  for (const id in partiteFirebase) {
    const p = partiteFirebase[id];
    if (!stanze[p.stanza]) continue;

    stanze[p.stanza].partite[id] = {
      ...p,
      maxGiocatori: p.maxGiocatori || (Object.keys(p.giocatori || {}).length || 2),
      chatAttiva: p.chatAttiva !== false,
      mediaAttiva: p.mediaAttiva === true,
      giocatori: p.giocatori || {},
      ordineGiocatori: p.ordineGiocatori || [],
      turnoAttuale: p.turnoAttuale || 0,
      iniziata: p.iniziata === true,
      iniziataIl: p.iniziataIl || null,
      tiriEffettuatiNelTurno: Number(p.tiriEffettuatiNelTurno || 0),
      tiriConsentitiNelTurno: Number(p.tiriConsentitiNelTurno || 1),
      tempoInizioTurno: p.tempoInizioTurno || null,
      scadenzaTurno: p.scadenzaTurno || null,
      elaborandoTiro: false,
      animazioneTiroInCorso: false,
      invitati: {},
      timerTurno: null,
      punteggiOrdineIniziale: p.punteggiOrdineIniziale || null,
      ordineDeterminazione: Array.isArray(p.ordineDeterminazione) ? p.ordineDeterminazione : [],
      risultatiDeterminazione: p.risultatiDeterminazione && typeof p.risultatiDeterminazione === "object" ? p.risultatiDeterminazione : {},
      codaDeterminazione: Array.isArray(p.codaDeterminazione) ? p.codaDeterminazione : [],
      turnoInCorsoDeterminazione: p.turnoInCorsoDeterminazione || null,
      gruppoSpareggioAttuale: Array.isArray(p.gruppoSpareggioAttuale) ? p.gruppoSpareggioAttuale : null,
      coppieAudioApprovate: new Set(),
      partecipantiMediaPronti: new Set(),
      partecipantiMediaInfo: new Map(),
      fase: p.fase || (p.iniziata === true ? "in_corso" : "attesa_giocatori")
    };

    const partitaRipristinata = stanze[p.stanza].partite[id];

    if (partitaRipristinata.iniziata) {
      partitaRipristinata.fase = "in_corso";
      ripristinaTimerTurno(partitaRipristinata, p.stanza);
    } else if (partitaRipristinata.fase === "determinazione_ordine") {
      await riprendiFaseDeterminazioneRipristinata(partitaRipristinata, p.stanza);
    } else if (Object.keys(partitaRipristinata.giocatori).length === partitaRipristinata.maxGiocatori) {
      await iniziaFaseDeterminazione(partitaRipristinata, p.stanza);
    }
  }
  console.log("Partite ripristinate da Firebase:", Object.keys(partiteFirebase).length);
}

let contatoreId = 0;
const socketsPerId = {};

function calcolaMovimento(posizioneAttuale, valoreDado) {
  // Converte esplicitamente i valori in numeri: in questo modo anche una
  // posizione ripristinata da Firebase come stringa non può causare
  // concatenazioni o spostamenti errati.
  const posizioneBase = Number(posizioneAttuale);
  const passiDado = Number(valoreDado);

  if (
    !Number.isInteger(posizioneBase) ||
    posizioneBase < 0 ||
    posizioneBase > CASELLA_VITTORIA
  ) {
    throw new Error("Posizione giocatore non valida: " + posizioneAttuale);
  }

  if (
    !Number.isInteger(passiDado) ||
    passiDado < 1 ||
    passiDado > 12
  ) {
    throw new Error("Valore dei dadi non valido: " + valoreDado);
  }

  const percorso = [];
  const messaggi = [];
  const effettiCasella = [];
  let nuovaPosizione = posizioneBase + passiDado;
  let turniDaSaltare = 0;
  let vittoria = false;
  let tiraAncora = false;

  function aggiungiEffetto(tipo, casella, percorsoIndex, titolo, testo, destinazione = null, icona = "✨") {
    effettiCasella.push({
      tipo,
      casella,
      destinazione,
      percorsoIndex,
      titolo,
      testo,
      icona,
      durataMs: 900
    });
  }

  // Movimento normale: parte SEMPRE dalla casella successiva.
  // Quindi, per esempio, da 0 con totale 3 il percorso è [1, 2, 3]:
  // esattamente tre caselle, mai quattro.
  if (nuovaPosizione > CASELLA_VITTORIA) {
    for (let p = posizioneBase + 1; p <= CASELLA_VITTORIA; p++) {
      percorso.push(p);
    }

    const eccesso = nuovaPosizione - CASELLA_VITTORIA;
    nuovaPosizione = CASELLA_VITTORIA - eccesso;

    for (let p = CASELLA_VITTORIA - 1; p >= nuovaPosizione; p--) {
      percorso.push(p);
    }

    messaggi.push("Hai superato il traguardo, rimbalzi indietro!");
    aggiungiEffetto(
      "rimbalzo",
      CASELLA_VITTORIA,
      percorso.indexOf(CASELLA_VITTORIA),
      "Rimbalzo!",
      "Hai superato il traguardo: torni indietro.",
      nuovaPosizione,
      "↩️"
    );
  } else {
    for (let p = posizioneBase + 1; p <= nuovaPosizione; p++) {
      percorso.push(p);
    }
  }

  if (nuovaPosizione === CASELLA_VITTORIA) {
    vittoria = true;
    messaggi.push("🎉 Hai vinto!");
    return {
      nuovaPosizione,
      percorso,
      messaggi,
      effettiCasella,
      turniDaSaltare,
      vittoria,
      tiraAncora
    };
  }

  if (nuovaPosizione === CASELLA_TIRA_ANCORA) {
    tiraAncora = true;
    messaggi.push("Sali sul ponte! Tira ancora i dadi.");
    aggiungiEffetto(
      "tira_ancora",
      nuovaPosizione,
      percorso.length - 1,
      "Tira ancora!",
      "Il ponte ti concede subito un altro tiro.",
      null,
      "🌉"
    );
  }

  // Regola speciale del Gioco dell'Oca: sulle caselle dell'Oca si avanza
  // nuovamente dello STESSO totale. Questo è l'unico caso in cui il percorso
  // può contenere più passi del totale dei dadi, oltre ai teletrasporti/rimbalzi.
  if (CASELLE_AVANZA_ANCORA.includes(nuovaPosizione)) {
    messaggi.push("Avanzi dello stesso numero di caselle!");
    aggiungiEffetto(
      "doppio_movimento",
      nuovaPosizione,
      percorso.length - 1,
      "Doppio movimento!",
      "Avanzi ancora dello stesso numero ottenuto con i dadi.",
      null,
      "🪿"
    );

    const seguito = calcolaMovimento(nuovaPosizione, passiDado);
    const offsetPercorsoSeguito = percorso.length;
    const effettiSeguito = (seguito.effettiCasella || []).map(effetto => ({
      ...effetto,
      percorsoIndex: effetto.percorsoIndex + offsetPercorsoSeguito
    }));

    return {
      nuovaPosizione: seguito.nuovaPosizione,
      percorso: percorso.concat(seguito.percorso),
      messaggi: messaggi.concat(seguito.messaggi),
      effettiCasella: effettiCasella.concat(effettiSeguito),
      turniDaSaltare: seguito.turniDaSaltare,
      vittoria: seguito.vittoria,
      tiraAncora: seguito.tiraAncora
    };
  }

  if (CASELLE_SALTA_TRE_TURNI.includes(nuovaPosizione)) {
    turniDaSaltare = 3;
    messaggi.push("Rimani fermo per 3 turni!");
    aggiungiEffetto(
      "fermo_tre_turni",
      nuovaPosizione,
      percorso.length - 1,
      "Stai fermo!",
      "Dovrai saltare i prossimi 3 turni.",
      null,
      "⏳"
    );
  }

  if (CASELLE_SALTA_UN_TURNO.includes(nuovaPosizione)) {
    turniDaSaltare = 1;
    messaggi.push("Salti un turno!");
    aggiungiEffetto(
      "fermo_un_turno",
      nuovaPosizione,
      percorso.length - 1,
      "Turno saltato!",
      "Dovrai restare fermo per un turno.",
      null,
      "⏸️"
    );
  }

  if (CASELLE_TORNA_A[nuovaPosizione] !== undefined) {
    const destinazione = CASELLE_TORNA_A[nuovaPosizione];
    messaggi.push(`Torni alla casella ${destinazione}!`);
    aggiungiEffetto(
      "torna_indietro",
      nuovaPosizione,
      percorso.length - 1,
      "Torna indietro!",
      `La casella ti riporta al numero ${destinazione}.`,
      destinazione,
      "⬅️"
    );
    percorso.push(destinazione);
    nuovaPosizione = destinazione;
  }

  return {
    nuovaPosizione,
    percorso,
    messaggi,
    effettiCasella,
    turniDaSaltare,
    vittoria,
    tiraAncora
  };
}

function passaAlProssimoTurno(partita) {
  const numeroGiocatori = partita.ordineGiocatori.length;
  if (numeroGiocatori <= 1) return;
  const indiceDiPartenza = partita.turnoAttuale;

  for (let i = 1; i < numeroGiocatori; i++) {
    const indice = (indiceDiPartenza + i) % numeroGiocatori;
    const idGiocatore = partita.ordineGiocatori[indice];
    const giocatore = partita.giocatori[idGiocatore];
    if (!giocatore) continue;
    if ((giocatore.turniSaltati || 0) > 0) { giocatore.turniSaltati--; continue; }
    partita.turnoAttuale = indice;
    partita.tiriEffettuatiNelTurno = 0;
    partita.tiriConsentitiNelTurno = 1;
    return;
  }
  partita.turnoAttuale = indiceDiPartenza;
  partita.tiriEffettuatiNelTurno = 0;
  partita.tiriConsentitiNelTurno = 1;
}

function trovaPartita(partitaId) {
  for (const nomeStanza in stanze) {
    if (stanze[nomeStanza].partite[partitaId]) return { partita: stanze[nomeStanza].partite[partitaId], nomeStanza };
  }
  return null;
}

function trovaPartitaAttivaPerUid(uid) {
  for (const nomeStanza in stanze) {
    for (const pid in stanze[nomeStanza].partite) {
      const p = stanze[nomeStanza].partite[pid];
      if (p.giocatori[uid]) return { partitaId: pid, stanza: nomeStanza, mediaAttiva: p.mediaAttiva === true };
    }
  }
  return null;
}

function calcolaUidInPartita(nomeStanza) {
  const uidInPartita = new Set();
  if (!stanze[nomeStanza]) return uidInPartita;

  // Partite ancora presenti sul server.
  Object.values(stanze[nomeStanza].partite || {}).forEach(partita => {
    if (!partita || partita.iniziata !== true) return;
    Object.keys(partita.giocatori || {}).forEach(uid => uidInPartita.add(uid));
  });

  // Se la partita è appena terminata, il tavolo può essere già stato rimosso.
  // Finché però il WebSocket della pagina gioco è ancora aperto, l'utente deve
  // continuare a risultare "In partita". Passerà a "In Lobby" solo quando
  // lascia davvero gioco.html (ad esempio premendo "Torna alla Lobby").
  Object.values(stanze[nomeStanza].giocatoriOnline || {}).forEach(presenza => {
    if (presenza && presenza.uid && presenza.schermataPartita === true) {
      uidInPartita.add(presenza.uid);
    }
  });

  return uidInPartita;
}

function costruisciStatoGiocatori(partita) {
  return partita.ordineGiocatori.map(id => ({
    id,
    nome: partita.giocatori[id].nome,
    avatar: partita.giocatori[id].avatar || null,
    posizione: partita.giocatori[id].posizione,
    tipoDispositivo: partita.giocatori[id].tipoDispositivo || "computer"
  }));
}

function normalizzaTipoDispositivoMedia(tipo) {
  if (tipo === "cellulare" || tipo === "tablet" || tipo === "computer") return tipo;
  return "computer";
}

function elencoPartecipantiMediaPronti(partita) {
  if (!partita || !(partita.partecipantiMediaPronti instanceof Set)) return [];
  return Array.from(partita.partecipantiMediaPronti).filter(uid => {
    const giocatore = partita.giocatori[uid];
    return giocatore && giocatore.socket && giocatore.socket.readyState === WebSocket.OPEN;
  });
}

function elencoPartecipantiMediaInfo(partita) {
  const pronti = elencoPartecipantiMediaPronti(partita);
  const infoMap = partita && partita.partecipantiMediaInfo instanceof Map
    ? partita.partecipantiMediaInfo
    : new Map();

  return pronti.map(uid => {
    const giocatore = partita.giocatori[uid] || {};
    const info = infoMap.get(uid) || {};
    const tipoDispositivo = normalizzaTipoDispositivoMedia(
      info.tipoDispositivo || giocatore.tipoDispositivo
    );

    return {
      uid,
      tipoDispositivo,
      videoDisponibile: tipoDispositivo !== "cellulare" && info.videoDisponibile !== false
    };
  });
}

function inviaStatoMedia(partita) {
  if (!partita || partita.mediaAttiva !== true) return;
  const partecipantiMedia = elencoPartecipantiMediaInfo(partita);
  const partecipanti = partecipantiMedia.map(partecipante => partecipante.uid);
  const messaggio = JSON.stringify({
    tipo: "statoMedia",
    mediaAttiva: true,
    partecipanti,
    partecipantiMedia
  });
  Object.values(partita.giocatori).forEach(giocatore => {
    if (giocatore.socket && giocatore.socket.readyState === WebSocket.OPEN) giocatore.socket.send(messaggio);
  });
}

function configurazioneIcePerClient() {
  const iceServers = [{ urls: process.env.STUN_URL || "stun:stun.l.google.com:19302" }];
  const turnUrls = String(process.env.TURN_URL || "").split(",").map(url => url.trim()).filter(Boolean);
  const turnUsername = String(process.env.TURN_USERNAME || "").trim();
  const turnCredential = String(process.env.TURN_CREDENTIAL || "").trim();
  if (turnUrls.length && turnUsername && turnCredential) {
    iceServers.push({ urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls, username: turnUsername, credential: turnCredential });
  }
  return { iceServers };
}

function rimuoviPartecipanteMedia(partita, uid, notifica = true) {
  if (!partita || !(partita.partecipantiMediaPronti instanceof Set)) return;
  const rimosso = partita.partecipantiMediaPronti.delete(uid);
  if (partita.partecipantiMediaInfo instanceof Map) partita.partecipantiMediaInfo.delete(uid);
  if (rimosso && notifica) inviaStatoMedia(partita);
}

function inviaAllaStanza(nomeStanza, messaggio) {
  if (!stanze[nomeStanza]) return;
  Object.keys(stanze[nomeStanza].giocatoriOnline).forEach(id => {
    const s = socketsPerId[id];
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(messaggio));
  });
}


async function inviaChatLobbyFiltrata(nomeStanza, mittenteUid, messaggio) {
  if (!stanze[nomeStanza]) return;

  const entries = Object.entries(stanze[nomeStanza].giocatoriOnline || {});

  for (const [socketId, giocatore] of entries) {
    if (!giocatore || !giocatore.uid) continue;

    if (
      giocatore.uid !== mittenteUid &&
      await sonoBloccatiTraLoro(mittenteUid, giocatore.uid)
    ) {
      continue;
    }

    const destinatarioSocket = socketsPerId[socketId];
    if (
      destinatarioSocket &&
      destinatarioSocket.readyState === WebSocket.OPEN
    ) {
      destinatarioSocket.send(JSON.stringify(messaggio));
    }
  }
}

async function inviaChatPartitaFiltrata(partita, mittenteUid, messaggio) {
  if (!partita) return;

  for (const [destinatarioUid, giocatore] of Object.entries(partita.giocatori || {})) {
    if (
      destinatarioUid !== mittenteUid &&
      await sonoBloccatiTraLoro(mittenteUid, destinatarioUid)
    ) {
      continue;
    }

    if (
      giocatore.socket &&
      giocatore.socket.readyState === WebSocket.OPEN
    ) {
      giocatore.socket.send(JSON.stringify(messaggio));
    }
  }
}

function inviaListaPartite(nomeStanza) {
  if (!stanze[nomeStanza]) return;
  const lista = Object.values(stanze[nomeStanza].partite).map(p => ({
    id: p.id, creatore: p.creatore, creatoDa: p.creatoDa, tempo: p.tempo, modalita: p.modalita, classificata: p.classificata !== false,
    maxGiocatori: p.maxGiocatori, numGiocatoriAttuali: Object.keys(p.giocatori).length, chatAttiva: p.chatAttiva !== false,
    mediaAttiva: p.mediaAttiva === true,
    iniziata: p.iniziata !== false,
    giocatori: Object.entries(p.giocatori).map(([uid, g]) => ({ uid, nome: g.nome, avatar: g.avatar || null }))
  }));
  inviaAllaStanza(nomeStanza, { tipo: "listaPartite", partite: lista });
}

function inviaConteggioStanze() {
  const conteggi = {};
  const giocatoriPerStanza = {};

  for (const nome in stanze) {
    const valori = Object.values(stanze[nome].giocatoriOnline || {});
    const uidInPartita = calcolaUidInPartita(nome);

    // Ogni UID può comparire una sola volta.
    const vistiUid = new Map();

    for (const g of valori) {
      if (!g || !g.uid) continue;

      // Se esistono più connessioni dello stesso utente,
      // manteniamo una sola presenza.
      vistiUid.set(g.uid, g);
    }

    const valoriUnici = Array.from(vistiUid.values());

    conteggi[nome] = valoriUnici.length;

    giocatoriPerStanza[nome] = valoriUnici.map(g => ({
      uid: g.uid,
      nickname: g.nickname,
      avatar: g.avatar || null,
      tipoDispositivo: g.tipoDispositivo || "computer",
      stato: uidInPartita.has(g.uid) ? "partita" : "lobby"
    }));
  }

  const messaggio = JSON.stringify({
    tipo: "conteggioStanze",
    stanze: conteggi,
    giocatori: giocatoriPerStanza
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messaggio);
    }
  });
}

const HEARTBEAT_MS = 15000;
const DURATA_ANIMAZIONE_DADI_MS = 1080;
const DURATA_PASSO_PEDINA_MS = 260;
const MARGINE_SINCRONIZZAZIONE_MOSSA_MS = 90;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(socket => { if (socket.isAlive === false) return socket.terminate(); socket.isAlive = false; socket.ping(); });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeatInterval));

function rilevaTipoDispositivo(userAgent) {
  const ua = userAgent || "";
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return "cellulare";
  return "computer";
}

// ===== TIMER DI TURNO =====
const TOLLERANZA_RETE_MS = 2000;

function millisecondiMossa(partita) {
  const secondi = parseInt(partita.tempo, 10);
  return (Number.isFinite(secondi) && secondi > 0 ? secondi : 15) * 1000;
}

function millisecondiTimerServer(partita) {
  return millisecondiMossa(partita) + TOLLERANZA_RETE_MS;
}

function tempoResiduoVisibileMs(partita, adesso = Date.now()) {
  if (!partita || !Number.isFinite(Number(partita.tempoInizioTurno))) return 0;

  const durataVisibile = millisecondiMossa(partita);
  const scadenzaVisibile = Number(partita.tempoInizioTurno) + durataVisibile;

  return Math.max(
    0,
    Math.min(durataVisibile, scadenzaVisibile - Number(adesso))
  );
}

function fermaTimerTurno(partita) {
  if (!partita) return;
  if (partita.timerTurno) {
    clearTimeout(partita.timerTurno);
    partita.timerTurno = null;
  }
  partita.tokenTimerTurno = (partita.tokenTimerTurno || 0) + 1;
}

function avviaTimerTurno(partita, nomeStanza) {
  if (!partita || !partita.iniziata) return;

  fermaTimerTurno(partita);

  const durataServer = millisecondiTimerServer(partita);
  const token = partita.tokenTimerTurno;

  partita.tempoInizioTurno = Date.now();

  // scadenzaTurno è la scadenza AUTOREVOLE del server:
  // 15 secondi visibili + 2 secondi di tolleranza rete.
  partita.scadenzaTurno = partita.tempoInizioTurno + durataServer;

  partita.timerTurno = setTimeout(async () => {
    if (token !== partita.tokenTimerTurno) return;

    partita.timerTurno = null;
    await gestisciScadenzaTurno(partita, nomeStanza);
  }, durataServer);
}

function durataAnimazioneMossaMs(percorso, effettiCasella) {
  const passi = Array.isArray(percorso) ? percorso.length : 0;
  const pausaEffetti = (Array.isArray(effettiCasella) ? effettiCasella : []).reduce((totale, effetto) => {
    const durata = Number(effetto && effetto.durataMs);
    return totale + (Number.isFinite(durata) && durata > 0 ? Math.min(durata, 3000) : 0);
  }, 0);
  return DURATA_ANIMAZIONE_DADI_MS + (passi * DURATA_PASSO_PEDINA_MS) + pausaEffetti + MARGINE_SINCRONIZZAZIONE_MOSSA_MS;
}

function ripristinaTimerTurno(partita, nomeStanza) {
  if (!partita || !partita.iniziata) return;

  partita.animazioneTiroInCorso = false;

  if (!partita.scadenzaTurno) {
    avviaTimerTurno(partita, nomeStanza);
    return;
  }

  if (!Number.isFinite(Number(partita.tempoInizioTurno))) {
    partita.tempoInizioTurno =
      Number(partita.scadenzaTurno) - millisecondiTimerServer(partita);
  }

  fermaTimerTurno(partita);

  const token = partita.tokenTimerTurno;
  const tempoRimanenteServer =
    Number(partita.scadenzaTurno) - Date.now();

  const ritardo =
    tempoRimanenteServer <= 0 ? 0 : tempoRimanenteServer;

  partita.timerTurno = setTimeout(async () => {
    if (token !== partita.tokenTimerTurno) return;

    partita.timerTurno = null;
    partita.animazioneTiroInCorso = false;
    await gestisciScadenzaTurno(partita, nomeStanza);
  }, ritardo);
}

async function gestisciScadenzaTurno(partita, nomeStanza) {
  if (!partita.iniziata) return;
  const idGiocatoreDiTurno = partita.ordineGiocatori[partita.turnoAttuale];
  const giocatore = partita.giocatori[idGiocatoreDiTurno];
  if (!giocatore) return;
  giocatore.tentativiAutomaticiConsecutivi = (giocatore.tentativiAutomaticiConsecutivi || 0) + 1;
  if (giocatore.tentativiAutomaticiConsecutivi > 3) {
    await forzaAbbandonoPerInattivita(partita, nomeStanza, idGiocatoreDiTurno);
    return;
  }
  await eseguiTiroDadiPerGiocatore(partita, nomeStanza, idGiocatoreDiTurno, true);
}

async function eseguiTiroDadiPerGiocatore(partita, nomeStanza, idGiocatore, automatico) {
  if (!partita || partita.elaborandoTiro) return;
  if (partita.animazioneTiroInCorso) return;
  if (partita.ordineGiocatori[partita.turnoAttuale] !== idGiocatore) return;

  const tiriEffettuati = Number(partita.tiriEffettuatiNelTurno || 0);
  const tiriConsentiti = Number(partita.tiriConsentitiNelTurno || 1);
  if (tiriEffettuati >= tiriConsentiti) return;

  const giocatore = partita.giocatori[idGiocatore];
  if (!giocatore) return;

  partita.tiriEffettuatiNelTurno = tiriEffettuati + 1;
  partita.elaborandoTiro = true;
  partita.animazioneTiroInCorso = true;
  fermaTimerTurno(partita);

  try {
    const tiriRealiPrimaDelTiro = numeroTiriRealiEffettuati(giocatore);
    const { dado1, dado2 } = await lanciaDueDadiPerGiocatore(giocatore);
    const valoreDado = dado1 + dado2;
    const risultato = calcolaMovimento(giocatore.posizione, valoreDado);
    giocatore.tiriRealiEffettuati = tiriRealiPrimaDelTiro + 1;

    if (risultato.tiraAncora) partita.tiriConsentitiNelTurno = partita.tiriEffettuatiNelTurno + 1;

    giocatore.posizione = risultato.nuovaPosizione;
    if (risultato.turniDaSaltare > 0) giocatore.turniSaltati = risultato.turniDaSaltare;

    if (!risultato.tiraAncora && !risultato.vittoria) passaAlProssimoTurno(partita);

    const statoGiocatori = costruisciStatoGiocatori(partita);
    const messaggiGenerali = automatico ? ["⏱️ Tempo scaduto: mossa automatica."] : [];
    const messaggiFinali = messaggiGenerali.concat(risultato.messaggi);

    if (risultato.vittoria) {
      Object.values(partita.giocatori).forEach(g => {
        if (g.socket && g.socket.readyState === WebSocket.OPEN) {
          g.socket.send(JSON.stringify({
            tipo: "aggiornamentoPartita", giocatori: statoGiocatori, dado1, dado2, valoreDado,
            percorso: risultato.percorso, idGiocatoreCheHaTirato: idGiocatore, automatico: !!automatico,
            messaggi: messaggiFinali, messaggiGenerali, effettiCasella: risultato.effettiCasella || [],
            turnoDiId: null, tempoInizioTurno: null, durataMossaMs: 0, tempoResiduoMs: 0,
            vittoria: true, vincitore: giocatore.nome
          }));
        }
      });
      await rimuoviPartita(nomeStanza, partita.id);
      await concludiPartita(partita, idGiocatore, nomeStanza, null);
      return;
    }

    // FIX (turni): in questa prima fase (mostra il tiro appena avvenuto) NON si
    // rivela più a chi tocca il prossimo turno — prima "turnoDiId" indicava già
    // il prossimo giocatore qui, anche se il suo vero timer non era partito:
    // il turno sembrava passare dopo appena 1 secondo. Ora l'informazione
    // completa arriva solo in seconda fase, quando il countdown vero parte.
    Object.values(partita.giocatori).forEach(g => {
      if (g.socket && g.socket.readyState === WebSocket.OPEN) {
        g.socket.send(JSON.stringify({
          tipo: "aggiornamentoPartita", giocatori: statoGiocatori, dado1, dado2, valoreDado,
          percorso: risultato.percorso, idGiocatoreCheHaTirato: idGiocatore, automatico: !!automatico,
          messaggi: messaggiFinali, messaggiGenerali, effettiCasella: risultato.effettiCasella || [],
          turnoDiId: null,
          tempoInizioTurno: null,
          durataMossaMs: 0, tempoResiduoMs: 0,
          vittoria: false, vincitore: null
        }));
      }
    });

    aggiornaStatoPartita(partita.id, {
      giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
      ordineGiocatori: partita.ordineGiocatori,
      turnoAttuale: partita.turnoAttuale,
      iniziata: partita.iniziata,
      tiriEffettuatiNelTurno: partita.tiriEffettuatiNelTurno,
      tiriConsentitiNelTurno: partita.tiriConsentitiNelTurno,
      tempoInizioTurno: null,
      scadenzaTurno: null
    }).catch(errore => {
      console.error("Errore salvataggio stato durante animazione:", errore.message);
    });

    // Seconda fase, dopo l'animazione: SOLO ORA il countdown vero parte, con
    // tempoInizioTurno preso da Date.now() in quell'istante — mai un valore
    // "spostato in avanti" che il client potrebbe interpretare come tempo già
    // trascorso.
    const tokenAnimazione = partita.tokenTimerTurno;
    setTimeout(async () => {
      const trovato = trovaPartita(partita.id);
      if (!trovato || trovato.partita !== partita) return;
      if (!partita.iniziata) return;
      if (tokenAnimazione !== partita.tokenTimerTurno) return;

      partita.animazioneTiroInCorso = false;
      avviaTimerTurno(partita, nomeStanza);

      const statoDopoAnimazione = costruisciStatoGiocatori(partita);
      const idTurnoAttuale = partita.ordineGiocatori[partita.turnoAttuale];

      Object.values(partita.giocatori).forEach(g => {
        if (g.socket && g.socket.readyState === WebSocket.OPEN) {
          g.socket.send(JSON.stringify({
            tipo: "statoPartita",
            giocatori: statoDopoAnimazione,
            turnoDiId: idTurnoAttuale,
            punteggiOrdineIniziale: partita.punteggiOrdineIniziale || null,
            tempoInizioTurno: partita.tempoInizioTurno,
            durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
            chatAttiva: partita.chatAttiva !== false,
            mediaAttiva: partita.mediaAttiva === true
          }));
        }
      });

      await aggiornaStatoPartita(partita.id, {
        turnoAttuale: partita.turnoAttuale,
        iniziata: partita.iniziata,
        tiriEffettuatiNelTurno: partita.tiriEffettuatiNelTurno,
        tiriConsentitiNelTurno: partita.tiriConsentitiNelTurno,
        tempoInizioTurno: partita.tempoInizioTurno,
        scadenzaTurno: partita.scadenzaTurno
      });
    }, durataAnimazioneMossaMs(risultato.percorso, risultato.effettiCasella));

  } catch (erroreTiro) {
    // Se la generazione o l'elaborazione del tiro fallisce, non lasciamo il
    // turno bloccato: restituiamo il tiro e riavviamo il timer dello stesso
    // giocatore.
    console.error("Errore durante il tiro dei dadi:", erroreTiro);
    partita.tiriEffettuatiNelTurno = Math.max(0, tiriEffettuati);
    partita.animazioneTiroInCorso = false;
    avviaTimerTurno(partita, nomeStanza);
    const idAttuale = partita.ordineGiocatori[partita.turnoAttuale];
    const statoGiocatori = costruisciStatoGiocatori(partita);
    Object.values(partita.giocatori).forEach(g => {
      if (g.socket && g.socket.readyState === WebSocket.OPEN) {
        g.socket.send(JSON.stringify({
          tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: idAttuale,
          messaggi: ["RANDOM.ORG non ha restituito i dadi. Riprova il tiro."],
          tempoInizioTurno: partita.tempoInizioTurno, durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
          chatAttiva: partita.chatAttiva !== false,
          mediaAttiva: partita.mediaAttiva === true
        }));
      }
    });
  } finally {
    partita.elaborandoTiro = false;
  }
}

async function forzaAbbandonoPerInattivita(partita, nomeStanza, idGiocatore) {
  fermaTimerTurno(partita);
  if (!partita.giocatori[idGiocatore]) return;
  const nomeUscente = partita.giocatori[idGiocatore].nome;
  rimuoviPartecipanteMedia(partita, idGiocatore);

  if (db) {
    try {
      await db.ref("utenti/" + idGiocatore).update({ streakVittorieAttuale: 0 });
    } catch (e) { console.error("Errore aggiornamento streak dopo inattività:", e.message); }
  }

  delete partita.giocatori[idGiocatore];
  partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== idGiocatore);
  const restanti = Object.keys(partita.giocatori);
  if (partita.turnoAttuale >= partita.ordineGiocatori.length) partita.turnoAttuale = 0;

  if (restanti.length === 0) { await rimuoviPartita(nomeStanza, partita.id); inviaListaPartite(nomeStanza); inviaConteggioStanze(); return; }

  if (restanti.length === 1) {
    const vincitoreId = restanti[0];
    const vincitoreNome = partita.giocatori[vincitoreId].nome;
    const statoGiocatori = costruisciStatoGiocatori(partita);
    Object.values(partita.giocatori).forEach(g => {
      if (g.socket && g.socket.readyState === WebSocket.OPEN) g.socket.send(JSON.stringify({ tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: vincitoreId, vittoria: true, vincitore: vincitoreNome, messaggi: [nomeUscente + " è stato rimosso per inattività prolungata."] }));
    });
    const elencoCompleto = partita.ordineGiocatori.concat([idGiocatore]).map(id => id === idGiocatore ? { uid: idGiocatore, nome: nomeUscente } : { uid: id, nome: partita.giocatori[id].nome });
    await rimuoviPartita(nomeStanza, partita.id);
    await concludiPartita(partita, vincitoreId, nomeStanza, elencoCompleto);
  } else {
    const idAttuale = partita.ordineGiocatori[partita.turnoAttuale];
    partita.tiriEffettuatiNelTurno = 0;
    partita.tiriConsentitiNelTurno = 1;
    partita.animazioneTiroInCorso = false;
    avviaTimerTurno(partita, nomeStanza);
    const statoGiocatori = costruisciStatoGiocatori(partita);
    Object.values(partita.giocatori).forEach(g => {
      if (g.socket && g.socket.readyState === WebSocket.OPEN) {
        g.socket.send(JSON.stringify({
          tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: idAttuale,
          messaggi: [nomeUscente + " è stato rimosso per inattività prolungata."],
          tempoInizioTurno: partita.tempoInizioTurno, durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita)
        }));
      }
    });
    await aggiornaStatoPartita(partita.id, { giocatori: preparaGiocatoriPerFirebase(partita.giocatori), ordineGiocatori: partita.ordineGiocatori, turnoAttuale: partita.turnoAttuale, tiriEffettuatiNelTurno: 0, tiriConsentitiNelTurno: 1 });
  }
  inviaListaPartite(nomeStanza);
  inviaConteggioStanze();
}

// ===== FASE "CHI INIZIA?" =====
function calcolaOrdineDaiRisultati(risultati, tuttiGliUid) {
  const coppie = tuttiGliUid.map(uid => ({ uid, punteggio: risultati[uid] }));
  coppie.sort((a, b) => b.punteggio - a.punteggio);
  for (let i = 0; i < coppie.length; i++) {
    let j = i + 1;
    while (j < coppie.length && coppie[j].punteggio === coppie[i].punteggio) j++;
    if (j - i > 1) return { ordineFinale: null, prossimoGruppoParitario: coppie.slice(i, j).map(c => c.uid) };
    i = j - 1;
  }
  return { ordineFinale: coppie.map(c => c.uid), prossimoGruppoParitario: null };
}

function rimuoviGiocatoreDaDeterminazione(partita, uid) {
  delete partita.giocatori[uid];
  partita.ordineDeterminazione = (partita.ordineDeterminazione || []).filter(u2 => u2 !== uid);
  partita.codaDeterminazione = (partita.codaDeterminazione || []).filter(u2 => u2 !== uid);
  if (partita.risultatiDeterminazione) delete partita.risultatiDeterminazione[uid];
  if (partita.gruppoSpareggioAttuale) partita.gruppoSpareggioAttuale = partita.gruppoSpareggioAttuale.filter(u2 => u2 !== uid);
}

function inviaStatoDeterminazione(partita, nomeStanza) {
  const elenco = (partita.ordineDeterminazione || []).map(uid => ({
    uid, nome: partita.giocatori[uid] ? partita.giocatori[uid].nome : "?",
    avatar: partita.giocatori[uid] ? (partita.giocatori[uid].avatar || null) : null,
    risultato: partita.risultatiDeterminazione && partita.risultatiDeterminazione[uid] != null ? partita.risultatiDeterminazione[uid] : null
  }));
  const messaggio = JSON.stringify({
    tipo: "statoDeterminazione", giocatori: elenco,
    turnoInCorsoUid: partita.turnoInCorsoDeterminazione || null,
    gruppoSpareggioAttuale: partita.gruppoSpareggioAttuale || null,
    tempoInizioTurno: partita.tempoInizioTurno || null,
    durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
    classificata: partita.classificata !== false,
    chatAttiva: partita.chatAttiva !== false,
    mediaAttiva: partita.mediaAttiva === true
  });
  Object.values(partita.giocatori).forEach(g => { if (g.socket && g.socket.readyState === WebSocket.OPEN) g.socket.send(messaggio); });
}

function avviaTimerDeterminazione(partita, nomeStanza) {
  if (!partita) return;

  fermaTimerTurno(partita);

  const token = partita.tokenTimerTurno;
  const durataServer = millisecondiTimerServer(partita);

  partita.tempoInizioTurno = Date.now();
  partita.scadenzaTurno = partita.tempoInizioTurno + durataServer;

  partita.timerTurno = setTimeout(async () => {
    if (token !== partita.tokenTimerTurno) return;

    partita.timerTurno = null;
    await gestisciScadenzaDeterminazione(partita, nomeStanza);
  }, durataServer);
}

function ripristinaTimerDeterminazione(partita, nomeStanza) {
  if (!partita) return;

  if (!partita.scadenzaTurno) {
    avviaTimerDeterminazione(partita, nomeStanza);
    return;
  }

  if (!Number.isFinite(Number(partita.tempoInizioTurno))) {
    partita.tempoInizioTurno =
      Number(partita.scadenzaTurno) - millisecondiTimerServer(partita);
  }

  fermaTimerTurno(partita);

  const token = partita.tokenTimerTurno;
  const tempoRimanenteServer =
    Number(partita.scadenzaTurno) - Date.now();

  partita.timerTurno = setTimeout(async () => {
    if (token !== partita.tokenTimerTurno) return;

    partita.timerTurno = null;
    await gestisciScadenzaDeterminazione(partita, nomeStanza);
  }, Math.max(0, tempoRimanenteServer));
}

async function gestisciScadenzaDeterminazione(partita, nomeStanza) {
  if (partita.fase !== "determinazione_ordine") return;
  const uid = partita.turnoInCorsoDeterminazione;
  if (!uid) return;
  const giocatore = partita.giocatori[uid];
  if (!giocatore) return;
  giocatore.tentativiAutomaticiConsecutivi = (giocatore.tentativiAutomaticiConsecutivi || 0) + 1;
  if (giocatore.tentativiAutomaticiConsecutivi > 3) { await espelliPerInattivitaDuranteDeterminazione(partita, nomeStanza, uid); return; }
  await eseguiTiroDeterminazionePerGiocatore(partita, nomeStanza, uid, true);
}

async function eseguiTiroDeterminazionePerGiocatore(partita, nomeStanza, uid, automatico) {
  if (partita.elaborandoTiro) return;
  partita.elaborandoTiro = true;
  try {
    fermaTimerTurno(partita);
    const { dado1, dado2 } = await lanciaDueDadiSicuri();
    const valoreDado = dado1 + dado2;
    if (!partita.risultatiDeterminazione) partita.risultatiDeterminazione = {};
    partita.risultatiDeterminazione[uid] = valoreDado;
    partita.turnoInCorsoDeterminazione = null;

    const giocatore = partita.giocatori[uid];
    const messaggio = JSON.stringify({ tipo: "risultatoDeterminazione", uid, nome: giocatore ? giocatore.nome : "?", dado1, dado2, valoreDado, automatico: !!automatico });
    Object.values(partita.giocatori).forEach(g => { if (g.socket && g.socket.readyState === WebSocket.OPEN) g.socket.send(messaggio); });

    try { await salvaPartita({ ...partita, stanza: nomeStanza }); }
    catch (erroreSalvataggio) { console.error("Errore salvataggio determinazione:", erroreSalvataggio.message); }

    setTimeout(() => { avanzaDeterminazione(partita, nomeStanza); }, 1600);
  } finally {
    partita.elaborandoTiro = false;
  }
}

async function iniziaFaseDeterminazione(partita, nomeStanza) {
  partita.fase = "determinazione_ordine";
  partita.ordineDeterminazione = Object.keys(partita.giocatori);
  partita.risultatiDeterminazione = {};
  partita.codaDeterminazione = [...partita.ordineDeterminazione];
  partita.turnoInCorsoDeterminazione = null;
  partita.gruppoSpareggioAttuale = null;
  await avanzaDeterminazione(partita, nomeStanza);
}

async function riprendiFaseDeterminazioneRipristinata(partita, nomeStanza) {
  const uidGiocatori = Object.keys(partita.giocatori);
  const uidValidi = new Set(uidGiocatori);
  const ordineSalvato = Array.isArray(partita.ordineDeterminazione)
    ? [...new Set(partita.ordineDeterminazione.filter(uid => uidValidi.has(uid)))]
    : [];

  if (ordineSalvato.length !== uidGiocatori.length || uidGiocatori.length < 2) {
    await iniziaFaseDeterminazione(partita, nomeStanza);
    return;
  }

  partita.ordineDeterminazione = ordineSalvato;
  partita.risultatiDeterminazione = Object.fromEntries(
    Object.entries(partita.risultatiDeterminazione || {}).filter(([uid, valore]) => uidValidi.has(uid) && Number.isFinite(Number(valore)))
  );
  partita.codaDeterminazione = [...new Set((partita.codaDeterminazione || []).filter(uid => uidValidi.has(uid)))];
  partita.gruppoSpareggioAttuale = Array.isArray(partita.gruppoSpareggioAttuale)
    ? partita.gruppoSpareggioAttuale.filter(uid => uidValidi.has(uid))
    : null;

  if (uidValidi.has(partita.turnoInCorsoDeterminazione)) {
    ripristinaTimerDeterminazione(partita, nomeStanza);
    inviaStatoDeterminazione(partita, nomeStanza);
    return;
  }

  partita.turnoInCorsoDeterminazione = null;
  if (partita.codaDeterminazione.length || Object.keys(partita.risultatiDeterminazione).length) {
    await avanzaDeterminazione(partita, nomeStanza);
    return;
  }

  await iniziaFaseDeterminazione(partita, nomeStanza);
}

async function avanzaDeterminazione(partita, nomeStanza) {
  if (partita.codaDeterminazione.length === 0) {
    const esito = calcolaOrdineDaiRisultati(partita.risultatiDeterminazione, partita.ordineDeterminazione);
    if (esito.prossimoGruppoParitario) {
      partita.gruppoSpareggioAttuale = esito.prossimoGruppoParitario;
      partita.codaDeterminazione = [...esito.prossimoGruppoParitario];
      await avanzaDeterminazione(partita, nomeStanza);
      return;
    }
    partita.gruppoSpareggioAttuale = null;

    const nomiOrdineFinale = esito.ordineFinale.map(uid => partita.giocatori[uid].nome);
    const punteggiOrdineFinale = {};
    esito.ordineFinale.forEach(uid => { punteggiOrdineFinale[partita.giocatori[uid].nome] = partita.risultatiDeterminazione[uid]; });
    const messaggioOrdine = JSON.stringify({ tipo: "ordineFinaleCalcolato", ordineGiocatori: nomiOrdineFinale, punteggi: punteggiOrdineFinale });
    Object.values(partita.giocatori).forEach(g => { if (g.socket && g.socket.readyState === WebSocket.OPEN) g.socket.send(messaggioOrdine); });

    setTimeout(() => { completaDeterminazione(partita, nomeStanza, esito.ordineFinale); }, 2600);
    return;
  }
  partita.turnoInCorsoDeterminazione = partita.codaDeterminazione.shift();
  avviaTimerDeterminazione(partita, nomeStanza);
  inviaStatoDeterminazione(partita, nomeStanza);
  try { await salvaPartita({ ...partita, stanza: nomeStanza }); }
  catch (erroreSalvataggio) { console.error("Errore salvataggio turno di determinazione:", erroreSalvataggio.message); }
}

async function espelliPerInattivitaDuranteDeterminazione(partita, nomeStanza, uid) {
  fermaTimerTurno(partita);
  const nomeUscente = partita.giocatori[uid] ? partita.giocatori[uid].nome : "?";

  rimuoviPartecipanteMedia(partita, uid);
  rimuoviGiocatoreDaDeterminazione(partita, uid);
  const restanti = Object.keys(partita.giocatori);

  if (restanti.length <= 1) {
    await rimuoviPartita(nomeStanza, partita.id);
    inviaListaPartite(nomeStanza);
    inviaConteggioStanze();
    return;
  }

  partita.turnoInCorsoDeterminazione = null;
  await avanzaDeterminazione(partita, nomeStanza);
  inviaListaPartite(nomeStanza);
  inviaConteggioStanze();
}

async function completaDeterminazione(partita, nomeStanza, ordineFinale) {
  partita.ordineGiocatori = ordineFinale;
  partita.turnoAttuale = 0;
  partita.fase = "in_corso";
  partita.iniziata = true;
  partita.iniziataIl = Date.now();
  partita.elaborandoTiro = false;
  partita.tiriEffettuatiNelTurno = 0;
  partita.tiriConsentitiNelTurno = 1;

  const punteggiPerNome = {};
  ordineFinale.forEach(uid => { punteggiPerNome[partita.giocatori[uid].nome] = partita.risultatiDeterminazione[uid]; });
  partita.punteggiOrdineIniziale = punteggiPerNome;

  const primoUid = ordineFinale[0];
  const primoGiocatore = partita.giocatori[primoUid];

  const statoGiocatori = costruisciStatoGiocatori(partita);
  const idPrimoTurno = partita.ordineGiocatori[partita.turnoAttuale];

  avviaTimerTurno(partita, nomeStanza);

  Object.values(partita.giocatori).forEach(g => {
    if (g.socket && g.socket.readyState === WebSocket.OPEN) {
      g.socket.send(JSON.stringify({
        tipo: "determinazioneCompletata",
        ordineGiocatori: ordineFinale.map(id => partita.giocatori[id].nome),
        punteggiOrdineIniziale: punteggiPerNome,
        primoMovimento: {
          idGiocatore: primoUid, nomeGiocatore: primoGiocatore.nome, valoreDado: 0, percorso: [],
          messaggi: ["Ordine deciso!", primoGiocatore.nome + " inizia la partita: tira i dadi!"]
        },
        giocatori: statoGiocatori, turnoDiId: idPrimoTurno,
        tempoInizioTurno: partita.tempoInizioTurno, durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
        vittoria: false, vincitore: null,
        classificata: partita.classificata !== false,
        chatAttiva: partita.chatAttiva !== false,
        mediaAttiva: partita.mediaAttiva === true
      }));
    }
  });

  await salvaPartita({ ...partita, stanza: nomeStanza });
  inviaConteggioStanze();
}

async function avviaPartitaAutomaticamente(partita) {
  const trovato = trovaPartita(partita.id);
  const nomeStanza = trovato ? trovato.nomeStanza : partita.stanza;

  await iniziaFaseDeterminazione(partita, nomeStanza);

  await salvaPartita({ ...partita, stanza: nomeStanza, fase: partita.fase, iniziata: partita.iniziata });

  Object.values(partita.giocatori).forEach(g => {
    if (g.socket && g.socket.readyState === WebSocket.OPEN) g.socket.send(JSON.stringify({ tipo: "partitaAvviata", partitaId: partita.id, mediaAttiva: partita.mediaAttiva === true }));
  });

  inviaConteggioStanze();
}

// ===== USCITA DA UNA PARTITA NON ANCORA INIZIATA =====
async function esciDaPartitaInAttesa(partita, nomeStanza, uid) {
  if (!partita || !uid) return false;
  if (partita.fase !== "attesa_giocatori") return false;

  const giocatoreUscente = partita.giocatori[uid];
  if (!giocatoreUscente) return false;

  const eraCreatore = partita.creatoDa === uid;
  const nomeUscente = giocatoreUscente.nome || "Giocatore";

  delete partita.giocatori[uid];
  partita.ordineGiocatori = (partita.ordineGiocatori || []).filter(id => id !== uid);
  partita.turnoAttuale = 0;

  const restanti = Object.keys(partita.giocatori);

  if (restanti.length === 0) {
    await rimuoviPartita(nomeStanza, partita.id);
    inviaListaPartite(nomeStanza);
    inviaConteggioStanze();
    return true;
  }

  if (eraCreatore) {
    const nuovoCreatoreUid = partita.ordineGiocatori[0];
    const nuovoCreatore = partita.giocatori[nuovoCreatoreUid];
    if (nuovoCreatore) {
      partita.creatoDa = nuovoCreatoreUid;
      partita.creatore = nuovoCreatore.nome;
    }
  }

  // Aggiorna subito Lobby e contatori; la persistenza può completarsi dopo.
  inviaListaPartite(nomeStanza);
  inviaConteggioStanze();

  await aggiornaStatoPartita(partita.id, {
    creatore: partita.creatore, creatoDa: partita.creatoDa,
    giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
    ordineGiocatori: partita.ordineGiocatori,
    turnoAttuale: partita.turnoAttuale,
    iniziata: false, fase: "attesa_giocatori"
  });

  inviaAllaStanza(nomeStanza, {
    tipo: "giocatoreHaLasciatoPartita", partitaId: partita.id, uid: uid,
    nome: nomeUscente, nuovoCreatoreUid: partita.creatoDa
  });

  inviaListaPartite(nomeStanza);
  inviaConteggioStanze();
  return true;
}

// ===== CONNESSIONI WEBSOCKET =====
wss.on("connection", (socket, request) => {
  const origineWebSocket = request.headers.origin || "";
  const origineLocaleDiSviluppo = process.env.NODE_ENV !== "production" &&
    (!origineWebSocket || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origineWebSocket));
  if (!ORIGINI_CONSENTITE.includes(origineWebSocket) && !origineLocaleDiSviluppo) {
    socket.close(1008, "Origine non consentita");
    return;
  }
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  const tipoDispositivo = rilevaTipoDispositivo(request.headers["user-agent"]);
  const socketId = "s" + (contatoreId++);
  socketsPerId[socketId] = socket;

  let stanzaAttuale = null, nickname = null, mioAvatar = null;
  const tokenDalCookie = estraiTokenDaCookieHeader(request.headers.cookie);
  const datiTokenIniziali = verificaToken(tokenDalCookie);
  let uid = datiTokenIniziali ? datiTokenIniziali.uid : null;

  socket.on("message", async (message) => {
    try {
      let dati;
      try { dati = JSON.parse(message); } catch (e) { return; }

      // Fallback per browser/iframe che bloccano il cookie di terze parti.
      // Il cookie HTTP-only resta il metodo principale; il token nel messaggio
      // viene usato solo quando la WebSocket non ha ricevuto il cookie.
      if (
        !uid &&
        typeof dati.token === "string" &&
        dati.token.length > 0 &&
        dati.token.length <= 4096
      ) {
        const datiTokenMessaggio = verificaToken(dati.token);
        if (datiTokenMessaggio && datiTokenMessaggio.uid) {
          uid = datiTokenMessaggio.uid;
        }
      }

      if (dati.tipo === "richiediConteggio") { inviaConteggioStanze(); return; }

      if (dati.tipo === "mediaPronto") {
        if (!uid) return;
        if (typeof dati.attivo !== "boolean") return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita } = trovato;
        const giocatore = partita.giocatori[uid];
        if (partita.mediaAttiva !== true || !giocatore || giocatore.socket !== socket) return;
        if (!(partita.partecipantiMediaPronti instanceof Set)) partita.partecipantiMediaPronti = new Set();
        if (!(partita.partecipantiMediaInfo instanceof Map)) partita.partecipantiMediaInfo = new Map();

        if (dati.attivo === false) {
          partita.partecipantiMediaPronti.delete(uid);
          partita.partecipantiMediaInfo.delete(uid);
        } else {
          const tipoDispositivoMedia = normalizzaTipoDispositivoMedia(
            giocatore.tipoDispositivo || tipoDispositivo
          );
          giocatore.tipoDispositivo = tipoDispositivoMedia;
          partita.partecipantiMediaPronti.add(uid);
          partita.partecipantiMediaInfo.set(uid, {
            tipoDispositivo: tipoDispositivoMedia,
            videoDisponibile: tipoDispositivoMedia !== "cellulare"
          });
        }
        inviaStatoMedia(partita);
        return;
      }

      if (dati.tipo === "richiestaAudio" || dati.tipo === "rispostaAudio" || dati.tipo === "webrtc-offer" || dati.tipo === "webrtc-answer" || dati.tipo === "webrtc-ice-candidate") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita } = trovato;
        const mittente = partita.giocatori[uid];
        if (!mittente || mittente.socket !== socket) return;
        const destinatarioUid = dati.destinatarioUid;
        if (!destinatarioUid || destinatarioUid === uid) return;
        const destinatario = partita.giocatori[destinatarioUid];
        if (!destinatario || !destinatario.socket || destinatario.socket.readyState !== WebSocket.OPEN) return;

        if (dati.tipo === "richiestaAudio") {
          if (partita.mediaAttiva === true) return;
          destinatario.socket.send(JSON.stringify({ tipo: "richiestaAudioRicevuta", mittenteUid: uid, mittenteNome: nickname }));
          return;
        }
        if (dati.tipo === "rispostaAudio") {
          if (partita.mediaAttiva === true) return;
          if (dati.accettato) {
            if (!partita.coppieAudioApprovate) partita.coppieAudioApprovate = new Set();
            partita.coppieAudioApprovate.add(idConversazione(uid, destinatarioUid));
          }
          destinatario.socket.send(JSON.stringify({ tipo: "rispostaAudioRicevuta", mittenteUid: uid, mittenteNome: nickname, accettato: !!dati.accettato }));
          return;
        }
        if (dati.tipo === "webrtc-offer" || dati.tipo === "webrtc-answer") {
          const sdpTesto = dati.sdp && typeof dati.sdp.sdp === "string" ? dati.sdp.sdp : "";
          if (!sdpTesto || sdpTesto.length > 128 * 1024) return;
        }
        if (dati.tipo === "webrtc-ice-candidate") {
          let candidateSerializzato = "";
          try { candidateSerializzato = JSON.stringify(dati.candidate || null); } catch (e) { return; }
          if (!candidateSerializzato || candidateSerializzato.length > 16 * 1024) return;
        }
        const coppiaAudioApprovata = partita.coppieAudioApprovate && partita.coppieAudioApprovate.has(idConversazione(uid, destinatarioUid));
        const coppiaMediaPronta = partita.mediaAttiva === true &&
          partita.partecipantiMediaPronti instanceof Set &&
          partita.partecipantiMediaPronti.has(uid) &&
          partita.partecipantiMediaPronti.has(destinatarioUid);
        if (!coppiaAudioApprovata && !coppiaMediaPronta) return;
        destinatario.socket.send(JSON.stringify({ tipo: dati.tipo, mittenteUid: uid, sdp: dati.sdp || null, candidate: dati.candidate || null }));
        return;
      }

      if (dati.tipo === "lasciaLobby") {
  if (!uid || !stanzaAttuale || !stanze[stanzaAttuale]) return;

  const nomeStanzaDaLasciare = stanzaAttuale;

  // Stacchiamo subito il socket dalla stanza. Se il browser chiude la
  // connessione mentre prosegue la pulizia, l'evento close non ripeterà
  // la stessa uscita in parallelo.
  stanzaAttuale = null;

  // Rimuove esclusivamente questa connessione WebSocket.
  delete stanze[nomeStanzaDaLasciare].giocatoriOnline[socketId];

  // La presenza viene pubblicata PRIMA di eventuali scritture Firebase: gli
  // altri client vedono l'uscita senza attendere la pulizia del tavolo.
  inviaConteggioStanze();

  // Se il giocatore aveva una partita ancora in attesa,
  // deve essere rimosso anche dalla partita.
  const partite = stanze[nomeStanzaDaLasciare].partite || {};

  for (const pid in partite) {
    const partita = partite[pid];

    if (partita.fase !== "attesa_giocatori") continue;

    const giocatore = partita.giocatori[uid];

    if (!giocatore) continue;

    if (giocatore.socket && giocatore.socket !== socket) continue;

    await esciDaPartitaInAttesa(
      partita,
      nomeStanzaDaLasciare,
      uid
    );
  }

  // Aggiorna immediatamente tutti i dati della stanza.
  inviaListaPartite(nomeStanzaDaLasciare);
  inviaConteggioStanze();

  return;
}

      if (dati.tipo === "entraLobby") {
        if (!db) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Servizio account non disponibile." })); return; }
        if (!uid) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }
        if (typeof dati.stanza !== "string" || !Object.prototype.hasOwnProperty.call(stanze, dati.stanza)) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Stanza non valida." }));
          return;
        }
        if (stanzaAttuale && stanzaAttuale !== dati.stanza) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Sei già collegato a un'altra stanza." }));
          return;
        }
        const utenteDb = await caricaUtenteRealtimeLeggero(
          uid,
          datiTokenIniziali && datiTokenIniziali.nickname
            ? datiTokenIniziali.nickname
            : "Utente"
        );

        if (!utenteDb) {
          socket.send(JSON.stringify({ tipo: "sessioneScaduta" }));
          return;
        }

        if (utenteDb.stato === "bannato") {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Il tuo account è stato bannato." }));
          return;
        }

        if (
          utenteDb.stato === "sospeso" &&
          utenteDb.sospesoFino &&
          utenteDb.sospesoFino > Date.now()
        ) {
          socket.send(JSON.stringify({
            tipo: "errore",
            messaggio: "Account sospeso fino al " +
              new Date(utenteDb.sospesoFino).toLocaleString("it-IT") +
              "."
          }));
          return;
        }

        stanzaAttuale = dati.stanza;
        nickname = utenteDb.nickname;
        mioAvatar = utenteDb.avatar || null;
        if (!stanze[stanzaAttuale]) stanze[stanzaAttuale] = { giocatoriOnline: {}, partite: {} };
        stanze[stanzaAttuale].giocatoriOnline[socketId] = {
  uid,
  nickname,
  avatar: mioAvatar,
  tipoDispositivo,
  schermataPartita: false,
  partitaIdAttiva: null
};
        inviaConteggioStanze();
        const numeroOnlineUnici = new Set(
  Object.values(stanze[stanzaAttuale].giocatoriOnline)
    .filter(g => g && g.uid)
    .map(g => g.uid)
).size;

inviaAllaStanza(stanzaAttuale, {
  tipo: "online",
  numero: numeroOnlineUnici
});
        inviaListaPartite(stanzaAttuale);
        socket.send(JSON.stringify({ tipo: "statoPartitaPersonale", partitaAttiva: trovaPartitaAttivaPerUid(uid) }));
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
            const u = await caricaUtenteRealtimeLeggero(uid, mioGiocatore.nome);
            if (u) mioGiocatore.avatar = u.avatar || null;
          } catch (e) {}
        }
        const socketPrecedente = mioGiocatore.socket;
        if (socketPrecedente && socketPrecedente !== socket) {
          rimuoviPartecipanteMedia(partita, uid);
          if (socketPrecedente.readyState === WebSocket.OPEN) {
            socketPrecedente.send(JSON.stringify({ tipo: "sessioneSostituita", messaggio: "La partita è stata aperta in un'altra scheda o dispositivo." }));
            socketPrecedente.close(4001, "Sessione sostituita");
          }
        }
        mioGiocatore.socket = socket;
        mioGiocatore.tipoDispositivo = tipoDispositivo;
        nickname = mioGiocatore.nome; mioAvatar = mioGiocatore.avatar || null;

        if (!stanze[stanzaAttuale]) stanze[stanzaAttuale] = { giocatoriOnline: {}, partite: {} };
        stanze[stanzaAttuale].giocatoriOnline[socketId] = {
  uid,
  nickname,
  avatar: mioAvatar,
  tipoDispositivo,
  schermataPartita: true,
  partitaIdAttiva: partita.id
};
        inviaConteggioStanze();

        if (partita.mediaAttiva === true) socket.send(JSON.stringify({ tipo: "configMedia", configurazioneIce: configurazioneIcePerClient() }));

        if (partita.fase === "determinazione_ordine") {
          socket.send(JSON.stringify({
            tipo: "statoDeterminazione",
            giocatori: (partita.ordineDeterminazione || []).map(u2 => ({ uid: u2, nome: partita.giocatori[u2] ? partita.giocatori[u2].nome : "?", avatar: partita.giocatori[u2] ? (partita.giocatori[u2].avatar || null) : null, risultato: partita.risultatiDeterminazione && partita.risultatiDeterminazione[u2] != null ? partita.risultatiDeterminazione[u2] : null })),
            turnoInCorsoUid: partita.turnoInCorsoDeterminazione || null,
            gruppoSpareggioAttuale: partita.gruppoSpareggioAttuale || null,
            tempoInizioTurno: partita.tempoInizioTurno || Date.now(),
            durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
            classificata: partita.classificata !== false,
            chatAttiva: partita.chatAttiva !== false,
            mediaAttiva: partita.mediaAttiva === true
          }));
        } else {
          socket.send(JSON.stringify({
            tipo: "statoPartita",
            giocatori: costruisciStatoGiocatori(partita),
            turnoDiId: partita.ordineGiocatori[partita.turnoAttuale],
            punteggiOrdineIniziale: partita.punteggiOrdineIniziale || null,
            tempoInizioTurno: partita.tempoInizioTurno || null,
            durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
            scadenzaTurno: partita.scadenzaTurno || null,
            tiriEffettuatiNelTurno: Number(partita.tiriEffettuatiNelTurno || 0),
            tiriConsentitiNelTurno: Number(partita.tiriConsentitiNelTurno || 1),
            chatAttiva: partita.chatAttiva !== false,
            mediaAttiva: partita.mediaAttiva === true
          }));
        }
        return;
      }

      if (dati.tipo === "creaPartita") {
        if (!stanzaAttuale || !uid) return;
        if (trovaPartitaAttivaPerUid(uid)) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Fai già parte di una partita attiva." })); return; }
        const mediaAttiva = dati.mediaAttiva === true;
        if (mediaAttiva && dati.mediaConsenso !== true) {
          const requisitoMedia = tipoDispositivo === "cellulare" ? "il microfono" : "webcam e microfono";
          socket.send(JSON.stringify({ tipo: "errore", messaggio: `Per creare questo tavolo devi prima autorizzare ${requisitoMedia}.` }));
          return;
        }
        const partitaId = "p" + Date.now() + Math.floor(Math.random() * 1000);
        const max = parseInt(dati.maxGiocatori);
        const nuovaPartita = {
          id: partitaId, creatore: nickname, creatoDa: uid, tempo: "15", modalita: dati.modalita, classificata: dati.classificata !== false,
          maxGiocatori: (!max || max < 2 || max > 8 ? 2 : max),
          chatAttiva: dati.chatAttiva !== false,
          mediaAttiva,
          fase: "attesa_giocatori",
          giocatori: { [uid]: { nome: nickname, avatar: mioAvatar, posizione: 0, socket, tipoDispositivo, turniSaltati: 0, tentativiAutomaticiConsecutivi: 0, tiriRealiEffettuati: 0 } },
          ordineGiocatori: [uid], turnoAttuale: 0, iniziata: false, elaborandoTiro: false, animazioneTiroInCorso: false,
          tiriEffettuatiNelTurno: 0, tiriConsentitiNelTurno: 1,
          invitati: dati.modalita === "privata" ? { [uid]: true } : null, timerTurno: null, tempoInizioTurno: null,
          coppieAudioApprovate: new Set(),
          partecipantiMediaPronti: new Set(),
          partecipantiMediaInfo: new Map()
        };
        stanze[stanzaAttuale].partite[partitaId] = nuovaPartita;

        // La Lobby vede subito il nuovo tavolo; Firebase resta la fonte persistente.
        inviaListaPartite(stanzaAttuale);
        inviaConteggioStanze();

        try {
          await salvaPartita({ ...nuovaPartita, stanza: stanzaAttuale });
        } catch (erroreSalvataggio) {
          delete stanze[stanzaAttuale].partite[partitaId];
          inviaListaPartite(stanzaAttuale);
          inviaConteggioStanze();
          console.error("Errore creazione partita:", erroreSalvataggio.message);
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è stato possibile creare la partita. Riprova." }));
          return;
        }

        return;
      }

      if (dati.tipo === "entraPartita") {
        if (!stanzaAttuale || !uid) return;
        const partita = stanze[stanzaAttuale].partite[dati.id];
        if (!partita) return;
        if (partita.fase !== "attesa_giocatori" || partita.iniziata === true) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Questa partita è già iniziata." })); return; }
        if (partita.giocatori[uid]) return;
        if (trovaPartitaAttivaPerUid(uid)) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Fai già parte di un'altra partita." })); return; }
        if (await partitaContieneUtenteBloccato(partita, uid)) {
          socket.send(JSON.stringify({
            tipo: "errore",
            messaggio: "Non puoi entrare in una partita che contiene un giocatore con cui è attivo un blocco."
          }));
          return;
        }
        if (Object.keys(partita.giocatori).length >= partita.maxGiocatori) return;
        if (partita.modalita === "privata") { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Questa è una partita privata: puoi entrare solo se il creatore ti invita direttamente." })); return; }
        if (partita.mediaAttiva === true && dati.mediaConsenso !== true) {
          const requisitoMedia = tipoDispositivo === "cellulare" ? "il microfono" : "webcam e microfono";
          socket.send(JSON.stringify({ tipo: "errore", messaggio: `Per entrare in questo tavolo devi autorizzare ${requisitoMedia}.` }));
          return;
        }
        partita.giocatori[uid] = { nome: nickname, avatar: mioAvatar, posizione: 0, socket, tipoDispositivo, turniSaltati: 0, tentativiAutomaticiConsecutivi: 0, tiriRealiEffettuati: 0 };
        partita.ordineGiocatori.push(uid);

        // Aggiornamento visivo immediato; se Firebase fallisce facciamo rollback.
        inviaListaPartite(stanzaAttuale);
        inviaConteggioStanze();

        try {
          await aggiornaStatoPartita(partita.id, {
            giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
            ordineGiocatori: partita.ordineGiocatori
          });
        } catch (erroreSalvataggio) {
          delete partita.giocatori[uid];
          partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== uid);
          inviaListaPartite(stanzaAttuale);
          inviaConteggioStanze();
          console.error("Errore ingresso partita:", erroreSalvataggio.message);
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è stato possibile entrare nella partita. Riprova." }));
          return;
        }

        if (Object.keys(partita.giocatori).length === partita.maxGiocatori) {
          await avviaPartitaAutomaticamente(partita);
        }

        return;
      }

      if (dati.tipo === "invitaPartita") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        if (partita.fase !== "attesa_giocatori" || partita.iniziata === true) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Questa partita è già iniziata." })); return; }
        if (partita.creatoDa !== uid) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Solo il creatore della partita può invitare altri giocatori." })); return; }
        if (partita.modalita !== "privata") return;
        if (Object.keys(partita.giocatori).length >= partita.maxGiocatori) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "La partita è già al completo." })); return; }
        const destinatarioUid = dati.destinatarioUid;
        if (!destinatarioUid || destinatarioUid === uid || partita.giocatori[destinatarioUid]) return;
        if (await sonoBloccatiTraLoro(uid, destinatarioUid)) {
          socket.send(JSON.stringify({
            tipo: "errore",
            messaggio: "Non puoi invitare questo giocatore perché tra voi è attivo un blocco."
          }));
          return;
        }
        const stanzaOggetto = stanze[nomeStanza];
        if (!stanzaOggetto) return;
        const socketIdDestinatario = Object.keys(stanzaOggetto.giocatoriOnline).find(sid => stanzaOggetto.giocatoriOnline[sid].uid === destinatarioUid);
        if (!socketIdDestinatario) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Questo giocatore non è più online in questa stanza." })); return; }
        if (!partita.invitati) partita.invitati = {};
        partita.invitati[destinatarioUid] = true;
        const socketDestinatario = socketsPerId[socketIdDestinatario];
        const nomeDestinatario = stanzaOggetto.giocatoriOnline[socketIdDestinatario].nickname;
        if (socketDestinatario && socketDestinatario.readyState === WebSocket.OPEN) socketDestinatario.send(JSON.stringify({ tipo: "invitoRicevuto", partitaId: partita.id, stanza: nomeStanza, daUid: uid, daNome: nickname, mediaAttiva: partita.mediaAttiva === true }));
        if (db) db.ref("utenti/" + destinatarioUid + "/notifiche").push({ tipo: "invitoPartita", testo: `${nickname} ti ha invitato a giocare nella stanza ${nomeStanza}`, data: Date.now(), letta: false, daUid: uid, daNome: nickname, stanza: nomeStanza, partitaId: partita.id }).catch(() => {});
        socket.send(JSON.stringify({ tipo: "invitoInviato", destinatarioUid, destinatarioNome: nomeDestinatario }));
        return;
      }

      if (dati.tipo === "rispostaInvito") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        if (!partita.invitati || !partita.invitati[uid]) return;
        if (!dati.accettato) {
          delete partita.invitati[uid];
          const hostGiocatore = partita.giocatori[partita.creatoDa];
          if (hostGiocatore && hostGiocatore.socket && hostGiocatore.socket.readyState === WebSocket.OPEN) hostGiocatore.socket.send(JSON.stringify({ tipo: "invitoRifiutato", destinatarioNome: nickname }));
          return;
        }
        if (partita.fase !== "attesa_giocatori" || partita.iniziata === true) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Questa partita è già iniziata." })); return; }
        if (partita.mediaAttiva === true && dati.mediaConsenso !== true) {
          const requisitoMedia = tipoDispositivo === "cellulare" ? "il microfono" : "webcam e microfono";
          socket.send(JSON.stringify({ tipo: "errore", messaggio: `Per accettare questo invito devi autorizzare ${requisitoMedia}.` }));
          return;
        }
        if (partita.giocatori[uid]) return;
        if (trovaPartitaAttivaPerUid(uid)) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Fai già parte di un'altra partita." })); return; }
        if (await partitaContieneUtenteBloccato(partita, uid)) {
          delete partita.invitati[uid];
          socket.send(JSON.stringify({
            tipo: "errore",
            messaggio: "Non puoi entrare: nella partita è presente un giocatore con cui è attivo un blocco."
          }));
          return;
        }
        if (Object.keys(partita.giocatori).length >= partita.maxGiocatori) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "La partita si è già riempita." })); return; }
        stanzaAttuale = nomeStanza;
        partita.giocatori[uid] = { nome: nickname, avatar: mioAvatar, posizione: 0, socket, tipoDispositivo, turniSaltati: 0, tentativiAutomaticiConsecutivi: 0, tiriRealiEffettuati: 0 };
        partita.ordineGiocatori.push(uid);

        inviaListaPartite(nomeStanza);
        inviaConteggioStanze();

        try {
          await aggiornaStatoPartita(partita.id, {
            giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
            ordineGiocatori: partita.ordineGiocatori
          });
        } catch (erroreSalvataggio) {
          delete partita.giocatori[uid];
          partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== uid);
          inviaListaPartite(nomeStanza);
          inviaConteggioStanze();
          console.error("Errore accettazione invito:", erroreSalvataggio.message);
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è stato possibile entrare nella partita. Riprova." }));
          return;
        }

        delete partita.invitati[uid];

        if (Object.keys(partita.giocatori).length === partita.maxGiocatori) {
          await avviaPartitaAutomaticamente(partita);
        }

        return;
      }

      if (dati.tipo === "eliminaPartita") {
        if (!stanzaAttuale || !uid) return;
        const idDaEliminare = Object.keys(stanze[stanzaAttuale].partite).find(pid => stanze[stanzaAttuale].partite[pid].creatoDa === uid);
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
        try {
          await registraLogChat({
            uid,
            nome: nickname,
            testo,
            ambito: "lobby",
            stanza: stanzaAttuale
          });
        } catch (erroreLog) {
          console.error("Errore salvataggio log chat Lobby:", erroreLog.message);
        }

        await inviaChatLobbyFiltrata(
          stanzaAttuale,
          uid,
          { tipo: "chat", uid, nome: nickname, testo }
        );
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
        if (partita.chatAttiva === false) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "La chat è disattivata in questa partita." })); return; }
        const mittente = partita.giocatori[uid];
        if (!mittente || mittente.socket !== socket) return;
        try {
          await registraLogChat({
            uid,
            nome: mittente.nome,
            testo,
            ambito: "partita",
            stanza: trovato.nomeStanza,
            partitaId: partita.id
          });
        } catch (erroreLog) {
          console.error("Errore salvataggio log chat Partita:", erroreLog.message);
        }

        await inviaChatPartitaFiltrata(
          partita,
          uid,
          { tipo: "chatPartita", nome: mittente.nome, testo }
        );
        return;
      }

      if (dati.tipo === "tiraDeterminazione") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        if (partita.fase !== "determinazione_ordine") return;
        if (!partita.giocatori[uid] || partita.giocatori[uid].socket !== socket) return;
        if (partita.turnoInCorsoDeterminazione !== uid) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è il tuo turno per tirare." })); return; }
        if (partita.scadenzaTurno && Date.now() >= partita.scadenzaTurno) return;
        if (partita.giocatori[uid]) partita.giocatori[uid].tentativiAutomaticiConsecutivi = 0;
        await eseguiTiroDeterminazionePerGiocatore(partita, nomeStanza, uid, false);
        return;
      }

      if (dati.tipo === "tiraDadi") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        if (partita.fase !== "in_corso") return;
        if (!partita.giocatori[uid] || partita.giocatori[uid].socket !== socket) return;
        if (partita.ordineGiocatori[partita.turnoAttuale] !== uid) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è il tuo turno!" }));
          return;
        }
        if (partita.scadenzaTurno && Date.now() >= partita.scadenzaTurno) return;
        if (partita.giocatori[uid]) partita.giocatori[uid].tentativiAutomaticiConsecutivi = 0;
        await eseguiTiroDadiPerGiocatore(partita, nomeStanza, uid, false);
        return;
      }

      if (dati.tipo === "abbandonaPartita") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        if (!partita.giocatori[uid] || partita.giocatori[uid].socket !== socket) return;
        rimuoviPartecipanteMedia(partita, uid);

        if (partita.fase === "attesa_giocatori") {
          await esciDaPartitaInAttesa(partita, nomeStanza, uid);
          return;
        }

        if (partita.fase === "determinazione_ordine") {
          const eraIlSuoTurnoDiTirare = partita.turnoInCorsoDeterminazione === uid;
          fermaTimerTurno(partita);
          rimuoviGiocatoreDaDeterminazione(partita, uid);
          const restanti = Object.keys(partita.giocatori);
          if (restanti.length <= 1) {
            await rimuoviPartita(nomeStanza, partita.id);
          } else {
            if (eraIlSuoTurnoDiTirare) partita.turnoInCorsoDeterminazione = null;
            await avanzaDeterminazione(partita, nomeStanza);
          }
          inviaListaPartite(nomeStanza);
          inviaConteggioStanze();
          return;
        }

        // ===== PARTITA IN CORSO =====
        const eraLuiIlGiocatoreAttivo = partita.ordineGiocatori[partita.turnoAttuale] === uid;
        const idGiocatoreAttivoPrimaDiRimuovere = eraLuiIlGiocatoreAttivo ? null : partita.ordineGiocatori[partita.turnoAttuale];
        const elencoPartecipantiOriginali = partita.ordineGiocatori.map(id => ({ uid: id, nome: partita.giocatori[id] ? partita.giocatori[id].nome : "?" }));
        const nomeUscente = partita.giocatori[uid].nome;

        delete partita.giocatori[uid];
        partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== uid);
        const restanti = Object.keys(partita.giocatori);

        if (restanti.length === 0) {
          await rimuoviPartita(nomeStanza, partita.id);
          inviaListaPartite(nomeStanza);
          inviaConteggioStanze();
          return;
        }

        if (!eraLuiIlGiocatoreAttivo) {
          const nuovoIndice = partita.ordineGiocatori.indexOf(idGiocatoreAttivoPrimaDiRimuovere);
          partita.turnoAttuale = nuovoIndice >= 0 ? nuovoIndice : 0;
        } else if (partita.turnoAttuale >= partita.ordineGiocatori.length) {
          partita.turnoAttuale = 0;
        }

        if (restanti.length === 1 && partita.iniziata) {
          const vincitoreId = restanti[0];
          const vincitoreNome = partita.giocatori[vincitoreId].nome;
          const statoGiocatori = costruisciStatoGiocatori(partita);
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) g.socket.send(JSON.stringify({ tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: vincitoreId, vittoria: true, vincitore: vincitoreNome, messaggi: [nomeUscente + " ha abbandonato la partita."] }));
          });
          await rimuoviPartita(nomeStanza, partita.id);
          await concludiPartita(partita, vincitoreId, nomeStanza, elencoPartecipantiOriginali);
        } else {
          if (eraLuiIlGiocatoreAttivo) {
            partita.tiriEffettuatiNelTurno = 0;
            partita.tiriConsentitiNelTurno = 1;
            partita.animazioneTiroInCorso = false;
            avviaTimerTurno(partita, nomeStanza);
          }
          const idAttuale = partita.ordineGiocatori[partita.turnoAttuale];
          const statoGiocatori = costruisciStatoGiocatori(partita);
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({
                tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: idAttuale,
                messaggi: [nomeUscente + " ha abbandonato la partita."],
                tempoInizioTurno: partita.tempoInizioTurno || null,
                scadenzaTurno: partita.scadenzaTurno || null,
                durataMossaMs: millisecondiMossa(partita), tempoResiduoMs: tempoResiduoVisibileMs(partita),
                tiriEffettuatiNelTurno: partita.tiriEffettuatiNelTurno,
                tiriConsentitiNelTurno: partita.tiriConsentitiNelTurno
              }));
            }
          });
          await aggiornaStatoPartita(partita.id, {
            giocatori: preparaGiocatoriPerFirebase(partita.giocatori),
            ordineGiocatori: partita.ordineGiocatori,
            turnoAttuale: partita.turnoAttuale,
            tiriEffettuatiNelTurno: partita.tiriEffettuatiNelTurno,
            tiriConsentitiNelTurno: partita.tiriConsentitiNelTurno,
            tempoInizioTurno: partita.tempoInizioTurno || null,
            scadenzaTurno: partita.scadenzaTurno || null,
            iniziata: partita.iniziata
          });
        }

        inviaListaPartite(nomeStanza);
        inviaConteggioStanze();
        return;
      }

    } catch (erroreInterno) {
      console.error("Errore nella gestione di un messaggio:", erroreInterno);
    }
  });

socket.on("close", async () => {
  try {
    delete socketsPerId[socketId];

    if (!stanzaAttuale || !stanze[stanzaAttuale]) return;

    const nomeStanza = stanzaAttuale;

    // Rimuove esclusivamente questa connessione.
    delete stanze[nomeStanza].giocatoriOnline[socketId];

    // Aggiorna subito la presenza, prima di qualsiasi await su Firebase.
    inviaConteggioStanze();

    // Rimuove il socket dal roster media. Nelle partite in corso il giocatore
    // resta al tavolo e potrà riconnettersi; in attesa viene invece alzato.
    const partite = stanze[nomeStanza].partite;

    for (const pid in partite) {
      const partita = partite[pid];
      const giocatore = partita.giocatori[uid];
      if (!giocatore) continue;
      if (giocatore.socket && giocatore.socket !== socket) continue;
      rimuoviPartecipanteMedia(partita, uid);

      if (partita.fase === "attesa_giocatori") {
        await esciDaPartitaInAttesa(partita, nomeStanza, uid);
      } else {
        giocatore.socket = null;
      }
    }

    inviaListaPartite(nomeStanza);
    inviaConteggioStanze();

  } catch (erroreInterno) {
    console.error(
      "Errore nella chiusura di una connessione:",
      erroreInterno
    );
  }
});

});

server.listen(PORT, async () => {
  console.log("Server avviato sulla porta " + PORT);
  await ripristinaPartiteDaFirebase();
});
