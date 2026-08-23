const posizioniCaselle = {
  1: { x: 2246, y: 817 }, 2: { x: 2227, y: 1064 }, 3: { x: 2102, y: 1329 },
  4: { x: 1801, y: 1545 }, 5: { x: 1421, y: 1599 }, 6: { x: 1126, y: 1591 },
  7: { x: 873, y: 1591 }, 8: { x: 567, y: 1518 }, 9: { x: 321, y: 1286 },
  10: { x: 249, y: 1017 }, 11: { x: 244, y: 759 }, 12: { x: 334, y: 492 },
  13: { x: 591, y: 298 }, 14: { x: 897, y: 258 }, 15: { x: 1139, y: 257 },
  16: { x: 1366, y: 246 }, 17: { x: 1674, y: 286 }, 18: { x: 1933, y: 490 },
  19: { x: 2008, y: 720 }, 20: { x: 2016, y: 974 }, 21: { x: 1930, y: 1232 },
  22: { x: 1694, y: 1395 }, 23: { x: 1325, y: 1423 }, 24: { x: 993, y: 1428 },
  25: { x: 673, y: 1386 }, 26: { x: 465, y: 1205 }, 27: { x: 435, y: 992 },
  28: { x: 425, y: 802 }, 29: { x: 480, y: 590 }, 30: { x: 685, y: 427 },
  31: { x: 999, y: 403 }, 32: { x: 1287, y: 398 }, 33: { x: 1578, y: 425 },
  34: { x: 1779, y: 579 }, 35: { x: 1811, y: 766 }, 36: { x: 1816, y: 943 },
  37: { x: 1765, y: 1134 }, 38: { x: 1566, y: 1264 }, 39: { x: 1269, y: 1275 },
  40: { x: 1022, y: 1267 }, 41: { x: 776, y: 1248 }, 42: { x: 622, y: 1106 },
  43: { x: 606, y: 967 }, 44: { x: 592, y: 829 }, 45: { x: 629, y: 676 },
  46: { x: 767, y: 554 }, 47: { x: 1044, y: 546 }, 48: { x: 1260, y: 527 },
  49: { x: 1505, y: 546 }, 50: { x: 1635, y: 722 }, 51: { x: 1639, y: 979 },
  52: { x: 1484, y: 1135 }, 53: { x: 1243, y: 1146 }, 54: { x: 1049, y: 1143 },
  55: { x: 857, y: 1129 }, 56: { x: 739, y: 986 }, 57: { x: 733, y: 798 },
  58: { x: 866, y: 679 }, 59: { x: 1040, y: 670 }, 60: { x: 1236, y: 668 },
  61: { x: 1400, y: 665 }, 62: { x: 1506, y: 738 }, 63: { x: 1486, y: 926 }
};

const coloriGiocatori = ["#6a2c70", "#dddddd", "#1e40af", "#43a047", "#f57c00", "#c0ca33", "#e53935", "#2b2b2b"];
const DURATA_SALTO_MS = 260;

const origineConfigurata = typeof window.GIOCO_SERVER_URL === "string" ? window.GIOCO_SERVER_URL.trim() : "";
const hostLocale = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "[::1]";
const paginaSulServerUfficiale = window.location.hostname === "gioco-oca-server.onrender.com";
const ORIGINE_SERVER = (origineConfigurata || ((hostLocale || paginaSulServerUfficiale)
  ? window.location.origin
  : "https://gioco-oca-server.onrender.com")).replace(/\/$/, "");
const URL_WEBSOCKET = ORIGINE_SERVER.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita");
const stanza = params.get("stanza");
let mioUid = null;

let socket;
let ultimoStatoGiocatori = [];
let mioTurno = false;
let turnoAttualeId = null;
let timerRiconnessione = null;
let timerRiprovaAvvio = null;
let timerVerificaDeterminazione = null;
let paginaInChiusura = false;
let versioneAnimazioneStato = 0;
const animazioniPedineAttive = new Map();
let chatPartitaAttiva = true;

// Evita che il server attivi visivamente il turno successivo mentre la pedina
// sta ancora completando l'ultimo saltello.
let mossaVisualeInCorso = false;
let statoPartitaAccodato = null;

let faseAttuale = "normale";
let possoTirareIoInDeterminazione = false;

function iniziale(nome) { return (nome || "?").trim().charAt(0).toUpperCase(); }
function coloreDaNome(nome) {
  const colori = ["#6a2c70", "#1e40af", "#43a047", "#f57c00", "#c0ca33", "#e53935", "#00838f", "#8d6e63"];
  let somma = 0;
  for (let i = 0; i < (nome || "?").length; i++) somma += nome.charCodeAt(i);
  return colori[somma % colori.length];
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
  inizialeEl.style.background = colore;
  inizialeEl.textContent = iniziale(nome);
  inizialeEl.setAttribute("aria-hidden", "true");
  return inizialeEl;
}

function impostaDadiAbilitati(abilitati) {
  const areaDadi = document.getElementById("area-dadi");
  if (!areaDadi) return;
  areaDadi.classList.toggle("disabilitato", !abilitati);
  areaDadi.setAttribute("aria-disabled", abilitati ? "false" : "true");
}

function impostaStatoConnessione(disconnesso) {
  const banner = document.getElementById("banner-disconnesso");
  if (banner) banner.classList.toggle("nascosto", !disconnesso);
  document.body.classList.toggle("disconnesso", disconnesso);
}

function inviaSocket(dati) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(dati));
    return true;
  } catch (errore) {
    console.error("Invio WebSocket non riuscito:", errore);
    return false;
  }
}

function impostaVisibilitaChat(valore) {
  if (typeof valore === "boolean") chatPartitaAttiva = valore;
  const chatWrapper = document.getElementById("chat-wrapper");
  if (!chatWrapper) return;
  chatWrapper.hidden = !chatPartitaAttiva;
  if (!chatPartitaAttiva) chiudiChat();
}

let graficaCaricata = false;
let statoInizialeRicevuto = false;
let timerMassimoCaricamento = null;
let percentualeCaricamento = 10;

function aggiornaCaricamento(testo, percentuale) {
  const testoEl = document.getElementById("caricamento-testo");
  const barra = document.getElementById("caricamento-progress-bar");
  const progresso = document.getElementById("caricamento-progress");
  if (testoEl && testo) testoEl.textContent = testo;
  if (Number.isFinite(percentuale)) {
    const valore = Math.max(percentualeCaricamento, Math.max(0, Math.min(100, percentuale)));
    percentualeCaricamento = valore;
    if (barra) barra.style.width = valore + "%";
    if (progresso) progresso.setAttribute("aria-valuenow", String(valore));
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
  statoInizialeRicevuto = true;
  aggiornaCaricamento(graficaCaricata ? "Partita pronta" : "Caricamento tabellone…", graficaCaricata ? 100 : 85);
  verificaFineCaricamento();
}

// ===== NOTIFICHE INTERNE — al posto degli alert() del browser =====
function mostraNotificaGioco(testo) {
  const contenitore = document.getElementById("contenitore-notifiche-gioco");
  if (!contenitore) { console.error(testo); return; }
  const toast = document.createElement("div");
  toast.className = "notifica-toast-gioco";
  toast.textContent = testo;
  contenitore.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ===== SUONI =====
let suoniAttivi = true;
try { suoniAttivi = localStorage.getItem("suoniAttivi") !== "off"; } catch (errore) {}
let contestoAudio = null;
let interazioneUtenteRegistrata = false;
function ottieniContestoAudio() {
  // I browser mobili bloccano Web Audio finché l'utente non interagisce con la pagina.
  if (!interazioneUtenteRegistrata) return null;
  if (!contestoAudio) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { contestoAudio = new C(); } catch (errore) { return null; }
  }
  if (contestoAudio.state === "suspended") {
    const ripresa = contestoAudio.resume();
    if (ripresa && typeof ripresa.catch === "function") ripresa.catch(() => {});
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
function suonaTono(frequenza, durataMs, tipoOnda, volume, ritardoMs) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  const inizio = ctx.currentTime + (ritardoMs || 0) / 1000;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = tipoOnda || "sine";
  osc.frequency.setValueAtTime(frequenza, inizio);
  g.gain.setValueAtTime(0, inizio);
  g.gain.linearRampToValueAtTime(volume || 0.12, inizio + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, inizio + durataMs / 1000);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(inizio); osc.stop(inizio + durataMs / 1000 + 0.02);
}
function suonaClick(volume, ritardoMs) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  const inizio = ctx.currentTime + (ritardoMs || 0) / 1000;
  const durata = 0.045;
  const lung = Math.floor(ctx.sampleRate * durata);
  const buffer = ctx.createBuffer(1, lung, ctx.sampleRate);
  const dati = buffer.getChannelData(0);
  for (let i = 0; i < lung; i++) dati[i] = (Math.random() * 2 - 1) * (1 - i / lung);
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  const g = ctx.createGain();
  g.gain.setValueAtTime(volume || 0.18, inizio);
  g.gain.exponentialRampToValueAtTime(0.001, inizio + durata);
  s.connect(g); g.connect(ctx.destination);
  s.start(inizio);
}
function suonaTiroDadi() { if (!suoniAttivi) return; for (let i = 0; i < 7; i++) suonaClick(0.1, i * 130); }
function suonaAtterraggioDadi() { suonaTono(180, 90, "square", 0.14, 0); suonaClick(0.15, 20); }
function suonaPassoPedina() { suonaTono(520, 55, "sine", 0.09, 0); }
function suonaTuoTurno() { suonaTono(660, 120, "sine", 0.11, 0); suonaTono(880, 160, "sine", 0.11, 120); }
function suonaVittoria() {
  suonaTono(523, 130, "sine", 0.13, 0); suonaTono(659, 130, "sine", 0.13, 130);
  suonaTono(784, 130, "sine", 0.13, 260); suonaTono(1047, 260, "sine", 0.14, 390);
}
function suonaMessaggioChat() { suonaTono(740, 70, "sine", 0.08, 0); }
function suonaAvvisoTempo() { suonaTono(300, 90, "triangle", 0.14, 0); }
function suonaRichiestaAudio() { suonaTono(700, 90, "sine", 0.12, 0); suonaTono(900, 120, "sine", 0.12, 130); }
function toggleSuoni() { impostaSuoni(!suoniAttivi); }
function impostaSuoni(attivi) {
  suoniAttivi = attivi;
  try { localStorage.setItem("suoniAttivi", attivi ? "on" : "off"); } catch (errore) {}
  if (attivi && interazioneUtenteRegistrata) ottieniContestoAudio();
  aggiornaTestoBottoneSuoni();
}
function aggiornaTestoBottoneSuoni() { const b = document.getElementById("btn-toggle-suoni"); if (b) b.textContent = suoniAttivi ? "🔊 Suoni: On" : "🔇 Suoni: Off"; }

// ===== TUTTO SCHERMO (solo Computer) =====
function toggleFullscreen() {
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const elemento = document.documentElement;
      const richiesta = elemento.requestFullscreen || elemento.webkitRequestFullscreen || elemento.mozRequestFullScreen || elemento.msRequestFullscreen;
      if (!richiesta) { mostraNotificaGioco("Il tuo browser non supporta lo schermo intero."); return; }
      const risultato = richiesta.call(elemento);
      if (risultato && typeof risultato.catch === "function") {
        risultato.catch((err) => { mostraNotificaGioco("Non è stato possibile attivare lo schermo intero" + (err && err.message ? (": " + err.message) : ".")); });
      }
    } else {
      const esci = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (esci) esci.call(document);
    }
  } catch (err) {
    mostraNotificaGioco("Errore durante l'attivazione dello schermo intero" + (err && err.message ? (": " + err.message) : "."));
  }
}
function aggiornaTestoBottoneFullscreen() {
  const b = document.getElementById("btn-toggle-fullscreen");
  if (!b) return;
  b.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? "🡼 Esci da tutto schermo" : "⛶ Tutto schermo";
}
document.addEventListener("fullscreenchange", aggiornaTestoBottoneFullscreen);
document.addEventListener("webkitfullscreenchange", aggiornaTestoBottoneFullscreen);

// ===== LAYOUT: il solo tabellone ruota sui dispositivi touch in verticale. =====
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
  const immagine = document.getElementById("immagine-tabellone");
  if (!areaTabellone || !mondo || !immagine) return;

  const rapportoNaturale = (immagine.naturalWidth && immagine.naturalHeight) ? immagine.naturalWidth / immagine.naturalHeight : 4 / 3;
  const eRuotato = document.body.classList.contains("modalita-ruotata");
  const videoDesktopAttivo = document.body.classList.contains("modalita-desktop") && document.body.classList.contains("media-partita");
  const larghezzaFinestra = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const altezzaReale = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--altezza-reale", altezzaReale + "px");

  const larghezzaCanvas = eRuotato ? altezzaReale : larghezzaFinestra;
  const altezzaCanvas = eRuotato ? larghezzaFinestra : altezzaReale;
  mondo.style.width = larghezzaCanvas + "px";
  mondo.style.height = altezzaCanvas + "px";

  // Smartphone: nessun margine artificiale attorno al tabellone.
  // La dimensione viene ricavata dal viewport reale del dispositivo, quindi
  // resta adattiva su telefoni con rapporti d'aspetto diversi.
  const eSmartphone =
    !document.body.classList.contains("modalita-desktop") &&
    Math.min(larghezzaFinestra, altezzaReale) <= 600;

  const margineOrizzontale = eSmartphone
    ? 0
    : Math.max(16, larghezzaCanvas * 0.03);

  const margineVerticale = eSmartphone
    ? 0
    : Math.max(16, altezzaCanvas * 0.06);

  let larghezzaDisponibile = larghezzaCanvas - margineOrizzontale * 2;
  const altezzaDisponibile = altezzaCanvas - margineVerticale * 2;

  if (videoDesktopAttivo) {
    const larghezzaColonnaDesiderata = Math.min(380, Math.max(180, larghezzaCanvas * 0.2));
    const distanzaDalTabellone = Math.max(12, larghezzaCanvas * 0.012);
    larghezzaDisponibile = Math.max(360, larghezzaCanvas - (larghezzaColonnaDesiderata + distanzaDalTabellone) * 2);
  }

  const Wc = Math.max(100, Math.min(larghezzaDisponibile, altezzaDisponibile * rapportoNaturale));
  const Hc = Wc / rapportoNaturale;

  if (videoDesktopAttivo) {
    const spazioLaterale = (larghezzaCanvas - Wc) / 2;
    const margineEsterno = Math.max(14, larghezzaCanvas * 0.012);
    const larghezzaColonnaVideo = Math.max(120, Math.min(380, spazioLaterale - margineEsterno - 10));
    document.documentElement.style.setProperty("--larghezza-colonna-video", larghezzaColonnaVideo + "px");
  } else {
    document.documentElement.style.removeProperty("--larghezza-colonna-video");
  }

  areaTabellone.style.width = Wc + "px";
  areaTabellone.style.height = Hc + "px";

  riposizionaTuttePedine();
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
  window.addEventListener("orientationchange", () => { setTimeout(gestisciResize, 300); });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", gestisciResize);

  const immagine = document.getElementById("immagine-tabellone");
  if (immagine) {
    const immaginePronta = () => {
      aggiornaLayoutTabellone();
      segnalaGraficaCaricata();
    };
    const immagineNonDisponibile = () => {
      segnalaGraficaCaricata();
      mostraNotificaGioco("Il tabellone non è stato caricato. Controlla la connessione e ricarica la pagina.");
    };
    if (immagine.complete) {
      if (immagine.naturalWidth) immaginePronta();
      else immagineNonDisponibile();
    } else {
      immagine.addEventListener("load", immaginePronta, { once: true });
      immagine.addEventListener("error", immagineNonDisponibile, { once: true });
    }
  }
}
function riposizionaTuttePedine() {
  ultimoStatoGiocatori.forEach(g => {
    const p = document.getElementById("pedina-" + g.id);
    if (p && !animazioniPedineAttive.has(g.id)) posizionaPedina(p, g.posizione);
  });
}

// ===== MESSAGGIO A TUTTO SCHERMO =====
let timerFlashMessaggio = null;
function mostraMessaggioGiocoGrande(testo) {
  if (!testo) return;
  const el = document.getElementById("flash-messaggio-gioco");
  if (!el) return;
  el.querySelector("span").textContent = testo;
  el.classList.remove("visibile");
  void el.offsetWidth;
  el.classList.add("visibile");
  if (timerFlashMessaggio) clearTimeout(timerFlashMessaggio);
  timerFlashMessaggio = setTimeout(() => el.classList.remove("visibile"), 2500);
}

// ===== "CHI INIZIA?" — turni veri, uno alla volta =====
let areaDadiHomeGenitore = null;
let areaDadiHomeFratelloSuccessivo = null;

function spostaDadiInDeterminazione() {
  const areaDadi = document.getElementById("area-dadi");
  const slot = document.getElementById("slot-dadi-determinazione");
  if (!areaDadi || !slot) return false;
  if (areaDadi.parentNode === slot) return false;
  areaDadiHomeGenitore = areaDadi.parentNode;
  areaDadiHomeFratelloSuccessivo = areaDadi.nextSibling;
  slot.appendChild(areaDadi);
  areaDadi.classList.add("dadi-in-popup");
  return true;
}
function riportaDadiAllaPartita() {
  const areaDadi = document.getElementById("area-dadi");
  if (!areaDadi || !areaDadiHomeGenitore) return;
  if (areaDadiHomeFratelloSuccessivo) areaDadiHomeGenitore.insertBefore(areaDadi, areaDadiHomeFratelloSuccessivo);
  else areaDadiHomeGenitore.appendChild(areaDadi);
  areaDadi.classList.remove("dadi-in-popup");
}

function annullaVerificaDeterminazione() {
  if (!timerVerificaDeterminazione) return;
  clearTimeout(timerVerificaDeterminazione);
  timerVerificaDeterminazione = null;
}

function pianificaVerificaDeterminazioneTra(ritardoMs) {
  annullaVerificaDeterminazione();
  const ritardo = Math.max(1000, Number(ritardoMs) || 5000);

  timerVerificaDeterminazione = setTimeout(() => {
    timerVerificaDeterminazione = null;
    if (paginaInChiusura || faseAttuale !== "determinazione") return;
    if (inviaSocket({ tipo: "riprendiPartita", partitaId })) {
      // Se il server non risponde, riprova senza sovraccaricarlo. Un nuovo stato
      // annullerà e ripianificherà automaticamente questo controllo.
      pianificaVerificaDeterminazioneTra(10000);
    }
  }, ritardo);
}

function pianificaVerificaDeterminazione(tempoInizio, durataMs) {
  const inizio = Number(tempoInizio);
  const durata = Number(durataMs);
  const tempoResiduo = Number.isFinite(inizio) && Number.isFinite(durata) && durata > 0
    ? Math.min(durata, Math.max(0, inizio + durata - Date.now()))
    : 0;
  pianificaVerificaDeterminazioneTra(tempoResiduo + 5000);
}

function disegnaListaDeterminazione(giocatori, turnoInCorsoUid, gruppoSpareggio) {
  const lista = document.getElementById("lista-determinazione");
  if (!lista) return;
  const spareggioSet = new Set(gruppoSpareggio || []);
  lista.replaceChildren();
  (Array.isArray(giocatori) ? giocatori : []).forEach(g => {
    const riga = document.createElement("div");
    riga.className = "determinazione-riga" + (g.uid === turnoInCorsoUid ? " determinazione-riga-attiva" : "");
    riga.appendChild(creaAvatarMini(g.nome, g.avatar, coloreDaNome(g.nome)));

    const nome = document.createElement("span");
    nome.className = "determinazione-nome";
    nome.textContent = g.nome || "Giocatore";
    riga.appendChild(nome);

    if (spareggioSet.has(g.uid)) {
      const spareggio = document.createElement("span");
      spareggio.className = "determinazione-tag-spareggio";
      spareggio.title = "In spareggio";
      spareggio.textContent = "⚔️";
      riga.appendChild(spareggio);
    }

    const stato = document.createElement("span");
    if (g.uid === turnoInCorsoUid) {
      stato.className = "determinazione-in-corso";
      stato.textContent = "🎲 sta tirando…";
    } else if (g.risultato != null) {
      stato.className = "determinazione-risultato";
      stato.textContent = "🎲 " + g.risultato;
    } else {
      stato.className = "determinazione-attesa";
      stato.textContent = "in attesa";
    }
    riga.appendChild(stato);
    lista.appendChild(riga);
  });
}

function gestisciStatoDeterminazione(dati) {
  ++versioneAnimazioneStato;
  faseAttuale = "determinazione";
  impostaVisibilitaChat(dati.chatAttiva);
  segnalaStatoInizialeRicevuto();
  const giocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];
  document.getElementById("overlay-determinazione").classList.add("aperto");
  const appenaEntrato = spostaDadiInDeterminazione();
  if (appenaEntrato) mostraDadi(1, 1);

  disegnaListaDeterminazione(giocatori, dati.turnoInCorsoUid, dati.gruppoSpareggioAttuale);

  possoTirareIoInDeterminazione = dati.turnoInCorsoUid === mioUid;
  impostaDadiAbilitati(possoTirareIoInDeterminazione);

  const sottotitolo = document.getElementById("sottotitolo-determinazione");
  if (dati.gruppoSpareggioAttuale && dati.gruppoSpareggioAttuale.length) {
    const nomiSpareggio = dati.gruppoSpareggioAttuale.map(u => { const g = giocatori.find(x => x.uid === u); return g ? g.nome : "?"; }).join(", ");
    sottotitolo.textContent = "⚔️ Pareggio tra " + nomiSpareggio + " — nuovo tiro per decidere l'ordine tra loro!";
  } else if (possoTirareIoInDeterminazione) {
    sottotitolo.textContent = "Tocca a te: tira i dadi!";
  } else {
    const inAttesaDi = giocatori.find(g => g.uid === dati.turnoInCorsoUid);
    sottotitolo.textContent = inAttesaDi ? ("In attesa che " + inAttesaDi.nome + " tiri...") : "I giocatori tirano i dadi uno alla volta.";
  }

  if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
  pianificaVerificaDeterminazione(dati.tempoInizioTurno, dati.durataMossaMs);
}

function gestisciRisultatoDeterminazione(dati) {
  possoTirareIoInDeterminazione = false;
  impostaDadiAbilitati(false);
  fermaCountdown(false);
  pianificaVerificaDeterminazioneTra(5000);
  animaLancioDadi(dati.dado1, dati.dado2, () => {
    const sottotitolo = document.getElementById("sottotitolo-determinazione");
    if (sottotitolo) sottotitolo.textContent = dati.nome + " ha fatto " + dati.valoreDado + (dati.automatico ? " (tempo scaduto)" : "") + "!";
  });
}

function gestisciOrdineFinaleCalcolato(dati) {
  possoTirareIoInDeterminazione = false;
  impostaDadiAbilitati(false);
  fermaCountdown(false);
  const sottotitolo = document.getElementById("sottotitolo-determinazione");
  if (sottotitolo) sottotitolo.textContent = "Ordine deciso! La partita inizia tra un istante...";
  pianificaVerificaDeterminazioneTra(5000);
  const lista = document.getElementById("lista-determinazione");
  if (!lista) return;
  lista.replaceChildren();
  (Array.isArray(dati.ordineGiocatori) ? dati.ordineGiocatori : []).forEach((nomeGiocatore, indice) => {
    const riga = document.createElement("div");
    riga.className = "determinazione-riga determinazione-riga-finale";
    riga.style.animationDelay = (indice * 0.12) + "s";

    const posizione = document.createElement("span");
    posizione.className = "determinazione-posizione-finale";
    posizione.textContent = (indice + 1) + "°";
    const nome = document.createElement("span");
    nome.className = "determinazione-nome";
    nome.textContent = nomeGiocatore;
    const risultato = document.createElement("span");
    risultato.className = "determinazione-risultato";
    risultato.textContent = "🎲 " + (dati.punteggi && dati.punteggi[nomeGiocatore] != null ? dati.punteggi[nomeGiocatore] : "?");
    riga.append(posizione, nome, risultato);
    lista.appendChild(riga);
  });
}

function gestisciDeterminazioneCompletata(dati) {
  annullaVerificaDeterminazione();
  const tokenAnimazione = ++versioneAnimazioneStato;
  faseAttuale = "normale";
  possoTirareIoInDeterminazione = false;
  document.getElementById("overlay-determinazione").classList.remove("aperto");
  riportaDadiAllaPartita();

  ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];

  const primoMovimento = dati.primoMovimento || {};
  document.getElementById("messaggi-gioco").textContent = primoMovimento.nomeGiocatore
    ? "🎲 Ordine deciso: inizia " + primoMovimento.nomeGiocatore + "!"
    : "🎲 Ordine deciso: la partita inizia!";

  animaSaltoPedina(primoMovimento.idGiocatore, primoMovimento.percorso, () => {
    if (primoMovimento.messaggi && primoMovimento.messaggi.length) mostraMessaggioGiocoGrande(primoMovimento.messaggi.join(" "));
    if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);

    if (dati.vittoria) {
      turnoAttualeId = null;
      impostaDadiAbilitati(false);
      disegnaGiocatori();
      mostraVittoria(dati.vincitore);
    } else {
      aggiornaTurno(dati.turnoDiId);
      disegnaGiocatori();
    }
  }, tokenAnimazione);
}

// ===== COUNTDOWN DI TURNO =====
let tempoInizioTurnoAttuale = null, durataMossaMsAttuale = null, intervalCountdown = null, ultimoSecondoAvviso = null;
let turnoLocalmenteCompletato = false;

function avviaCountdownTurno(tempoInizio, durataMs) {
  if (!Number.isFinite(Number(tempoInizio)) || !Number.isFinite(Number(durataMs)) || Number(durataMs) <= 0) {
    fermaCountdown(false);
    return;
  }
  tempoInizioTurnoAttuale = tempoInizio;
  durataMossaMsAttuale = durataMs;
  ultimoSecondoAvviso = null;
  turnoLocalmenteCompletato = false;
  if (intervalCountdown) clearInterval(intervalCountdown);
  intervalCountdown = setInterval(aggiornaCountdownTurno, 250);
  aggiornaCountdownTurno();
}
function elementiCountdown() {
  return [document.getElementById("countdown-turno"), document.getElementById("countdown-determinazione")].filter(Boolean);
}
function fermaCountdown(mostraCompletato) {
  if (intervalCountdown) {
    clearInterval(intervalCountdown);
    intervalCountdown = null;
  }
  tempoInizioTurnoAttuale = null;
  durataMossaMsAttuale = null;
  ultimoSecondoAvviso = null;
  elementiCountdown().forEach(el => {
    el.classList.remove("countdown-scaduto", "countdown-fermo");
    el.textContent = mostraCompletato ? "✓" : "⏱ --s";
    if (mostraCompletato) el.classList.add("countdown-fermo");
  });
}
function fermaCountdownPerAzioneLocale() {
  turnoLocalmenteCompletato = true;
  if (intervalCountdown) { clearInterval(intervalCountdown); intervalCountdown = null; }
  elementiCountdown().forEach(el => {
    el.textContent = "✓";
    el.classList.remove("countdown-scaduto");
    el.classList.add("countdown-fermo");
  });
}
function aggiornaCountdownTurno() {
  const elementi = elementiCountdown();
  if (!elementi.length || tempoInizioTurnoAttuale == null || durataMossaMsAttuale == null) return;
  if (turnoLocalmenteCompletato) return;
  const sec = Math.max(0, Math.ceil((durataMossaMsAttuale - (Date.now() - tempoInizioTurnoAttuale)) / 1000));
  elementi.forEach(el => {
    el.textContent = "⏱ " + sec + "s";
    el.classList.toggle("countdown-scaduto", sec <= 0);
    el.classList.remove("countdown-fermo");
  });
  if (sec <= 3 && sec >= 1 && sec !== ultimoSecondoAvviso) { ultimoSecondoAvviso = sec; suonaAvvisoTempo(); }
}

// ===== VIDEOCHIAMATA DI TAVOLO: consenso in lobby, collegamento automatico =====
const mediaRichiestaDaLobby = params.get("media") === "1";
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
const nomiPartecipantiMedia = new Map();
let CONFIGURAZIONE_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const VINCOLI_MEDIA = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: { width: { ideal: 320, max: 640 }, height: { ideal: 240, max: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: "user" }
};

function aggiornaNomiPartecipanti(dati) {
  if (!dati || !Array.isArray(dati.giocatori)) return;
  dati.giocatori.forEach(giocatore => {
    const uidGiocatore = giocatore && (giocatore.id || giocatore.uid);
    if (uidGiocatore) nomiPartecipantiMedia.set(uidGiocatore, giocatore.nome || "Giocatore");
  });
  Object.entries(elementiVideoRemoti).forEach(([uidGiocatore, elementi]) => {
    if (elementi && elementi.didascalia) elementi.didascalia.textContent = nomiPartecipantiMedia.get(uidGiocatore) || "Giocatore";
  });
}

function aggiornaConfigurazioneIce(configurazione) {
  if (!configurazione || !Array.isArray(configurazione.iceServers)) return;
  const iceServers = configurazione.iceServers.slice(0, 4).filter(server => {
    const urls = Array.isArray(server && server.urls) ? server.urls : [server && server.urls];
    return urls.length > 0 && urls.every(url => typeof url === "string" && /^(stun|stuns|turn|turns):/i.test(url));
  }).map(server => ({
    urls: server.urls,
    ...(typeof server.username === "string" ? { username: server.username } : {}),
    ...(typeof server.credential === "string" ? { credential: server.credential } : {})
  }));
  if (iceServers.length) CONFIGURAZIONE_ICE = { iceServers };
}

function aggiornaInterfacciaMedia(testo, errore) {
  const layoutMediaEraAttivo = document.body.classList.contains("media-partita");
  document.body.classList.toggle("media-partita", mediaPartitaAttiva);
  if (layoutMediaEraAttivo !== mediaPartitaAttiva) requestAnimationFrame(aggiornaLayoutTabellone);
  const pannello = document.getElementById("videochiamata");
  const stato = document.getElementById("stato-media-connessione");
  const voceMenu = document.getElementById("btn-stato-media");
  if (pannello) pannello.classList.toggle("nascosto", !mediaPartitaAttiva);
  if (stato) { stato.textContent = testo || (mediaPartitaAttiva ? "Collegamento…" : "Non attiva"); stato.style.color = errore ? "#ff8a80" : ""; }
  if (voceMenu) {
    voceMenu.textContent = mediaPartitaAttiva ? (errore ? "⚠️ Webcam/microfono non disponibili" : "🎥 Webcam e microfono attivi") : "🔇 Videochiamata: non attiva";
    voceMenu.classList.toggle("media-attiva", mediaPartitaAttiva && !errore);
  }
}

function impostaMediaPartitaAttiva(attiva) {
  if (attiva !== true) {
    mediaPartitaAttiva = false;
    mediaProntoSegnalato = false;
    mediaRichiedeRiprovaManuale = false;
    partecipantiMediaPronti.clear();
    if (flussoMediaLocale) {
      const streamDaChiudere = flussoMediaLocale;
      flussoMediaLocale = null;
      streamDaChiudere.getTracks().forEach(traccia => { traccia.onended = null; traccia.stop(); });
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
    aggiornaInterfacciaMedia("Webcam o microfono non disponibili", true);
    return;
  }
  aggiornaInterfacciaMedia(flussoMediaLocale ? "Collegata" : "Avvio webcam e microfono…", false);
  gestisciPromessaWebRtc(inizializzaMediaPartita());
}

function segnalaMediaPronto() {
  if (!mediaPartitaAttiva || !flussoMediaLocale || mediaProntoSegnalato) return;
  if (inviaSocket({ tipo: "mediaPronto", partitaId, attivo: true })) mediaProntoSegnalato = true;
}

function gestisciInterruzioneMediaLocale() {
  if (puliziaMediaInCorso || !flussoMediaLocale) return;
  const streamDaChiudere = flussoMediaLocale;
  flussoMediaLocale = null;
  streamDaChiudere.getTracks().forEach(traccia => { if (traccia.readyState === "live") traccia.stop(); });
  mediaProntoSegnalato = false;
  mediaRichiedeRiprovaManuale = true;
  inviaSocket({ tipo: "mediaPronto", partitaId, attivo: false });
  partecipantiMediaPronti.clear();
  Object.keys(connessioniPeer).forEach(chiudiConnessioneMedia);
  const locale = document.getElementById("video-locale");
  if (locale) locale.srcObject = null;
  aggiornaInterfacciaMedia("Webcam o microfono non disponibili", true);
  const riprova = document.getElementById("btn-sblocca-media");
  if (riprova) { riprova.textContent = "Riprova webcam e microfono"; riprova.classList.remove("nascosto"); }
}

async function inizializzaMediaPartita() {
  if (!mediaPartitaAttiva || paginaInChiusura) return false;
  if (flussoMediaLocale) { segnalaMediaPronto(); return true; }
  if (avvioMediaInCorso) return avvioMediaInCorso;
  avvioMediaInCorso = (async () => {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") throw new Error("getUserMedia non disponibile");
      const stream = await navigator.mediaDevices.getUserMedia(VINCOLI_MEDIA);
      if (!mediaPartitaAttiva || paginaInChiusura) {
        stream.getTracks().forEach(traccia => traccia.stop());
        return false;
      }
      if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) {
        stream.getTracks().forEach(traccia => traccia.stop());
        throw new Error("Sono necessarie entrambe le tracce audio e video");
      }
      flussoMediaLocale = stream;
      mediaRichiedeRiprovaManuale = false;
      stream.getTracks().forEach(traccia => { traccia.onended = gestisciInterruzioneMediaLocale; });
      const videoLocale = document.getElementById("video-locale");
      if (videoLocale) { videoLocale.srcObject = stream; videoLocale.muted = true; videoLocale.play().catch(() => {}); }
      const riprova = document.getElementById("btn-sblocca-media");
      if (riprova) riprova.classList.add("nascosto");
      aggiornaInterfacciaMedia("In attesa degli altri giocatori…", false);
      segnalaMediaPronto();
      return true;
    } catch (errore) {
      console.warn("Avvio webcam/microfono non riuscito:", errore);
      mediaRichiedeRiprovaManuale = true;
      aggiornaInterfacciaMedia("Permesso o dispositivo non disponibile", true);
      mostraNotificaGioco("Webcam e microfono non sono disponibili. La partita resta comunque utilizzabile.");
      const riprova = document.getElementById("btn-sblocca-media");
      if (riprova) { riprova.textContent = "Riprova webcam e microfono"; riprova.classList.remove("nascosto"); }
      return false;
    } finally {
      avvioMediaInCorso = null;
    }
  })();
  return avvioMediaInCorso;
}

function creaElementiVideoRemoto(altroUid) {
  if (elementiVideoRemoti[altroUid]) return elementiVideoRemoti[altroUid];
  const figura = document.createElement("figure");
  figura.className = "video-tile";
  figura.dataset.uid = altroUid;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  const audio = document.createElement("audio");
  audio.autoplay = true;
  const didascalia = document.createElement("figcaption");
  didascalia.textContent = nomiPartecipantiMedia.get(altroUid) || "Giocatore";
  figura.append(video, audio, didascalia);
  document.getElementById("griglia-video").appendChild(figura);
  elementiVideoRemoti[altroUid] = { figura, video, audio, didascalia };
  return elementiVideoRemoti[altroUid];
}

function tentaRiproduzioneElementoMedia(elemento) {
  if (!elemento || typeof elemento.play !== "function") return;
  elemento.play().then(() => {
    const pulsante = document.getElementById("btn-sblocca-media");
    if (pulsante && Object.values(elementiVideoRemoti).every(elementi => !elementi.video.paused && !elementi.audio.paused)) pulsante.classList.add("nascosto");
  }).catch(() => {
    const pulsante = document.getElementById("btn-sblocca-media");
    if (pulsante) { pulsante.textContent = "🔊 Attiva l'audio"; pulsante.classList.remove("nascosto"); }
  });
}

function creaConnessionePeer(altroUid) {
  const esistente = connessioniPeer[altroUid];
  if (esistente && esistente.connectionState !== "closed") return esistente;
  if (!flussoMediaLocale) throw new Error("Stream locale non pronto");
  const pc = new RTCPeerConnection(CONFIGURAZIONE_ICE);
  flussoMediaLocale.getTracks().forEach(traccia => {
    const sender = pc.addTrack(traccia, flussoMediaLocale);
    if (traccia.kind === "video" && sender && typeof sender.getParameters === "function") {
      const parametri = sender.getParameters();
      if (!parametri.encodings || !parametri.encodings.length) parametri.encodings = [{}];
      parametri.encodings[0].maxBitrate = 180000;
      sender.setParameters(parametri).catch(() => {});
    }
  });
  pc.onicecandidate = evento => {
    if (evento.candidate) inviaSocket({ tipo: "webrtc-ice-candidate", partitaId, destinatarioUid: altroUid, candidate: evento.candidate });
  };
  pc.ontrack = evento => {
    const elementi = creaElementiVideoRemoto(altroUid);
    let streamRemoto = evento.streams && evento.streams[0];
    if (!streamRemoto) {
      streamRemoto = elementi.video.srcObject instanceof MediaStream ? elementi.video.srcObject : new MediaStream();
      if (!streamRemoto.getTracks().includes(evento.track)) streamRemoto.addTrack(evento.track);
    }
    elementi.video.srcObject = streamRemoto;
    elementi.audio.srcObject = streamRemoto;
    tentaRiproduzioneElementoMedia(elementi.video);
    tentaRiproduzioneElementoMedia(elementi.audio);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      if (timerDisconnessionePeer[altroUid]) clearTimeout(timerDisconnessionePeer[altroUid]);
      delete timerDisconnessionePeer[altroUid];
      aggiornaInterfacciaMedia(`${partecipantiMediaPronti.size} partecipanti collegati`, false);
    } else if (pc.connectionState === "disconnected") {
      if (!timerDisconnessionePeer[altroUid]) {
        timerDisconnessionePeer[altroUid] = setTimeout(() => {
          delete timerDisconnessionePeer[altroUid];
          if (connessioniPeer[altroUid] === pc && pc.connectionState === "disconnected") {
            chiudiConnessioneMedia(altroUid);
            pianificaRiprovaConnessioneMedia(altroUid);
          }
        }, 5000);
      }
    } else if (pc.connectionState === "failed") {
      chiudiConnessioneMedia(altroUid);
      pianificaRiprovaConnessioneMedia(altroUid);
    }
  };
  connessioniPeer[altroUid] = pc;
  return pc;
}

async function avviaConnessioneMedia(altroUid) {
  if (!flussoMediaLocale || !partecipantiMediaPronti.has(altroUid)) return;
  if (connessioniPeer[altroUid]) return;
  const pc = creaConnessionePeer(altroUid);
  const offerta = await pc.createOffer();
  await pc.setLocalDescription(offerta);
  inviaSocket({ tipo: "webrtc-offer", partitaId, destinatarioUid: altroUid, sdp: pc.localDescription });
}

async function applicaCandidatiIceInAttesa(altroUid) {
  const pc = connessioniPeer[altroUid];
  if (!pc || !pc.remoteDescription) return;
  const candidati = candidatiIceInAttesa[altroUid] || [];
  delete candidatiIceInAttesa[altroUid];
  for (const candidate of candidati) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (errore) { console.warn("Candidato ICE ignorato:", errore); }
  }
}

async function gestisciOffertaRicevuta(mittenteUid, sdp) {
  if (!mediaPartitaAttiva || !flussoMediaLocale || !partecipantiMediaPronti.has(mittenteUid) || !sdp) return;
  const pc = connessioniPeer[mittenteUid] || creaConnessionePeer(mittenteUid);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await applicaCandidatiIceInAttesa(mittenteUid);
  const risposta = await pc.createAnswer();
  await pc.setLocalDescription(risposta);
  inviaSocket({ tipo: "webrtc-answer", partitaId, destinatarioUid: mittenteUid, sdp: pc.localDescription });
}

async function gestisciRispostaRicevuta(mittenteUid, sdp) {
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !sdp) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await applicaCandidatiIceInAttesa(mittenteUid);
}

async function gestisciCandidatoRicevuto(mittenteUid, candidate) {
  if (!candidate) return;
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !pc.remoteDescription) {
    if (!candidatiIceInAttesa[mittenteUid]) candidatiIceInAttesa[mittenteUid] = [];
    candidatiIceInAttesa[mittenteUid].push(candidate);
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (errore) { console.warn("Candidato ICE ignorato:", errore); }
}

function chiudiConnessioneMedia(altroUid) {
  if (timerRiprovaPeer[altroUid]) { clearTimeout(timerRiprovaPeer[altroUid]); delete timerRiprovaPeer[altroUid]; }
  if (timerDisconnessionePeer[altroUid]) { clearTimeout(timerDisconnessionePeer[altroUid]); delete timerDisconnessionePeer[altroUid]; }
  const pc = connessioniPeer[altroUid];
  delete connessioniPeer[altroUid];
  if (pc && pc.connectionState !== "closed") pc.close();
  const elementi = elementiVideoRemoti[altroUid];
  if (elementi) { elementi.video.srcObject = null; elementi.audio.srcObject = null; elementi.figura.remove(); delete elementiVideoRemoti[altroUid]; }
  delete candidatiIceInAttesa[altroUid];
}

function pianificaRiprovaConnessioneMedia(altroUid) {
  if (!altroUid || timerRiprovaPeer[altroUid] || !mioUid || String(mioUid) >= String(altroUid)) return;
  if (!mediaPartitaAttiva || !flussoMediaLocale || !partecipantiMediaPronti.has(altroUid)) return;
  timerRiprovaPeer[altroUid] = setTimeout(() => {
    delete timerRiprovaPeer[altroUid];
    if (!connessioniPeer[altroUid] && partecipantiMediaPronti.has(altroUid)) gestisciPromessaWebRtc(avviaConnessioneMedia(altroUid));
  }, 3000);
}

function gestisciStatoMedia(dati) {
  impostaMediaPartitaAttiva(dati.mediaAttiva === true);
  if (!mediaPartitaAttiva) return;
  partecipantiMediaPronti = new Set(Array.isArray(dati.partecipanti) ? dati.partecipanti.filter(uid => typeof uid === "string") : []);
  Object.keys(connessioniPeer).forEach(uid => { if (!partecipantiMediaPronti.has(uid)) chiudiConnessioneMedia(uid); });
  Object.keys(elementiVideoRemoti).forEach(uid => { if (!partecipantiMediaPronti.has(uid)) chiudiConnessioneMedia(uid); });
  const quanti = partecipantiMediaPronti.size;
  aggiornaInterfacciaMedia(quanti > 1 ? `${quanti} partecipanti collegati` : "In attesa degli altri giocatori…", false);
  if (flussoMediaLocale && mioUid && !partecipantiMediaPronti.has(mioUid)) {
    mediaProntoSegnalato = false;
    segnalaMediaPronto();
    return;
  }
  if (!flussoMediaLocale || !mioUid || !partecipantiMediaPronti.has(mioUid)) return;
  partecipantiMediaPronti.forEach(altroUid => {
    if (altroUid !== mioUid && String(mioUid) < String(altroUid)) gestisciPromessaWebRtc(avviaConnessioneMedia(altroUid));
  });
  disegnaGiocatori();
}

async function sbloccaRiproduzioneMedia() {
  if (!flussoMediaLocale) {
    mediaRichiedeRiprovaManuale = false;
    if (!(await inizializzaMediaPartita())) return;
  }
  const elementiDaRiprodurre = Object.values(elementiVideoRemoti).flatMap(elementi => [elementi.video, elementi.audio]);
  const risultati = await Promise.allSettled(elementiDaRiprodurre.map(elemento => elemento.play()));
  const fallita = risultati.some(risultato => risultato.status === "rejected");
  const pulsante = document.getElementById("btn-sblocca-media");
  if (pulsante) pulsante.classList.toggle("nascosto", !fallita);
}

function pulisciMediaPagina() {
  if (puliziaMediaInCorso) return;
  puliziaMediaInCorso = true;
  paginaInChiusura = true;
  if (timerRiconnessione) clearTimeout(timerRiconnessione);
  if (timerRiprovaAvvio) clearTimeout(timerRiprovaAvvio);
  if (mediaProntoSegnalato) inviaSocket({ tipo: "mediaPronto", partitaId, attivo: false });
  if (flussoMediaLocale) flussoMediaLocale.getTracks().forEach(traccia => traccia.stop());
  flussoMediaLocale = null;
  Object.keys(connessioniPeer).forEach(chiudiConnessioneMedia);
  Object.values(timerRiprovaPeer).forEach(clearTimeout);
  Object.values(timerDisconnessionePeer).forEach(clearTimeout);
  timerRiprovaPeer = {};
  timerDisconnessionePeer = {};
}
window.addEventListener("pagehide", pulisciMediaPagina);
window.addEventListener("beforeunload", pulisciMediaPagina);
window.addEventListener("pageshow", evento => {
  if (evento.persisted) window.location.reload();
});

// ===== DADI 3D =====
const CORREZIONE_ANGOLI_DADO = { 1: { x: 0, y: 0 }, 2: { x: 0, y: -90 }, 3: { x: -90, y: 0 }, 4: { x: 90, y: 0 }, 5: { x: 0, y: 90 }, 6: { x: 0, y: 180 } };
let rotazioneAttuale = { dado1: { x: 0, y: 0 }, dado2: { x: 0, y: 0 } };
function normalizza360(g) { return ((g % 360) + 360) % 360; }
function calcolaNuovaRotazione(idDado, valore) {
  const valoreSicuro = Number.isInteger(Number(valore)) && Number(valore) >= 1 && Number(valore) <= 6 ? Number(valore) : 1;
  const c = CORREZIONE_ANGOLI_DADO[valoreSicuro];
  const a = rotazioneAttuale[idDado];
  let dX = normalizza360(c.x) - normalizza360(a.x); if (dX < 0) dX += 360;
  let dY = normalizza360(c.y) - normalizza360(a.y); if (dY < 0) dY += 360;
  const nuova = { x: a.x + dX + (2 + Math.floor(Math.random() * 2)) * 360, y: a.y + dY + (2 + Math.floor(Math.random() * 2)) * 360 };
  rotazioneAttuale[idDado] = nuova;
  return nuova;
}
function applicaRotazioneDado(idDado, valore) {
  const r = calcolaNuovaRotazione(idDado, valore);
  const cubo = document.querySelector("#" + idDado + " .cubo");
  if (cubo) cubo.style.transform = `rotateX(${r.x}deg) rotateY(${r.y}deg)`;
}
function fissaFacciaDado(idDado, valore) {
  const cubo = document.querySelector("#" + idDado + " .cubo");
  const numero = Number(valore);
  const valoreSicuro = Number.isInteger(numero) && numero >= 1 && numero <= 6 ? numero : 1;
  const angoli = CORREZIONE_ANGOLI_DADO[valoreSicuro];
  if (!cubo) return;
  cubo.style.transition = "none";
  cubo.style.transform = `rotateX(${angoli.x}deg) rotateY(${angoli.y}deg)`;
  void cubo.offsetWidth;
  cubo.style.transition = "";
  rotazioneAttuale[idDado] = { ...angoli };
}
function mostraDadi(v1, v2) {
  fissaFacciaDado("dado1", v1);
  fissaFacciaDado("dado2", v2);
}
function animaLancioDadi(vf1, vf2, callback) {
  suonaTiroDadi();
  applicaRotazioneDado("dado1", vf1);
  applicaRotazioneDado("dado2", vf2);
  setTimeout(() => {
    fissaFacciaDado("dado1", vf1);
    fissaFacciaDado("dado2", vf2);
    suonaAtterraggioDadi();
    if (callback) callback();
  }, 1080);
}

function schiarisciColore(hex, p) { return mescolaColore(hex, 255, p); }
function scuriscColore(hex, p) { return mescolaColore(hex, 0, p); }
function mescolaColore(hex, target, p) {
  const num = parseInt(hex.replace("#", ""), 16);
  let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  r = Math.round(r + (target - r) * (p / 100));
  g = Math.round(g + (target - g) * (p / 100));
  b = Math.round(b + (target - b) * (p / 100));
  return `rgb(${r},${g},${b})`;
}

function coordinatePerCasella(casellaNumero) {
  const immagine = document.getElementById("immagine-tabellone");
  if (!immagine || !immagine.naturalWidth || !immagine.naturalHeight || !immagine.clientWidth || !immagine.clientHeight) return null;
  const scaleX = immagine.clientWidth / immagine.naturalWidth;
  const scaleY = immagine.clientHeight / immagine.naturalHeight;
  const casella = casellaNumero === 0 ? { x: 100, y: 1900 } : posizioniCaselle[casellaNumero];
  if (!casella) return null;
  return { left: casella.x * scaleX, top: casella.y * scaleY };
}
function posizionaPedina(pedina, casellaNumero) {
  const coord = coordinatePerCasella(casellaNumero);
  if (!coord) return;
  pedina.style.left = coord.left + "px";
  pedina.style.top = coord.top + "px";
}
function ottieniOCreaPedina(idGiocatore, colore, indice) {
  let pedina = document.getElementById("pedina-" + idGiocatore);
  if (!pedina) {
    pedina = document.createElement("div");
    pedina.id = "pedina-" + idGiocatore;
    pedina.className = "pedina";
    const idG = "gradPedina" + indice;
    pedina.innerHTML = `
      <div class="pedina-interno">
        <svg width="26" height="38" viewBox="0 0 34 48">
          <defs><radialGradient id="${idG}" cx="35%" cy="25%" r="75%">
            <stop offset="0%" stop-color="${schiarisciColore(colore, 55)}"/>
            <stop offset="55%" stop-color="${colore}"/>
            <stop offset="100%" stop-color="${scuriscColore(colore, 35)}"/>
          </radialGradient></defs>
          <ellipse cx="17" cy="44" rx="12" ry="3.5" fill="rgba(0,0,0,0.3)"/>
          <ellipse cx="17" cy="42" rx="11" ry="4" fill="${scuriscColore(colore, 25)}"/>
          <path d="M17 42 C10 42 4 40 4 37 L10 15 C10 15 12 12 17 12 C22 12 24 15 24 15 L30 37 C30 40 24 42 17 42 Z" fill="url(#${idG})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
          <circle cx="17" cy="9" r="7.5" fill="url(#${idG})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
          <ellipse cx="14" cy="6" rx="2.5" ry="1.8" fill="rgba(255,255,255,0.55)"/>
        </svg>
      </div>`;
    document.getElementById("contenitore-pedine").appendChild(pedina);
  }
  return pedina;
}
function animaSaltoPedina(idGiocatore, percorso, callback, tokenAnimazione) {
  if (!percorso || percorso.length === 0) { if (callback) callback(); return; }
  const indice = ultimoStatoGiocatori.findIndex(g => g.id === idGiocatore);
  const colore = coloriGiocatori[(indice >= 0 ? indice : 0) % coloriGiocatori.length];
  const pedina = ottieniOCreaPedina(idGiocatore, colore, indice >= 0 ? indice : 0);
  if (animazioniPedineAttive.has(idGiocatore)) {
    const statoCorrente = ultimoStatoGiocatori.find(g => g.id === idGiocatore);
    if (statoCorrente) posizionaPedina(pedina, statoCorrente.posizione);
  }
  const tokenPedina = Symbol("animazione-pedina");
  animazioniPedineAttive.set(idGiocatore, tokenPedina);
  let passo = 0;
  function saltaProssimo() {
    if (animazioniPedineAttive.get(idGiocatore) !== tokenPedina) return;
    if (passo >= percorso.length) {
      animazioniPedineAttive.delete(idGiocatore);
      const statoFinale = ultimoStatoGiocatori.find(g => g.id === idGiocatore);
      if (statoFinale) posizionaPedina(pedina, statoFinale.posizione);
      if (callback) callback();
      return;
    }
    const casella = percorso[passo];
    pedina.classList.add("pedina-salta");
    posizionaPedina(pedina, casella);
    suonaPassoPedina();
    const et = document.getElementById("casella-" + idGiocatore);
    if (et && (tokenAnimazione == null || tokenAnimazione === versioneAnimazioneStato)) et.textContent = casella;
    const pulisciSalto = () => pedina.classList.remove("pedina-salta");
    pedina.addEventListener("animationend", pulisciSalto, { once: true });
    passo++;
    setTimeout(saltaProssimo, DURATA_SALTO_MS);
  }
  saltaProssimo();
}

function applicaStatoPartitaQuandoPossibile(dati) {
  if (mossaVisualeInCorso) {
    // Teniamo soltanto lo stato più recente: verrà applicato appena finisce
    // l'animazione della pedina.
    statoPartitaAccodato = dati;
    return;
  }
  gestisciStatoPartita(dati);
}

function terminaMossaVisualeEApplicaStatoAccodato() {
  mossaVisualeInCorso = false;

  if (!statoPartitaAccodato) return;

  const stato = statoPartitaAccodato;
  statoPartitaAccodato = null;

  // Un microtask separato evita di sovrapporre il rendering dell'ultimo salto
  // con l'aggiornamento del turno.
  setTimeout(() => gestisciStatoPartita(stato), 0);
}

function gestisciStatoPartita(dati) {
  annullaVerificaDeterminazione();
  ++versioneAnimazioneStato;
  faseAttuale = "normale";
  possoTirareIoInDeterminazione = false;
  document.getElementById("overlay-determinazione").classList.remove("aperto");
  riportaDadiAllaPartita();
  fermaCountdown(false);

  ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];
  impostaVisibilitaChat(dati.chatAttiva);

  if (dati.vittoria) {
    turnoAttualeId = null;
    mioTurno = false;
    document.getElementById("riga-turno").textContent = "🏆 Partita conclusa";
    impostaDadiAbilitati(false);
    disegnaGiocatori();
    mostraVittoria(dati.vincitore || "un giocatore");
  } else {
    const turnoPronto = dati.turnoDiId != null && dati.tempoInizioTurno != null && Number(dati.durataMossaMs) > 0;
    aggiornaTurno(turnoPronto ? dati.turnoDiId : null);
    if (!turnoPronto && dati.turnoDiId != null) {
      document.getElementById("riga-turno").textContent = "⏳ Preparazione del prossimo turno…";
    }
    disegnaGiocatori();
    if (turnoPronto) {
      avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
    }
  }

  if (Array.isArray(dati.messaggi) && dati.messaggi.length) mostraMessaggioGiocoGrande(dati.messaggi.join(" "));
  segnalaStatoInizialeRicevuto();
}

function gestisciAggiornamentoPartita(dati) {
  mossaVisualeInCorso = true;
  const tokenAnimazione = ++versioneAnimazioneStato;
  mioTurno = false;
  turnoAttualeId = null;
  document.getElementById("riga-turno").textContent = "🎲 Mossa in corso…";
  impostaDadiAbilitati(false);
  fermaCountdown(false);
  document.getElementById("messaggi-gioco").textContent = "🎲 " + dati.dado1 + " + " + dati.dado2 + " = " + dati.valoreDado;

  animaLancioDadi(dati.dado1, dati.dado2, () => {
    if (tokenAnimazione !== versioneAnimazioneStato) return;
    if (Array.isArray(dati.messaggi) && dati.messaggi.length) mostraMessaggioGiocoGrande(dati.messaggi.join(" "));

    const completa = () => {
      if (tokenAnimazione !== versioneAnimazioneStato) return;
      ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : ultimoStatoGiocatori;

      if (dati.vittoria) {
        turnoAttualeId = null;
        mioTurno = false;
        document.getElementById("riga-turno").textContent = "🏆 Partita conclusa";
        impostaDadiAbilitati(false);
        disegnaGiocatori();
        mostraVittoria(dati.vincitore || "un giocatore");
      } else if (dati.turnoDiId != null) {
        aggiornaTurno(dati.turnoDiId);
        disegnaGiocatori();
        if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) {
          avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
        }
      } else {
        document.getElementById("riga-turno").textContent = "⏳ Preparazione del prossimo turno…";
        impostaDadiAbilitati(false);
        disegnaGiocatori();
      }

      terminaMossaVisualeEApplicaStatoAccodato();
    };

    if (Array.isArray(dati.percorso) && dati.percorso.length && dati.idGiocatoreCheHaTirato) {
      animaSaltoPedina(dati.idGiocatoreCheHaTirato, dati.percorso, completa, tokenAnimazione);
    } else {
      completa();
    }
  });
}

function gestisciPromessaWebRtc(promessa) {
  Promise.resolve(promessa).catch(errore => {
    console.error("Errore WebRTC:", errore);
    mostraNotificaGioco("La connessione audio/video non è riuscita.");
  });
}

async function avvia() {
  if (!partitaId) {
    aggiornaCaricamento("Partita non specificata", 100);
    terminaCaricamento("Partita non specificata");
    mostraNotificaGioco("Manca l'identificativo della partita. Ritorno alla lobby…");
    setTimeout(tornaAllaLobby, 1800);
    return;
  }

  if (!timerMassimoCaricamento) {
    timerMassimoCaricamento = setTimeout(() => {
      timerMassimoCaricamento = null;
      const overlay = document.getElementById("overlay-caricamento");
      if (overlay && !overlay.classList.contains("caricamento-finito")) {
        document.body.classList.remove("caricamento-in-corso");
        overlay.classList.add("caricamento-finito");
        mostraNotificaGioco("Il caricamento sta richiedendo più tempo del previsto. La connessione continuerà in automatico.");
      }
    }, 20000);
  }

  aggiornaCaricamento("Verifica accesso…", 25);
  try {
    const risposta = await fetch(ORIGINE_SERVER + "/api/me", { credentials: "include", cache: "no-store" });
    if (risposta.status >= 400 && risposta.status < 500 && risposta.status !== 429) {
      paginaInChiusura = true;
      window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
      return;
    }
    if (!risposta.ok) throw new Error("Risposta server " + risposta.status);
    const profilo = await risposta.json();
    if (!profilo || !profilo.uid) throw new Error("Profilo non valido");
    mioUid = profilo.uid;
    if (timerRiprovaAvvio) { clearTimeout(timerRiprovaAvvio); timerRiprovaAvvio = null; }
    aggiornaCaricamento("Connessione alla partita…", 55);
    connetti();
  } catch (errore) {
    console.error("Accesso al server non riuscito:", errore);
    impostaStatoConnessione(true);
    aggiornaCaricamento("Server non raggiungibile. Nuovo tentativo…", 25);
    if (!paginaInChiusura && !timerRiprovaAvvio) {
      timerRiprovaAvvio = setTimeout(() => {
        timerRiprovaAvvio = null;
        avvia();
      }, 3000);
    }
  }
}

function pianificaRiconnessione() {
  if (paginaInChiusura || timerRiconnessione) return;
  timerRiconnessione = setTimeout(() => {
    timerRiconnessione = null;
    connetti();
  }, 3000);
}

function connetti() {
  if (paginaInChiusura || !mioUid) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  let socketCorrente;
  try {
    socketCorrente = new WebSocket(URL_WEBSOCKET);
  } catch (errore) {
    console.error("Apertura WebSocket non riuscita:", errore);
    impostaStatoConnessione(true);
    pianificaRiconnessione();
    return;
  }
  socket = socketCorrente;

  socketCorrente.onopen = () => {
    if (socket !== socketCorrente) return;
    impostaStatoConnessione(false);
    aggiornaCaricamento("Recupero stato partita…", 75);
    if (timerRiconnessione) { clearTimeout(timerRiconnessione); timerRiconnessione = null; }
    if (!inviaSocket({ tipo: "riprendiPartita", partitaId })) socketCorrente.close();
  };

  socketCorrente.onclose = () => {
    if (socket !== socketCorrente) return;
    socket = null;
    mediaProntoSegnalato = false;
    partecipantiMediaPronti.clear();
    Object.keys(connessioniPeer).forEach(chiudiConnessioneMedia);
    if (mediaPartitaAttiva) aggiornaInterfacciaMedia("Riconnessione…", false);
    impostaStatoConnessione(true);
    impostaDadiAbilitati(false);
    fermaCountdown(false);
    annullaVerificaDeterminazione();
    pianificaRiconnessione();
  };

  socketCorrente.onerror = () => {
    if (socket === socketCorrente) impostaStatoConnessione(true);
  };

  socketCorrente.onmessage = (msg) => {
    if (socket !== socketCorrente) return;
    let dati;
    try {
      dati = JSON.parse(msg.data);
    } catch (errore) {
      console.error("Messaggio WebSocket non valido:", errore);
      return;
    }
    if (!dati || typeof dati.tipo !== "string") return;
    aggiornaNomiPartecipanti(dati);
    if (typeof dati.mediaAttiva === "boolean") impostaMediaPartitaAttiva(dati.mediaAttiva);

    if (dati.tipo === "sessioneScaduta") {
      annullaVerificaDeterminazione();
      paginaInChiusura = true;
      window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
      return;
    }

    if (dati.tipo === "sessioneSostituita") {
      pulisciMediaPagina();
      impostaDadiAbilitati(false);
      fermaCountdown(false);
      terminaCaricamento("Partita aperta altrove");
      document.getElementById("messaggi-gioco").textContent = dati.messaggio || "La partita è stata aperta in un'altra scheda o dispositivo.";
      mostraNotificaGioco(dati.messaggio || "Questa scheda non è più collegata alla partita.");
      return;
    }

    if (dati.tipo === "statoDeterminazione") { gestisciStatoDeterminazione(dati); return; }
    if (dati.tipo === "risultatoDeterminazione") { gestisciRisultatoDeterminazione(dati); return; }
    if (dati.tipo === "ordineFinaleCalcolato") { gestisciOrdineFinaleCalcolato(dati); return; }
    if (dati.tipo === "determinazioneCompletata") { gestisciDeterminazioneCompletata(dati); return; }

    if (dati.tipo === "statoMedia") { gestisciStatoMedia(dati); return; }
    if (dati.tipo === "configMedia") { aggiornaConfigurazioneIce(dati.configurazioneIce); return; }
    if (dati.tipo === "webrtc-offer") { gestisciPromessaWebRtc(gestisciOffertaRicevuta(dati.mittenteUid, dati.sdp)); return; }
    if (dati.tipo === "webrtc-answer") { gestisciPromessaWebRtc(gestisciRispostaRicevuta(dati.mittenteUid, dati.sdp)); return; }
    if (dati.tipo === "webrtc-ice-candidate") { gestisciPromessaWebRtc(gestisciCandidatoRicevuto(dati.mittenteUid, dati.candidate)); return; }

    if (dati.tipo === "statoPartita") { applicaStatoPartitaQuandoPossibile(dati); return; }
    if (dati.tipo === "aggiornamentoPartita") { gestisciAggiornamentoPartita(dati); return; }
    if (dati.tipo === "chatPartita") { aggiungiMessaggioChatPartita(dati.nome, dati.testo); return; }

    if (dati.tipo === "partitaAnnullata" || dati.tipo === "partitaTerminata") {
      annullaVerificaDeterminazione();
      mostraNotificaGioco(dati.messaggio || "La partita è terminata. Ritorno alla lobby…");
      setTimeout(tornaAllaLobby, 1800);
      return;
    }

    if (dati.tipo === "errore") {
      const messaggio = typeof dati.messaggio === "string" ? dati.messaggio : "Si è verificato un errore.";
      mostraNotificaGioco(messaggio);
      const messaggioMinuscolo = messaggio.toLocaleLowerCase("it");
      if (messaggioMinuscolo.includes("non trovata") || messaggioMinuscolo.includes("non fai parte")) {
        annullaVerificaDeterminazione();
        terminaCaricamento("Partita non disponibile");
        setTimeout(tornaAllaLobby, 2500);
      } else if (messaggioMinuscolo.includes("non è il tuo turno")) {
        turnoLocalmenteCompletato = false;
        impostaDadiAbilitati(false);
        fermaCountdown(false);
        inviaSocket({ tipo: "riprendiPartita", partitaId });
      }
    }
  };
}

function aggiornaTurno(turnoDiId) {
  const eraIlMioTurno = mioTurno;
  turnoLocalmenteCompletato = false;
  turnoAttualeId = turnoDiId;
  mioTurno = (turnoDiId === mioUid);
  if (mioTurno && !eraIlMioTurno) suonaTuoTurno();
  document.getElementById("riga-turno").textContent = mioTurno ? "🎲 È il tuo turno!" : "⏳ In attesa…";
  impostaDadiAbilitati(mioTurno);
}

function disegnaGiocatori() {
  const contenitore = document.getElementById("contenitore-pedine");
  const giocatori = Array.isArray(ultimoStatoGiocatori) ? ultimoStatoGiocatori : [];
  Array.from(contenitore.children).forEach(p => {
    const giocatore = giocatori.find(g => "pedina-" + g.id === p.id);
    if (!giocatore) {
      const idRimosso = p.id.replace(/^pedina-/, "");
      animazioniPedineAttive.delete(idRimosso);
      p.remove();
    }
  });
  const listaPannello = document.getElementById("lista-giocatori");
  listaPannello.replaceChildren();
  giocatori.forEach((giocatore, indice) => {
    const colore = coloriGiocatori[indice % coloriGiocatori.length];
    const pedina = ottieniOCreaPedina(giocatore.id, colore, indice);
    if (!animazioniPedineAttive.has(giocatore.id)) posizionaPedina(pedina, giocatore.posizione);
    const eAttivo = giocatore.id === turnoAttualeId;

    const card = document.createElement("div");
    card.className = "giocatore-card" + (eAttivo ? " attivo" : "");
    card.appendChild(creaAvatarMini(giocatore.nome, giocatore.avatar, colore));

    const linkProfilo = document.createElement("a");
    linkProfilo.href = "profilo-pubblico.html?nickname=" + encodeURIComponent(giocatore.nome || "");
    linkProfilo.target = "_blank";
    linkProfilo.rel = "noopener";
    linkProfilo.style.color = "inherit";
    linkProfilo.style.textDecoration = "none";
    linkProfilo.style.flexGrow = "1";
    linkProfilo.textContent = giocatore.nome || "Giocatore";
    card.appendChild(linkProfilo);

    if (mediaPartitaAttiva) {
      const stato = document.createElement("span");
      const pronto = partecipantiMediaPronti.has(giocatore.id);
      stato.className = "stato-media" + (pronto ? " attivo" : "");
      stato.title = pronto ? "Webcam e microfono collegati" : "Collegamento audio/video in attesa";
      stato.textContent = pronto ? "🎥" : "◌";
      card.appendChild(stato);
    }

    if (eAttivo) {
      const countdown = document.createElement("span");
      countdown.className = "countdown-turno";
      countdown.id = "countdown-turno";
      countdown.textContent = "⏱ --s";
      card.appendChild(countdown);
    }

    const casella = document.createElement("span");
    casella.className = "casella-mini";
    casella.id = "casella-" + giocatore.id;
    casella.textContent = Number.isFinite(Number(giocatore.posizione)) ? String(giocatore.posizione) : "0";
    card.appendChild(casella);
    listaPannello.appendChild(card);
  });
}

function mostraVittoria(nomeVincitore) {
  fermaCountdown(false);
  impostaDadiAbilitati(false);
  impostaMediaPartitaAttiva(false);
  suonaVittoria();
  document.getElementById("testo-vincitore").textContent = "🎉 Ha vinto " + nomeVincitore + "!";
  const overlay = document.getElementById("overlay-vittoria");
  overlay.classList.add("aperto");
  const bottone = overlay.querySelector("button");
  if (bottone) bottone.focus();
}
function urlLobby() {
  return stanza ? "lobby.html?stanza=" + encodeURIComponent(stanza) : "lobby.html";
}
function tornaAllaLobby() {
  paginaInChiusura = true;
  window.location.href = urlLobby();
}
function abbandonaPartita() {
  if (!confirm("Sei sicuro di voler abbandonare la partita?")) return;
  if (!inviaSocket({ tipo: "abbandonaPartita", partitaId })) {
    mostraNotificaGioco("Connessione assente: attendi la riconnessione prima di abbandonare la partita.");
    return;
  }
  paginaInChiusura = true;
  setTimeout(tornaAllaLobby, 120);
}
function apriProfilo() { chiudiMenu(); window.location.href = "profilo.html"; }
function apriImpostazioni() { chiudiMenu(); window.location.href = "account.html"; }
function chiudiMenu() {
  document.getElementById("pannello-menu").classList.add("nascosto");
  const bottone = document.getElementById("btn-menu");
  bottone.setAttribute("aria-expanded", "false");
  bottone.setAttribute("aria-label", "Apri menu");
}
function chiudiPannelloGiocatori() {
  document.getElementById("pannello-giocatori").classList.remove("aperto");
  document.getElementById("backdrop-giocatori").classList.remove("aperto");
  const bottone = document.getElementById("btn-giocatori");
  bottone.setAttribute("aria-expanded", "false");
  bottone.setAttribute("aria-label", "Mostra giocatori");
}
function chiudiChat() {
  const pannello = document.getElementById("pannello-chat");
  if (pannello) pannello.classList.add("nascosto");
  const bottone = document.getElementById("btn-chat");
  if (bottone) {
    bottone.setAttribute("aria-expanded", "false");
    bottone.setAttribute("aria-label", "Apri chat");
  }
}

document.getElementById("btn-menu").onclick = (e) => {
  e.stopPropagation();
  const pannello = document.getElementById("pannello-menu");
  const staPerAprirsi = pannello.classList.contains("nascosto");
  if (staPerAprirsi) {
    chiudiChat();
    chiudiPannelloGiocatori();
  }
  const aperto = pannello.classList.toggle("nascosto") === false;
  const bottone = document.getElementById("btn-menu");
  bottone.setAttribute("aria-expanded", aperto ? "true" : "false");
  bottone.setAttribute("aria-label", aperto ? "Chiudi menu" : "Apri menu");
};
document.addEventListener("click", chiudiMenu);

document.getElementById("btn-giocatori").onclick = (e) => {
  e.stopPropagation();
  const staPerAprirsi = !document.getElementById("pannello-giocatori").classList.contains("aperto");
  if (staPerAprirsi) {
    chiudiMenu();
    chiudiChat();
  }
  const aperto = document.getElementById("pannello-giocatori").classList.toggle("aperto");
  document.getElementById("backdrop-giocatori").classList.toggle("aperto", aperto);
  const bottone = document.getElementById("btn-giocatori");
  bottone.setAttribute("aria-expanded", aperto ? "true" : "false");
  bottone.setAttribute("aria-label", aperto ? "Nascondi giocatori" : "Mostra giocatori");
};
document.getElementById("backdrop-giocatori").onclick = chiudiPannelloGiocatori;

let messaggiChatNonLetti = 0;
function aggiornaBadgeChatPartita() {
  const badge = document.getElementById("badge-chat-partita");
  if (!badge) return;
  if (messaggiChatNonLetti > 0) { badge.style.display = "flex"; badge.textContent = messaggiChatNonLetti > 9 ? "9+" : messaggiChatNonLetti; }
  else badge.style.display = "none";
}
function aggiungiMessaggioChatPartita(nome, testo) {
  suonaMessaggioChat();
  const box = document.getElementById("chat-messaggi");
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
  const testo = input.value.trim();
  if (!testo) return;
  if (inviaSocket({ tipo: "chatPartita", partitaId, testo })) {
    input.value = "";
  } else {
    mostraNotificaGioco("Connessione assente: il messaggio non è stato inviato.");
  }
}
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    inviaChatPartita();
  }
});
document.getElementById("btn-chat").onclick = (e) => {
  e.stopPropagation();
  const pannello = document.getElementById("pannello-chat");
  const staPerAprirsi = pannello.classList.contains("nascosto");
  if (staPerAprirsi) {
    chiudiMenu();
    chiudiPannelloGiocatori();
  }
  const aperto = pannello.classList.toggle("nascosto") === false;
  const bottone = document.getElementById("btn-chat");
  bottone.setAttribute("aria-expanded", aperto ? "true" : "false");
  bottone.setAttribute("aria-label", aperto ? "Chiudi chat" : "Apri chat");
  if (aperto) {
    messaggiChatNonLetti = 0;
    aggiornaBadgeChatPartita();
    setTimeout(() => document.getElementById("chat-input").focus(), 0);
  }
};

function tentaTiroDadi() {
  const possoTirare = faseAttuale === "determinazione" ? possoTirareIoInDeterminazione : mioTurno;
  if (!possoTirare || turnoLocalmenteCompletato) return;
  const tipo = faseAttuale === "determinazione" ? "tiraDeterminazione" : "tiraDadi";
  if (!inviaSocket({ tipo, partitaId })) {
    mostraNotificaGioco("Connessione assente: impossibile tirare i dadi.");
    return;
  }
  fermaCountdownPerAzioneLocale();
  impostaDadiAbilitati(false);
}
document.getElementById("area-dadi").addEventListener("click", tentaTiroDadi);
document.getElementById("area-dadi").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    tentaTiroDadi();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  chiudiMenu();
  chiudiChat();
  chiudiPannelloGiocatori();
});

aggiornaTestoBottoneSuoni();
aggiornaInterfacciaMedia(mediaRichiestaDaLobby ? "Verifica impostazioni del tavolo…" : "Non attiva", false);
mostraDadi(1, 1);
inizializzaGestioneLayout();
avvia();
