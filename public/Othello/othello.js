"use strict";

/* =========================================================
   OTHELLO (REVERSI) — stessa architettura di Dama/Gioco dell'Oca.
   Il nero muove sempre per primo. Niente dadi né fase "Chi inizia".
   I dischi catturati NON escono dalla tavola: si limitano a
   girare colore con un flip 3D, come nel gioco reale.
   Videochiamata di tavolo integrata (stessa logica dell'Oca).
   ========================================================= */

const origineConfigurata = typeof window.GIOCO_SERVER_URL === "string" ? window.GIOCO_SERVER_URL.trim() : "";
const hostLocale = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "[::1]";
const paginaSulServerUfficiale = window.location.hostname === "api.giochisocieta.com";
const ORIGINE_SERVER = (origineConfigurata || ((hostLocale || paginaSulServerUfficiale)
  ? window.location.origin
  : "https://api.giochisocieta.com")).replace(/\/$/, "");
const URL_WEBSOCKET = ORIGINE_SERVER.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita") || params.get("id") || "";
const stanza = params.get("stanza") || "othello";
const CHIAVE_TOKEN_AUTH = "giochiSocietaAuthToken";

let socket = null;
let timerRiconnessione = null;
let paginaInChiusura = false;
let mioUid = null;
let mioColore = null;
let mosseLegaliCorrenti = [];
let chatPartitaAttiva = true;
let messaggiChatNonLetti = 0;
let graficaCaricata = false;
let statoInizialeRicevuto = false;
let timerMassimoCaricamento = null;
let percentualeCaricamento = 10;
let presentazioneSfidaAperta = false;
let timerChiusuraPresentazioneSfida = null;
let avvisoTempoChiave = "";
let mossaInAttesa = false;
let timerMossaInAttesa = null;
let vittoriaMostrata = false;

let ultimoNumeroMossaAccettato = -1;

/* =========================================================
   MOTORE DI REGOLE OTHELLO
   ========================================================= */

const DIREZIONI_OTHELLO = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1]
];

function tavolaInizialeOthello() {
  const t = Array.from({ length: 8 }, () => Array(8).fill(null));
  t[3][3] = "bianco";
  t[3][4] = "nero";
  t[4][3] = "nero";
  t[4][4] = "bianco";
  return t;
}

function catturePerCella(tavola, r, c, colore) {
  if (!colore || tavola[r][c]) return [];
  const avversario = colore === "nero" ? "bianco" : "nero";
  let totali = [];
  for (const [dr, dc] of DIREZIONI_OTHELLO) {
    let rr = r + dr, cc = c + dc;
    const linea = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && tavola[rr][cc] === avversario) {
      linea.push({ r: rr, c: cc });
      rr += dr; cc += dc;
    }
    if (linea.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && tavola[rr][cc] === colore) {
      totali = totali.concat(linea);
    }
  }
  return totali;
}

function mosseLegaliPer(tavola, colore) {
  const mosse = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const catture = catturePerCella(tavola, r, c, colore);
      if (catture.length) mosse.push({ r, c, catture });
    }
  }
  return mosse;
}

function contaDischi(tavola) {
  let nero = 0, bianco = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (tavola[r][c] === "nero") nero++;
    else if (tavola[r][c] === "bianco") bianco++;
  }
  return { nero, bianco };
}

function tavolaValida(tavola) {
  return Array.isArray(tavola) && tavola.length === 8
    && tavola.every(riga => Array.isArray(riga) && riga.length === 8
      && riga.every(cella => cella === null || cella === "nero" || cella === "bianco"));
}

function copiaTavola(tavola) {
  return tavola.map(riga => riga.slice());
}

function coloreValido(colore) {
  return colore === "nero" || colore === "bianco";
}

function avversarioDi(colore) {
  return colore === "nero" ? "bianco" : colore === "bianco" ? "nero" : null;
}

function coloreUtenteDaPartita(partita = stato) {
  const scheda = mioUid && partita?.giocatori ? partita.giocatori[mioUid] : null;
  if (scheda && coloreValido(scheda.colore)) return scheda.colore;
  return coloreValido(mioColore) ? mioColore : null;
}

function sincronizzaIdentitaDaPartita(partita, coloreFallback = null) {
  const canonico = coloreUtenteDaPartita(partita);
  if (canonico) {
    if (mioColore && mioColore !== canonico) {
      console.warn("Othello: colore locale corretto dal colore canonico della partita", {
        precedente: mioColore,
        corretto: canonico,
        uid: mioUid
      });
    }
    mioColore = canonico;
    return canonico;
  }
  if (coloreValido(coloreFallback)) {
    mioColore = coloreFallback;
    return mioColore;
  }
  return null;
}

/* =========================================================
   STATO
   ========================================================= */

let stato = {
  id: partitaId || null,
  stanza,
  fase: "attesa_giocatori",
  iniziata: false,
  turno: "nero",
  tavola: tavolaInizialeOthello(),
  giocatori: {},
  numeroMossa: 0,
  ultimoMovimento: null,
  scadenzaTurno: null,
  durataTurnoMs: null,
  classificata: true,
  vincitoreUid: null,
  motivoFine: null
};
let ultimoStatoRicevuto = stato;
let attesaSnapshot = true;

/* =========================================================
   TOKEN / SOCKET
   ========================================================= */

function tokenAutenticazione() {
  try {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const daUrl = hash.get("auth_token");
    if (daUrl) {
      sessionStorage.setItem(CHIAVE_TOKEN_AUTH, daUrl);
      hash.delete("auth_token");
      history.replaceState(null, "", location.pathname + location.search + (hash.toString() ? "#" + hash.toString() : ""));
      return daUrl;
    }
    return sessionStorage.getItem(CHIAVE_TOKEN_AUTH) || "";
  } catch (_) {
    return "";
  }
}

function inviaSocket(dati) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    const token = tokenAutenticazione();
    socket.send(JSON.stringify(token ? { ...dati, token } : dati));
    return true;
  } catch (errore) {
    console.error("Invio WebSocket non riuscito:", errore);
    return false;
  }
}

function impostaStatoConnessione(disconnesso) {
  const banner = document.getElementById("banner-disconnesso");
  if (banner) banner.classList.toggle("nascosto", !disconnesso);
  document.body.classList.toggle("disconnesso", disconnesso);
}

/* =========================================================
   CARICAMENTO
   ========================================================= */

function aggiornaCaricamento(testo, percentuale) {
  const testoEl = document.getElementById("caricamento-testo");
  const barra = document.getElementById("caricamento-progress-bar");
  const progresso = document.getElementById("caricamento-progress");
  if (testoEl && testo) testoEl.textContent = testo;
  if (Number.isFinite(percentuale)) {
    percentualeCaricamento = Math.max(percentualeCaricamento, Math.max(0, Math.min(100, percentuale)));
    if (barra) barra.style.width = percentualeCaricamento + "%";
    if (progresso) progresso.setAttribute("aria-valuenow", String(percentualeCaricamento));
  }
}

function terminaCaricamento(testoFinale) {
  const overlay = document.getElementById("overlay-caricamento");
  if (!overlay || overlay.classList.contains("caricamento-finito")) return;
  aggiornaCaricamento(testoFinale || "Partita pronta", 100);
  document.body.classList.remove("caricamento-in-corso");
  if (timerMassimoCaricamento) {
    clearTimeout(timerMassimoCaricamento);
    timerMassimoCaricamento = null;
  }
  setTimeout(() => overlay.classList.add("caricamento-finito"), 180);
}

function verificaFineCaricamento() {
  if (graficaCaricata && statoInizialeRicevuto) terminaCaricamento();
}

function segnalaGraficaCaricata() {
  graficaCaricata = true;
  aggiornaCaricamento(statoInizialeRicevuto ? "Partita pronta" : "Connessione alla partita…", statoInizialeRicevuto ? 100 : 55);
  verificaFineCaricamento();
}

function segnalaStatoInizialeRicevuto() {
  if (statoInizialeRicevuto) return;
  statoInizialeRicevuto = true;
  aggiornaCaricamento(graficaCaricata ? "Partita pronta" : "Caricamento tavola…", graficaCaricata ? 100 : 85);
  verificaFineCaricamento();
}

/* =========================================================
   NOTIFICHE / FLASH
   ========================================================= */

function mostraNotificaGioco(testo) {
  const contenitore = document.getElementById("contenitore-notifiche-gioco");
  if (!contenitore) {
    console.error(testo);
    return;
  }
  const toast = document.createElement("div");
  toast.className = "notifica-toast-gioco";
  toast.textContent = testo;
  contenitore.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

let timerFlashMessaggio = null;
function mostraMessaggioGiocoGrande(testo, opzioni = {}) {
  const overlay = document.getElementById("flash-messaggio-gioco");
  const titolo = document.getElementById("flash-titolo-gioco");
  const dettaglio = document.getElementById("flash-dettaglio-gioco");
  const icona = document.getElementById("flash-icona-gioco");
  if (!overlay || !titolo || !testo) return;

  clearTimeout(timerFlashMessaggio);
  titolo.textContent = testo;

  if (dettaglio) {
    dettaglio.textContent = opzioni.dettaglio || "";
    dettaglio.hidden = !opzioni.dettaglio;
  }
  if (icona) {
    icona.textContent = opzioni.icona || "";
    icona.hidden = !opzioni.icona;
  }

  const durata = Math.max(900, Number(opzioni.durata) || 2200);
  overlay.style.setProperty("--durata-flash-gioco", durata + "ms");
  overlay.classList.remove("visibile");
  void overlay.offsetWidth;
  overlay.classList.add("visibile");
  timerFlashMessaggio = setTimeout(() => overlay.classList.remove("visibile"), durata);
}

/* =========================================================
   AUDIO
   ========================================================= */

let suoniAttivi = true;
try { suoniAttivi = localStorage.getItem("suoniAttivi") !== "off"; } catch (_) {}
let contestoAudio = null;
let interazioneUtenteRegistrata = false;

function ottieniContestoAudio() {
  if (!interazioneUtenteRegistrata) return null;
  if (!contestoAudio) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { contestoAudio = new C(); } catch (_) { return null; }
  }
  if (contestoAudio.state === "suspended") {
    const p = contestoAudio.resume();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }
  return contestoAudio;
}

function registraPrimaInterazioneAudio() {
  interazioneUtenteRegistrata = true;
  document.removeEventListener("pointerdown", registraPrimaInterazioneAudio, true);
  document.removeEventListener("keydown", registraPrimaInterazioneAudio, true);
  if (suoniAttivi) ottieniContestoAudio();
}

document.addEventListener("pointerdown", registraPrimaInterazioneAudio, { capture: true, passive: true });
document.addEventListener("keydown", registraPrimaInterazioneAudio, true);

function suonaTono(frequenza, durataMs, tipoOnda = "sine", volume = 0.1, ritardoMs = 0) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  const inizio = ctx.currentTime + ritardoMs / 1000;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = tipoOnda;
  osc.frequency.setValueAtTime(frequenza, inizio);
  gain.gain.setValueAtTime(0, inizio);
  gain.gain.linearRampToValueAtTime(volume, inizio + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, inizio + durataMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(inizio);
  osc.stop(inizio + durataMs / 1000 + 0.02);
}

function suonaPosa() { suonaTono(500, 55, "sine", 0.09, 0); }
function suonaFlip(ritardoMs) { suonaTono(320, 70, "triangle", 0.07, ritardoMs); }
function suonaTuoTurno() { suonaTono(660, 120, "sine", 0.11, 0); suonaTono(880, 160, "sine", 0.11, 120); }
function suonaVittoria() { suonaTono(523, 130, "sine", 0.13, 0); suonaTono(659, 130, "sine", 0.13, 130); suonaTono(784, 130, "sine", 0.13, 260); suonaTono(1047, 260, "sine", 0.14, 390); }
function suonaMessaggioChat() { suonaTono(740, 70, "sine", 0.08, 0); }
function suonaAvvisoTempo() { suonaTono(300, 90, "triangle", 0.14, 0); }

function toggleSuoni() { impostaSuoni(!suoniAttivi); }
function impostaSuoni(attivi) {
  suoniAttivi = !!attivi;
  try { localStorage.setItem("suoniAttivi", suoniAttivi ? "on" : "off"); } catch (_) {}
  if (suoniAttivi && interazioneUtenteRegistrata) ottieniContestoAudio();
  aggiornaTestoBottoneSuoni();
}
function aggiornaTestoBottoneSuoni() {
  const b = document.getElementById("btn-toggle-suoni");
  if (b) b.textContent = suoniAttivi ? "🔊 Suoni: On" : "🔇 Suoni: Off";
}

/* =========================================================
   FULLSCREEN / LAYOUT
   ========================================================= */

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const elemento = document.documentElement;
      const richiesta = elemento.requestFullscreen || elemento.webkitRequestFullscreen || elemento.mozRequestFullScreen || elemento.msRequestFullscreen;
      if (!richiesta) {
        mostraNotificaGioco("Il tuo browser non supporta lo schermo intero.");
        return;
      }
      const risultato = richiesta.call(elemento);
      if (risultato && typeof risultato.catch === "function") risultato.catch(() => mostraNotificaGioco("Non è stato possibile attivare lo schermo intero."));
    } else {
      const esci = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (esci) esci.call(document);
    }
  } catch (_) {
    mostraNotificaGioco("Errore durante l'attivazione dello schermo intero.");
  }
}

function aggiornaTestoBottoneFullscreen() {
  const b = document.getElementById("btn-toggle-fullscreen");
  if (!b) return;
  b.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? "🡼 Esci da tutto schermo" : "⛶ Tutto schermo";
}

document.addEventListener("fullscreenchange", aggiornaTestoBottoneFullscreen);
document.addEventListener("webkitfullscreenchange", aggiornaTestoBottoneFullscreen);

function rilevaEImpostaModalitaDesktop() {
  const puntatorePreciso = !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches);
  const eDesktop = puntatorePreciso && window.innerWidth >= 1000;
  document.body.classList.toggle("modalita-desktop", eDesktop);
}

function aggiornaLayoutTabellone() {
  const areaTabellone = document.getElementById("area-tabellone");
  const mondo = document.getElementById("mondo-ruotato");
  if (!areaTabellone || !mondo) return;

  const videoDesktopAttivo = document.body.classList.contains("modalita-desktop") && document.body.classList.contains("media-partita");
  const larghezzaFinestra = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const altezzaReale = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--altezza-reale", altezzaReale + "px");

  mondo.style.width = larghezzaFinestra + "px";
  mondo.style.height = altezzaReale + "px";

  const altezzaRaccolta = larghezzaFinestra < 600 ? 38 : 46;
  document.documentElement.style.setProperty("--altezza-raccolta", altezzaRaccolta + "px");
  const margineOrizzontale = Math.max(10, larghezzaFinestra * 0.015);
  const spazioRaccolte = 2 * (altezzaRaccolta + 6);
  let larghezzaDisponibile = larghezzaFinestra - margineOrizzontale * 2;
  const altezzaDisponibile = altezzaReale - spazioRaccolte - 20;

  if (videoDesktopAttivo) {
    const larghezzaColonnaDesiderata = Math.min(340, Math.max(160, larghezzaFinestra * 0.16));
    const distanzaDalTabellone = Math.max(12, larghezzaFinestra * 0.012);
    larghezzaDisponibile = Math.max(320, larghezzaFinestra - (larghezzaColonnaDesiderata + distanzaDalTabellone) * 2);
  }

  const lato = Math.max(120, Math.min(larghezzaDisponibile, altezzaDisponibile));

  if (videoDesktopAttivo) {
    const spazioLaterale = (larghezzaFinestra - lato) / 2;
    const margineEsterno = Math.max(14, larghezzaFinestra * 0.012);
    const larghezzaColonnaVideo = Math.max(120, Math.min(340, spazioLaterale - margineEsterno - 10));
    document.documentElement.style.setProperty("--larghezza-colonna-video", larghezzaColonnaVideo + "px");
  } else {
    document.documentElement.style.removeProperty("--larghezza-colonna-video");
  }

  const puntatorePreciso = !!window.matchMedia?.("(pointer: fine)").matches;
  document.body.classList.toggle("modalita-desktop", puntatorePreciso && larghezzaFinestra >= 1000 && larghezzaFinestra - lato >= 600);

  areaTabellone.style.width = lato + "px";
  areaTabellone.style.height = lato + "px";
}

let timerDebounceResize = null;
function gestisciResize() {
  rilevaEImpostaModalitaDesktop();
  clearTimeout(timerDebounceResize);
  timerDebounceResize = setTimeout(aggiornaLayoutTabellone, 60);
}

function inizializzaGestioneLayout() {
  rilevaEImpostaModalitaDesktop();
  aggiornaLayoutTabellone();
  window.addEventListener("resize", gestisciResize);
  window.addEventListener("orientationchange", () => setTimeout(gestisciResize, 300));
  if (window.visualViewport) window.visualViewport.addEventListener("resize", gestisciResize);
  requestAnimationFrame(() => {
    aggiornaLayoutTabellone();
    segnalaGraficaCaricata();
  });
}

/* =========================================================
   VIDEOCHIAMATA DI TAVOLO — stessa logica del Gioco dell'Oca
   ========================================================= */

const mediaRichiestaDaLobby = params.get("media") === "1";

function rilevaTipoDispositivoMediaLocale() {
  const ua = String(navigator.userAgent || "");
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return "cellulare";
  return "computer";
}

const tipoDispositivoMediaLocale = rilevaTipoDispositivoMediaLocale();
const clientCellulareAudioOnly = tipoDispositivoMediaLocale === "cellulare";
document.body.classList.toggle("client-cellulare-audio-only", clientCellulareAudioOnly);
document.body.classList.toggle("client-tablet", tipoDispositivoMediaLocale === "tablet");
document.body.classList.toggle("client-computer", tipoDispositivoMediaLocale === "computer");

let mediaPartitaAttiva = false;
let flussoMediaLocale = null;
let avvioMediaInCorso = null;
let mediaProntoSegnalato = false;
let mediaRichiedeRiprovaManuale = false;
let puliziaMediaInCorso = false;
let connessioniPeer = {};
let elementiVideoRemoti = {};
let candidatiIceInAttesa = {};
let timerRiprovaPeer = {};
let timerDisconnessionePeer = {};
let partecipantiMediaPronti = new Set();
let partecipantiMediaInfo = new Map();
const nomiPartecipantiMedia = new Map();
let CONFIGURAZIONE_ICE = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
  ],
  iceCandidatePoolSize: 4,
  bundlePolicy: "max-bundle"
};

const VINCOLI_AUDIO = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

const VINCOLI_MEDIA = {
  audio: VINCOLI_AUDIO,
  video: {
    width: { ideal: 320, max: 640 },
    height: { ideal: 240, max: 480 },
    frameRate: { ideal: 15, max: 20 },
    facingMode: { ideal: "user" }
  }
};

function normalizzaTipoDispositivoMedia(tipo) {
  if (tipo === "cellulare" || tipo === "tablet" || tipo === "computer") return tipo;
  return "computer";
}

function descrittoreMediaPerUid(uid) {
  const salvato = partecipantiMediaInfo.get(uid);
  if (salvato) return salvato;
  const giocatore = giocatoriStato().find(g => g && g.uid === uid);
  const tipoDispositivo = normalizzaTipoDispositivoMedia(giocatore && giocatore.tipoDispositivo);
  return {
    uid,
    tipoDispositivo,
    videoDisponibile: tipoDispositivo !== "cellulare"
  };
}

function peerSupportaVideo(uid) {
  const info = descrittoreMediaPerUid(uid);
  return info.tipoDispositivo !== "cellulare" && info.videoDisponibile !== false;
}

function streamLocaleMediaPronto(stream) {
  if (!stream) return false;
  const audioVivo = stream.getAudioTracks().some(t => t.readyState === "live");
  if (!audioVivo) return false;
  if (clientCellulareAudioOnly) return true;
  return stream.getVideoTracks().some(t => t.readyState === "live");
}

function aspettaWebRtc(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nomeErroreMediaPartita(errore) {
  return String(errore && errore.name ? errore.name : "");
}

function descriviErroreMediaPartita(errore) {
  const nome = nomeErroreMediaPartita(errore);
  if (nome === "NotAllowedError" || nome === "SecurityError" || nome === "PermissionDeniedError") {
    return clientCellulareAudioOnly
      ? "Permesso negato: abilita il microfono nelle impostazioni del browser."
      : "Permesso negato: abilita webcam e microfono nelle impostazioni del browser.";
  }
  if (nome === "NotFoundError" || nome === "DevicesNotFoundError") {
    return clientCellulareAudioOnly ? "Microfono non trovato." : "Webcam o microfono non trovati.";
  }
  if (nome === "NotReadableError" || nome === "TrackStartError") {
    return clientCellulareAudioOnly
      ? "Il microfono è occupato da un'altra app o scheda."
      : "Webcam o microfono sono occupati da un'altra app o scheda.";
  }
  if (nome === "OverconstrainedError" || nome === "ConstraintNotSatisfiedError") {
    return clientCellulareAudioOnly
      ? "Il dispositivo non supporta le impostazioni audio richieste."
      : "Il dispositivo non supporta le impostazioni video richieste.";
  }
  if (nome === "AbortError") {
    return clientCellulareAudioOnly
      ? "Apertura del microfono interrotta dal browser."
      : "Apertura di webcam o microfono interrotta dal browser.";
  }
  return clientCellulareAudioOnly ? "Microfono non disponibile." : "Webcam o microfono non disponibili.";
}

function aggiornaNomiPartecipanti(dati) {
  if (!dati || !Array.isArray(dati.giocatori)) return;
  dati.giocatori.forEach(giocatore => {
    const uidGiocatore = giocatore && (giocatore.id || giocatore.uid);
    if (!uidGiocatore) return;
    nomiPartecipantiMedia.set(uidGiocatore, giocatore.nome || "Giocatore");
    if (!partecipantiMediaInfo.has(uidGiocatore) && giocatore.tipoDispositivo) {
      const tipoDispositivo = normalizzaTipoDispositivoMedia(giocatore.tipoDispositivo);
      partecipantiMediaInfo.set(uidGiocatore, {
        uid: uidGiocatore,
        tipoDispositivo,
        videoDisponibile: tipoDispositivo !== "cellulare"
      });
    }
  });
  Object.entries(elementiVideoRemoti).forEach(([uidGiocatore, elementi]) => {
    if (elementi && elementi.didascalia) {
      elementi.didascalia.textContent = nomiPartecipantiMedia.get(uidGiocatore) || "Giocatore";
    }
  });
}

function aggiornaConfigurazioneIce(configurazione) {
  if (!configurazione || !Array.isArray(configurazione.iceServers)) return;
  const iceServers = configurazione.iceServers.slice(0, 6).filter(server => {
    const urls = Array.isArray(server && server.urls) ? server.urls : [server && server.urls];
    return urls.length > 0 && urls.every(url => typeof url === "string" && /^(stun|stuns|turn|turns):/i.test(url));
  }).map(server => ({
    urls: server.urls,
    ...(typeof server.username === "string" ? { username: server.username } : {}),
    ...(typeof server.credential === "string" ? { credential: server.credential } : {})
  }));
  if (iceServers.length) {
    CONFIGURAZIONE_ICE = {
      iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: "max-bundle"
    };
  }
}

function aggiornaInterfacciaMedia(testo, errore) {
  const layoutMediaEraAttivo = document.body.classList.contains("media-partita");
  document.body.classList.toggle("media-partita", mediaPartitaAttiva);
  document.body.classList.toggle("client-cellulare-audio-only", clientCellulareAudioOnly);
  if (layoutMediaEraAttivo !== mediaPartitaAttiva) requestAnimationFrame(aggiornaLayoutTabellone);

  const pannello = document.getElementById("videochiamata");
  const statoTesto = document.getElementById("stato-media-connessione");
  const voceMenu = document.getElementById("btn-stato-media");
  if (pannello) pannello.classList.toggle("nascosto", !mediaPartitaAttiva);
  if (statoTesto) {
    statoTesto.textContent = testo || (mediaPartitaAttiva ? "Collegamento…" : "Non attiva");
    statoTesto.style.color = errore ? "#ff8a80" : "";
  }
  if (voceMenu) {
    if (!mediaPartitaAttiva) {
      voceMenu.textContent = "🔇 Videochiamata: non attiva";
    } else if (clientCellulareAudioOnly) {
      voceMenu.textContent = errore ? "⚠️ Microfono: verifica necessaria" : "🎙️ Chiamata audio attiva";
    } else {
      voceMenu.textContent = errore ? "⚠️ Webcam/microfono: verifica necessaria" : "🎥 Webcam e microfono attivi";
    }
    voceMenu.classList.toggle("media-attiva", mediaPartitaAttiva && !errore);
  }
  aggiornaControlliMediaLocale();
}

function aggiornaControlliMediaLocale() {
  const tracciaAudio = flussoMediaLocale && flussoMediaLocale.getAudioTracks().find(t => t.readyState === "live");
  const tracciaVideo = flussoMediaLocale && flussoMediaLocale.getVideoTracks().find(t => t.readyState === "live");
  const btnMic = document.getElementById("btn-toggle-microfono-media");
  const btnCam = document.getElementById("btn-toggle-webcam-media");
  const tileLocale = document.getElementById("video-tile-locale");

  if (btnMic) {
    const acceso = !!(tracciaAudio && tracciaAudio.enabled);
    btnMic.disabled = !tracciaAudio;
    btnMic.textContent = acceso ? "🎙️" : "🔇";
    btnMic.setAttribute("aria-pressed", acceso ? "false" : "true");
    btnMic.setAttribute("aria-label", acceso ? "Disattiva microfono" : "Attiva microfono");
    btnMic.title = acceso ? "Disattiva microfono" : "Attiva microfono";
    btnMic.classList.toggle("media-spento", !!tracciaAudio && !acceso);
  }

  if (btnCam) {
    btnCam.hidden = clientCellulareAudioOnly;
    btnCam.setAttribute("aria-hidden", clientCellulareAudioOnly ? "true" : "false");
    if (!clientCellulareAudioOnly) {
      const acceso = !!(tracciaVideo && tracciaVideo.enabled);
      btnCam.disabled = !tracciaVideo;
      btnCam.textContent = acceso ? "📷" : "🚫";
      btnCam.setAttribute("aria-pressed", acceso ? "false" : "true");
      btnCam.setAttribute("aria-label", acceso ? "Disattiva webcam" : "Attiva webcam");
      btnCam.title = acceso ? "Disattiva webcam" : "Attiva webcam";
      btnCam.classList.toggle("media-spento", !!tracciaVideo && !acceso);
    }
  }

  if (tileLocale) tileLocale.hidden = clientCellulareAudioOnly;
}

function toggleMicrofonoMedia() {
  const traccia = flussoMediaLocale && flussoMediaLocale.getAudioTracks().find(t => t.readyState === "live");
  if (!traccia) {
    mostraNotificaGioco(clientCellulareAudioOnly
      ? "Microfono non disponibile. Usa 'Riprova microfono'."
      : "Microfono non disponibile. Usa 'Riprova webcam e microfono'.");
    return;
  }
  traccia.enabled = !traccia.enabled;
  aggiornaControlliMediaLocale();
}

function toggleWebcamMedia() {
  if (clientCellulareAudioOnly) return;
  const traccia = flussoMediaLocale && flussoMediaLocale.getVideoTracks().find(t => t.readyState === "live");
  if (!traccia) {
    mostraNotificaGioco("Webcam non disponibile. Usa 'Riprova webcam e microfono'.");
    return;
  }
  traccia.enabled = !traccia.enabled;
  aggiornaControlliMediaLocale();
}

function impostaMediaPartitaAttiva(attiva) {
  if (attiva !== true) {
    mediaPartitaAttiva = false;
    mediaProntoSegnalato = false;
    mediaRichiedeRiprovaManuale = false;
    partecipantiMediaPronti.clear();
    partecipantiMediaInfo.clear();
    if (flussoMediaLocale) {
      const streamDaChiudere = flussoMediaLocale;
      flussoMediaLocale = null;
      streamDaChiudere.getTracks().forEach(traccia => {
        traccia.onended = null;
        try { traccia.stop(); } catch (e) {}
      });
    }
    Object.keys(connessioniPeer).forEach(chiudiConnessioneMedia);
    Object.values(timerRiprovaPeer).forEach(clearTimeout);
    Object.values(timerDisconnessionePeer).forEach(clearTimeout);
    timerRiprovaPeer = {};
    timerDisconnessionePeer = {};
    const locale = document.getElementById("video-locale");
    if (locale) locale.srcObject = null;
    aggiornaInterfacciaMedia("Non attiva", false);
    return;
  }

  mediaPartitaAttiva = true;
  if (mediaRichiedeRiprovaManuale) {
    aggiornaInterfacciaMedia(
      clientCellulareAudioOnly ? "Autorizzazione microfono da verificare" : "Autorizzazione o dispositivo da verificare",
      true
    );
    return;
  }
  aggiornaInterfacciaMedia(
    flussoMediaLocale ? "Collegata" : (clientCellulareAudioOnly ? "Avvio microfono…" : "Avvio webcam e microfono…"),
    false
  );
  gestisciPromessaWebRtc(inizializzaMediaPartita());
}

function segnalaMediaPronto() {
  if (!mediaPartitaAttiva || !flussoMediaLocale || mediaProntoSegnalato) return;
  if (!streamLocaleMediaPronto(flussoMediaLocale)) return;
  const videoDisponibile = !clientCellulareAudioOnly &&
    flussoMediaLocale.getVideoTracks().some(t => t.readyState === "live");
  if (inviaSocket({
    tipo: "mediaPronto",
    partitaId: stato.id || partitaId,
    attivo: true,
    tipoDispositivo: tipoDispositivoMediaLocale,
    videoDisponibile
  })) {
    mediaProntoSegnalato = true;
  }
}

function gestisciInterruzioneMediaLocale() {
  if (puliziaMediaInCorso || !flussoMediaLocale) return;
  if (streamLocaleMediaPronto(flussoMediaLocale)) return;

  const streamDaChiudere = flussoMediaLocale;
  flussoMediaLocale = null;
  streamDaChiudere.getTracks().forEach(traccia => {
    traccia.onended = null;
    try { if (traccia.readyState === "live") traccia.stop(); } catch (e) {}
  });
  mediaProntoSegnalato = false;
  mediaRichiedeRiprovaManuale = true;
  inviaSocket({ tipo: "mediaPronto", partitaId: stato.id || partitaId, attivo: false });
  partecipantiMediaPronti.delete(mioUid);
  partecipantiMediaInfo.delete(mioUid);
  Object.keys(connessioniPeer).forEach(chiudiConnessioneMedia);
  const locale = document.getElementById("video-locale");
  if (locale) locale.srcObject = null;
  aggiornaInterfacciaMedia(clientCellulareAudioOnly ? "Microfono scollegato" : "Webcam o microfono scollegati", true);
  const riprova = document.getElementById("btn-sblocca-media");
  if (riprova) {
    riprova.textContent = clientCellulareAudioOnly ? "Riprova microfono" : "Riprova webcam e microfono";
    riprova.classList.remove("nascosto");
  }
}

async function ottieniFlussoMediaRobusto() {
  const tentativiVincoli = clientCellulareAudioOnly
    ? [
        { audio: VINCOLI_AUDIO, video: false },
        { audio: { echoCancellation: true, noiseSuppression: true }, video: false },
        { audio: true, video: false }
      ]
    : [
        VINCOLI_MEDIA,
        { audio: { echoCancellation: true, noiseSuppression: true }, video: { facingMode: { ideal: "user" } } },
        { audio: true, video: true }
      ];
  let ultimoErrore = null;

  for (let indice = 0; indice < tentativiVincoli.length; indice++) {
    const vincoli = tentativiVincoli[indice];
    for (let tentativoOccupato = 0; tentativoOccupato < 3; tentativoOccupato++) {
      try {
        return await navigator.mediaDevices.getUserMedia(vincoli);
      } catch (errore) {
        ultimoErrore = errore;
        const nome = nomeErroreMediaPartita(errore);
        const vincoliTroppoStretti = nome === "OverconstrainedError" || nome === "ConstraintNotSatisfiedError";
        const dispositivoTemporaneamenteOccupato = nome === "NotReadableError" || nome === "TrackStartError" || nome === "AbortError";
        if (vincoliTroppoStretti) break;
        if (dispositivoTemporaneamenteOccupato && tentativoOccupato < 2) {
          await aspettaWebRtc(450 + tentativoOccupato * 550);
          continue;
        }
        throw errore;
      }
    }
  }
  throw ultimoErrore || new Error(clientCellulareAudioOnly
    ? "Impossibile aprire il microfono"
    : "Impossibile aprire webcam e microfono");
}

async function inizializzaMediaPartita() {
  if (!mediaPartitaAttiva || paginaInChiusura) return false;
  if (flussoMediaLocale && streamLocaleMediaPronto(flussoMediaLocale)) {
    segnalaMediaPronto();
    aggiornaControlliMediaLocale();
    return true;
  }
  if (avvioMediaInCorso) return avvioMediaInCorso;

  avvioMediaInCorso = (async () => {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        throw new DOMException("getUserMedia non disponibile", "NotSupportedError");
      }
      if (typeof RTCPeerConnection !== "function") {
        throw new DOMException("WebRTC non disponibile", "NotSupportedError");
      }
      const policy = document.permissionsPolicy || document.featurePolicy;
      if (policy && typeof policy.allowsFeature === "function") {
        const microfonoConsentito = policy.allowsFeature("microphone");
        const webcamConsentita = clientCellulareAudioOnly || policy.allowsFeature("camera");
        if (!microfonoConsentito || !webcamConsentita) {
          throw new DOMException(
            clientCellulareAudioOnly
              ? "Il contenitore iframe non autorizza il microfono"
              : "Il contenitore iframe non autorizza camera/microfono",
            "NotAllowedError"
          );
        }
      }

      const stream = await ottieniFlussoMediaRobusto();
      if (!mediaPartitaAttiva || paginaInChiusura) {
        stream.getTracks().forEach(traccia => traccia.stop());
        return false;
      }

      const audio = stream.getAudioTracks().find(t => t.readyState === "live");
      const video = stream.getVideoTracks().find(t => t.readyState === "live");
      if (!audio || (!clientCellulareAudioOnly && !video)) {
        stream.getTracks().forEach(traccia => traccia.stop());
        throw new DOMException(
          clientCellulareAudioOnly ? "È necessaria una traccia audio" : "Sono necessarie entrambe le tracce",
          "NotFoundError"
        );
      }

      flussoMediaLocale = stream;
      mediaRichiedeRiprovaManuale = false;
      stream.getTracks().forEach(traccia => {
        traccia.onended = gestisciInterruzioneMediaLocale;
      });

      const videoLocale = document.getElementById("video-locale");
      if (videoLocale) {
        if (clientCellulareAudioOnly) {
          videoLocale.srcObject = null;
        } else {
          videoLocale.srcObject = stream;
          videoLocale.muted = true;
          videoLocale.playsInline = true;
          videoLocale.play().catch(() => {});
        }
      }

      const riprova = document.getElementById("btn-sblocca-media");
      if (riprova) riprova.classList.add("nascosto");
      aggiornaControlliMediaLocale();
      aggiornaInterfacciaMedia("In attesa degli altri giocatori…", false);
      segnalaMediaPronto();
      return true;
    } catch (errore) {
      console.warn(clientCellulareAudioOnly ? "Avvio microfono non riuscito:" : "Avvio webcam/microfono non riuscito:", errore);
      mediaRichiedeRiprovaManuale = true;
      mediaProntoSegnalato = false;
      inviaSocket({ tipo: "mediaPronto", partitaId: stato.id || partitaId, attivo: false });
      const dettaglio = descriviErroreMediaPartita(errore);
      aggiornaInterfacciaMedia(dettaglio, true);
      mostraNotificaGioco(dettaglio + " La partita attenderà finché non riprovi.");
      const riprova = document.getElementById("btn-sblocca-media");
      if (riprova) {
        riprova.textContent = clientCellulareAudioOnly ? "Riprova microfono" : "Riprova webcam e microfono";
        riprova.classList.remove("nascosto");
      }
      aggiornaControlliMediaLocale();
      return false;
    } finally {
      avvioMediaInCorso = null;
    }
  })();
  return avvioMediaInCorso;
}

function creaIconaCellulareBarratoElemento() {
  const contenitore = document.createElement("span");
  contenitore.className = "icona-cellulare-barrato";
  contenitore.setAttribute("aria-hidden", "true");
  contenitore.innerHTML = `
    <svg viewBox="0 0 28 28" focusable="false">
      <rect x="8" y="3.5" width="12" height="21" rx="2.4" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="11.5" y1="21" x2="16.5" y2="21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="4" y1="24" x2="24" y2="4" stroke="currentColor" stroke-width="2.7" stroke-linecap="round"/>
    </svg>`;
  return contenitore;
}

function creaElementiVideoRemoto(altroUid) {
  if (elementiVideoRemoti[altroUid]) return elementiVideoRemoti[altroUid];

  const info = descrittoreMediaPerUid(altroUid);
  const remotoCellulare = info.tipoDispositivo === "cellulare";
  const mostraVideo = !clientCellulareAudioOnly && peerSupportaVideo(altroUid);

  const figura = document.createElement("figure");
  figura.className = "video-tile" + (mostraVideo ? "" : " video-tile-mobile-audio");
  figura.dataset.uid = altroUid;

  let video = null;
  let placeholder = null;

  if (mostraVideo) {
    video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    figura.appendChild(video);
  } else {
    placeholder = document.createElement("div");
    placeholder.className = "placeholder-mobile-audio";
    if (remotoCellulare) {
      placeholder.appendChild(creaIconaCellulareBarratoElemento());
      const testo = document.createElement("span");
      testo.textContent = "Da cellulare · solo audio";
      placeholder.appendChild(testo);
    } else {
      const testo = document.createElement("span");
      testo.textContent = "Solo audio";
      placeholder.appendChild(testo);
    }
    figura.appendChild(placeholder);
  }

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.preload = "auto";
  figura.appendChild(audio);

  const didascalia = document.createElement("figcaption");
  const giocatoreNoto = giocatoriStato().find(g => g.uid === altroUid);
  didascalia.textContent = nomiPartecipantiMedia.get(altroUid) || (giocatoreNoto && (giocatoreNoto.nome || giocatoreNoto.nickname)) || "Giocatore";
  figura.appendChild(didascalia);

  const griglia = document.getElementById("griglia-video");
  if (griglia) griglia.appendChild(figura);

  elementiVideoRemoti[altroUid] = {
    figura,
    video,
    audio,
    didascalia,
    placeholder,
    streamAudioRemoto: new MediaStream(),
    streamVideoRemoto: new MediaStream()
  };
  return elementiVideoRemoti[altroUid];
}

function mostraPulsanteSbloccoAudio(testo) {
  const pulsante = document.getElementById("btn-sblocca-media");
  if (!pulsante) return;
  if (testo) pulsante.textContent = testo;
  pulsante.classList.remove("nascosto");
}

function tentaRiproduzioneElementoMedia(elemento) {
  if (!elemento || typeof elemento.play !== "function") return Promise.resolve(false);
  return elemento.play().then(() => true).catch(() => {
    mostraPulsanteSbloccoAudio("🔊 Attiva l'audio");
    return false;
  });
}

function chiudiPeerSenzaRimuovereTile(altroUid) {
  if (timerRiprovaPeer[altroUid]) { clearTimeout(timerRiprovaPeer[altroUid]); delete timerRiprovaPeer[altroUid]; }
  if (timerDisconnessionePeer[altroUid]) { clearTimeout(timerDisconnessionePeer[altroUid]); delete timerDisconnessionePeer[altroUid]; }
  const pc = connessioniPeer[altroUid];
  delete connessioniPeer[altroUid];
  if (pc && pc.connectionState !== "closed") {
    try { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null; pc.close(); } catch (e) {}
  }
  delete candidatiIceInAttesa[altroUid];
}

function creaConnessionePeer(altroUid) {
  const esistente = connessioniPeer[altroUid];
  if (esistente && esistente.connectionState !== "closed" && esistente.connectionState !== "failed") return esistente;
  if (!flussoMediaLocale) throw new Error("Stream locale non pronto");

  const pc = new RTCPeerConnection(CONFIGURAZIONE_ICE);
  const peerAccettaVideo = peerSupportaVideo(altroUid);

  flussoMediaLocale.getTracks().forEach(traccia => {
    if (traccia.kind === "video" && !peerAccettaVideo) return;
    const sender = pc.addTrack(traccia, flussoMediaLocale);
    if (traccia.kind === "video" && sender && typeof sender.getParameters === "function") {
      const parametri = sender.getParameters();
      if (!parametri.encodings || !parametri.encodings.length) parametri.encodings = [{}];
      parametri.encodings[0].maxBitrate = 260000;
      parametri.encodings[0].maxFramerate = 20;
      sender.setParameters(parametri).catch(() => {});
    }
  });

  pc.onicecandidate = evento => {
    if (evento.candidate) {
      inviaSocket({
        tipo: "webrtc-ice-candidate",
        partitaId: stato.id || partitaId,
        destinatarioUid: altroUid,
        candidate: evento.candidate.toJSON ? evento.candidate.toJSON() : evento.candidate
      });
    }
  };

  pc.ontrack = evento => {
    if (!evento || !evento.track) return;
    const elementi = creaElementiVideoRemoto(altroUid);

    if (evento.track.kind === "audio") {
      if (!elementi.streamAudioRemoto.getTracks().some(t => t.id === evento.track.id)) {
        elementi.streamAudioRemoto.addTrack(evento.track);
      }
      elementi.audio.srcObject = elementi.streamAudioRemoto;
      evento.track.onended = () => {
        try { elementi.streamAudioRemoto.removeTrack(evento.track); } catch (e) {}
      };
      tentaRiproduzioneElementoMedia(elementi.audio);
      return;
    }

    if (evento.track.kind === "video") {
      if (clientCellulareAudioOnly || !elementi.video || !peerSupportaVideo(altroUid)) return;
      if (!elementi.streamVideoRemoto.getTracks().some(t => t.id === evento.track.id)) {
        elementi.streamVideoRemoto.addTrack(evento.track);
      }
      elementi.video.srcObject = elementi.streamVideoRemoto;
      evento.track.onended = () => {
        try { elementi.streamVideoRemoto.removeTrack(evento.track); } catch (e) {}
      };
      tentaRiproduzioneElementoMedia(elementi.video);
    }
  };

  const gestisciStatoConnessione = () => {
    const statoConn = pc.connectionState;
    const statoIce = pc.iceConnectionState;
    if (statoConn === "connected" || statoIce === "connected" || statoIce === "completed") {
      if (timerDisconnessionePeer[altroUid]) clearTimeout(timerDisconnessionePeer[altroUid]);
      delete timerDisconnessionePeer[altroUid];
      aggiornaInterfacciaMedia(`${partecipantiMediaPronti.size} partecipanti collegati`, false);
      return;
    }
    if (statoConn === "failed" || statoIce === "failed") {
      chiudiPeerSenzaRimuovereTile(altroUid);
      pianificaRiprovaConnessioneMedia(altroUid, 900);
      return;
    }
    if (statoConn === "disconnected" || statoIce === "disconnected") {
      if (!timerDisconnessionePeer[altroUid]) {
        timerDisconnessionePeer[altroUid] = setTimeout(() => {
          delete timerDisconnessionePeer[altroUid];
          const attuale = connessioniPeer[altroUid];
          if (attuale === pc && (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected")) {
            chiudiPeerSenzaRimuovereTile(altroUid);
            pianificaRiprovaConnessioneMedia(altroUid, 600);
          }
        }, 6500);
      }
    }
  };
  pc.onconnectionstatechange = gestisciStatoConnessione;
  pc.oniceconnectionstatechange = gestisciStatoConnessione;
  pc.onicecandidateerror = evento => console.warn("ICE candidate error:", evento && evento.errorText ? evento.errorText : evento);

  connessioniPeer[altroUid] = pc;
  return pc;
}

async function avviaConnessioneMedia(altroUid, riavvioIce = false) {
  if (!flussoMediaLocale || !partecipantiMediaPronti.has(altroUid) || !mioUid) return;
  if (String(mioUid) >= String(altroUid)) return;

  let pc = connessioniPeer[altroUid];
  if (pc && pc.connectionState === "connected" && !riavvioIce) return;
  if (pc && pc.signalingState !== "stable") return;
  if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") pc = creaConnessionePeer(altroUid);

  const offerta = await pc.createOffer(riavvioIce ? { iceRestart: true } : undefined);
  if (pc.signalingState !== "stable") return;
  await pc.setLocalDescription(offerta);
  inviaSocket({ tipo: "webrtc-offer", partitaId: stato.id || partitaId, destinatarioUid: altroUid, sdp: pc.localDescription });
}

async function applicaCandidatiIceInAttesa(altroUid) {
  const pc = connessioniPeer[altroUid];
  if (!pc || !pc.remoteDescription) return;
  const candidati = candidatiIceInAttesa[altroUid] || [];
  delete candidatiIceInAttesa[altroUid];
  for (const candidate of candidati.slice(0, 100)) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (errore) { console.warn("Candidato ICE ignorato:", errore); }
  }
}

async function gestisciOffertaRicevuta(mittenteUid, sdp) {
  if (!mediaPartitaAttiva || !flussoMediaLocale || !partecipantiMediaPronti.has(mittenteUid) || !sdp) return;
  if (sdp.type !== "offer") return;

  let pc = connessioniPeer[mittenteUid];
  if (pc && pc.signalingState !== "stable") {
    chiudiPeerSenzaRimuovereTile(mittenteUid);
    pc = null;
  }
  if (!pc) pc = creaConnessionePeer(mittenteUid);

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await applicaCandidatiIceInAttesa(mittenteUid);
  const risposta = await pc.createAnswer();
  await pc.setLocalDescription(risposta);
  inviaSocket({ tipo: "webrtc-answer", partitaId: stato.id || partitaId, destinatarioUid: mittenteUid, sdp: pc.localDescription });
}

async function gestisciRispostaRicevuta(mittenteUid, sdp) {
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !sdp || sdp.type !== "answer") return;
  if (pc.signalingState !== "have-local-offer") return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await applicaCandidatiIceInAttesa(mittenteUid);
}

async function gestisciCandidatoRicevuto(mittenteUid, candidate) {
  if (!candidate || typeof candidate !== "object") return;
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !pc.remoteDescription) {
    if (!candidatiIceInAttesa[mittenteUid]) candidatiIceInAttesa[mittenteUid] = [];
    if (candidatiIceInAttesa[mittenteUid].length < 100) candidatiIceInAttesa[mittenteUid].push(candidate);
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
  catch (errore) { console.warn("Candidato ICE ignorato:", errore); }
}

function chiudiConnessioneMedia(altroUid) {
  chiudiPeerSenzaRimuovereTile(altroUid);
  const elementi = elementiVideoRemoti[altroUid];
  if (elementi) {
    if (elementi.video) elementi.video.srcObject = null;
    if (elementi.audio) elementi.audio.srcObject = null;
    try {
      elementi.streamAudioRemoto.getTracks().forEach(t => elementi.streamAudioRemoto.removeTrack(t));
      elementi.streamVideoRemoto.getTracks().forEach(t => elementi.streamVideoRemoto.removeTrack(t));
    } catch (e) {}
    elementi.figura.remove();
    delete elementiVideoRemoti[altroUid];
  }
}

function pianificaRiprovaConnessioneMedia(altroUid, ritardoMs = 1800) {
  if (!altroUid || timerRiprovaPeer[altroUid] || !mioUid || String(mioUid) >= String(altroUid)) return;
  if (!mediaPartitaAttiva || !flussoMediaLocale || !partecipantiMediaPronti.has(altroUid)) return;
  timerRiprovaPeer[altroUid] = setTimeout(() => {
    delete timerRiprovaPeer[altroUid];
    if (partecipantiMediaPronti.has(altroUid)) gestisciPromessaWebRtc(avviaConnessioneMedia(altroUid, true));
  }, Math.max(400, Number(ritardoMs) || 1800));
}

function normalizzaDescrittorePartecipanteMedia(valore) {
  if (!valore || typeof valore !== "object" || typeof valore.uid !== "string") return null;
  const tipoDispositivo = normalizzaTipoDispositivoMedia(valore.tipoDispositivo);
  return {
    uid: valore.uid,
    tipoDispositivo,
    videoDisponibile: tipoDispositivo !== "cellulare" && valore.videoDisponibile !== false
  };
}

function gestisciStatoMedia(dati) {
  impostaMediaPartitaAttiva(dati.mediaAttiva === true);
  if (!mediaPartitaAttiva) return;

  const infoPrecedenti = partecipantiMediaInfo;
  const descrittori = Array.isArray(dati.partecipantiMedia)
    ? dati.partecipantiMedia.map(normalizzaDescrittorePartecipanteMedia).filter(Boolean)
    : [];

  if (descrittori.length) {
    partecipantiMediaInfo = new Map(descrittori.map(info => [info.uid, info]));
    partecipantiMediaPronti = new Set(descrittori.map(info => info.uid));
  } else {
    partecipantiMediaPronti = new Set(
      Array.isArray(dati.partecipanti)
        ? dati.partecipanti.filter(uid => typeof uid === "string")
        : []
    );
    partecipantiMediaInfo = new Map(
      Array.from(partecipantiMediaPronti).map(uid => {
        const info = descrittoreMediaPerUid(uid);
        return [uid, info];
      })
    );
  }

  Object.keys(connessioniPeer).forEach(uid => {
    if (!partecipantiMediaPronti.has(uid)) {
      chiudiConnessioneMedia(uid);
      return;
    }
    const prima = infoPrecedenti.get(uid);
    const dopo = partecipantiMediaInfo.get(uid);
    if (prima && dopo && (
      prima.tipoDispositivo !== dopo.tipoDispositivo ||
      prima.videoDisponibile !== dopo.videoDisponibile
    )) {
      chiudiConnessioneMedia(uid);
    }
  });
  Object.keys(elementiVideoRemoti).forEach(uid => {
    if (!partecipantiMediaPronti.has(uid)) chiudiConnessioneMedia(uid);
  });

  const quanti = partecipantiMediaPronti.size;
  aggiornaInterfacciaMedia(quanti > 1 ? `${quanti} partecipanti collegati` : "In attesa degli altri giocatori…", false);

  if (flussoMediaLocale && mioUid && !partecipantiMediaPronti.has(mioUid)) {
    mediaProntoSegnalato = false;
    segnalaMediaPronto();
    return;
  }
  if (!flussoMediaLocale || !mioUid || !partecipantiMediaPronti.has(mioUid)) return;

  partecipantiMediaPronti.forEach(altroUid => {
    if (altroUid !== mioUid && String(mioUid) < String(altroUid)) {
      gestisciPromessaWebRtc(avviaConnessioneMedia(altroUid));
    }
  });
  renderPannelloGiocatori();
}

async function sbloccaRiproduzioneMedia() {
  if (!flussoMediaLocale) {
    mediaRichiedeRiprovaManuale = false;
    if (!(await inizializzaMediaPartita())) return;
  }

  const elementiDaRiprodurre = Object.values(elementiVideoRemoti)
    .flatMap(elementi => [elementi.audio, elementi.video])
    .filter(Boolean);
  const risultati = await Promise.allSettled(elementiDaRiprodurre.map(elemento => elemento.play()));
  const fallita = risultati.some(risultato => risultato.status === "rejected");
  const pulsante = document.getElementById("btn-sblocca-media");
  if (pulsante) {
    pulsante.textContent = fallita ? "🔊 Attiva l'audio" : "🔊 Audio attivo";
    pulsante.classList.toggle("nascosto", !fallita);
  }
}

document.addEventListener("pointerdown", () => {
  if (!mediaPartitaAttiva || !flussoMediaLocale) return;
  const audioRemoti = Object.values(elementiVideoRemoti).map(elementi => elementi.audio).filter(Boolean);
  audioRemoti.forEach(audio => audio.play().catch(() => mostraPulsanteSbloccoAudio("🔊 Attiva l'audio")));
}, { passive: true });

function pulisciMediaPagina() {
  if (puliziaMediaInCorso) return;
  puliziaMediaInCorso = true;
  paginaInChiusura = true;
  clearTimeout(timerRiconnessione);
  clearTimeout(timerChiusuraPresentazioneSfida);
  if (mediaProntoSegnalato) inviaSocket({ tipo: "mediaPronto", partitaId: stato.id || partitaId, attivo: false });
  if (flussoMediaLocale) {
    flussoMediaLocale.getTracks().forEach(traccia => {
      traccia.onended = null;
      try { traccia.stop(); } catch (e) {}
    });
  }
  flussoMediaLocale = null;
  Object.keys(connessioniPeer).forEach(chiudiConnessioneMedia);
  Object.values(timerRiprovaPeer).forEach(clearTimeout);
  Object.values(timerDisconnessionePeer).forEach(clearTimeout);
  timerRiprovaPeer = {};
  timerDisconnessionePeer = {};
  partecipantiMediaPronti.clear();
  partecipantiMediaInfo.clear();
  aggiornaControlliMediaLocale();
  try { socket?.close(); } catch (e) {}
}
window.addEventListener("pagehide", pulisciMediaPagina);

function gestisciPromessaWebRtc(promessa) {
  Promise.resolve(promessa).catch(errore => {
    console.error("Errore WebRTC:", errore);
    mostraNotificaGioco("La connessione audio/video non è riuscita.");
  });
}

/* =========================================================
   PRESENTAZIONE SFIDA
   ========================================================= */

function chiavePresentazioneSfida() {
  return "giochi-societa:othello:presentazione-sfida:" + (partitaId || "sconosciuta");
}
function presentazioneSfidaGiaVista() {
  try { return sessionStorage.getItem(chiavePresentazioneSfida()) === "1"; } catch (_) { return false; }
}
function marcaPresentazioneSfidaVista() {
  try { sessionStorage.setItem(chiavePresentazioneSfida(), "1"); } catch (_) {}
}
function iniziale(nome) { return (nome || "?").trim().charAt(0).toUpperCase(); }
function coloreDaNome(nome) {
  const colori = ["#6a2c70", "#1e40af", "#43a047", "#f57c00", "#c0ca33", "#e53935", "#00838f", "#8d6e63"];
  let somma = 0;
  for (let i = 0; i < (nome || "?").length; i++) somma += nome.charCodeAt(i);
  return colori[somma % colori.length];
}
function escapeHtml(valore) {
  return String(valore == null ? "" : valore)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function stelleDaElo(elo) {
  const valore = Number.isFinite(Number(elo)) ? Number(elo) : 1500;
  if (valore < 1300) return 1;
  if (valore < 1500) return 2;
  if (valore < 1700) return 3;
  if (valore < 1900) return 4;
  return 5;
}
function htmlStelle(elo) {
  const piene = stelleDaElo(elo);
  let html = "";
  for (let i = 1; i <= 5; i++) html += i <= piene ? "★" : '<span class="vuota">★</span>';
  return html;
}
function htmlAvatar(giocatore) {
  const nome = escapeHtml(giocatore.nome || giocatore.nickname || "Giocatore");
  if (typeof giocatore.avatar === "string" && giocatore.avatar.trim()) {
    return `<div class="sfida-avatar"><img src="${escapeHtml(giocatore.avatar)}" alt="Avatar di ${nome}" referrerpolicy="no-referrer"></div>`;
  }
  return `<div class="sfida-avatar" style="background:${coloreDaNome(giocatore.nome || giocatore.nickname)}">${escapeHtml(iniziale(giocatore.nome || giocatore.nickname))}</div>`;
}
function probabilitaVittoriaElo(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (Number(eloB) - Number(eloA)) / 400));
}
function variazioniElo(eloA, eloB) {
  const a = Number.isFinite(Number(eloA)) ? Number(eloA) : 1500;
  const b = Number.isFinite(Number(eloB)) ? Number(eloB) : 1500;
  const p = probabilitaVittoriaElo(a, b);
  return {
    vittoria: Math.max(100, Math.round(a + 32 * (1 - p))) - Math.round(a),
    sconfitta: Math.max(100, Math.round(a + 32 * (0 - p))) - Math.round(a)
  };
}

function giocatoriStato() {
  return Object.entries(stato.giocatori || {}).map(([uid, g]) => ({ uid, ...g }));
}

function disegnaPresentazioneSfida() {
  const contenitore = document.getElementById("sfida-giocatori");
  if (!contenitore) return;
  const elenco = giocatoriStato();
  if (elenco.length < 2) {
    contenitore.innerHTML = '<div class="sfida-caricamento">In attesa dell\'avversario…</div>';
    return;
  }

  const sx = elenco.find(g => g.colore === "nero") || elenco[0];
  const dx = elenco.find(g => g.colore === "bianco") || elenco[1];

  const card = (g, lato) => {
    const destra = lato === "destra" ? " sfida-giocatore-destra" : "";
    const nome = escapeHtml(g.nome || g.nickname || "Giocatore");
    const elo = Number.isFinite(Number(g.elo)) ? Math.round(Number(g.elo)) : 1500;
    return `<article class="sfida-giocatore${destra}">
      <div class="sfida-identita">
        ${htmlAvatar(g)}
        <div class="sfida-nome-wrap">
          <div class="sfida-nome" title="${nome}">${nome}</div>
          <div class="sfida-stelle" aria-label="Indicatore grafico ELO">${htmlStelle(elo)}</div>
        </div>
      </div>
      <div class="sfida-stat-riga"><div class="sfida-stat-barra"><div class="sfida-stat-riempimento" style="width:${Math.max(8, Math.min(100, elo / 20))}%"></div></div><span class="sfida-stat-valore">${elo}</span></div>
      <div class="sfida-stat-riga"><div class="sfida-stat-barra"><div class="sfida-stat-riempimento" style="width:0%"></div></div><span class="sfida-stat-valore">—</span></div>
      <div class="sfida-stat-riga"><div class="sfida-stat-barra"><div class="sfida-stat-riempimento" style="width:0%"></div></div><span class="sfida-stat-valore">—</span></div>
    </article>`;
  };

  contenitore.innerHTML = `<div class="sfida-duello">
    ${card(sx, "sinistra")}
    <div class="sfida-vs-colonna" aria-hidden="true">
      <div class="sfida-vs">VS</div>
      <div class="sfida-vs-etichetta">ELO</div>
      <div class="sfida-vs-etichetta">Giocate</div>
      <div class="sfida-vs-etichetta">Vinte</div>
    </div>
    ${card(dx, "destra")}
  </div>`;

  const mio = elenco.find(g => g.uid === mioUid) || sx;
  const avversario = elenco.find(g => g.uid !== mio.uid) || dx;
  const variazione = variazioniElo(mio.elo, avversario.elo);
  const classificata = stato.classificata !== false;
  const boxVariazione = document.getElementById("sfida-box-variazione-elo");
  if (boxVariazione) boxVariazione.hidden = !classificata;
  const v = document.getElementById("sfida-elo-vittoria");
  const s = document.getElementById("sfida-elo-sconfitta");
  if (v) v.textContent = classificata ? ((variazione.vittoria >= 0 ? "+" : "") + variazione.vittoria) : "";
  if (s) s.textContent = classificata ? String(variazione.sconfitta) : "";
  const streak = document.getElementById("sfida-streak");
  const wr = document.getElementById("sfida-winrate");
  if (streak) streak.textContent = "—";
  if (wr) wr.textContent = "—";
}

function mostraPresentazioneSfida() {
  if (presentazioneSfidaAperta || presentazioneSfidaGiaVista() || giocatoriStato().length < 2) return;
  const overlay = document.getElementById("overlay-presentazione-sfida");
  if (!overlay) return;

  const classificata = stato.classificata !== false;
  const testoModalita = document.getElementById("sfida-modalita-testo");
  const descrizione = document.getElementById("sfida-descrizione-modalita");
  const statoSfida = document.getElementById("sfida-stato");
  if (testoModalita) testoModalita.textContent = classificata
    ? "Partita classificata · Othello · ELO attivo"
    : "Partita Divertimento · Othello · ELO invariato";
  if (descrizione) descrizione.textContent = classificata
    ? "Giocatori reali · il risultato modifica il rating ELO della modalità Othello"
    : "Giocatori reali · questa partita non modifica il rating ELO";
  if (statoSfida) statoSfida.textContent = classificata
    ? "Confronto ELO Othello · K = 32"
    : "Modalità Divertimento: ELO invariato";

  disegnaPresentazioneSfida();
  presentazioneSfidaAperta = true;
  overlay.classList.add("aperto");
  overlay.setAttribute("aria-hidden", "false");
  clearTimeout(timerChiusuraPresentazioneSfida);
  timerChiusuraPresentazioneSfida = setTimeout(() => chiudiPresentazioneSfida(true), 6000);
  setTimeout(() => document.getElementById("btn-entra-partita")?.focus(), 0);
}

function chiudiPresentazioneSfida() {
  if (!presentazioneSfidaAperta) return;
  clearTimeout(timerChiusuraPresentazioneSfida);
  timerChiusuraPresentazioneSfida = null;
  presentazioneSfidaAperta = false;
  marcaPresentazioneSfidaVista();
  const overlay = document.getElementById("overlay-presentazione-sfida");
  if (overlay) {
    overlay.classList.remove("aperto");
    overlay.setAttribute("aria-hidden", "true");
  }
}

document.getElementById("btn-entra-partita")?.addEventListener("click", () => chiudiPresentazioneSfida(false));

/* =========================================================
   TAVOLA / DISCHI / ANIMAZIONI
   ========================================================= */

function nomeColore(colore) {
  return colore === "nero" ? "Nero" : colore === "bianco" ? "Bianco" : "—";
}

const posizioniDischi = new Map();
const caselleTavola = new Map();
let tavolaDisegnata = null;
let animazioniDaAttendere = 0;
let animazioniDaAttendereGenerazione = 0;
const TIMEOUT_ANIMAZIONE_MS = 2500;
const animazioniDischiAttive = true;
function aggiornaBottoneAnimazioniOthello() {
  const bottone = document.getElementById("btn-animazioni-othello");
  if (!bottone) return;
  bottone.textContent = "Animazioni dischi: attive";
  bottone.setAttribute("aria-pressed", "true");
}
function toggleAnimazioniOthello() {
  aggiornaBottoneAnimazioniOthello();
}
aggiornaBottoneAnimazioniOthello();

function chiaveCasella(r, c) { return r + "," + c; }

function coordinateVisive(r, c) {
  const coloreLocale = coloreUtenteDaPartita(stato);
  return coloreLocale === "bianco" ? { r: 7 - r, c: 7 - c } : { r, c };
}

function creaFacciaDisco(colore) {
  const elemento = document.createElement("div");
  elemento.className = "othello-disco";
  elemento.dataset.colore = colore;
  const bianco = document.createElement("div");
  bianco.className = "othello-disco-faccia bianco";
  const nero = document.createElement("div");
  nero.className = "othello-disco-faccia nero";
  elemento.append(bianco, nero);
  return elemento;
}

function preparaTavola() {
  const tavola = document.getElementById("othello-tavola");
  if (!tavola || caselleTavola.size) return tavola;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const casella = document.createElement("button");
      casella.type = "button";
      casella.setAttribute("role", "gridcell");
      casella.dataset.r = String(r);
      casella.dataset.c = String(c);
      casella.addEventListener("click", () => cliccaCasella(r, c));
      tavola.appendChild(casella);
      caselleTavola.set(chiaveCasella(r, c), casella);
    }
  }
  let strato = document.getElementById("othello-strato-dischi");
  if (!strato) {
    strato = document.createElement("div");
    strato.id = "othello-strato-dischi";
    strato.setAttribute("aria-hidden", "true");
    tavola.appendChild(strato);
  }
  return tavola;
}

function impostaPosizioneDisco(elemento, r, c) {
  const visiva = coordinateVisive(r, c);
  elemento.style.left = (visiva.c * 12.5) + "%";
  elemento.style.top = (visiva.r * 12.5) + "%";
}

function sincronizzaDischiIstantaneo(tavolaStato) {
  preparaTavola();
  const strato = document.getElementById("othello-strato-dischi");
  if (!strato) return;
  strato.innerHTML = "";
  posizioniDischi.clear();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const colore = tavolaStato[r][c];
      if (!colore) continue;
      const posizione = document.createElement("div");
      posizione.className = "othello-posizione";
      posizione.appendChild(creaFacciaDisco(colore));
      strato.appendChild(posizione);
      impostaPosizioneDisco(posizione, r, c);
      posizioniDischi.set(chiaveCasella(r, c), posizione);
    }
  }
  tavolaDisegnata = copiaTavola(tavolaStato);
}

function renderTavola() {
  const tavola = preparaTavola();
  if (!tavola) return;
  if (!tavolaDisegnata) sincronizzaDischiIstantaneo(stato.tavola);

  const inCorso = stato.fase === "in_corso";
  const coloreLocale = coloreUtenteDaPartita(stato);
  const mioTurno = inCorso && !!coloreLocale && stato.turno === coloreLocale;
  const destinazioni = new Map();
  if (mioTurno && !mossaInAttesa && animazioniDaAttendere === 0) {
    for (const mossa of mosseLegaliCorrenti) destinazioni.set(chiaveCasella(mossa.r, mossa.c), true);
  }

  const bloccata = animazioniDaAttendere > 0 || mossaInAttesa || attesaSnapshot;
  tavola.setAttribute("aria-busy", bloccata ? "true" : "false");

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const key = chiaveCasella(r, c);
      const casella = caselleTavola.get(key);
      const visiva = coordinateVisive(r, c);
      casella.style.gridRow = String(visiva.r + 1);
      casella.style.gridColumn = String(visiva.c + 1);
      const giocabile = destinazioni.has(key) && !bloccata;
      casella.className = "othello-casella" + (giocabile ? " giocabile destinazione" : "");
      const ultimo = stato.ultimoMovimento || {};
      if (ultimo.a && ultimo.a.r === r && ultimo.a.c === c) casella.classList.add("ultima-mossa");
      const occupata = tavolaDisegnata[r][c];
      casella.setAttribute("aria-label", "Casella " + (r * 8 + c + 1)
        + (occupata ? ", disco " + nomeColore(occupata).toLowerCase() : ", vuota")
        + (giocabile ? ", mossa disponibile" : ""));
      casella.disabled = bloccata || !giocabile;
    }
  }
}

function estraiDifferenzeTavola(precedente, prossima) {
  const nuove = [];
  const girati = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const prima = precedente[r][c];
      const dopo = prossima[r][c];
      if (prima === dopo) continue;
      if (!prima && dopo) nuove.push({ r, c, colore: dopo });
      else if (prima && dopo && prima !== dopo) girati.push({ r, c, colore: dopo });
    }
  }
  return { nuove, girati };
}

function distanzaScacchi(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
}

async function animaVersoTavola(prossimaTavola, istantanea, generazione) {
  if (istantanea || !tavolaDisegnata || !animazioniDischiAttive) {
    sincronizzaDischiIstantaneo(prossimaTavola);
    return;
  }

  const { nuove, girati } = estraiDifferenzeTavola(tavolaDisegnata, prossimaTavola);
  const strato = document.getElementById("othello-strato-dischi");
  if (!strato) { sincronizzaDischiIstantaneo(prossimaTavola); return; }

  const centro = nuove[0] || girati[0] || { r: 3.5, c: 3.5 };

  for (const cella of nuove) {
    const key = chiaveCasella(cella.r, cella.c);
    if (posizioniDischi.has(key)) continue;
    const posizione = document.createElement("div");
    posizione.className = "othello-posizione appena-giocato";
    posizione.appendChild(creaFacciaDisco(cella.colore));
    strato.appendChild(posizione);
    impostaPosizioneDisco(posizione, cella.r, cella.c);
    posizioniDischi.set(key, posizione);
    if (cella === nuove[0]) suonaPosa();
  }

  const flipPromesse = girati.map(cella => {
    const key = chiaveCasella(cella.r, cella.c);
    const posizione = posizioniDischi.get(key);
    if (!posizione) return Promise.resolve();
    const disco = posizione.querySelector(".othello-disco");
    if (!disco) return Promise.resolve();
    const ritardo = Math.max(0, distanzaScacchi(centro, cella) - 1) * 70;
    const classeFlip = cella.colore === "bianco" ? "girando-a-bianco" : "girando-a-nero";
    return new Promise(resolve => {
      setTimeout(() => {
        if (generazione !== animazioniDaAttendereGenerazione) { resolve(); return; }
        posizione.classList.add("in-animazione");
        suonaFlip(0);
        let finito = false;
        let timerFallback = null;
        const conclusa = () => {
          if (finito) return;
          finito = true;
          if (timerFallback) clearTimeout(timerFallback);
          disco.classList.remove(classeFlip);
          if (generazione === animazioniDaAttendereGenerazione) {
            disco.dataset.colore = cella.colore;
          }
          posizione.classList.remove("in-animazione");
          disco.removeEventListener("animationend", conclusa);
          resolve();
        };
        disco.addEventListener("animationend", conclusa, { once: true });
        disco.classList.add(classeFlip);
        timerFallback = setTimeout(conclusa, 1500);
      }, ritardo);
    });
  });

  await Promise.all(flipPromesse);
  if (generazione !== animazioniDaAttendereGenerazione) return;
  tavolaDisegnata = copiaTavola(prossimaTavola);
}

/* =========================================================
   PUNTEGGIO
   ========================================================= */

function renderPunteggio() {
  const conteggio = contaDischi(stato.tavola);
  const coloreLocale = coloreUtenteDaPartita(stato);
  const mioConteggio = coloreLocale === "bianco" ? conteggio.bianco : coloreLocale === "nero" ? conteggio.nero : 0;
  const avversarioColore = avversarioDi(coloreLocale);
  const avversarioConteggio = coloreLocale === "bianco" ? conteggio.nero : coloreLocale === "nero" ? conteggio.bianco : 0;

  const giocatore = giocatoriStato().find(g => g.colore === coloreLocale);
  const avversario = giocatoriStato().find(g => g.colore === avversarioColore);

  const etGiocatore = document.getElementById("punteggio-giocatore-etichetta");
  const etAvversario = document.getElementById("punteggio-avversario-etichetta");
  if (etGiocatore) etGiocatore.textContent = coloreLocale ? "Tu (" + nomeColore(coloreLocale) + ")" : "Tu";
  if (etAvversario) etAvversario.textContent = avversario ? (avversario.nome || avversario.nickname || nomeColore(avversarioColore)) : "Avversario";

  const cGiocatore = document.getElementById("punteggio-giocatore-conteggio");
  const cAvversario = document.getElementById("punteggio-avversario-conteggio");
  if (cGiocatore) cGiocatore.textContent = String(mioConteggio);
  if (cAvversario) cAvversario.textContent = String(avversarioConteggio);

  const dGiocatore = document.getElementById("punteggio-giocatore-disco");
  const dAvversario = document.getElementById("punteggio-avversario-disco");
  if (dGiocatore) dGiocatore.classList.toggle("bianco", coloreLocale === "bianco");
  if (dAvversario) dAvversario.classList.toggle("bianco", avversarioColore === "bianco");
}

/* =========================================================
   PANNELLO GIOCATORI / TURNO
   ========================================================= */

function creaAvatarMini(nome, avatar) {
  if (typeof avatar === "string" && avatar.trim()) {
    const immagine = document.createElement("img");
    immagine.className = "avatar-mini";
    immagine.src = avatar;
    immagine.alt = "Avatar di " + (nome || "giocatore");
    immagine.referrerPolicy = "no-referrer";
    return immagine;
  }
  const inizialeEl = document.createElement("div");
  inizialeEl.className = "avatar-mini";
  inizialeEl.style.background = coloreDaNome(nome);
  inizialeEl.textContent = iniziale(nome);
  inizialeEl.setAttribute("aria-hidden", "true");
  return inizialeEl;
}

function renderPannelloGiocatori() {
  const lista = document.getElementById("lista-giocatori");
  if (!lista) return;
  lista.textContent = "";

  const giocatori = giocatoriStato().sort((a, b) => {
    if (a.colore === b.colore) return 0;
    return a.colore === "nero" ? -1 : 1;
  });

  for (const giocatore of giocatori) {
    const attivo = stato.fase === "in_corso" && giocatore.colore === stato.turno;
    const card = document.createElement("div");
    card.className = "giocatore-card" + (attivo ? " attivo" : "");
    card.appendChild(creaAvatarMini(giocatore.nome || giocatore.nickname, giocatore.avatar));

    const link = document.createElement("a");
    link.href = "/profilo-pubblico.html?nickname=" + encodeURIComponent(giocatore.nome || giocatore.nickname || "");
    link.target = "_blank";
    link.rel = "noopener";
    link.style.color = "inherit";
    link.style.textDecoration = "none";
    link.style.flexGrow = "1";
    link.textContent = giocatore.nome || giocatore.nickname || "Giocatore";
    card.appendChild(link);

    const elo = document.createElement("span");
    elo.className = "stato-media";
    elo.textContent = "ELO " + (Number.isFinite(Number(giocatore.elo)) ? Math.round(Number(giocatore.elo)) : "—");
    elo.title = "ELO Othello";
    card.appendChild(elo);

    if (attivo) {
      const countdown = document.createElement("span");
      countdown.className = "countdown-turno";
      countdown.id = "countdown-turno";
      countdown.textContent = "⏱ --s";
      card.appendChild(countdown);
    }

    const colore = document.createElement("span");
    colore.className = "othello-colore-riga";
    colore.textContent = nomeColore(giocatore.colore);
    card.appendChild(colore);
    lista.appendChild(card);
  }
}

function aggiornaInterfacciaPartita() {
  const rigaTurno = document.getElementById("riga-turno");
  const messaggi = document.getElementById("messaggi-gioco");
  const inCorso = stato.fase === "in_corso";
  const coloreLocale = coloreUtenteDaPartita(stato);
  const mioTurno = inCorso && !!coloreLocale && stato.turno === coloreLocale;

  if (rigaTurno) {
    if (stato.fase === "attesa_giocatori") rigaTurno.textContent = "⏳ In attesa dell'avversario…";
    else if (stato.fase === "terminata") rigaTurno.textContent = "Partita terminata";
    else rigaTurno.textContent = mioTurno ? "● È il tuo turno!" : "⏳ In attesa…";
  }

  if (messaggi) {
    if (stato.fase === "attesa_giocatori") messaggi.textContent = "In attesa dell'avversario…";
    else if (stato.fase === "terminata") messaggi.textContent = "Partita terminata";
    else if (mioTurno && !mosseLegaliCorrenti.length) messaggi.textContent = "Nessuna mossa disponibile: passi il turno";
    else messaggi.textContent = "";
  }
}

function render() {
  const coloreLocale = coloreUtenteDaPartita(stato);
  if (coloreLocale) mioColore = coloreLocale;
  mosseLegaliCorrenti = (stato.fase === "in_corso" && coloreLocale) ? mosseLegaliPer(stato.tavola, coloreLocale) : [];
  renderTavola();
  renderPunteggio();
  renderPannelloGiocatori();
  aggiornaInterfacciaPartita();
}

/* =========================================================
   TIMER TURNO
   ========================================================= */

function aggiornaCountdownTurno() {
  const el = document.getElementById("countdown-turno");
  if (!el) return;
  if (!stato.scadenzaTurno || stato.fase !== "in_corso") {
    el.textContent = "⏱ --s";
    return;
  }

  const secondi = Math.max(0, Math.ceil((Number(stato.scadenzaTurno) - Date.now()) / 1000));
  el.textContent = "⏱ " + secondi + "s";
  el.classList.toggle("countdown-scaduto", secondi <= 5);

  const chiave = stato.numeroMossa + ":" + stato.turno;
  if (secondi <= 10 && secondi > 0 && avvisoTempoChiave !== chiave && stato.turno === coloreUtenteDaPartita(stato)) {
    avvisoTempoChiave = chiave;
    suonaAvvisoTempo();
  }
}

/* =========================================================
   APPLICAZIONE STATO / SOCKET
   ========================================================= */

async function applicaStatoPartita(partita, istantanea = false) {
  if (!partita || typeof partita !== "object") return false;
  if (!tavolaValida(partita.tavola)) {
    mostraNotificaGioco("Stato della tavola non valido: attendo la sincronizzazione.");
    attesaSnapshot = true;
    return false;
  }

  const prossimo = { ...ultimoStatoRicevuto, ...partita };
  prossimo.tavola = copiaTavola(partita.tavola);

  const numeroMossaIngresso = Number.isFinite(Number(prossimo.numeroMossa))
    ? Number(prossimo.numeroMossa)
    : 0;
  const numeroMossaCorrente = Number.isFinite(Number(stato.numeroMossa))
    ? Number(stato.numeroMossa)
    : 0;

  if (!istantanea && numeroMossaIngresso < Math.max(numeroMossaCorrente, ultimoNumeroMossaAccettato)) {
    console.warn("Othello: ignorato stato arretrato", {
      ricevuto: numeroMossaIngresso,
      corrente: numeroMossaCorrente,
      accettato: ultimoNumeroMossaAccettato
    });
    return false;
  }

  ultimoStatoRicevuto = prossimo;
  sincronizzaIdentitaDaPartita(prossimo);

  const interrompeAnimazione = animazioniDaAttendere > 0;
  const generazione = ++animazioniDaAttendereGenerazione;
  animazioniDaAttendere = 1;
  const precedenteNumeroMossa = numeroMossaCorrente;
  const turnoPrecedente = stato.turno;
  const tavolaPrecedente = tavolaDisegnata;

  let timerSicurezza = null;
  try {
    const animazione = animaVersoTavola(
      prossimo.tavola,
      istantanea || interrompeAnimazione || !tavolaPrecedente,
      generazione
    ).then(() => true);

    const scaduto = new Promise(resolve => {
      timerSicurezza = setTimeout(() => resolve(false), TIMEOUT_ANIMAZIONE_MS);
    });

    const finita = await Promise.race([animazione, scaduto]);
    if (!finita && generazione === animazioniDaAttendereGenerazione) {
      sincronizzaDischiIstantaneo(prossimo.tavola);
    }
  } catch (errore) {
    console.error("Animazione tavola Othello:", errore);
    if (generazione === animazioniDaAttendereGenerazione) {
      sincronizzaDischiIstantaneo(prossimo.tavola);
    }
  } finally {
    clearTimeout(timerSicurezza);
  }

  if (generazione !== animazioniDaAttendereGenerazione) return false;

  stato = prossimo;
  ultimoStatoRicevuto = prossimo;
  ultimoNumeroMossaAccettato = Math.max(ultimoNumeroMossaAccettato, numeroMossaIngresso);
  sincronizzaIdentitaDaPartita(stato);
  animazioniDaAttendere = 0;

  if (istantanea || prossimo.fase !== "in_corso" || stato.numeroMossa !== precedenteNumeroMossa) {
    mossaInAttesa = false;
    clearTimeout(timerMossaInAttesa);
  }
  if (stato.numeroMossa !== precedenteNumeroMossa) {
    avvisoTempoChiave = "";
  }

  render();

  if (
    stato.fase === "in_corso" &&
    stato.turno === turnoPrecedente &&
    stato.numeroMossa !== precedenteNumeroMossa &&
    giocatoriStato().length >= 2
  ) {
    const chiNonMuove = giocatoriStato().find(g => g.colore !== stato.turno);
    mostraMessaggioGiocoGrande(
      (chiNonMuove?.nome || chiNonMuove?.nickname || "L'avversario") + " non ha mosse disponibili",
      { dettaglio: "Tocca ancora a " + (stato.turno === coloreUtenteDaPartita(stato) ? "te" : nomeColore(stato.turno).toLowerCase()), icona: "⏭️", durata: 2400 }
    );
  }

  if (
    stato.fase === "in_corso" &&
    stato.turno === coloreUtenteDaPartita(stato) &&
    stato.numeroMossa !== precedenteNumeroMossa
  ) {
    suonaTuoTurno();
  }

  if (stato.fase === "in_corso" && giocatoriStato().length >= 2 && !presentazioneSfidaGiaVista()) {
    setTimeout(() => {
      if (stato.fase === "in_corso") mostraPresentazioneSfida();
    }, 260);
  }

  if (stato.fase === "terminata" || (stato.vincitoreUid !== undefined && stato.motivoFine)) {
    mostraVittoria(stato);
  }

  return true;
}

function cliccaCasella(r, c) {
  if (animazioniDaAttendere || mossaInAttesa || attesaSnapshot) return;
  const coloreLocale = coloreUtenteDaPartita(stato);
  if (stato.fase !== "in_corso" || !coloreLocale || stato.turno !== coloreLocale) return;
  const mossa = mosseLegaliCorrenti.find(m => m.r === r && m.c === c);
  if (!mossa) return;

  if (!inviaSocket({ tipo: "othello_mossa", partitaId: stato.id || partitaId, a: { r, c } })) {
    mostraNotificaGioco("Connessione assente: la mossa non è stata inviata.");
    return;
  }
  mossaInAttesa = true;
  clearTimeout(timerMossaInAttesa);
  timerMossaInAttesa = setTimeout(() => {
    if (!mossaInAttesa) return;
    mostraNotificaGioco("Conferma della mossa in ritardo: sincronizzazione in corso…");
    attesaSnapshot = true;
    if (!inviaSocket({ tipo: "othello_entra", partitaId: stato.id || partitaId, stanza })) socket?.close();
  }, 8000);
  renderTavola();
}

/* =========================================================
   VITTORIA
   ========================================================= */

function mostraVittoria(dati = {}) {
  if (vittoriaMostrata) return;
  vittoriaMostrata = true;
  chiudiPresentazioneSfida();
  impostaMediaPartitaAttiva(false);
  suonaVittoria();
  const vincitoreUid = dati.vincitoreUid || stato.vincitoreUid || null;
  const vincitore = vincitoreUid ? (stato.giocatori?.[vincitoreUid] || null) : null;
  const conteggio = contaDischi(stato.tavola);
  const testo = document.getElementById("testo-vincitore");
  if (testo) {
    if (!vincitoreUid) testo.textContent = "🤝 Partita terminata in parità (" + conteggio.nero + "-" + conteggio.bianco + ")";
    else if (vincitoreUid === mioUid) testo.textContent = "🎉 Hai vinto! (" + conteggio.nero + "-" + conteggio.bianco + ")";
    else testo.textContent = "🎉 Ha vinto " + (vincitore?.nome || vincitore?.nickname || "l'avversario") + " (" + conteggio.nero + "-" + conteggio.bianco + ")";
  }
  const overlay = document.getElementById("overlay-vittoria");
  if (overlay) {
    overlay.classList.add("aperto");
    const bottone = overlay.querySelector("button");
    if (bottone) bottone.focus();
  }
}

/* =========================================================
   CHAT
   ========================================================= */

function aggiornaBadgeChatPartita() {
  const badge = document.getElementById("badge-chat-partita");
  if (!badge) return;
  if (messaggiChatNonLetti > 0) {
    badge.style.display = "flex";
    badge.textContent = messaggiChatNonLetti > 9 ? "9+" : String(messaggiChatNonLetti);
  } else {
    badge.style.display = "none";
  }
}

function aggiungiMessaggioChatPartita(nome, testo) {
  suonaMessaggioChat();
  const box = document.getElementById("chat-messaggi");
  if (!box) return;
  const riga = document.createElement("div");
  riga.className = "chat-msg";
  const autore = document.createElement("b");
  autore.textContent = (nome || "Giocatore") + ":";
  riga.append(autore, document.createTextNode(" " + (testo || "")));
  box.appendChild(riga);
  box.scrollTop = box.scrollHeight;

  const pannelloChat = document.getElementById("pannello-chat");
  if (pannelloChat && pannelloChat.classList.contains("nascosto")) {
    messaggiChatNonLetti++;
    aggiornaBadgeChatPartita();
  }
}

function inviaChatPartita() {
  const input = document.getElementById("chat-input");
  if (!input) return;
  const testo = input.value.trim();
  if (!testo) return;
  if (inviaSocket({ tipo: "othello_chat", partitaId: stato.id || partitaId, messaggio: testo })) input.value = "";
  else mostraNotificaGioco("Connessione assente: il messaggio non è stato inviato.");
}

/* =========================================================
   MENU / PANNELLI
   ========================================================= */

function chiudiMenu() {
  const pannello = document.getElementById("pannello-menu");
  const bottone = document.getElementById("btn-menu");
  if (pannello) pannello.classList.add("nascosto");
  if (bottone) {
    bottone.setAttribute("aria-expanded", "false");
    bottone.setAttribute("aria-label", "Apri menu");
  }
}

function chiudiPannelloGiocatori() {
  document.getElementById("pannello-giocatori")?.classList.remove("aperto");
  document.getElementById("backdrop-giocatori")?.classList.remove("aperto");
  const bottone = document.getElementById("btn-giocatori");
  if (bottone) {
    bottone.setAttribute("aria-expanded", "false");
    bottone.setAttribute("aria-label", "Mostra giocatori");
  }
}

function chiudiChat() {
  document.getElementById("pannello-chat")?.classList.add("nascosto");
  const bottone = document.getElementById("btn-chat");
  if (bottone) {
    bottone.setAttribute("aria-expanded", "false");
    bottone.setAttribute("aria-label", "Apri chat");
  }
}

function apriProfilo() {
  chiudiMenu();
  window.location.href = ORIGINE_SERVER + "/profilo.html";
}
function apriImpostazioni() {
  chiudiMenu();
  window.location.href = ORIGINE_SERVER + "/account.html";
}

function urlLobby() {
  return stanza ? "lobbyothello.html?stanza=" + encodeURIComponent(stanza) : "lobbyothello.html";
}
function tornaAllaLobby() {
  paginaInChiusura = true;
  window.location.replace(urlLobby());
}

let risolviConfermaGioco = null;
function chiudiConfermaGioco(esito) {
  const overlay = document.getElementById("overlay-conferma-gioco");
  if (overlay) {
    overlay.classList.remove("aperto");
    overlay.setAttribute("aria-hidden", "true");
  }
  const risolvi = risolviConfermaGioco;
  risolviConfermaGioco = null;
  if (typeof risolvi === "function") risolvi(!!esito);
}

function chiediConfermaGioco({ titolo, messaggio, testoConferma } = {}) {
  const overlay = document.getElementById("overlay-conferma-gioco");
  const titoloEl = document.getElementById("titolo-conferma-gioco");
  const testoEl = document.getElementById("testo-conferma-gioco");
  const annulla = document.getElementById("btn-annulla-conferma-gioco");
  const conferma = document.getElementById("btn-conferma-gioco");
  if (!overlay || !annulla || !conferma) return Promise.resolve(false);

  if (risolviConfermaGioco) chiudiConfermaGioco(false);
  if (titoloEl) titoloEl.textContent = titolo || "Confermare l'operazione?";
  if (testoEl) testoEl.textContent = messaggio || "Vuoi continuare?";
  conferma.textContent = testoConferma || "Conferma";
  overlay.classList.add("aperto");
  overlay.setAttribute("aria-hidden", "false");

  return new Promise(resolve => {
    risolviConfermaGioco = resolve;
    annulla.onclick = () => chiudiConfermaGioco(false);
    conferma.onclick = () => chiudiConfermaGioco(true);
    overlay.onclick = evento => {
      if (evento.target === overlay) chiudiConfermaGioco(false);
    };
    annulla.focus();
  });
}

async function abbandonaPartita() {
  chiudiMenu();
  const confermato = await chiediConfermaGioco({
    titolo: "Abbandonare la partita?",
    messaggio: "Uscirai dalla partita e tornerai alla Lobby.",
    testoConferma: "Abbandona"
  });
  if (!confermato) return;
  if (!inviaSocket({ tipo: "othello_abbandona", partitaId: stato.id || partitaId })) {
    mostraNotificaGioco("Connessione assente: attendi la riconnessione prima di abbandonare la partita.");
    return;
  }
  paginaInChiusura = true;
  setTimeout(tornaAllaLobby, 120);
}

/* =========================================================
   WEBSOCKET OTHELLO
   ========================================================= */

function gestisciMessaggioSocket(dati) {
  if (!dati || typeof dati !== "object") return;

  aggiornaNomiPartecipanti(dati);
  if (typeof dati.mediaAttiva === "boolean") impostaMediaPartitaAttiva(dati.mediaAttiva);

  if (dati.tipo === "othello_identita") {
    mioUid = dati.uid || mioUid;
    if (coloreValido(dati.colore) && !coloreUtenteDaPartita(stato)) {
      mioColore = dati.colore;
      tavolaDisegnata = null;
      render();
    }
    return;
  }

  if (dati.tipo === "othello_stato") {
    if (dati.uid) mioUid = dati.uid;
    if (!dati.partita || !tavolaValida(dati.partita.tavola)) return;

    const istantanea = attesaSnapshot;
    attesaSnapshot = false;
    applicaStatoPartita(dati.partita, istantanea).then(ok => {
      if (!ok && istantanea) attesaSnapshot = true;
      if (ok) segnalaStatoInizialeRicevuto();
    });
    return;
  }

  if (dati.tipo === "othello_chat") {
    aggiungiMessaggioChatPartita(dati.nickname || "Giocatore", dati.messaggio || "");
    return;
  }

  if (dati.tipo === "othello_fine") {
    const conclusa = { ...(dati.partita || {}), fase: "terminata" };
    if (Object.prototype.hasOwnProperty.call(dati, "vincitoreUid")) conclusa.vincitoreUid = dati.vincitoreUid;
    if (dati.motivo) conclusa.motivoFine = dati.motivo;
    applicaStatoPartita(conclusa);
    return;
  }

  if (dati.tipo === "othello_rivincita") {
    mostraNotificaGioco(dati.messaggio || "L'avversario chiede una rivincita.");
    return;
  }

  if (dati.tipo === "statoMedia") { gestisciStatoMedia(dati); return; }
  if (dati.tipo === "configMedia") { aggiornaConfigurazioneIce(dati.configurazioneIce); return; }
  if (dati.tipo === "webrtc-offer") { gestisciPromessaWebRtc(gestisciOffertaRicevuta(dati.mittenteUid, dati.sdp)); return; }
  if (dati.tipo === "webrtc-answer") { gestisciPromessaWebRtc(gestisciRispostaRicevuta(dati.mittenteUid, dati.sdp)); return; }
  if (dati.tipo === "webrtc-ice-candidate") { gestisciPromessaWebRtc(gestisciCandidatoRicevuto(dati.mittenteUid, dati.candidate)); return; }

  if (dati.tipo === "othello_errore") {
    mossaInAttesa = false;
    clearTimeout(timerMossaInAttesa);
    attesaSnapshot = true;
    renderTavola();
    const errore = dati.errore || "Operazione non consentita.";
    mostraNotificaGioco(errore);

    inviaSocket({ tipo: "othello_entra", partitaId: stato.id || partitaId, stanza });

    const minuscolo = errore.toLowerCase();
    if (minuscolo.includes("non trovata") || minuscolo.includes("non fai parte")) setTimeout(tornaAllaLobby, 2200);
    return;
  }

  if (dati.tipo === "sessioneScaduta") {
    paginaInChiusura = true;
    window.location.href = ORIGINE_SERVER + "/login.html?redirect=" + encodeURIComponent(window.location.href);
  }
}

function connetti() {
  clearTimeout(timerRiconnessione);
  if (paginaInChiusura) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const q = new URLSearchParams({ gioco: "othello", stanza });
  const token = tokenAutenticazione();
  if (token) q.set("token", token);
  if (partitaId) q.set("partita", partitaId);

  let ws;
  try {
    ws = new WebSocket(URL_WEBSOCKET + "/?" + q.toString());
    socket = ws;
  } catch (errore) {
    console.error("Apertura WebSocket non riuscita:", errore);
    impostaStatoConnessione(true);
    timerRiconnessione = setTimeout(connetti, 1800);
    return;
  }

  ws.onopen = () => {
    attesaSnapshot = true;
    mossaInAttesa = false;
    clearTimeout(timerMossaInAttesa);
    impostaStatoConnessione(false);
    aggiornaCaricamento("Sincronizzazione partita…", 70);

    if (socket === ws) {
      inviaSocket({ tipo: "othello_entra", partitaId: partitaId || null, stanza });
    }
  };

  ws.onmessage = evento => {
    if (socket !== ws) return;

    let dati;
    try {
      dati = JSON.parse(evento.data);
    } catch (errore) {
      console.error("Messaggio WebSocket non valido:", errore);
      return;
    }
    gestisciMessaggioSocket(dati);
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    if (socket !== ws) return;

    socket = null;
    if (paginaInChiusura) return;

    attesaSnapshot = true;
    mossaInAttesa = false;
    clearTimeout(timerMossaInAttesa);
    impostaStatoConnessione(true);

    const messaggi = document.getElementById("messaggi-gioco");
    if (messaggi) messaggi.textContent = "Connessione persa — riconnessione in corso…";

    clearTimeout(timerRiconnessione);
    timerRiconnessione = setTimeout(connetti, 1800);
  };
}

async function avvia() {
  inizializzaGestioneLayout();
  aggiornaTestoBottoneSuoni();
  render();

  if (!partitaId) {
    aggiornaCaricamento("Partita non specificata", 100);
    terminaCaricamento("Partita non specificata");
    mostraNotificaGioco("Manca l'identificativo della partita. Ritorno alla lobby…");
    setTimeout(tornaAllaLobby, 1800);
    return;
  }

  timerMassimoCaricamento = setTimeout(() => {
    const overlay = document.getElementById("overlay-caricamento");
    if (overlay && !overlay.classList.contains("caricamento-finito")) {
      document.body.classList.remove("caricamento-in-corso");
      overlay.classList.add("caricamento-finito");
      mostraNotificaGioco("Il caricamento sta richiedendo più tempo del previsto. La connessione continuerà in automatico.");
    }
  }, 20000);

  aggiornaCaricamento("Verifica accesso…", 25);
  try {
    const token = tokenAutenticazione();
    const opzioni = {
      credentials: "include",
      cache: "no-store",
      headers: token ? { Authorization: "Bearer " + token } : {}
    };
    let risposta = await fetch(ORIGINE_SERVER + "/api/me-menu", opzioni);
    if (token && (risposta.status === 401 || risposta.status === 403)) {
      risposta = await fetch(ORIGINE_SERVER + "/api/me-menu", { credentials: "include", cache: "no-store" });
      if (risposta.ok) {
        try { if (sessionStorage.getItem(CHIAVE_TOKEN_AUTH) === token) sessionStorage.removeItem(CHIAVE_TOKEN_AUTH); } catch (_) {}
      }
    }
    if (risposta.status === 401 || risposta.status === 403) {
      paginaInChiusura = true;
      window.location.href = ORIGINE_SERVER + "/login.html?redirect=" + encodeURIComponent(window.location.href);
      return;
    }
    if (risposta.ok) {
      const profilo = await risposta.json();
      if (profilo && profilo.uid) mioUid = profilo.uid;
    }
  } catch (errore) {
    console.warn("Verifica HTTP non disponibile, provo il WebSocket:", errore);
  }

  aggiornaCaricamento("Connessione alla partita…", 55);
  connetti();
}

/* =========================================================
   EVENTI UI
   ========================================================= */

const btnMenu = document.getElementById("btn-menu");
if (btnMenu) {
  btnMenu.onclick = evento => {
    evento.stopPropagation();
    const pannello = document.getElementById("pannello-menu");
    if (!pannello) return;
    const staPerAprirsi = pannello.classList.contains("nascosto");
    if (staPerAprirsi) {
      chiudiChat();
      chiudiPannelloGiocatori();
    }
    const aperto = pannello.classList.toggle("nascosto") === false;
    btnMenu.setAttribute("aria-expanded", aperto ? "true" : "false");
    btnMenu.setAttribute("aria-label", aperto ? "Chiudi menu" : "Apri menu");
  };
}

document.addEventListener("click", chiudiMenu);

const btnGiocatori = document.getElementById("btn-giocatori");
if (btnGiocatori) {
  btnGiocatori.onclick = evento => {
    evento.stopPropagation();
    const pannello = document.getElementById("pannello-giocatori");
    if (!pannello) return;
    const staPerAprirsi = !pannello.classList.contains("aperto");
    if (staPerAprirsi) {
      chiudiMenu();
      chiudiChat();
    }
    const aperto = pannello.classList.toggle("aperto");
    document.getElementById("backdrop-giocatori")?.classList.toggle("aperto", aperto);
    btnGiocatori.setAttribute("aria-expanded", aperto ? "true" : "false");
    btnGiocatori.setAttribute("aria-label", aperto ? "Nascondi giocatori" : "Mostra giocatori");
  };
}

document.getElementById("backdrop-giocatori")?.addEventListener("click", chiudiPannelloGiocatori);

const btnChat = document.getElementById("btn-chat");
if (btnChat) {
  btnChat.onclick = evento => {
    evento.stopPropagation();
    const pannello = document.getElementById("pannello-chat");
    if (!pannello) return;
    const staPerAprirsi = pannello.classList.contains("nascosto");
    if (staPerAprirsi) {
      chiudiMenu();
      chiudiPannelloGiocatori();
    }
    const aperto = pannello.classList.toggle("nascosto") === false;
    btnChat.setAttribute("aria-expanded", aperto ? "true" : "false");
    btnChat.setAttribute("aria-label", aperto ? "Chiudi chat" : "Apri chat");
    if (aperto) {
      messaggiChatNonLetti = 0;
      aggiornaBadgeChatPartita();
      setTimeout(() => document.getElementById("chat-input")?.focus(), 0);
    }
  };
}

document.getElementById("chat-input")?.addEventListener("keydown", evento => {
  if (evento.key === "Enter" && !evento.isComposing) {
    evento.preventDefault();
    inviaChatPartita();
  }
});

document.addEventListener("keydown", evento => {
  if (evento.key !== "Escape") return;
  chiudiMenu();
  chiudiChat();
  chiudiPannelloGiocatori();
  if (risolviConfermaGioco) chiudiConfermaGioco(false);
});

window.addEventListener("beforeunload", () => {
  pulisciMediaPagina();
});

aggiornaInterfacciaMedia(mediaRichiestaDaLobby ? "Verifica impostazioni del tavolo…" : "Non attiva", false);
setInterval(aggiornaCountdownTurno, 250);
avvia();
