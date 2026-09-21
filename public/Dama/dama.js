"use strict";

/* =========================================================
   DAMA ITALIANA — interfaccia uguale al Gioco dell'Oca
   La logica di gioco resta quella della Dama Italiana.
   Non esistono dadi né fase "Chi inizia": inizia il Bianco.
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
const stanza = params.get("stanza") || "dama";
const CHIAVE_TOKEN_AUTH = "giochiSocietaAuthToken";

let socket = null;
let timerRiconnessione = null;
let paginaInChiusura = false;
let mioUid = null;
let mioColore = null;
let selezionata = null;
let mosseLegali = [];
let ultimoTurnoSegnalato = null;
let chatPartitaAttiva = true;
let messaggiChatNonLetti = 0;
let graficaCaricata = false;
let statoInizialeRicevuto = false;
let timerMassimoCaricamento = null;
let percentualeCaricamento = 10;
let presentazioneSfidaAperta = false;
let timerChiusuraPresentazioneSfida = null;
let avvisoTempoChiave = "";

function creaScacchieraIniziale() {
  const scacchiera = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) scacchiera[r][c] = { colore: "nero", dama: false };
    }
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) scacchiera[r][c] = { colore: "bianco", dama: false };
    }
  }
  return scacchiera;
}

let stato = {
  id: partitaId || null,
  stanza,
  fase: "attesa_giocatori",
  iniziata: false,
  turno: "bianco",
  scacchiera: creaScacchieraIniziale(),
  giocatori: {},
  numeroMossa: 0,
  ultimoMovimento: null,
  prese: {},
  presaInCorso: null,
  scadenzaTurno: null,
  durataTurnoMs: null,
  classificata: true,
  vincitoreUid: null,
  motivoFine: null
};

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
   CARICAMENTO — uguale al Gioco dell'Oca
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
  aggiornaCaricamento(graficaCaricata ? "Partita pronta" : "Caricamento damiera…", graficaCaricata ? 100 : 85);
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
   AUDIO — stesso comportamento generale dell'Oca
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

function suonaMossa() { suonaTono(430, 60, "sine", 0.08, 0); }
function suonaPresa() { suonaTono(260, 90, "square", 0.09, 0); suonaTono(180, 110, "triangle", 0.08, 70); }
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
   FULLSCREEN / LAYOUT — stessa logica dell'Oca
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
  // La damiera quadrata si adatta al telefono senza ruotare l'intera interfaccia.
  document.body.classList.remove("modalita-ruotata");
}

function aggiornaLayoutTabellone() {
  const areaTabellone = document.getElementById("area-tabellone");
  const mondo = document.getElementById("mondo-ruotato");
  if (!areaTabellone || !mondo) return;

  const eRuotato = document.body.classList.contains("modalita-ruotata");
  const larghezzaFinestra = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const altezzaReale = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--altezza-reale", altezzaReale + "px");

  const larghezzaCanvas = eRuotato ? altezzaReale : larghezzaFinestra;
  const altezzaCanvas = eRuotato ? larghezzaFinestra : altezzaReale;
  mondo.style.width = larghezzaCanvas + "px";
  mondo.style.height = altezzaCanvas + "px";

  const orizzontaleCompatto = larghezzaCanvas > altezzaCanvas * 1.35 && altezzaCanvas < 620;
  const altezzaRaccolta = orizzontaleCompatto ? 40 : larghezzaCanvas < 600 ? 44 : 54;
  document.documentElement.style.setProperty("--altezza-raccolta", altezzaRaccolta + "px");
  const margineOrizzontale = larghezzaCanvas < 600 ? 10 : 26;
  const spazioComandi = orizzontaleCompatto ? 8 : altezzaCanvas < 500 ? 50 : 66;
  const larghezzaDisponibile = larghezzaCanvas - margineOrizzontale * 2;
  const altezzaDisponibile = altezzaCanvas - 2 * (altezzaRaccolta + 18 + spazioComandi);
  const lato = Math.max(120, Math.min(larghezzaDisponibile, altezzaDisponibile, 880));

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
   PRESENTAZIONE SFIDA — stessa grafica dell'Oca
   ========================================================= */

function chiavePresentazioneSfida() {
  return "giochi-societa:dama:presentazione-sfida:" + (partitaId || "sconosciuta");
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

  const sx = elenco.find(g => g.colore === "bianco") || elenco[0];
  const dx = elenco.find(g => g.colore === "nero") || elenco[1];

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
    ? "Partita classificata · Dama italiana · ELO attivo"
    : "Partita Divertimento · Dama italiana · ELO invariato";
  if (descrizione) descrizione.textContent = classificata
    ? "Giocatori reali · il risultato modifica il rating ELO della Dama"
    : "Giocatori reali · questa partita non modifica il rating ELO";
  if (statoSfida) statoSfida.textContent = classificata
    ? "Confronto ELO Dama · K = 32"
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
   DAMIERA / PARTITA
   ========================================================= */

function nomeColore(colore) {
  return colore === "bianco" ? "Bianco" : colore === "nero" ? "Nero" : "—";
}

const posizioniPedine = new Map();
const caselleDamiera = new Map();
const animazioniPedine = new Set();
const pedineInPresa = [];
let scacchieraDisegnata = null;
let preseDisegnate = { bianco: [], nero: [] };
let ultimoStatoRicevuto = stato;
let codaAnimazioni = Promise.resolve();
let generazioneAnimazioni = 0;
let statiInAttesa = 0;
let attesaSnapshot = true;
let mossaInAttesa = false;
let damieraMossaInAttesa = "";
let timerMossaInAttesa = null;
let richiestaMosse = null;
let richiestaMosseSuccessiva = null;
let versioneMosse = 0;
let vittoriaMostrata = false;

function chiaveCasella(r, c) { return r + "," + c; }
function coordinateValide(punto) {
  return punto && Number.isInteger(punto.r) && Number.isInteger(punto.c)
    && punto.r >= 0 && punto.r < 8 && punto.c >= 0 && punto.c < 8;
}
function stessaCasella(a, b) { return !!a && !!b && a.r === b.r && a.c === b.c; }
function scacchieraValida(scacchiera) {
  return Array.isArray(scacchiera) && scacchiera.length === 8
    && scacchiera.every(riga => Array.isArray(riga) && riga.length === 8
      && riga.every(pezzo => pezzo === null || (pezzo && (pezzo.colore === "bianco" || pezzo.colore === "nero"))));
}
function copiaScacchiera(scacchiera) {
  return scacchiera.map(riga => riga.map(pezzo => pezzo ? { colore: pezzo.colore, dama: !!pezzo.dama } : null));
}
function coordinateVisive(r, c) {
  // Dama italiana: casella scura in basso a destra; coordinate server invariate.
  return mioColore === "nero" ? { r: 7 - r, c } : { r, c: 7 - c };
}
function impostaPosizionePedina(elemento, r, c) {
  const visiva = coordinateVisive(r, c);
  elemento.style.left = (visiva.c * 12.5) + "%";
  elemento.style.top = (visiva.r * 12.5) + "%";
  elemento.dataset.r = String(r);
  elemento.dataset.c = String(c);
}
function creaElementoPedina(pezzo) {
  const elemento = document.createElement("div");
  elemento.className = "dama-pezzo " + pezzo.colore + (pezzo.dama ? " dama" : "");
  elemento.setAttribute("aria-hidden", "true");
  const faccia = document.createElement("span");
  faccia.className = "dama-faccia";
  elemento.appendChild(faccia);
  return elemento;
}
function preparaDamiera() {
  const damiera = document.getElementById("damiera");
  if (!damiera || caselleDamiera.size) return damiera;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const casella = document.createElement("button");
      casella.type = "button";
      casella.setAttribute("role", "gridcell");
      casella.dataset.r = String(r);
      casella.dataset.c = String(c);
      if ((r + c) % 2 === 1) casella.addEventListener("click", () => cliccaCasella(r, c));
      damiera.appendChild(casella);
      caselleDamiera.set(chiaveCasella(r, c), casella);
    }
  }
  let strato = document.getElementById("dama-strato-pedine");
  if (!strato) {
    strato = document.createElement("div");
    strato.id = "dama-strato-pedine";
    strato.setAttribute("aria-hidden", "true");
    damiera.appendChild(strato);
  }
  return damiera;
}
function sincronizzaPedine(scacchiera) {
  preparaDamiera();
  const strato = document.getElementById("dama-strato-pedine");
  if (!strato) return;
  const presenti = new Set();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const pezzo = scacchiera[r][c];
      if (!pezzo) continue;
      const chiave = chiaveCasella(r, c);
      presenti.add(chiave);
      let posizione = posizioniPedine.get(chiave);
      if (!posizione) {
        posizione = document.createElement("div");
        posizione.className = "dama-posizione";
        posizione.appendChild(creaElementoPedina(pezzo));
        strato.appendChild(posizione);
        posizioniPedine.set(chiave, posizione);
      }
      posizione.firstElementChild.className = "dama-pezzo " + pezzo.colore + (pezzo.dama ? " dama" : "");
      impostaPosizionePedina(posizione, r, c);
    }
  }
  for (const [chiave, elemento] of posizioniPedine) {
    if (presenti.has(chiave)) continue;
    elemento.remove();
    posizioniPedine.delete(chiave);
  }
  scacchieraDisegnata = copiaScacchiera(scacchiera);
}

function sincronizzaPrese(scacchiera, nuovePrese = [], ricostruisci = false) {
  if (ricostruisci) preseDisegnate = { bianco: [], nero: [] };
  for (const pezzo of nuovePrese) {
    const proprietario = pezzo.colore === "bianco" ? "nero" : "bianco";
    preseDisegnate[proprietario].push({ colore: pezzo.colore, dama: !!pezzo.dama });
  }
  const rimaste = { bianco: 0, nero: 0 };
  scacchiera.forEach(riga => riga.forEach(pezzo => { if (pezzo) rimaste[pezzo.colore]++; }));
  for (const proprietario of ["bianco", "nero"]) {
    const colorePreda = proprietario === "bianco" ? "nero" : "bianco";
    const ancoraSullaDamiera = pedineInPresa.filter(p => p.pezzo.colore === colorePreda).length;
    const numeroPrese = Math.max(0, Math.min(12, 12 - rimaste[colorePreda] - ancoraSullaDamiera));
    preseDisegnate[proprietario] = preseDisegnate[proprietario].slice(0, numeroPrese);
    while (preseDisegnate[proprietario].length < numeroPrese) {
      // Uno snapshot non rivela quali pedine fossero già dame al momento della presa.
      preseDisegnate[proprietario].unshift({ colore: colorePreda, dama: false, tipoSconosciuto: true });
    }
  }
}
function renderPrese() {
  const coloreVicino = mioColore || "bianco";
  const coloreLontano = coloreVicino === "bianco" ? "nero" : "bianco";
  for (const [lato, colore] of [["giocatore", coloreVicino], ["avversario", coloreLontano]]) {
    const elenco = preseDisegnate[colore];
    const giocatore = giocatoriStato().find(g => g.colore === colore);
    const nome = giocatore?.nome || giocatore?.nickname || nomeColore(colore);
    const etichetta = document.getElementById("prese-" + lato + "-etichetta");
    const conteggio = document.getElementById("prese-" + lato + "-conteggio");
    const raccolta = document.getElementById("prese-" + lato + "-pedine");
    if (etichetta) etichetta.textContent = lato === "giocatore" && mioColore ? "Le tue prese" : "Prese di " + nome;
    if (conteggio) conteggio.textContent = String(elenco.length);
    if (!raccolta) continue;
    raccolta.setAttribute("aria-label", elenco.length + " pedine catturate da " + nome);
    const firma = elenco.map(p => p.colore + ":" + p.dama + ":" + !!p.tipoSconosciuto).join("|");
    if (raccolta.dataset.firma === firma) continue;
    raccolta.dataset.firma = firma;
    raccolta.replaceChildren();
    for (const preda of elenco) {
      const contenitore = document.createElement("div");
      contenitore.className = "dama-preda" + (preda.tipoSconosciuto ? " tipo-sconosciuto" : "");
      contenitore.setAttribute("role", "listitem");
      contenitore.title = preda.tipoSconosciuto ? "Pedina catturata prima della connessione (tipo non disponibile)"
        : (preda.dama ? "Dama" : "Pedina") + " " + nomeColore(preda.colore).toLowerCase() + " catturata";
      contenitore.appendChild(creaElementoPedina(preda));
      raccolta.appendChild(contenitore);
    }
  }
}

function renderDamiera() {
  const damiera = preparaDamiera();
  if (!damiera) return;
  if (!scacchieraDisegnata) {
    sincronizzaPedine(stato.scacchiera);
    sincronizzaPrese(stato.scacchiera, [], true);
  }
  const destinazioni = new Map();
  for (const mossa of mosseLegali) {
    const arrivo = mossa.a || mossa.to;
    if (coordinateValide(arrivo)) destinazioni.set(chiaveCasella(arrivo.r, arrivo.c), !!(mossa.presa || mossa.capture));
  }
  const bloccata = statiInAttesa > 0 || mossaInAttesa || attesaSnapshot;
  damiera.setAttribute("aria-busy", bloccata ? "true" : "false");
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const key = chiaveCasella(r, c);
      const casella = caselleDamiera.get(key);
      const visiva = coordinateVisive(r, c);
      casella.style.gridRow = String(visiva.r + 1);
      casella.style.gridColumn = String(visiva.c + 1);
      const scura = (r + c) % 2 === 1;
      casella.className = "dama-casella " + (scura ? "scura" : "chiara");
      if (selezionata && selezionata.r === r && selezionata.c === c) casella.classList.add("selezionata");
      if (destinazioni.has(key)) casella.classList.add(destinazioni.get(key) ? "destinazione-presa" : "destinazione");
      const ultimo = stato.ultimoMovimento || {};
      if (stessaCasella(ultimo.da, { r, c }) || stessaCasella(ultimo.a, { r, c })) {
        casella.classList.add("ultima-mossa");
      }
      const pezzo = scacchieraDisegnata[r][c];
      const numero = scura ? r * 4 + Math.floor(c / 2) + 1 : null;
      casella.setAttribute("aria-label", (scura ? "Casella " + numero : "Casella chiara")
        + (pezzo ? ", " + (pezzo.dama ? "dama " : "pedina ") + nomeColore(pezzo.colore).toLowerCase() : ", vuota")
        + (destinazioni.has(key) ? ", destinazione consentita" : ""));
      casella.disabled = !scura || bloccata;
      const posizione = posizioniPedine.get(key);
      if (posizione) {
        posizione.classList.toggle("selezionata", stessaCasella(selezionata, { r, c }));
        if (!posizione.classList.contains("dama-in-animazione")) impostaPosizionePedina(posizione, r, c);
      }
    }
  }
  renderPrese();
}

function estraiMovimentoConfermato(prima, dopo) {
  const sparite = [];
  const arrivate = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const vecchio = prima[r][c];
      const nuovo = dopo[r][c];
      if (vecchio && (!nuovo || vecchio.colore !== nuovo.colore)) sparite.push({ r, c, pezzo: vecchio });
      if (nuovo && (!vecchio || vecchio.colore !== nuovo.colore)) arrivate.push({ r, c, pezzo: nuovo });
    }
  }
  if (arrivate.length !== 1) return null;
  const a = arrivate[0];
  const origini = sparite.filter(p => p.pezzo.colore === a.pezzo.colore);
  const catturate = sparite.filter(p => p.pezzo.colore !== a.pezzo.colore);
  if (origini.length !== 1 || catturate.length > 1) return null;
  const da = origini[0];
  const distanza = Math.abs(da.r - a.r);
  if (distanza !== Math.abs(da.c - a.c) || distanza !== (catturate.length ? 2 : 1)) return null;
  if (catturate.length && (catturate[0].r !== (da.r + a.r) / 2 || catturate[0].c !== (da.c + a.c) / 2)) return null;
  return { da, a, catturate };
}

async function animaVersoSnapshot(prossimo, istantanea, generazione) {
  const movimento = !istantanea && scacchieraDisegnata
    ? estraiMovimentoConfermato(scacchieraDisegnata, prossimo.scacchiera) : null;
  if (movimento) {
    const origine = chiaveCasella(movimento.da.r, movimento.da.c);
    const destinazione = chiaveCasella(movimento.a.r, movimento.a.c);
    const elemento = posizioniPedine.get(origine);
    if (elemento) {
      const da = coordinateVisive(movimento.da.r, movimento.da.c);
      const a = coordinateVisive(movimento.a.r, movimento.a.c);
      const dx = (da.c - a.c) * 100;
      const dy = (da.r - a.r) * 100;
      elemento.classList.add("dama-in-animazione");
      impostaPosizionePedina(elemento, movimento.a.r, movimento.a.c);
      if (typeof elemento.animate === "function") {
        const presa = movimento.catturate.length > 0;
        const fotogrammi = presa
          ? [0, .2, .4, .6, .8, 1].map(t => ({
              offset: t,
              transform:
                "translate(" + (dx * (1 - t)) + "%, " + (dy * (1 - t) - Math.sin(Math.PI * t) * 72) + "%) " +
                "scale(" + (1 + Math.sin(Math.PI * t) * .16) + ") " +
                "rotate(" + (Math.sin(Math.PI * t) * 9 * (dx >= 0 ? 1 : -1)) + "deg)"
            }))
          : [
              { transform: "translate(" + dx + "%, " + dy + "%)" },
              { transform: "translate(0, 0)" }
            ];
        const animazione = elemento.animate(fotogrammi, {
          duration: presa ? 620 : 420,
          easing: presa ? "cubic-bezier(.32,.08,.32,1)" : "cubic-bezier(.32,.05,.14,1)"
        });
        animazioniPedine.add(animazione);
        try { await animazione.finished; } catch (_) { /* Riconnessione o cambio di orientamento. */ }
        animazioniPedine.delete(animazione);
      }
      elemento.classList.remove("dama-in-animazione");
      if (generazione !== generazioneAnimazioni) return;
      posizioniPedine.delete(origine);
      posizioniPedine.set(destinazione, elemento);
      movimento.catturate.length ? suonaPresa() : suonaMossa();
    }
  }
  if (generazione !== generazioneAnimazioni) return;
  if (movimento) {
    for (const catturata of movimento.catturate) {
      const chiave = chiaveCasella(catturata.r, catturata.c);
      const elemento = posizioniPedine.get(chiave);
      if (elemento) {
        posizioniPedine.delete(chiave);
        elemento.classList.add("dama-preda-in-attesa");
      }
      pedineInPresa.push({ pezzo: catturata.pezzo, elemento });
    }
  }
  // Nella presa multipla italiana le pedine saltate restano fino alla fine della sequenza.
  const raccolte = [];
  if (!prossimo.presaInCorso) {
    for (const catturata of pedineInPresa.splice(0)) {
      raccolte.push(catturata.pezzo);
      catturata.elemento?.remove();
    }
  }
  sincronizzaPrese(prossimo.scacchiera, raccolte, istantanea);
  sincronizzaPedine(prossimo.scacchiera);
}

function annullaTransizioni() {
  generazioneAnimazioni++;
  for (const animazione of animazioniPedine) animazione.cancel();
  animazioniPedine.clear();
  codaAnimazioni = Promise.resolve();
  statiInAttesa = 0;
  mossaInAttesa = false;
  clearTimeout(timerMossaInAttesa);
  richiestaMosse = null;
  richiestaMosseSuccessiva = null;
  versioneMosse++;
  selezionata = null;
  mosseLegali = [];
  for (const elemento of posizioniPedine.values()) elemento.classList.remove("dama-in-animazione");
  for (const catturata of pedineInPresa.splice(0)) catturata.elemento?.remove();
}

function richiediMosseCasella(da) {
  if (richiestaMosse) {
    richiestaMosseSuccessiva = { ...da };
    return;
  }
  richiestaMosse = { ...da, versione: versioneMosse };
  if (!inviaSocket({ tipo: "dama_richiedi_mosse", partitaId: stato.id || partitaId, da })) {
    richiestaMosse = null;
    mostraNotificaGioco("Connessione assente: impossibile verificare le mosse.");
  }
}

function accodaStatoPartita(partita, istantanea = false) {
  const prossimo = { ...ultimoStatoRicevuto, ...partita };
  if (!scacchieraValida(prossimo.scacchiera)) {
    mostraNotificaGioco("Stato della damiera non valido: attendo la sincronizzazione.");
    return;
  }
  prossimo.scacchiera = copiaScacchiera(prossimo.scacchiera);
  ultimoStatoRicevuto = prossimo;
  if (istantanea) annullaTransizioni();
  const generazione = generazioneAnimazioni;
  statiInAttesa++;
  versioneMosse++;
  selezionata = null;
  mosseLegali = [];
  richiestaMosseSuccessiva = null;
  renderDamiera();
  codaAnimazioni = codaAnimazioni.then(async () => {
    if (generazione !== generazioneAnimazioni) return;
    const precedenteNumeroMossa = stato.numeroMossa;
    await animaVersoSnapshot(prossimo, istantanea, generazione);
    if (generazione !== generazioneAnimazioni) return;
    stato = prossimo;
    statiInAttesa--;
    if (istantanea || prossimo.fase !== "in_corso" || JSON.stringify(prossimo.scacchiera) !== damieraMossaInAttesa) {
      mossaInAttesa = false;
      clearTimeout(timerMossaInAttesa);
    }
    if (stato.numeroMossa !== precedenteNumeroMossa) avvisoTempoChiave = "";
    render();
    if (statiInAttesa) return;
    if (stato.fase === "in_corso" && stato.presaInCorso?.uid === mioUid && coordinateValide(stato.presaInCorso)) {
      selezionata = { r: stato.presaInCorso.r, c: stato.presaInCorso.c };
      renderDamiera();
      richiediMosseCasella(selezionata);
    }
    if (stato.fase === "in_corso" && giocatoriStato().length >= 2 && !presentazioneSfidaGiaVista()) {
      setTimeout(() => { if (stato.fase === "in_corso") mostraPresentazioneSfida(); }, 260);
    }
    if (stato.fase === "terminata" || stato.vincitoreUid || stato.motivoFine) mostraVittoria(stato);
  }).catch(errore => {
    if (generazione !== generazioneAnimazioni) return;
    console.error("Sincronizzazione damiera:", errore);
    annullaTransizioni();
    stato = ultimoStatoRicevuto;
    sincronizzaPedine(stato.scacchiera);
    sincronizzaPrese(stato.scacchiera, [], true);
    render();
    mostraNotificaGioco("Damiera risincronizzata con la partita.");
  });
}

function cliccaCasella(r, c) {
  if (statiInAttesa || mossaInAttesa || attesaSnapshot) return;
  if (stato.fase !== "in_corso" || !mioColore || stato.turno !== mioColore) return;
  const pezzo = stato.scacchiera?.[r]?.[c];

  if (pezzo && pezzo.colore === mioColore) {
    selezionata = { r, c };
    mosseLegali = [];
    renderDamiera();
    richiediMosseCasella({ r, c });
    return;
  }

  if (!selezionata) return;
  const scelta = mosseLegali.find(mossa => {
    const arrivo = mossa.a || mossa.to;
    return arrivo && arrivo.r === r && arrivo.c === c;
  });
  if (!scelta) return;

  if (!inviaSocket({ tipo: "dama_mossa", partitaId: stato.id || partitaId, da: selezionata, a: { r, c } })) {
    mostraNotificaGioco("Connessione assente: la mossa non è stata inviata.");
    return;
  }
  mossaInAttesa = true;
  damieraMossaInAttesa = JSON.stringify(stato.scacchiera);
  clearTimeout(timerMossaInAttesa);
  timerMossaInAttesa = setTimeout(() => {
    if (!mossaInAttesa) return;
    mostraNotificaGioco("Conferma della mossa in ritardo: sincronizzazione in corso…");
    // Una mossa non confermata non viene ritentata: si richiede lo snapshot aggiornato.
    attesaSnapshot = true;
    if (!inviaSocket({ tipo: "dama_entra", partitaId: stato.id || partitaId, stanza })) socket?.close();
  }, 8000);
  selezionata = null;
  mosseLegali = [];
  renderDamiera();
}

function creaAvatarMini(nome, avatar, colore) {
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
    return a.colore === "bianco" ? -1 : 1;
  });

  for (const giocatore of giocatori) {
    const attivo = stato.fase === "in_corso" && giocatore.colore === stato.turno;
    const card = document.createElement("div");
    card.className = "giocatore-card" + (attivo ? " attivo" : "");
    card.appendChild(creaAvatarMini(giocatore.nome || giocatore.nickname, giocatore.avatar, coloreDaNome(giocatore.nome)));

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
    elo.title = "ELO Dama";
    card.appendChild(elo);

    if (attivo) {
      const countdown = document.createElement("span");
      countdown.className = "countdown-turno";
      countdown.id = "countdown-turno";
      countdown.textContent = "⏱ --s";
      card.appendChild(countdown);
    }

    const colore = document.createElement("span");
    colore.className = "casella-mini dama-colore";
    colore.textContent = nomeColore(giocatore.colore);
    card.appendChild(colore);
    lista.appendChild(card);
  }
}

function aggiornaInterfacciaPartita() {
  const rigaTurno = document.getElementById("riga-turno");
  const messaggi = document.getElementById("messaggi-gioco");
  const inCorso = stato.fase === "in_corso";
  const mioTurno = inCorso && !!mioColore && stato.turno === mioColore;

  if (rigaTurno) {
    if (stato.fase === "attesa_giocatori") rigaTurno.textContent = "⏳ In attesa dell'avversario…";
    else if (stato.fase === "terminata") rigaTurno.textContent = "Partita terminata";
    else rigaTurno.textContent = mioTurno ? "● È il tuo turno!" : "⏳ In attesa…";
  }

  if (messaggi) {
    if (stato.fase === "attesa_giocatori") messaggi.textContent = "In attesa dell'avversario…";
    else if (stato.fase === "terminata") messaggi.textContent = "Partita terminata";
    else if (mioTurno && stato.presaInCorso?.uid === mioUid) messaggi.textContent = "Continua la presa obbligatoria";
    else messaggi.textContent = "";
  }

  ultimoTurnoSegnalato = stato.numeroMossa + ":" + stato.turno;
}

function render() {
  renderDamiera();
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
  if (secondi <= 10 && secondi > 0 && avvisoTempoChiave !== chiave && stato.turno === mioColore) {
    avvisoTempoChiave = chiave;
    suonaAvvisoTempo();
  }
}

/* =========================================================
   VITTORIA
   ========================================================= */

function mostraVittoria(dati = {}) {
  if (vittoriaMostrata) return;
  vittoriaMostrata = true;
  chiudiPresentazioneSfida();
  suonaVittoria();
  const vincitoreUid = dati.vincitoreUid || stato.vincitoreUid || null;
  const vincitore = vincitoreUid ? (stato.giocatori?.[vincitoreUid] || null) : null;
  const testo = document.getElementById("testo-vincitore");
  if (testo) {
    if (!vincitoreUid) testo.textContent = "🤝 Partita terminata in parità";
    else if (vincitoreUid === mioUid) testo.textContent = "🎉 Hai vinto!";
    else testo.textContent = "🎉 Ha vinto " + (vincitore?.nome || vincitore?.nickname || "l'avversario") + "!";
  }
  const overlay = document.getElementById("overlay-vittoria");
  if (overlay) {
    overlay.classList.add("aperto");
    const bottone = overlay.querySelector("button");
    if (bottone) bottone.focus();
  }
}

/* =========================================================
   CHAT — stessa UI dell'Oca, protocollo Dama
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
  if (inviaSocket({ tipo: "dama_chat", partitaId: stato.id || partitaId, messaggio: testo })) input.value = "";
  else mostraNotificaGioco("Connessione assente: il messaggio non è stato inviato.");
}

/* =========================================================
   MENU / PANNELLI — uguali all'Oca
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
  return stanza ? "lobbydama.html?stanza=" + encodeURIComponent(stanza) : "lobbydama.html";
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
  if (!inviaSocket({ tipo: "dama_abbandona", partitaId: stato.id || partitaId })) {
    mostraNotificaGioco("Connessione assente: attendi la riconnessione prima di abbandonare la partita.");
    return;
  }
  paginaInChiusura = true;
  setTimeout(tornaAllaLobby, 120);
}

/* La sezione video resta identica graficamente all'Oca. Il backend Dama attuale
   dichiara mediaAttiva:false, quindi i controlli restano disabilitati. */
function toggleMicrofonoMedia() { mostraNotificaGioco("La videochiamata non è attiva in questa partita di Dama."); }
function toggleWebcamMedia() { mostraNotificaGioco("La videochiamata non è attiva in questa partita di Dama."); }
function sbloccaRiproduzioneMedia() { mostraNotificaGioco("La videochiamata non è attiva in questa partita di Dama."); }

/* =========================================================
   WEBSOCKET DAMA
   ========================================================= */

function gestisciMessaggioSocket(dati) {
  if (!dati || typeof dati !== "object") return;

  if (dati.tipo === "dama_identita") {
    mioUid = dati.uid || mioUid;
    if ((dati.colore === "bianco" || dati.colore === "nero") && dati.colore !== mioColore) {
      mioColore = dati.colore;
      renderDamiera();
    }
    return;
  }

  if (dati.tipo === "dama_stato") {
    if (dati.uid) mioUid = dati.uid;
    if (dati.colore === "bianco" || dati.colore === "nero") mioColore = dati.colore;
    if (!dati.partita || !scacchieraValida(dati.partita.scacchiera || ultimoStatoRicevuto.scacchiera)) return;
    const istantanea = attesaSnapshot;
    attesaSnapshot = false;
    accodaStatoPartita(dati.partita, istantanea);
    segnalaStatoInizialeRicevuto();
    return;
  }

  if (dati.tipo === "dama_mosse_legali") {
    const richiesta = richiestaMosse;
    if (!richiesta || (dati.da && !stessaCasella(dati.da, richiesta))) return;
    richiestaMosse = null;
    if (!statiInAttesa && !mossaInAttesa && !attesaSnapshot && richiesta.versione === versioneMosse
      && stessaCasella(selezionata, richiesta) && stato.turno === mioColore) {
      mosseLegali = Array.isArray(dati.mosse) ? dati.mosse.filter(mossa => {
        if (!mossa || typeof mossa !== "object") return false;
        const origine = mossa.da || mossa.from;
        return mossa && (!origine || stessaCasella(origine, selezionata)) && coordinateValide(mossa.a || mossa.to);
      }) : [];
    }
    const successiva = richiestaMosseSuccessiva;
    richiestaMosseSuccessiva = null;
    if (successiva && stessaCasella(successiva, selezionata) && !statiInAttesa && !mossaInAttesa) richiediMosseCasella(successiva);
    renderDamiera();
    return;
  }

  if (dati.tipo === "dama_chat") {
    aggiungiMessaggioChatPartita(dati.nickname || "Giocatore", dati.messaggio || "");
    return;
  }

  if (dati.tipo === "dama_fine") {
    const conclusa = { ...(dati.partita || {}), fase: "terminata" };
    if (Object.prototype.hasOwnProperty.call(dati, "vincitoreUid")) conclusa.vincitoreUid = dati.vincitoreUid;
    if (dati.motivo) conclusa.motivoFine = dati.motivo;
    accodaStatoPartita(conclusa);
    return;
  }

  if (dati.tipo === "dama_rivincita") {
    mostraNotificaGioco(dati.messaggio || "L'avversario chiede una rivincita.");
    return;
  }

  if (dati.tipo === "dama_errore") {
    mossaInAttesa = false;
    clearTimeout(timerMossaInAttesa);
    richiestaMosse = null;
    richiestaMosseSuccessiva = null;
    mosseLegali = [];
    renderDamiera();
    const errore = dati.errore || "Operazione non consentita.";
    mostraNotificaGioco(errore);
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

  const q = new URLSearchParams({ gioco: "dama", stanza });
  const token = tokenAutenticazione();
  if (token) q.set("token", token);
  if (partitaId) q.set("partita", partitaId);

  try {
    socket = new WebSocket(URL_WEBSOCKET + "/?" + q.toString());
  } catch (errore) {
    console.error("Apertura WebSocket non riuscita:", errore);
    impostaStatoConnessione(true);
    timerRiconnessione = setTimeout(connetti, 1800);
    return;
  }

  socket.onopen = () => {
    attesaSnapshot = true;
    impostaStatoConnessione(false);
    aggiornaCaricamento("Sincronizzazione partita…", 70);
    inviaSocket({ tipo: "dama_entra", partitaId: partitaId || null, stanza });
  };

  socket.onmessage = evento => {
    let dati;
    try { dati = JSON.parse(evento.data); }
    catch (errore) {
      console.error("Messaggio WebSocket non valido:", errore);
      return;
    }
    gestisciMessaggioSocket(dati);
  };

  socket.onerror = () => {};

  socket.onclose = () => {
    socket = null;
    if (paginaInChiusura) return;
    attesaSnapshot = true;
    annullaTransizioni();
    renderDamiera();
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
  paginaInChiusura = true;
  clearTimeout(timerRiconnessione);
  clearTimeout(timerChiusuraPresentazioneSfida);
  try { socket?.close(); } catch (_) {}
});

setInterval(aggiornaCountdownTurno, 250);
avvia();
