const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cambia-questo-secret";

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

function creaToken(uid, nickname, ruolo) {
  return jwt.sign({ uid, nickname, ruolo }, JWT_SECRET, { expiresIn: "30d" });
}
function verificaToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}
function estraiTokenHeader(req) {
  const header = req.headers.authorization || "";
  const parti = header.split(" ");
  return parti.length === 2 ? parti[1] : null;
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
async function trovaUtentePerNickname(nicknameLower) {
  const snap = await db.ref("utenti").orderByChild("nicknameLower").equalTo(nicknameLower).once("value");
  if (!snap.exists()) return null;
  const val = snap.val();
  const uid = Object.keys(val)[0];
  return { uid, ...val[uid] };
}

app.post("/api/registrati", async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile al momento." });
  try {
    const { email, nickname, password } = req.body;
    if (!email || !nickname || !password) return res.status(400).json({ errore: "Compila tutti i campi." });
    if (password.length < 6) return res.status(400).json({ errore: "La password deve avere almeno 6 caratteri." });

    const emailLower = email.trim().toLowerCase();
    const nicknameLower = nickname.trim().toLowerCase();

    if (await trovaUtentePerEmail(emailLower)) return res.status(400).json({ errore: "Questa email è già registrata." });
    if (await trovaUtentePerNickname(nicknameLower)) return res.status(400).json({ errore: "Questo nickname è già in uso." });

    const passwordHash = await bcrypt.hash(password, 10);
    const nuovoRef = db.ref("utenti").push();
    const uid = nuovoRef.key;

    await nuovoRef.set({
      partiteVinte: 0,
      partiteGiocate: 0,
      puntiTotali: 0,
      email: email.trim(), emailLower,
      nickname: nickname.trim(), nicknameLower,
      passwordHash,
      ruolo: "utente",
      stato: "attivo",
      sospesoFino: null,
      avvisi: [],
      creatoIl: Date.now()
    });

    const token = creaToken(uid, nickname.trim(), "utente");
    res.json({ token, nickname: nickname.trim(), ruolo: "utente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server, riprova." });
  }
});

app.post("/api/login", async (req, res) => {
  if (!db) return res.status(500).json({ errore: "Servizio account non disponibile al momento." });
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ errore: "Inserisci email e password." });

    const utente = await trovaUtentePerEmail(email.trim().toLowerCase());
    if (!utente) return res.status(400).json({ errore: "Email o password errati." });

    const passwordOk = await bcrypt.compare(password, utente.passwordHash);
    if (!passwordOk) return res.status(400).json({ errore: "Email o password errati." });

    if (utente.stato === "bannato") return res.status(403).json({ errore: "Il tuo account è stato bannato." });

    if (utente.stato === "sospeso") {
      if (utente.sospesoFino && utente.sospesoFino > Date.now()) {
        const dataFine = new Date(utente.sospesoFino).toLocaleString("it-IT");
        return res.status(403).json({ errore: "Account sospeso fino al " + dataFine + "." });
      } else {
        await db.ref("utenti/" + utente.uid).update({ stato: "attivo", sospesoFino: null });
        utente.stato = "attivo";
      }
    }

    const token = creaToken(utente.uid, utente.nickname, utente.ruolo || "utente");
    res.json({ token, nickname: utente.nickname, ruolo: utente.ruolo || "utente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ errore: "Errore del server, riprova." });
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
  await db.ref("utenti/" + uid).update({ stato: "bannato", motivoBan: motivo || "" });
  res.json({ ok: true });
});

app.post("/api/admin/riattiva", richiediAdmin, async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ errore: "Dati mancanti." });
  await db.ref("utenti/" + uid).update({ stato: "attivo", sospesoFino: null });
  res.json({ ok: true });
});

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
      nuovaPosizione: r.nuovaPosizione,
      percorso: percorso.concat(r.percorso),
      messaggi: messaggi.concat(r.messaggi),
      turniDaSaltare: r.turniDaSaltare,
      vittoria: r.vittoria,
      tiraAncora: r.tiraAncora
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
    if (giocatoreProssimo.turniSaltati > 0) { giocatoreProssimo.turniSaltati--; tentativi++; } else break;
  } while (tentativi < partita.ordineGiocatori.length);
}

function trovaPartita(partitaId) {
  for (const nomeStanza in stanze) {
    if (stanze[nomeStanza].partite[partitaId]) return { partita: stanze[nomeStanza].partite[partitaId], nomeStanza };
  }
  return null;
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
    const nomiGiocatori = Object.values(stanze[nome].giocatoriOnline);
    conteggi[nome] = nomiGiocatori.length;
    giocatoriPerStanza[nome] = nomiGiocatori;
  }
  const messaggio = JSON.stringify({ tipo: "conteggioStanze", stanze: conteggi, giocatori: giocatoriPerStanza });
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(messaggio); });
}

const HEARTBEAT_MS = 15000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(socket => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeatInterval));

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  const socketId = "s" + (contatoreId++);
  socketsPerId[socketId] = socket;

  let stanzaAttuale = null;
  let nickname = null;
  let uid = null;

  socket.on("message", async (message) => {
    try {
      let dati;
      try { dati = JSON.parse(message); } catch (e) { return; }

      if (dati.tipo === "richiediConteggio") { inviaConteggioStanze(); return; }

      if (dati.tipo === "entraLobby") {
        if (!db) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Servizio account non disponibile." })); return; }
        const datiToken = verificaToken(dati.token);
        if (!datiToken) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }

        const snap = await db.ref("utenti/" + datiToken.uid).once("value");
        const utenteDb = snap.val();
        if (!utenteDb) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }
        if (utenteDb.stato === "bannato") { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Il tuo account è stato bannato." })); return; }
        if (utenteDb.stato === "sospeso" && utenteDb.sospesoFino && utenteDb.sospesoFino > Date.now()) {
          const dataFine = new Date(utenteDb.sospesoFino).toLocaleString("it-IT");
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Account sospeso fino al " + dataFine + "." }));
          return;
        }

        if (!dati.stanza) return;
        stanzaAttuale = dati.stanza;
        uid = datiToken.uid;
        nickname = utenteDb.nickname;

        if (!stanze[stanzaAttuale]) stanze[stanzaAttuale] = { giocatoriOnline: {}, partite: {} };
        stanze[stanzaAttuale].giocatoriOnline[socketId] = nickname;

        inviaConteggioStanze();
        inviaAllaStanza(stanzaAttuale, { tipo: "online", numero: Object.keys(stanze[stanzaAttuale].giocatoriOnline).length });
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "riprendiPartita") {
        const datiToken = verificaToken(dati.token);
        if (!datiToken) { socket.send(JSON.stringify({ tipo: "sessioneScaduta" })); return; }

        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Partita non trovata." })); return; }
        const { partita, nomeStanza } = trovato;
        stanzaAttuale = nomeStanza;
        uid = datiToken.uid;
        nickname = datiToken.nickname;

        const mioGiocatore = partita.giocatori[uid];
        if (!mioGiocatore) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non fai parte di questa partita." })); return; }
        mioGiocatore.socket = socket;

        const statoGiocatori = partita.ordineGiocatori.map(id => ({ id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione }));
        socket.send(JSON.stringify({ tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: partita.ordineGiocatori[partita.turnoAttuale] }));
        return;
      }

      if (dati.tipo === "creaPartita") {
        if (!stanzaAttuale || !uid) return;
        const haGiaCreato = Object.values(stanze[stanzaAttuale].partite).some(p => p.creatoDa === uid);
        if (haGiaCreato) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Hai già una partita attiva." })); return; }

        const partitaId = "p" + Date.now() + Math.floor(Math.random() * 1000);
        stanze[stanzaAttuale].partite[partitaId] = {
          id: partitaId, creatore: nickname, creatoDa: uid,
          tempo: dati.tempo, punti: dati.punti, modalita: dati.modalita,
          codicePrivato: dati.modalita === "privata" ? dati.codicePrivato : null,
          maxGiocatori: parseInt(dati.maxGiocatori) || 2,
          giocatori: { [uid]: { nome: nickname, posizione: 0, socket, turniSaltati: 0 } },
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

        partita.giocatori[uid] = { nome: nickname, posizione: 0, socket, turniSaltati: 0 };
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
        inviaAllaStanza(stanzaAttuale, { tipo: "chat", nome: nickname, testo: dati.testo });
        return;
      }

      if (dati.tipo === "chatPartita") {
        if (!uid) return;
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const partita = trovato.partita;
        const mittente = partita.giocatori[uid];
        if (!mittente) return;
        Object.values(partita.giocatori).forEach(g => {
          if (g.socket && g.socket.readyState === WebSocket.OPEN) {
            g.socket.send(JSON.stringify({ tipo: "chatPartita", nome: mittente.nome, testo: dati.testo }));
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

        // Fix: lucchetto anti doppio-tiro durante l'attesa di random.org (mancava)
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

          const statoGiocatori = partita.ordineGiocatori.map(id => ({ id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione }));
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
          const statoGiocatori = partita.ordineGiocatori.map(id => ({ id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione }));
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({ tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: vincitoreId, vittoria: true, vincitore: vincitoreNome, messaggi: [nomeUscente + " ha abbandonato la partita."] }));
            }
          });
          await aggiornaStatistichePartitaConclusa(partita, vincitoreId);
          await rimuoviPartita(nomeStanza, partita.id);
        } else {
          const idAttuale = partita.ordineGiocatori[partita.turnoAttuale];
          const statoGiocatori = partita.ordineGiocatori.map(id => ({ id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione }));
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
