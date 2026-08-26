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
let timerRecuperoTurno = null;
let paginaInChiusura = false;
let versioneAnimazioneStato = 0;
let animazioneMossaInCorso = false;
let statoPartitaAccodato = null;
const animazioniPedineAttive = new Map();
let chatPartitaAttiva = true;

let faseAttuale = "normale";
let possoTirareIoInDeterminazione = false;

// ===== PRESENTAZIONE SFIDA PRE-PARTITA =====
let mioProfilo = null;
let presentazioneSfidaInAttesa = null;
let presentazioneSfidaAperta = false;
let eventiDeterminazioneInAttesa = [];
let timerChiusuraPresentazioneSfida = null;
let tokenCaricamentoPresentazioneSfida = 0;

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

  const margineOrizzontale = Math.max(16, larghezzaCanvas * 0.03);
  const margineVerticale = Math.max(16, altezzaCanvas * 0.06);
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


function chiavePresentazioneSfida() {
  return "giochi-societa:presentazione-sfida:" + (partitaId || "sconosciuta");
}

function presentazioneSfidaGiaVista() {
  try { return sessionStorage.getItem(chiavePresentazioneSfida()) === "1"; }
  catch (errore) { return false; }
}

function marcaPresentazioneSfidaVista() {
  try { sessionStorage.setItem(chiavePresentazioneSfida(), "1"); }
  catch (errore) {}
}

function probabilitaVittoriaEloPresentazione(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (Number(eloB) - Number(eloA)) / 400));
}

function calcolaVariazioniEloPresentazione(eloGiocatore, eloAvversari) {
  const elo = Number.isFinite(Number(eloGiocatore)) ? Math.round(Number(eloGiocatore)) : 1500;
  const avversari = (Array.isArray(eloAvversari) ? eloAvversari : [])
    .map(Number)
    .filter(Number.isFinite);

  if (!avversari.length) return { vittoria: 0, sconfitta: 0 };

  const aspettativaMedia = avversari.reduce(
    (somma, eloAvversario) => somma + probabilitaVittoriaEloPresentazione(elo, eloAvversario),
    0
  ) / avversari.length;

  const eloVittoria = Math.max(100, Math.round(elo + 32 * (1 - aspettativaMedia)));
  const eloSconfitta = Math.max(100, Math.round(elo + 32 * (0 - aspettativaMedia)));

  return {
    vittoria: eloVittoria - elo,
    sconfitta: eloSconfitta - elo
  };
}

function escapeHtmlPresentazione(valore) {
  return String(valore == null ? "" : valore)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stelleDaEloPresentazione(elo) {
  const valore = Number.isFinite(Number(elo)) ? Number(elo) : 1500;
  if (valore < 1300) return 1;
  if (valore < 1500) return 2;
  if (valore < 1700) return 3;
  if (valore < 1900) return 4;
  return 5;
}

function htmlStellePresentazione(elo) {
  const piene = stelleDaEloPresentazione(elo);
  let html = "";
  for (let i = 1; i <= 5; i++) html += i <= piene ? "★" : '<span class="vuota">★</span>';
  return html;
}

function normalizzaProfiloPresentazione(giocatore, profilo) {
  const giocate = Math.max(0, Number(profilo?.partiteGiocate || 0));
  const vinte = Math.max(0, Number(profilo?.partiteVinte || 0));
  return {
    uid: giocatore.uid || giocatore.id || profilo?.uid || null,
    nome: profilo?.nickname || giocatore.nome || "Giocatore",
    avatar: profilo?.avatar || giocatore.avatar || null,
    elo: Number.isFinite(Number(profilo?.elo)) ? Math.round(Number(profilo.elo)) : 1500,
    giocate,
    vinte,
    winRate: Number.isFinite(Number(profilo?.winRate))
      ? Math.max(0, Math.min(100, Math.round(Number(profilo.winRate))))
      : (giocate > 0 ? Math.round((vinte / giocate) * 100) : 0),
    streak: Math.max(0, Number(profilo?.streakVittorieMassima || 0))
  };
}

async function caricaProfiloPresentazioneSfida(giocatore) {
  const uid = giocatore.uid || giocatore.id || null;
  if (uid && uid === mioUid && mioProfilo) {
    return normalizzaProfiloPresentazione(giocatore, mioProfilo);
  }

  const nome = typeof giocatore.nome === "string" ? giocatore.nome.trim() : "";
  if (!nome) return normalizzaProfiloPresentazione(giocatore, null);

  try {
    const risposta = await fetch(
      ORIGINE_SERVER + "/api/profilo-pubblico/" + encodeURIComponent(nome),
      { credentials: "include", cache: "no-store" }
    );
    if (!risposta.ok) throw new Error("Profilo HTTP " + risposta.status);
    return normalizzaProfiloPresentazione(giocatore, await risposta.json());
  } catch (errore) {
    console.warn("Profilo sfida non disponibile per " + nome + ":", errore);
    return normalizzaProfiloPresentazione(giocatore, null);
  }
}

function percentualeBarraPresentazione(valore, massimo) {
  const v = Math.max(0, Number(valore) || 0);
  const m = Math.max(1, Number(massimo) || 1);
  if (v <= 0) return 0;
  return Math.max(8, Math.min(100, Math.round((v / m) * 100)));
}

function htmlAvatarPresentazione(profilo) {
  const nome = escapeHtmlPresentazione(profilo.nome);
  if (typeof profilo.avatar === "string" && profilo.avatar.trim()) {
    return `<div class="sfida-avatar"><img src="${escapeHtmlPresentazione(profilo.avatar)}" alt="Avatar di ${nome}" referrerpolicy="no-referrer"></div>`;
  }
  return `<div class="sfida-avatar" style="background:${coloreDaNome(profilo.nome)}">${escapeHtmlPresentazione(iniziale(profilo.nome))}</div>`;
}

function htmlGiocatoreDuelloPresentazione(profilo, lato, massimi) {
  const classeDestra = lato === "destra" ? " sfida-giocatore-destra" : "";
  const dati = [
    [profilo.elo, massimi.elo],
    [profilo.giocate, massimi.giocate],
    [profilo.vinte, massimi.vinte]
  ];
  const righe = dati.map(([valore, massimo]) => `
    <div class="sfida-stat-riga">
      <div class="sfida-stat-barra"><div class="sfida-stat-riempimento" style="width:${percentualeBarraPresentazione(valore, massimo)}%"></div></div>
      <span class="sfida-stat-valore">${Math.round(Number(valore) || 0)}</span>
    </div>`).join("");

  return `<article class="sfida-giocatore${classeDestra}">
    <div class="sfida-identita">
      ${htmlAvatarPresentazione(profilo)}
      <div class="sfida-nome-wrap">
        <div class="sfida-nome" title="${escapeHtmlPresentazione(profilo.nome)}">${escapeHtmlPresentazione(profilo.nome)}</div>
        <div class="sfida-stelle" aria-label="Indicatore grafico ELO">${htmlStellePresentazione(profilo.elo)}</div>
      </div>
    </div>
    ${righe}
  </article>`;
}

function htmlGiocatoreMultiPresentazione(profilo, massimi) {
  const statistiche = [
    ["ELO", profilo.elo, massimi.elo],
    ["Giocate", profilo.giocate, massimi.giocate],
    ["Vinte", profilo.vinte, massimi.vinte]
  ];

  return `<article class="sfida-multi-card">
    <div class="sfida-identita">
      ${htmlAvatarPresentazione(profilo)}
      <div class="sfida-nome-wrap">
        <div class="sfida-nome" title="${escapeHtmlPresentazione(profilo.nome)}">${escapeHtmlPresentazione(profilo.nome)}</div>
        <div class="sfida-stelle" aria-label="Indicatore grafico ELO">${htmlStellePresentazione(profilo.elo)}</div>
      </div>
    </div>
    ${statistiche.map(([etichetta, valore, massimo]) => `
      <div class="sfida-multi-stat">
        <span>${etichetta}</span>
        <div class="sfida-stat-barra"><div class="sfida-stat-riempimento" style="width:${percentualeBarraPresentazione(valore, massimo)}%"></div></div>
        <strong>${Math.round(Number(valore) || 0)}</strong>
      </div>`).join("")}
  </article>`;
}

function configuraPresentazioneSfidaModalita(classificata) {
  const eClassificata = classificata !== false;
  const testoModalita = document.getElementById("sfida-modalita-testo");
  const descrizione = document.getElementById("sfida-descrizione-modalita");
  const boxVariazione = document.getElementById("sfida-box-variazione-elo");

  if (testoModalita) {
    testoModalita.textContent = eClassificata
      ? "Partita classificata · 63 caselle · ELO attivo"
      : "Partita Divertimento · 63 caselle · ELO invariato";
  }
  if (descrizione) {
    descrizione.textContent = eClassificata
      ? "Giocatori reali · il risultato modifica il rating ELO"
      : "Giocatori reali · questa partita non modifica il rating ELO";
  }
  if (boxVariazione) boxVariazione.hidden = !eClassificata;
  return eClassificata;
}

function disegnaPresentazioneSfida(profili, classificata = true) {
  const contenitore = document.getElementById("sfida-giocatori");
  if (!contenitore) return;

  const elenco = Array.isArray(profili) ? profili : [];
  if (!elenco.length) {
    contenitore.innerHTML = '<div class="sfida-caricamento">Giocatori non disponibili.</div>';
    return;
  }

  const massimi = {
    elo: Math.max(...elenco.map(p => p.elo), 1),
    giocate: Math.max(...elenco.map(p => p.giocate), 1),
    vinte: Math.max(...elenco.map(p => p.vinte), 1)
  };

  if (elenco.length === 2) {
    contenitore.innerHTML = `<div class="sfida-duello">
      ${htmlGiocatoreDuelloPresentazione(elenco[0], "sinistra", massimi)}
      <div class="sfida-vs-colonna" aria-hidden="true">
        <div class="sfida-vs">VS</div>
        <div class="sfida-vs-etichetta">ELO</div>
        <div class="sfida-vs-etichetta">Giocate</div>
        <div class="sfida-vs-etichetta">Vinte</div>
      </div>
      ${htmlGiocatoreDuelloPresentazione(elenco[1], "destra", massimi)}
    </div>`;
  } else {
    contenitore.innerHTML = `<div class="sfida-multi">${elenco.map(p => htmlGiocatoreMultiPresentazione(p, massimi)).join("")}</div>`;
  }

  const mio = elenco.find(p => p.uid === mioUid) || elenco[0];
  const eClassificata = classificata !== false;
  const avversari = elenco.filter(p => p.uid !== mio.uid).map(p => p.elo);
  const variazioni = eClassificata
    ? calcolaVariazioniEloPresentazione(mio.elo, avversari)
    : { vittoria: 0, sconfitta: 0 };

  const elVittoria = document.getElementById("sfida-elo-vittoria");
  const elSconfitta = document.getElementById("sfida-elo-sconfitta");
  const elStreak = document.getElementById("sfida-streak");
  const elWinRate = document.getElementById("sfida-winrate");
  if (elVittoria) elVittoria.textContent = eClassificata ? ((variazioni.vittoria >= 0 ? "+" : "") + variazioni.vittoria) : "";
  if (elSconfitta) elSconfitta.textContent = eClassificata ? String(variazioni.sconfitta) : "";
  if (elStreak) elStreak.textContent = String(Math.round(mio.streak || 0));
  if (elWinRate) elWinRate.textContent = Math.round(mio.winRate || 0) + "%";
}

function calcolaRitardoChiusuraAutomaticaPresentazione(dati) {
  const durata = Number(dati?.durataMossaMs);
  if (!Number.isFinite(durata) || durata <= 0) return 6000;
  return Math.max(2200, Math.min(6000, Math.round(durata * 0.45)));
}

async function mostraPresentazioneSfida(giocatori, datiDeterminazione) {
  const overlay = document.getElementById("overlay-presentazione-sfida");
  if (!overlay || presentazioneSfidaAperta) return;

  const classificata = datiDeterminazione?.classificata !== false;
  configuraPresentazioneSfidaModalita(classificata);
  presentazioneSfidaAperta = true;
  faseAttuale = "presentazione";
  possoTirareIoInDeterminazione = false;
  mioTurno = false;
  impostaDadiAbilitati(false);
  fermaCountdown(false);
  annullaVerificaDeterminazione();
  document.getElementById("overlay-determinazione")?.classList.remove("aperto");
  riportaDadiAllaPartita();

  overlay.classList.add("aperto");
  overlay.setAttribute("aria-hidden", "false");
  document.getElementById("sfida-giocatori").innerHTML = '<div class="sfida-caricamento">Caricamento confronto…</div>';
  const stato = document.getElementById("sfida-stato");
  if (stato) stato.textContent = classificata ? "Recupero ELO e statistiche reali…" : "Recupero statistiche reali…";

  if (timerChiusuraPresentazioneSfida) clearTimeout(timerChiusuraPresentazioneSfida);
  timerChiusuraPresentazioneSfida = setTimeout(
    () => chiudiPresentazioneSfida(true),
    calcolaRitardoChiusuraAutomaticaPresentazione(datiDeterminazione)
  );

  const token = ++tokenCaricamentoPresentazioneSfida;
  const profili = await Promise.all((Array.isArray(giocatori) ? giocatori : []).map(caricaProfiloPresentazioneSfida));
  if (!presentazioneSfidaAperta || token !== tokenCaricamentoPresentazioneSfida) return;

  disegnaPresentazioneSfida(profili, classificata);
  if (stato) {
    stato.textContent = classificata
      ? "Il confronto ELO è calcolato con K = 32."
      : "Modalità Divertimento: ELO invariato, nessun punto viene aggiunto o sottratto.";
  }

  setTimeout(() => document.getElementById("btn-entra-partita")?.focus(), 0);
}

function deveMostrarePresentazioneSfida(dati) {
  const giocatori = Array.isArray(dati?.giocatori) ? dati.giocatori : [];
  return !presentazioneSfidaGiaVista() && giocatori.length >= 2;
}

function accodaEventoDeterminazioneDurantePresentazione(tipo, dati) {
  if (!presentazioneSfidaAperta) return false;
  eventiDeterminazioneInAttesa.push({ tipo, dati });
  return true;
}

function riproduciEventiDeterminazioneInAttesa() {
  const eventi = eventiDeterminazioneInAttesa.splice(0);
  eventi.forEach(evento => {
    if (evento.tipo === "risultatoDeterminazione") gestisciRisultatoDeterminazione(evento.dati);
    else if (evento.tipo === "ordineFinaleCalcolato") gestisciOrdineFinaleCalcolato(evento.dati);
    else if (evento.tipo === "determinazioneCompletata") gestisciDeterminazioneCompletata(evento.dati);
  });
}

function chiudiPresentazioneSfida(automatica = false) {
  if (!presentazioneSfidaAperta) return;

  if (timerChiusuraPresentazioneSfida) {
    clearTimeout(timerChiusuraPresentazioneSfida);
    timerChiusuraPresentazioneSfida = null;
  }

  ++tokenCaricamentoPresentazioneSfida;
  presentazioneSfidaAperta = false;
  marcaPresentazioneSfidaVista();

  const overlay = document.getElementById("overlay-presentazione-sfida");
  if (overlay) {
    overlay.classList.remove("aperto");
    overlay.setAttribute("aria-hidden", "true");
  }

  const statoDeterminazione = presentazioneSfidaInAttesa;
  presentazioneSfidaInAttesa = null;

  if (statoDeterminazione) gestisciStatoDeterminazione(statoDeterminazione);
  riproduciEventiDeterminazioneInAttesa();

  if (automatica) mostraNotificaGioco("Presentazione completata: si passa alla determinazione dell'ordine.");
}

document.getElementById("btn-entra-partita")?.addEventListener("click", () => chiudiPresentazioneSfida(false));

function gestisciStatoDeterminazione(dati) {
  if (deveMostrarePresentazioneSfida(dati)) {
    presentazioneSfidaInAttesa = dati;
    segnalaStatoInizialeRicevuto();
    mostraPresentazioneSfida(dati.giocatori, dati).catch(errore => {
      console.error("Errore presentazione sfida:", errore);
      chiudiPresentazioneSfida(false);
    });
    return;
  }

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
  if (accodaEventoDeterminazioneDurantePresentazione("risultatoDeterminazione", dati)) return;
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
  if (accodaEventoDeterminazioneDurantePresentazione("ordineFinaleCalcolato", dati)) return;
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
  if (accodaEventoDeterminazioneDurantePresentazione("determinazioneCompletata", dati)) return;
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

function rilevaTipoDispositivoMediaLocale() {
  const ua = String(navigator.userAgent || "");
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return "cellulare";
  return "computer";
}

const tipoDispositivoMediaLocale = rilevaTipoDispositivoMediaLocale();
const clientCellulareAudioOnly = tipoDispositivoMediaLocale === "cellulare";
document.body.classList.toggle("client-cellulare-audio-only", clientCellulareAudioOnly);

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

  const giocatore = (Array.isArray(ultimoStatoGiocatori) ? ultimoStatoGiocatori : [])
    .find(g => g && g.id === uid);
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
  const stato = document.getElementById("stato-media-connessione");
  const voceMenu = document.getElementById("btn-stato-media");
  if (pannello) pannello.classList.toggle("nascosto", !mediaPartitaAttiva);
  if (stato) {
    stato.textContent = testo || (mediaPartitaAttiva ? "Collegamento…" : "Non attiva");
    stato.style.color = errore ? "#ff8a80" : "";
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
    btnMic.textContent = acceso ? "🎙️ Microfono: On" : "🔇 Microfono: Muto";
    btnMic.setAttribute("aria-pressed", acceso ? "false" : "true");
    btnMic.classList.toggle("media-spento", !!tracciaAudio && !acceso);
  }

  if (btnCam) {
    btnCam.hidden = clientCellulareAudioOnly;
    btnCam.setAttribute("aria-hidden", clientCellulareAudioOnly ? "true" : "false");
    if (!clientCellulareAudioOnly) {
      const acceso = !!(tracciaVideo && tracciaVideo.enabled);
      btnCam.disabled = !tracciaVideo;
      btnCam.textContent = acceso ? "📷 Webcam: On" : "🚫 Webcam: Off";
      btnCam.setAttribute("aria-pressed", acceso ? "false" : "true");
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
    partitaId,
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
  inviaSocket({ tipo: "mediaPronto", partitaId, attivo: false });
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
      inviaSocket({ tipo: "mediaPronto", partitaId, attivo: false });
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
  didascalia.textContent = nomiPartecipantiMedia.get(altroUid) || "Giocatore";
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
        partitaId,
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
    const stato = pc.connectionState;
    const statoIce = pc.iceConnectionState;
    if (stato === "connected" || statoIce === "connected" || statoIce === "completed") {
      if (timerDisconnessionePeer[altroUid]) clearTimeout(timerDisconnessionePeer[altroUid]);
      delete timerDisconnessionePeer[altroUid];
      aggiornaInterfacciaMedia(`${partecipantiMediaPronti.size} partecipanti collegati`, false);
      return;
    }

    if (stato === "failed" || statoIce === "failed") {
      chiudiPeerSenzaRimuovereTile(altroUid);
      pianificaRiprovaConnessioneMedia(altroUid, 900);
      return;
    }

    if (stato === "disconnected" || statoIce === "disconnected") {
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
  if (String(mioUid) >= String(altroUid)) return; // un solo lato crea le offerte: niente glare

  let pc = connessioniPeer[altroUid];
  if (pc && pc.connectionState === "connected" && !riavvioIce) return;
  if (pc && pc.signalingState !== "stable") return;
  if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") pc = creaConnessionePeer(altroUid);

  const offerta = await pc.createOffer(riavvioIce ? { iceRestart: true } : undefined);
  if (pc.signalingState !== "stable") return;
  await pc.setLocalDescription(offerta);
  inviaSocket({ tipo: "webrtc-offer", partitaId, destinatarioUid: altroUid, sdp: pc.localDescription });
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
  inviaSocket({ tipo: "webrtc-answer", partitaId, destinatarioUid: mittenteUid, sdp: pc.localDescription });
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
  disegnaGiocatori();
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

// Un tocco dell'utente è sufficiente per sbloccare l'audio remoto sui browser mobili
// che vietano autoplay con audio.
document.addEventListener("pointerdown", () => {
  if (!mediaPartitaAttiva || !flussoMediaLocale) return;
  const audioRemoti = Object.values(elementiVideoRemoti).map(elementi => elementi.audio).filter(Boolean);
  audioRemoti.forEach(audio => audio.play().catch(() => mostraPulsanteSbloccoAudio("🔊 Attiva l'audio")));
}, { passive: true });

function pulisciMediaPagina() {
  if (puliziaMediaInCorso) return;
  puliziaMediaInCorso = true;
  paginaInChiusura = true;
  if (timerRiconnessione) clearTimeout(timerRiconnessione);
  if (timerRiprovaAvvio) clearTimeout(timerRiprovaAvvio);
  annullaRecuperoTurno();
  if (mediaProntoSegnalato) inviaSocket({ tipo: "mediaPronto", partitaId, attivo: false });
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
    // Su alcuni browser mobili riaggiungere subito la stessa classe non
    // riavvia l'animazione. La rimozione + reflow forza un salto per casella.
    pedina.classList.remove("pedina-salta");
    void pedina.offsetWidth;
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

function annullaRecuperoTurno() {
  if (timerRecuperoTurno) {
    clearTimeout(timerRecuperoTurno);
    timerRecuperoTurno = null;
  }
}

function pianificaRecuperoTurno() {
  annullaRecuperoTurno();
  if (paginaInChiusura) return;
  timerRecuperoTurno = setTimeout(() => {
    timerRecuperoTurno = null;
    if (paginaInChiusura || faseAttuale !== "normale" || animazioneMossaInCorso) return;
    inviaSocket({ tipo: "riprendiPartita", partitaId });
  }, 650);
}

function gestisciPreparazionePartita(dati) {
  annullaVerificaDeterminazione();
  annullaRecuperoTurno();
  animazioneMossaInCorso = false;
  statoPartitaAccodato = null;
  ++versioneAnimazioneStato;
  faseAttuale = "preparazione";
  possoTirareIoInDeterminazione = false;
  mioTurno = false;
  turnoAttualeId = null;
  fermaCountdown(false);
  impostaDadiAbilitati(false);
  document.getElementById("overlay-determinazione").classList.remove("aperto");
  riportaDadiAllaPartita();

  ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : ultimoStatoGiocatori;
  impostaVisibilitaChat(dati.chatAttiva);
  disegnaGiocatori();

  const riga = document.getElementById("riga-turno");
  if (riga) riga.textContent = dati.messaggio || (dati.mediaAttiva
    ? (clientCellulareAudioOnly ? "🎙️ Preparazione microfono…" : "🎥 Preparazione webcam e microfono…")
    : "⏳ Preparazione partita…");
  segnalaStatoInizialeRicevuto();
}

function gestisciStatoPartita(dati) {
  annullaVerificaDeterminazione();

  // Uno stato del turno successivo non deve troncare l'animazione corrente.
  // Conserviamo soltanto lo stato più recente e lo applichiamo appena la
  // pedina ha terminato tutti i salti.
  if (animazioneMossaInCorso && !dati.vittoria) {
    statoPartitaAccodato = dati;
    return;
  }

  annullaRecuperoTurno();
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
      document.getElementById("riga-turno").textContent = "🎲 Aggiornamento partita…";
      pianificaRecuperoTurno();
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
  annullaRecuperoTurno();
  animazioneMossaInCorso = true;
  statoPartitaAccodato = null;
  const tokenAnimazione = ++versioneAnimazioneStato;
  mioTurno = false;
  turnoAttualeId = null;
  document.getElementById("riga-turno").textContent = "🎲 Mossa in corso…";
  impostaDadiAbilitati(false);
  fermaCountdown(false);
  document.getElementById("messaggi-gioco").textContent = "🎲 " + dati.dado1 + " + " + dati.dado2 + " = " + dati.valoreDado;

  animaLancioDadi(dati.dado1, dati.dado2, () => {
    if (tokenAnimazione !== versioneAnimazioneStato) {
      animazioneMossaInCorso = false;
      return;
    }
    if (Array.isArray(dati.messaggi) && dati.messaggi.length) mostraMessaggioGiocoGrande(dati.messaggi.join(" "));

    const completa = () => {
      if (tokenAnimazione !== versioneAnimazioneStato) {
        animazioneMossaInCorso = false;
        return;
      }

      ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : ultimoStatoGiocatori;

      if (dati.vittoria) {
        animazioneMossaInCorso = false;
        statoPartitaAccodato = null;
        turnoAttualeId = null;
        mioTurno = false;
        document.getElementById("riga-turno").textContent = "🏆 Partita conclusa";
        impostaDadiAbilitati(false);
        disegnaGiocatori();
        mostraVittoria(dati.vincitore || "un giocatore");
        return;
      }

      if (dati.turnoDiId != null && dati.tempoInizioTurno != null && Number(dati.durataMossaMs) > 0) {
        animazioneMossaInCorso = false;
        aggiornaTurno(dati.turnoDiId);
        disegnaGiocatori();
        avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
        return;
      }

      // Il server invia il turno reale in un secondo messaggio, dopo la durata
      // completa dell'animazione. Nel frattempo manteniamo la mossa conclusa
      // senza attribuire prematuramente il turno a un altro giocatore.
      document.getElementById("riga-turno").textContent = "🎲 Mossa completata…";
      impostaDadiAbilitati(false);
      disegnaGiocatori();
      animazioneMossaInCorso = false;

      const statoAccodato = statoPartitaAccodato;
      statoPartitaAccodato = null;
      if (statoAccodato) {
        gestisciStatoPartita(statoAccodato);
      } else {
        pianificaRecuperoTurno();
      }
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
    // Per aprire il WebSocket non serve scaricare l'intero profilo:
    // /api/me-menu restituisce solo pochi dati e non trasferisce l'avatar base64.
    const risposta = await fetch(ORIGINE_SERVER + "/api/me-menu", {
      credentials: "include",
      cache: "no-store"
    });

    if (risposta.status >= 400 && risposta.status < 500 && risposta.status !== 429) {
      paginaInChiusura = true;
      window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
      return;
    }

    if (!risposta.ok) throw new Error("Risposta server " + risposta.status);

    const profiloRapido = await risposta.json();
    if (!profiloRapido || !profiloRapido.uid) throw new Error("Profilo non valido");

    mioUid = profiloRapido.uid;

    if (timerRiprovaAvvio) {
      clearTimeout(timerRiprovaAvvio);
      timerRiprovaAvvio = null;
    }

    aggiornaCaricamento("Connessione alla partita…", 55);
    connetti();

    // Le statistiche complete servono solo alla presentazione della sfida:
    // le carichiamo in parallelo senza ritardare la connessione WebSocket.
    fetch(ORIGINE_SERVER + "/api/me", {
      credentials: "include",
      cache: "no-store"
    })
      .then(r => r.ok ? r.json() : null)
      .then(profilo => {
        if (profilo && profilo.uid === mioUid) mioProfilo = profilo;
      })
      .catch(erroreProfilo => {
        console.warn("Profilo completo non disponibile durante l'avvio:", erroreProfilo);
      });

  } catch (errore) {
    console.error("Accesso al server non riuscito:", errore);
    impostaStatoConnessione(true);
    aggiornaCaricamento("Server non raggiungibile. Nuovo tentativo…", 25);

    if (!paginaInChiusura && !timerRiprovaAvvio) {
      timerRiprovaAvvio = setTimeout(() => {
        timerRiprovaAvvio = null;
        avvia();
      }, 1500);
    }
  }
}

function pianificaRiconnessione() {
  if (paginaInChiusura || timerRiconnessione) return;
  timerRiconnessione = setTimeout(() => {
    timerRiconnessione = null;
    connetti();
  }, 1200);
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

    if (dati.tipo === "preparazionePartita") { gestisciPreparazionePartita(dati); return; }
    if (dati.tipo === "statoDeterminazione") { gestisciStatoDeterminazione(dati); return; }
    if (dati.tipo === "risultatoDeterminazione") { gestisciRisultatoDeterminazione(dati); return; }
    if (dati.tipo === "ordineFinaleCalcolato") { gestisciOrdineFinaleCalcolato(dati); return; }
    if (dati.tipo === "determinazioneCompletata") { gestisciDeterminazioneCompletata(dati); return; }

    if (dati.tipo === "statoMedia") { gestisciStatoMedia(dati); return; }
    if (dati.tipo === "configMedia") { aggiornaConfigurazioneIce(dati.configurazioneIce); return; }
    if (dati.tipo === "webrtc-offer") { gestisciPromessaWebRtc(gestisciOffertaRicevuta(dati.mittenteUid, dati.sdp)); return; }
    if (dati.tipo === "webrtc-answer") { gestisciPromessaWebRtc(gestisciRispostaRicevuta(dati.mittenteUid, dati.sdp)); return; }
    if (dati.tipo === "webrtc-ice-candidate") { gestisciPromessaWebRtc(gestisciCandidatoRicevuto(dati.mittenteUid, dati.candidate)); return; }

    if (dati.tipo === "statoPartita") { gestisciStatoPartita(dati); return; }
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
  annullaRecuperoTurno();
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
      const infoMedia = descrittoreMediaPerUid(giocatore.id);
      const daCellulare = infoMedia.tipoDispositivo === "cellulare";
      stato.className = "stato-media" + (pronto ? " attivo" : "");

      if (daCellulare) {
        stato.title = pronto ? "Cellulare collegato: solo audio" : "Cellulare: collegamento audio in attesa";
        stato.appendChild(creaIconaCellulareBarratoElemento());
      } else {
        stato.title = pronto ? "Webcam e microfono collegati" : "Collegamento audio/video in attesa";
        stato.textContent = pronto ? "🎥" : "◌";
      }
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
  // Anche il ritorno sostituisce la voce corrente: il browser conserva
  // Stanze -> Lobby, ma non mantiene mai la Partita nella cronologia.
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
