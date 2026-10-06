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
  const tipoOrientamento = window.screen && window.screen.orientation ? window.screen.orientation.type : "";
  const orientamentoVerticale = tipoOrientamento
    ? tipoOrientamento.startsWith("portrait")
    : (typeof window.orientation === "number" ? Math.abs(window.orientation % 180) === 0 : window.innerHeight > window.innerWidth);
  const vaRuotato = !puntatorePreciso && orientamentoVerticale;
  document.body.classList.toggle("modalita-desktop", eDesktop);
  document.body.classList.toggle("modalita-ruotata", vaRuotato);
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

  const margineOrizzontale = Math.max(16, larghezzaCanvas * 0.03);
  const margineVerticale = Math.max(16, altezzaCanvas * 0.06);
  const larghezzaDisponibile = larghezzaCanvas - margineOrizzontale * 2;
  const altezzaDisponibile = altezzaCanvas - margineVerticale * 2;
  const lato = Math.max(160, Math.min(larghezzaDisponibile, altezzaDisponibile));

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

function renderDamiera() {
  const damiera = document.getElementById("damiera");
  if (!damiera) return;
  damiera.textContent = "";

  const destinazioni = new Map();
  for (const mossa of mosseLegali) {
    const arrivo = mossa.a || mossa.to;
    if (arrivo) destinazioni.set(arrivo.r + "," + arrivo.c, !!(mossa.presa || mossa.capture));
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const scura = (r + c) % 2 === 1;
      const casella = document.createElement("button");
      casella.type = "button";
      casella.className = "dama-casella " + (scura ? "scura" : "chiara");
      casella.setAttribute("role", "gridcell");
      casella.setAttribute("aria-label", String.fromCharCode(97 + c) + (8 - r));

      if (selezionata && selezionata.r === r && selezionata.c === c) casella.classList.add("selezionata");

      const key = r + "," + c;
      if (destinazioni.has(key)) casella.classList.add(destinazioni.get(key) ? "destinazione-presa" : "destinazione");

      const ultimo = stato.ultimoMovimento || {};
      if ((ultimo.da && ultimo.da.r === r && ultimo.da.c === c) || (ultimo.a && ultimo.a.r === r && ultimo.a.c === c)) {
        casella.classList.add("ultima-mossa");
      }

      const pezzo = stato.scacchiera?.[r]?.[c];
      if (pezzo) {
        const elemento = document.createElement("div");
        elemento.className = "dama-pezzo " + pezzo.colore + (pezzo.dama ? " dama" : "");
        elemento.setAttribute("aria-hidden", "true");
        casella.appendChild(elemento);
      }

      if (scura) casella.addEventListener("click", () => cliccaCasella(r, c));
      else casella.disabled = true;
      damiera.appendChild(casella);
    }
  }
}

function cliccaCasella(r, c) {
  if (stato.fase !== "in_corso" || !mioColore || stato.turno !== mioColore) return;
  const pezzo = stato.scacchiera?.[r]?.[c];

  if (pezzo && pezzo.colore === mioColore) {
    selezionata = { r, c };
    mosseLegali = [];
    renderDamiera();
    if (!inviaSocket({ tipo: "dama_richiedi_mosse", partitaId: stato.id || partitaId, da: { r, c } })) {
      mostraNotificaGioco("Connessione assente: impossibile verificare le mosse.");
    }
    return;
  }

  if (!selezionata) return;
  const scelta = mosseLegali.find(mossa => {
    const arrivo = mossa.a || mossa.to;
    return arrivo && arrivo.r === r && arrivo.c === c;
  });
  if (!scelta) return;

  const eraPresa = !!(scelta.presa || scelta.capture);
  if (!inviaSocket({ tipo: "dama_mossa", partitaId: stato.id || partitaId, da: selezionata, a: { r, c } })) {
    mostraNotificaGioco("Connessione assente: la mossa non è stata inviata.");
    return;
  }
  eraPresa ? suonaPresa() : suonaMossa();
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
    else if (mioTurno) messaggi.textContent = stato.presaInCorso?.uid === mioUid ? "Continua la presa obbligatoria" : "È il tuo turno: seleziona una pedina";
    else messaggi.textContent = "Turno del " + nomeColore(stato.turno);
  }

  if (mioTurno && ultimoTurnoSegnalato !== stato.numeroMossa + ":" + stato.turno) {
    ultimoTurnoSegnalato = stato.numeroMossa + ":" + stato.turno;
    suonaTuoTurno();
    mostraMessaggioGiocoGrande("È IL TUO TURNO", { icona: "●", dettaglio: nomeColore(mioColore), durata: 1700 });
  }
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

/* =========================================================
   VIDEOCHIAMATA — SOLO MEDIA WEBRTC
   Questo modulo non tocca la logica, lo stato o il rendering della Dama.
   ========================================================= */
const DamaMedia = (() => {
  let attiva = false;
  let streamLocale = null;
  let avvio = null;
  let pronto = false;
  let peers = Object.create(null);
  let remote = Object.create(null);
  let iceInAttesa = Object.create(null);
  let retry = Object.create(null);
  let disconnessioni = Object.create(null);
  let partecipanti = new Set();
  let configurazioneIce = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  let puliziaInCorso = false;

  const VINCOLI = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: {
      width: { ideal: 320, max: 640 },
      height: { ideal: 240, max: 480 },
      frameRate: { ideal: 15, max: 20 },
      facingMode: { ideal: "user" }
    }
  };

  function statoTesto(testo, errore = false) {
    const pannello = document.getElementById("videochiamata");
    const statoEl = document.getElementById("stato-media-connessione");
    const voce = document.getElementById("btn-stato-media");
    if (pannello) pannello.classList.toggle("nascosto", !attiva);
    if (statoEl) {
      statoEl.textContent = testo || (attiva ? "Collegamento…" : "Non attiva");
      statoEl.style.color = errore ? "#ff8a80" : "";
    }
    if (voce) {
      voce.textContent = attiva
        ? (errore ? "⚠️ Webcam/microfono: verifica necessaria" : "🎥 Webcam e microfono attivi")
        : "🔇 Videochiamata: non attiva";
    }
    aggiornaControlli();
  }

  function aggiornaControlli() {
    const audio = streamLocale?.getAudioTracks().find(t => t.readyState === "live") || null;
    const video = streamLocale?.getVideoTracks().find(t => t.readyState === "live") || null;
    const mic = document.getElementById("btn-toggle-microfono-media");
    const cam = document.getElementById("btn-toggle-webcam-media");
    if (mic) {
      const on = !!(audio && audio.enabled);
      mic.disabled = !audio;
      mic.setAttribute("aria-pressed", on ? "false" : "true");
      mic.setAttribute("aria-label", on ? "Disattiva microfono" : "Attiva microfono");
      mic.setAttribute("title", on ? "Disattiva microfono" : "Attiva microfono");
      mic.classList.toggle("media-spento", !!audio && !on);
    }
    if (cam) {
      const on = !!(video && video.enabled);
      cam.disabled = !video;
      cam.setAttribute("aria-pressed", on ? "false" : "true");
      cam.setAttribute("aria-label", on ? "Disattiva webcam" : "Attiva webcam");
      cam.setAttribute("title", on ? "Disattiva webcam" : "Attiva webcam");
      cam.classList.toggle("media-spento", !!video && !on);
    }
  }

  function erroreNome(e) { return String(e?.name || ""); }
  function descriviErrore(e) {
    const n = erroreNome(e);
    if (["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(n)) return "Permesso negato: abilita webcam e microfono nel browser.";
    if (["NotFoundError", "DevicesNotFoundError"].includes(n)) return "Webcam o microfono non trovati.";
    if (["NotReadableError", "TrackStartError"].includes(n)) return "Webcam o microfono occupati da un'altra app o scheda.";
    if (["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(n)) return "Il dispositivo non supporta le impostazioni video richieste.";
    return "Webcam o microfono non disponibili.";
  }

  async function getStream() {
    const tentativi = [
      VINCOLI,
      { audio: { echoCancellation: true, noiseSuppression: true }, video: { facingMode: { ideal: "user" } } },
      { audio: true, video: true }
    ];
    let ultimo = null;
    for (const vincoli of tentativi) {
      try { return await navigator.mediaDevices.getUserMedia(vincoli); }
      catch (e) {
        ultimo = e;
        const n = erroreNome(e);
        if (n === "OverconstrainedError" || n === "ConstraintNotSatisfiedError") continue;
        if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") {
          await new Promise(r => setTimeout(r, 350));
          continue;
        }
        break;
      }
    }
    throw ultimo || new Error("getUserMedia non disponibile");
  }

  function chiudiPeer(uid, rimuoviTile = false) {
    if (retry[uid]) { clearTimeout(retry[uid]); delete retry[uid]; }
    if (disconnessioni[uid]) { clearTimeout(disconnessioni[uid]); delete disconnessioni[uid]; }
    const pc = peers[uid];
    delete peers[uid];
    delete iceInAttesa[uid];
    try { pc?.close(); } catch (_) {}
    if (rimuoviTile) {
      const el = remote[uid];
      if (el) {
        try { el.video.srcObject = null; } catch (_) {}
        try { el.audio.srcObject = null; } catch (_) {}
        try { el.stream.getTracks().forEach(t => el.stream.removeTrack(t)); } catch (_) {}
        el.figura.remove();
        delete remote[uid];
      }
    }
  }

  function creaTile(uid) {
    if (remote[uid]) return remote[uid];
    const figura = document.createElement("figure");
    figura.className = "video-tile";
    figura.dataset.uid = uid;
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.preload = "auto";
    const didascalia = document.createElement("figcaption");
    const giocatore = stato?.giocatori?.[uid];
    didascalia.textContent = giocatore?.nome || giocatore?.nickname || "Giocatore";
    const stream = new MediaStream();
    figura.append(video, audio, didascalia);
    document.getElementById("griglia-video")?.appendChild(figura);
    remote[uid] = { figura, video, audio, didascalia, stream };
    return remote[uid];
  }

  function riproduci(el) {
    if (!el?.play) return;
    el.play().catch(() => {
      const b = document.getElementById("btn-sblocca-media");
      if (b) { b.textContent = "🔊 Attiva l'audio"; b.classList.remove("nascosto"); }
    });
  }

  function creaPeer(uid) {
    const esistente = peers[uid];
    if (esistente && esistente.connectionState !== "closed" && esistente.connectionState !== "failed") return esistente;
    if (!streamLocale) throw new Error("Stream locale non pronto");
    const pc = new RTCPeerConnection(configurazioneIce);
    streamLocale.getTracks().forEach(track => pc.addTrack(track, streamLocale));

    pc.onicecandidate = e => {
      if (!e.candidate) return;
      inviaSocket({
        tipo: "webrtc-ice-candidate",
        partitaId,
        destinatarioUid: uid,
        candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate
      });
    };

    pc.ontrack = e => {
      const el = creaTile(uid);
      if (!el.stream.getTracks().some(t => t.id === e.track.id)) el.stream.addTrack(e.track);
      el.video.srcObject = el.stream;
      el.audio.srcObject = el.stream;
      riproduci(el.video);
      riproduci(el.audio);
      e.track.onended = () => { try { el.stream.removeTrack(e.track); } catch (_) {} };
    };

    const statoPc = () => {
      if (pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        if (disconnessioni[uid]) { clearTimeout(disconnessioni[uid]); delete disconnessioni[uid]; }
        statoTesto(`${partecipanti.size} partecipanti collegati`);
        return;
      }
      if (pc.connectionState === "failed" || pc.iceConnectionState === "failed") {
        chiudiPeer(uid, false);
        pianificaRetry(uid, 900);
      } else if (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected") {
        if (!disconnessioni[uid]) {
          disconnessioni[uid] = setTimeout(() => {
            delete disconnessioni[uid];
            const attuale = peers[uid];
            if (attuale === pc && (pc.connectionState === "disconnected" || pc.iceConnectionState === "disconnected")) {
              chiudiPeer(uid, false);
              pianificaRetry(uid, 700);
            }
          }, 6000);
        }
      }
    };
    pc.onconnectionstatechange = statoPc;
    pc.oniceconnectionstatechange = statoPc;
    peers[uid] = pc;
    return pc;
  }

  function pianificaRetry(uid, ms) {
    if (retry[uid] || !attiva || !streamLocale || !partecipanti.has(uid) || !mioUid || String(mioUid) >= String(uid)) return;
    retry[uid] = setTimeout(() => {
      delete retry[uid];
      avviaOfferta(uid, true).catch(() => {});
    }, Math.max(500, ms || 1200));
  }

  async function avviaOfferta(uid, restartIce = false) {
    if (!attiva || !streamLocale || !partecipanti.has(uid) || !mioUid || String(mioUid) >= String(uid)) return;
    let pc = peers[uid];
    if (pc && pc.connectionState === "connected" && !restartIce) return;
    if (pc && pc.signalingState !== "stable") return;
    if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") pc = creaPeer(uid);
    const offer = await pc.createOffer(restartIce ? { iceRestart: true } : undefined);
    if (pc.signalingState !== "stable") return;
    await pc.setLocalDescription(offer);
    inviaSocket({ tipo: "webrtc-offer", partitaId, destinatarioUid: uid, sdp: pc.localDescription });
  }

  async function applicaIce(uid) {
    const pc = peers[uid];
    if (!pc?.remoteDescription) return;
    const lista = iceInAttesa[uid] || [];
    delete iceInAttesa[uid];
    for (const c of lista.slice(0, 100)) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
  }

  async function offerta(uid, sdp) {
    if (!attiva || !streamLocale || !partecipanti.has(uid) || !sdp || sdp.type !== "offer") return;
    let pc = peers[uid];
    if (pc && pc.signalingState !== "stable") { chiudiPeer(uid, false); pc = null; }
    if (!pc) pc = creaPeer(uid);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await applicaIce(uid);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    inviaSocket({ tipo: "webrtc-answer", partitaId, destinatarioUid: uid, sdp: pc.localDescription });
  }

  async function risposta(uid, sdp) {
    const pc = peers[uid];
    if (!pc || !sdp || sdp.type !== "answer" || pc.signalingState !== "have-local-offer") return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await applicaIce(uid);
  }

  async function candidato(uid, candidate) {
    if (!candidate || typeof candidate !== "object") return;
    const pc = peers[uid];
    if (!pc || !pc.remoteDescription) {
      if (!iceInAttesa[uid]) iceInAttesa[uid] = [];
      if (iceInAttesa[uid].length < 100) iceInAttesa[uid].push(candidate);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }

  async function avviaLocale() {
    if (!attiva || paginaInChiusura) return false;
    if (streamLocale && streamLocale.getAudioTracks().some(t => t.readyState === "live") && streamLocale.getVideoTracks().some(t => t.readyState === "live")) {
      pronto = true;
      aggiornaControlli();
      inviaPronto();
      return true;
    }
    if (avvio) return avvio;
    avvio = (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection !== "function") throw new DOMException("WebRTC non disponibile", "NotSupportedError");
        const stream = await getStream();
        if (!attiva || paginaInChiusura) { stream.getTracks().forEach(t => t.stop()); return false; }
        if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) throw new DOMException("Tracce audio/video mancanti", "NotFoundError");
        streamLocale = stream;
        pronto = true;
        stream.getTracks().forEach(t => { t.onended = () => { pronto = false; inviaPronto(false); statoTesto("Webcam o microfono scollegati", true); const b = document.getElementById("btn-sblocca-media"); if (b) { b.textContent = "Riprova webcam e microfono"; b.classList.remove("nascosto"); } }; });
        const locale = document.getElementById("video-locale");
        if (locale) { locale.srcObject = stream; locale.muted = true; locale.playsInline = true; locale.play().catch(() => {}); }
        const b = document.getElementById("btn-sblocca-media");
        if (b) b.classList.add("nascosto");
        aggiornaControlli();
        statoTesto("In attesa dell'avversario…");
        inviaPronto();
        return true;
      } catch (e) {
        pronto = false;
        inviaPronto(false);
        const msg = descriviErrore(e);
        statoTesto(msg, true);
        const b = document.getElementById("btn-sblocca-media");
        if (b) { b.textContent = "Riprova webcam e microfono"; b.classList.remove("nascosto"); }
        return false;
      } finally { avvio = null; }
    })();
    return avvio;
  }

  function inviaPronto(attivo = true) {
    if (!partitaId || !socket || socket.readyState !== WebSocket.OPEN) return;
    inviaSocket({ tipo: "mediaPronto", partitaId, attivo: !!attivo });
  }

  function riceviStato(dati) {
    attiva = dati.mediaAttiva === true;
    if (!attiva) {
      pulisci(false);
      statoTesto("Non attiva");
      return;
    }
    partecipanti = new Set(Array.isArray(dati.partecipanti) ? dati.partecipanti.filter(v => typeof v === "string") : []);
    Object.keys(peers).forEach(uid => { if (!partecipanti.has(uid)) chiudiPeer(uid, true); });
    Object.keys(remote).forEach(uid => { if (!partecipanti.has(uid)) chiudiPeer(uid, true); });
    statoTesto(partecipanti.size > 1 ? `${partecipanti.size} partecipanti collegati` : "Avvio webcam e microfono…");
    if (!streamLocale) { avviaLocale(); return; }
    if (!partecipanti.has(mioUid)) { pronto = true; inviaPronto(true); return; }
    partecipanti.forEach(uid => { if (uid !== mioUid && String(mioUid) < String(uid)) avviaOfferta(uid).catch(() => {}); });
  }

  function riceviConfig(config) {
    if (!config || !Array.isArray(config.iceServers)) return;
    const servers = config.iceServers.slice(0, 6).filter(s => {
      const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
      return urls.length && urls.every(u => typeof u === "string" && /^(stun|stuns|turn|turns):/i.test(u));
    }).map(s => ({ urls: s.urls, ...(typeof s.username === "string" ? { username: s.username } : {}), ...(typeof s.credential === "string" ? { credential: s.credential } : {}) }));
    if (servers.length) configurazioneIce = { iceServers: servers, iceCandidatePoolSize: 4, bundlePolicy: "max-bundle" };
  }

  async function sblocca() {
    if (!streamLocale) await avviaLocale();
    const els = Object.values(remote).flatMap(x => [x.video, x.audio]);
    const risultati = await Promise.allSettled(els.map(x => x.play()));
    const fallita = risultati.some(r => r.status === "rejected");
    const b = document.getElementById("btn-sblocca-media");
    if (b) { b.textContent = fallita ? "🔊 Attiva l'audio" : "🔊 Audio attivo"; b.classList.toggle("nascosto", !fallita); }
  }

  function pulisci(perPagina = false) {
    if (puliziaInCorso && perPagina) return;
    if (perPagina) puliziaInCorso = true;
    if (pronto) inviaPronto(false);
    pronto = false;
    Object.keys(retry).forEach(k => clearTimeout(retry[k]));
    Object.keys(disconnessioni).forEach(k => clearTimeout(disconnessioni[k]));
    retry = Object.create(null);
    disconnessioni = Object.create(null);
    Object.keys(peers).forEach(uid => chiudiPeer(uid, true));
    peers = Object.create(null);
    remote = Object.create(null);
    iceInAttesa = Object.create(null);
    if (streamLocale) streamLocale.getTracks().forEach(t => { t.onended = null; try { t.stop(); } catch (_) {} });
    streamLocale = null;
    const locale = document.getElementById("video-locale");
    if (locale) locale.srcObject = null;
    document.getElementById("griglia-video")?.querySelectorAll(".video-tile:not(.video-locale)").forEach(el => el.remove());
    if (!perPagina) {
      attiva = false;
      partecipanti.clear();
      statoTesto("Non attiva");
    } else {
      aggiornaControlli();
    }
  }

  document.addEventListener("pointerdown", () => {
    if (!attiva) return;
    Object.values(remote).forEach(x => x.audio?.play?.().catch(() => {}));
  }, { passive: true });

  return { statoTesto, riceviStato, riceviConfig, offerta, risposta, candidato, sblocca, pulisci, aggiornaControlli };
})();

function toggleMicrofonoMedia() {
  const track = DamaMedia && document.getElementById("video-locale")?.srcObject?.getAudioTracks?.().find(t => t.readyState === "live");
  if (!track) { mostraNotificaGioco("Microfono non disponibile."); return; }
  track.enabled = !track.enabled;
  DamaMedia.aggiornaControlli();
}
function toggleWebcamMedia() {
  const track = DamaMedia && document.getElementById("video-locale")?.srcObject?.getVideoTracks?.().find(t => t.readyState === "live");
  if (!track) { mostraNotificaGioco("Webcam non disponibile."); return; }
  track.enabled = !track.enabled;
  DamaMedia.aggiornaControlli();
}
function sbloccaRiproduzioneMedia() { DamaMedia.sblocca(); }

/* =========================================================
   WEBSOCKET DAMA
   ========================================================= */

function gestisciMessaggioSocket(dati) {
  if (!dati || typeof dati !== "object") return;

  if (dati.tipo === "configMedia") {
    DamaMedia.riceviConfig(dati.configurazioneIce);
    return;
  }

  if (dati.tipo === "statoMedia") {
    DamaMedia.riceviStato(dati);
    return;
  }

  if (dati.tipo === "webrtc-offer") {
    gestisciPromessaWebRtc(DamaMedia.offerta(dati.mittenteUid, dati.sdp));
    return;
  }

  if (dati.tipo === "webrtc-answer") {
    gestisciPromessaWebRtc(DamaMedia.risposta(dati.mittenteUid, dati.sdp));
    return;
  }

  if (dati.tipo === "webrtc-ice-candidate") {
    gestisciPromessaWebRtc(DamaMedia.candidato(dati.mittenteUid, dati.candidate));
    return;
  }

  if (dati.tipo === "dama_identita") {
    mioUid = dati.uid || mioUid;
    mioColore = dati.colore || mioColore;
    return;
  }

  if (dati.tipo === "dama_stato") {
    const precedenteNumeroMossa = Number(stato.numeroMossa || 0);
    if (dati.partita) {
      stato = { ...stato, ...dati.partita };
      if (Array.isArray(dati.partita.scacchiera)) stato.scacchiera = dati.partita.scacchiera;
    }
    if (dati.uid) mioUid = dati.uid;
    if (dati.colore) mioColore = dati.colore;

    selezionata = null;
    mosseLegali = [];
    segnalaStatoInizialeRicevuto();
    render();

    if (Number(stato.numeroMossa || 0) !== precedenteNumeroMossa) avvisoTempoChiave = "";

    if (stato.presaInCorso && stato.presaInCorso.uid === mioUid) {
      selezionata = { r: stato.presaInCorso.r, c: stato.presaInCorso.c };
      renderDamiera();
      inviaSocket({ tipo: "dama_richiedi_mosse", partitaId: stato.id || partitaId, da: selezionata });
    }

    if (stato.fase === "in_corso" && giocatoriStato().length >= 2 && !presentazioneSfidaGiaVista()) {
      setTimeout(mostraPresentazioneSfida, 260);
    }

    if (stato.fase === "terminata" || stato.vincitoreUid || stato.motivoFine) mostraVittoria(stato);
    return;
  }

  if (dati.tipo === "dama_mosse_legali") {
    mosseLegali = Array.isArray(dati.mosse) ? dati.mosse : [];
    renderDamiera();
    return;
  }

  if (dati.tipo === "dama_chat") {
    aggiungiMessaggioChatPartita(dati.nickname || "Giocatore", dati.messaggio || "");
    return;
  }

  if (dati.tipo === "dama_fine") {
    if (dati.partita) stato = { ...stato, ...dati.partita };
    if (dati.vincitoreUid) stato.vincitoreUid = dati.vincitoreUid;
    if (dati.motivo) stato.motivoFine = dati.motivo;
    render();
    mostraVittoria(dati);
    return;
  }

  if (dati.tipo === "dama_rivincita") {
    mostraNotificaGioco(dati.messaggio || "L'avversario chiede una rivincita.");
    return;
  }

  if (dati.tipo === "dama_errore") {
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
    const risposta = await fetch(ORIGINE_SERVER + "/api/me-menu", {
      credentials: "include",
      cache: "no-store"
    });
    if (risposta.status >= 400 && risposta.status < 500 && risposta.status !== 429) {
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
  try { DamaMedia.pulisci(true); } catch (_) {}
  paginaInChiusura = true;
  clearTimeout(timerRiconnessione);
  clearTimeout(timerChiusuraPresentazioneSfida);
  try { socket?.close(); } catch (_) {}
});

setInterval(aggiornaCountdownTurno, 250);
avvia();
