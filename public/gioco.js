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

const coloriGiocatori = [
  "#6a2c70", "#dddddd", "#1e40af", "#43a047",
  "#f57c00", "#c0ca33", "#e53935", "#2b2b2b"
];

const DURATA_LANCIO_DADI_MS = 1200;
const DURATA_SALTO_MS = 220;

const URL_SERVER_HTTP = "https://gioco-oca-server.onrender.com";
const URL_SERVER_WS = "wss://gioco-oca-server.onrender.com";

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita");
const stanza = params.get("stanza");

let mioUid = null;
let socket = null;

let ultimoStatoGiocatori = [];
let mioTurno = false;
let turnoAttualeId = null;

let timerRiconnessione = null;
let tentativoRiconnessioneInCorso = false;

let faseAttuale = "normale";
let possoTirareIoInDeterminazione = false;

/* ============================================================
   TIMER CLIENT — ancorato a performance.now() al momento in cui
   il messaggio arriva, mai a un confronto diretto tra orario del
   server e orologio del telefono (un piccolo disallineamento tra
   i due causava numeri sballati). Il valore iniziale non supera
   mai durataMossaMs, qualunque altro dato arrivi insieme.
   ============================================================ */

let durataMossaMsAttuale = null;
let msResiduiRiferimento = null;
let momentoLocaleRiferimento = null;
let intervalCountdown = null;
let ultimoSecondoAvviso = null;
let turnoLocalmenteCompletato = false;

function iniziale(nome) {
  return (nome || "?").trim().charAt(0).toUpperCase();
}

function coloreDaNome(nome) {
  const colori = [
    "#6a2c70", "#1e40af", "#43a047", "#f57c00",
    "#c0ca33", "#e53935", "#00838f", "#8d6e63"
  ];
  let somma = 0;
  for (let i = 0; i < (nome || "?").length; i++) {
    somma += nome.charCodeAt(i);
  }
  return colori[somma % colori.length];
}

/* ============================================================
   NOTIFICHE INTERNE — al posto degli alert() del browser
   ============================================================ */

function mostraNotificaGioco(testo) {
  const contenitore = document.getElementById("contenitore-notifiche-gioco");
  if (!contenitore) { console.error(testo); return; }
  const toast = document.createElement("div");
  toast.className = "notifica-toast-gioco";
  toast.textContent = testo;
  contenitore.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

/* ============================================================
   SUONI
   ============================================================ */

let suoniAttivi = localStorage.getItem("suoniAttivi") !== "off";
let contestoAudio = null;

function ottieniContestoAudio() {
  try {
    if (!contestoAudio) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      contestoAudio = new C();
    }
    if (contestoAudio.state === "suspended") {
      const promessa = contestoAudio.resume();
      if (promessa && typeof promessa.catch === "function") promessa.catch(() => {});
    }
    return contestoAudio;
  } catch (e) {
    return null;
  }
}

function suonaTono(frequenza, durataMs, tipoOnda, volume, ritardoMs) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  try {
    const inizio = ctx.currentTime + (ritardoMs || 0) / 1000;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = tipoOnda || "sine";
    osc.frequency.setValueAtTime(frequenza, inizio);
    g.gain.setValueAtTime(0.0001, inizio);
    g.gain.linearRampToValueAtTime(volume || 0.12, inizio + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, inizio + durataMs / 1000);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(inizio);
    osc.stop(inizio + durataMs / 1000 + 0.02);
  } catch (e) {}
}

function suonaClick(volume, ritardoMs) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  try {
    const inizio = ctx.currentTime + (ritardoMs || 0) / 1000;
    const durata = 0.045;
    const lung = Math.max(1, Math.floor(ctx.sampleRate * durata));
    const buffer = ctx.createBuffer(1, lung, ctx.sampleRate);
    const dati = buffer.getChannelData(0);
    for (let i = 0; i < lung; i++) dati[i] = (Math.random() * 2 - 1) * (1 - i / lung);
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume || 0.18, inizio);
    g.gain.exponentialRampToValueAtTime(0.001, inizio + durata);
    s.connect(g);
    g.connect(ctx.destination);
    s.start(inizio);
  } catch (e) {}
}

function suonaTiroDadi() { if (!suoniAttivi) return; for (let i = 0; i < 7; i++) suonaClick(0.1, i * 100); }
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
  suoniAttivi = !!attivi;
  localStorage.setItem("suoniAttivi", suoniAttivi ? "on" : "off");
  aggiornaTestoBottoneSuoni();
}
function aggiornaTestoBottoneSuoni() {
  const b = document.getElementById("btn-toggle-suoni");
  if (b) b.textContent = suoniAttivi ? "🔊 Suoni: On" : "🔇 Suoni: Off";
}

/* ============================================================
   TUTTO SCHERMO
   ============================================================ */

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const elemento = document.documentElement;
      const richiesta =
        elemento.requestFullscreen ||
        elemento.webkitRequestFullscreen ||
        elemento.mozRequestFullScreen ||
        elemento.msRequestFullscreen;
      if (!richiesta) { mostraNotificaGioco("Il tuo browser non supporta lo schermo intero."); return; }
      const risultato = richiesta.call(elemento);
      if (risultato && typeof risultato.catch === "function") {
        risultato.catch((err) => {
          mostraNotificaGioco("Non è stato possibile attivare lo schermo intero" + (err && err.message ? ": " + err.message : "."));
        });
      }
    } else {
      const esci =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;
      if (esci) esci.call(document);
    }
  } catch (err) {
    mostraNotificaGioco("Errore durante l'attivazione dello schermo intero" + (err && err.message ? ": " + err.message : "."));
  }
}

function aggiornaTestoBottoneFullscreen() {
  const b = document.getElementById("btn-toggle-fullscreen");
  if (!b) return;
  b.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? "🡼 Esci da tutto schermo" : "⛶ Tutto schermo";
}
document.addEventListener("fullscreenchange", aggiornaTestoBottoneFullscreen);
document.addEventListener("webkitfullscreenchange", aggiornaTestoBottoneFullscreen);

/* ============================================================
   LAYOUT — su Computer normale; su cellulare tutto (tranne la
   chat) vive dentro #mondo-ruotato che ruota SEMPRE di 90°, senza
   controllare l'orientamento fisico: pensato per restare in
   verticale in mano.
   ============================================================ */

function rilevaEImpostaModalitaDesktop() {
  const puntatorePreciso = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  const schermoAmpio = window.innerWidth >= 1000;
  document.body.classList.toggle("modalita-desktop", !!(puntatorePreciso && schermoAmpio));
}

function aggiornaLayoutTabellone() {
  const areaTabellone = document.getElementById("area-tabellone");
  const mondo = document.getElementById("mondo-ruotato");
  const immagine = document.getElementById("immagine-tabellone");
  if (!areaTabellone || !mondo || !immagine) return;

  const rapportoNaturale = (immagine.naturalWidth && immagine.naturalHeight) ? immagine.naturalWidth / immagine.naturalHeight : 1.48;
  const eDesktop = document.body.classList.contains("modalita-desktop");
  const larghezzaFinestra = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const altezzaReale = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--altezza-reale", altezzaReale + "px");

  const larghezzaCanvas = eDesktop ? larghezzaFinestra : altezzaReale;
  const altezzaCanvas = eDesktop ? altezzaReale : larghezzaFinestra;
  mondo.style.width = larghezzaCanvas + "px";
  mondo.style.height = altezzaCanvas + "px";

  const margineOrizzontale = Math.max(16, larghezzaCanvas * 0.03);
  const margineVerticale = Math.max(16, altezzaCanvas * 0.06);
  const larghezzaDisponibile = larghezzaCanvas - margineOrizzontale * 2;
  const altezzaDisponibile = altezzaCanvas - margineVerticale * 2;

  const Wc = Math.max(100, Math.min(larghezzaDisponibile, altezzaDisponibile * rapportoNaturale));
  const Hc = Wc / rapportoNaturale;

  if (!Number.isFinite(Wc) || !Number.isFinite(Hc)) return;

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
    if (immagine.complete && immagine.naturalWidth) aggiornaLayoutTabellone();
    else immagine.addEventListener("load", aggiornaLayoutTabellone);
  }
}

function riposizionaTuttePedine() {
  ultimoStatoGiocatori.forEach((g) => {
    const p = document.getElementById("pedina-" + g.id);
    if (p) posizionaPedina(p, g.posizione);
  });
}

/* ============================================================
   MESSAGGIO GRANDE
   ============================================================ */

let timerFlashMessaggio = null;

function mostraMessaggioGiocoGrande(testo) {
  if (!testo) return;
  const el = document.getElementById("flash-messaggio-gioco");
  if (!el) return;
  const span = el.querySelector("span");
  if (!span) return;
  span.textContent = testo;
  el.classList.remove("visibile");
  void el.offsetWidth;
  el.classList.add("visibile");
  if (timerFlashMessaggio) clearTimeout(timerFlashMessaggio);
  timerFlashMessaggio = setTimeout(() => { el.classList.remove("visibile"); }, 1500);
}

/* ============================================================
   DETERMINAZIONE ORDINE ("CHI INIZIA?")
   ============================================================ */

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
  if (areaDadiHomeFratelloSuccessivo && areaDadiHomeFratelloSuccessivo.parentNode === areaDadiHomeGenitore) {
    areaDadiHomeGenitore.insertBefore(areaDadi, areaDadiHomeFratelloSuccessivo);
  } else {
    areaDadiHomeGenitore.appendChild(areaDadi);
  }
  areaDadi.classList.remove("dadi-in-popup");
}

function disegnaListaDeterminazione(giocatori, turnoInCorsoUid, gruppoSpareggio) {
  const lista = document.getElementById("lista-determinazione");
  if (!lista) return;
  const elenco = Array.isArray(giocatori) ? giocatori : [];
  const spareggioSet = new Set(Array.isArray(gruppoSpareggio) ? gruppoSpareggio : []);

  lista.innerHTML = elenco.map((g) => {
    const avatarHtml = g.avatar
      ? `<img class="avatar-mini" src="${g.avatar}" alt="">`
      : `<div class="avatar-mini" style="background:${coloreDaNome(g.nome)};">${iniziale(g.nome)}</div>`;

    let statoHtml;
    if (g.risultato != null) {
      statoHtml = `<span class="determinazione-risultato">🎲 ${g.risultato}</span>`;
    } else if (g.uid === turnoInCorsoUid) {
      statoHtml = `<span class="determinazione-in-corso">🎲 sta tirando...</span>`;
    } else {
      statoHtml = `<span class="determinazione-attesa">in attesa</span>`;
    }

    const tagSpareggio = spareggioSet.has(g.uid) ? `<span class="determinazione-tag-spareggio" title="In spareggio">⚔️</span>` : "";
    const evidenzia = g.uid === turnoInCorsoUid ? " determinazione-riga-attiva" : "";

    return `
      <div class="determinazione-riga${evidenzia}">
        ${avatarHtml}
        <span class="determinazione-nome">${g.nome || "?"}</span>
        ${tagSpareggio}
        ${statoHtml}
      </div>
    `;
  }).join("");
}

function gestisciStatoDeterminazione(dati) {
  faseAttuale = "determinazione";

  const overlay = document.getElementById("overlay-determinazione");
  if (overlay) overlay.classList.add("aperto");

  const appenaEntrato = spostaDadiInDeterminazione();
  if (appenaEntrato) mostraDadi(1, 1);

  const giocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];
  disegnaListaDeterminazione(giocatori, dati.turnoInCorsoUid || null, dati.gruppoSpareggioAttuale || []);

  possoTirareIoInDeterminazione = dati.turnoInCorsoUid === mioUid;

  const areaDadi = document.getElementById("area-dadi");
  if (areaDadi) areaDadi.classList.toggle("disabilitato", !possoTirareIoInDeterminazione);

  const sottotitolo = document.getElementById("sottotitolo-determinazione");
  if (dati.gruppoSpareggioAttuale && dati.gruppoSpareggioAttuale.length) {
    const nomiSpareggio = dati.gruppoSpareggioAttuale.map((u) => {
      const g = giocatori.find((x) => x.uid === u);
      return g ? g.nome : "?";
    }).join(", ");
    if (sottotitolo) sottotitolo.textContent = "⚔️ Pareggio tra " + nomiSpareggio + " — nuovo tiro per decidere l'ordine tra loro!";
  } else if (possoTirareIoInDeterminazione) {
    if (sottotitolo) sottotitolo.textContent = "Tocca a te: tira i dadi!";
  } else {
    const inAttesaDi = giocatori.find((g) => g.uid === dati.turnoInCorsoUid);
    if (sottotitolo) sottotitolo.textContent = inAttesaDi ? "In attesa che " + inAttesaDi.nome + " tiri..." : "I giocatori tirano i dadi uno alla volta.";
  }

  if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) {
    avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs, dati.scadenzaTurno || null);
  } else if (appenaEntrato) {
    mostraDadi(1, 1);
  }
}

function gestisciRisultatoDeterminazione(dati) {
  animaLancioDadi(dati.dado1, dati.dado2, () => {
    const sottotitolo = document.getElementById("sottotitolo-determinazione");
    if (sottotitolo) {
      sottotitolo.textContent = (dati.nome || "Il giocatore") + " ha fatto " + dati.valoreDado + (dati.automatico ? " (tempo scaduto)" : "") + "!";
    }
  });
}

function gestisciOrdineFinaleCalcolato(dati) {
  const sottotitolo = document.getElementById("sottotitolo-determinazione");
  if (sottotitolo) sottotitolo.textContent = "Ordine deciso! La partita inizia tra un istante...";

  const lista = document.getElementById("lista-determinazione");
  if (!lista) return;

  const ordine = Array.isArray(dati.ordineGiocatori) ? dati.ordineGiocatori : [];
  lista.innerHTML = ordine.map((nome, indice) => {
    const punteggio = dati.punteggi && dati.punteggi[nome] != null ? dati.punteggi[nome] : "?";
    return `
      <div class="determinazione-riga determinazione-riga-finale" style="animation-delay:${indice * 0.12}s;">
        <span class="determinazione-posizione-finale">${indice + 1}°</span>
        <span class="determinazione-nome">${nome || "?"}</span>
        <span class="determinazione-risultato">🎲 ${punteggio}</span>
      </div>
    `;
  }).join("");
}

function gestisciDeterminazioneCompletata(dati) {
  faseAttuale = "normale";

  const overlay = document.getElementById("overlay-determinazione");
  if (overlay) overlay.classList.remove("aperto");

  riportaDadiAllaPartita();

  ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];
  const primoMovimento = dati.primoMovimento || {};

  const messaggiGioco = document.getElementById("messaggi-gioco");
  if (messaggiGioco) {
    messaggiGioco.textContent =
      "🎲 " + (primoMovimento.nomeGiocatore || "?") +
      " ha fatto " + Number(primoMovimento.valoreDado || 0) +
      " — avanza di " + Number(primoMovimento.valoreDado || 0) + " caselle!";
  }

  animaSaltoPedina(primoMovimento.idGiocatore, primoMovimento.percorso || [], () => {
    if (Array.isArray(primoMovimento.messaggi) && primoMovimento.messaggi.length) {
      mostraMessaggioGiocoGrande(primoMovimento.messaggi.join(" "));
    }

    if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) {
      avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs, dati.scadenzaTurno || null);
    }

    if (dati.vittoria) {
      turnoAttualeId = null;
      mioTurno = false;
      fermaCountdownCompleto();

      const areaDadi = document.getElementById("area-dadi");
      if (areaDadi) areaDadi.classList.add("disabilitato");

      disegnaGiocatori();
      mostraVittoria(dati.vincitore);
    } else {
      aggiornaTurno(dati.turnoDiId || null);
      disegnaGiocatori();
    }
  });
}

/* ============================================================
   TIMER
   ============================================================ */

function fermaCountdownCompleto() {
  if (intervalCountdown !== null) {
    clearInterval(intervalCountdown);
    intervalCountdown = null;
  }
}

function azzeraDatiCountdown() {
  durataMossaMsAttuale = null;
  msResiduiRiferimento = null;
  momentoLocaleRiferimento = null;
  ultimoSecondoAvviso = null;
}

function avviaCountdownTurno(tempoInizio, durataMs, scadenzaTurno = null) {
  fermaCountdownCompleto();

  const durataNumero = Number(durataMs);
  durataMossaMsAttuale = Number.isFinite(durataNumero) && durataNumero > 0 ? durataNumero : null;

  if (durataMossaMsAttuale === null) {
    msResiduiRiferimento = null;
    momentoLocaleRiferimento = null;
    const el = document.getElementById("countdown-turno");
    if (el) el.textContent = "⏱ --s";
    return;
  }

  const inizioNumero = Number(tempoInizio);
  const scadenzaNumero = Number(scadenzaTurno);

  let msRestantiAllArrivo;
  if (Number.isFinite(scadenzaNumero) && scadenzaNumero > 0) {
    msRestantiAllArrivo = scadenzaNumero - Date.now();
  } else if (Number.isFinite(inizioNumero) && inizioNumero > 0) {
    msRestantiAllArrivo = (inizioNumero + durataMossaMsAttuale) - Date.now();
  } else {
    msRestantiAllArrivo = durataMossaMsAttuale;
  }

  msResiduiRiferimento = Math.max(0, Math.min(durataMossaMsAttuale, msRestantiAllArrivo));
  momentoLocaleRiferimento = performance.now();

  ultimoSecondoAvviso = null;
  turnoLocalmenteCompletato = false;

  aggiornaCountdownTurno();
  intervalCountdown = setInterval(aggiornaCountdownTurno, 100);
}

function fermaCountdownPerAzioneLocale() {
  turnoLocalmenteCompletato = true;
  fermaCountdownCompleto();
  const el = document.getElementById("countdown-turno");
  if (el) {
    el.textContent = "✓";
    el.classList.remove("countdown-scaduto");
    el.classList.add("countdown-fermo");
  }
}

function aggiornaCountdownTurno() {
  const el = document.getElementById("countdown-turno");
  if (!el) return;
  if (turnoLocalmenteCompletato) return;

  if (msResiduiRiferimento === null || momentoLocaleRiferimento === null) {
    el.textContent = "⏱ --s";
    el.classList.remove("countdown-scaduto");
    return;
  }

  const trascorsoLocaleMs = performance.now() - momentoLocaleRiferimento;
  const restanteMs = msResiduiRiferimento - trascorsoLocaleMs;
  const sec = Math.max(0, Math.ceil(restanteMs / 1000));

  el.textContent = "⏱ " + sec + "s";
  el.classList.toggle("countdown-scaduto", sec <= 0);
  el.classList.remove("countdown-fermo");

  if (sec >= 1 && sec <= 3 && sec !== ultimoSecondoAvviso) {
    ultimoSecondoAvviso = sec;
    suonaAvvisoTempo();
  }
}

/* ============================================================
   MICROFONO / WEBRTC (consenso reciproco per coppia)
   ============================================================ */

let microfonoAttivo = false;
let flussoAudioLocale = null;
let connessioniPeer = {};
let elementiAudioRemoti = {};
let uidRichiestaAudioInAttesa = null;
let richiesteInviate = new Set();
let coppieAudioAttive = new Set();

const CONFIGURAZIONE_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function toggleMicrofono() {
  if (microfonoAttivo) disattivaMicrofono();
  else await attivaMicrofono();
}

async function attivaMicrofono() {
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      mostraNotificaGioco("Il tuo browser non permette l'accesso al microfono.");
      return;
    }
    flussoAudioLocale = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    mostraNotificaGioco("Non è stato possibile accedere al microfono. Controlla i permessi del browser.");
    return;
  }
  microfonoAttivo = true;
  aggiornaTestoBottoneMicrofono();
  disegnaGiocatori();
}

function disattivaMicrofono() {
  microfonoAttivo = false;
  if (flussoAudioLocale) { flussoAudioLocale.getTracks().forEach((t) => t.stop()); flussoAudioLocale = null; }
  Object.keys(connessioniPeer).forEach(chiudiConnessioneAudio);
  richiesteInviate.clear();
  coppieAudioAttive.clear();
  aggiornaTestoBottoneMicrofono();
  disegnaGiocatori();
}

function aggiornaTestoBottoneMicrofono() {
  const b = document.getElementById("btn-toggle-microfono");
  if (b) b.textContent = microfonoAttivo ? "🎤 Microfono: On" : "🔇 Microfono: Off";
}

function richiediAudioCon(altroUid) {
  if (!microfonoAttivo) { mostraNotificaGioco("Attiva prima il tuo microfono dal menu ☰."); return; }
  if (!altroUid || altroUid === mioUid) return;
  if (richiesteInviate.has(altroUid) || coppieAudioAttive.has(altroUid)) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  richiesteInviate.add(altroUid);
  socket.send(JSON.stringify({ tipo: "richiestaAudio", partitaId, destinatarioUid: altroUid }));
  disegnaGiocatori();
}

function mostraRichiestaAudioRicevuta(mittenteUid, mittenteNome) {
  uidRichiestaAudioInAttesa = mittenteUid;
  suonaRichiestaAudio();
  const testo = document.getElementById("testo-richiesta-audio");
  if (testo) testo.textContent = (mittenteNome || "Un giocatore") + " ti sta chiedendo di parlare in chiamata audio";
  const popup = document.getElementById("popup-richiesta-audio");
  if (popup) popup.classList.remove("nascosto");
}

async function rispondiRichiestaAudioRicevuta(accettato) {
  const mittenteUid = uidRichiestaAudioInAttesa;
  const popup = document.getElementById("popup-richiesta-audio");
  if (popup) popup.classList.add("nascosto");
  uidRichiestaAudioInAttesa = null;
  if (!mittenteUid) return;

  if (accettato && !microfonoAttivo) {
    await attivaMicrofono();
    if (!microfonoAttivo) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ tipo: "rispostaAudio", partitaId, destinatarioUid: mittenteUid, accettato: false }));
      }
      return;
    }
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ tipo: "rispostaAudio", partitaId, destinatarioUid: mittenteUid, accettato: !!accettato }));

  if (accettato) {
    coppieAudioAttive.add(mittenteUid);
    disegnaGiocatori();
  }
}

function creaConnessionePeer(altroUid) {
  if (!altroUid) return null;
  if (connessioniPeer[altroUid]) return connessioniPeer[altroUid];

  let pc;
  try { pc = new RTCPeerConnection(CONFIGURAZIONE_ICE); } catch (e) { return null; }

  if (flussoAudioLocale) {
    flussoAudioLocale.getTracks().forEach((t) => { try { pc.addTrack(t, flussoAudioLocale); } catch (e) {} });
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ tipo: "webrtc-ice-candidate", partitaId, destinatarioUid: altroUid, candidate: ev.candidate }));
    }
  };

  pc.ontrack = (ev) => {
    let elAudio = elementiAudioRemoti[altroUid];
    if (!elAudio) {
      elAudio = document.createElement("audio");
      elAudio.autoplay = true;
      elAudio.playsInline = true;
      elAudio.id = "audio-remoto-" + altroUid;
      document.body.appendChild(elAudio);
      elementiAudioRemoti[altroUid] = elAudio;
    }
    if (ev.streams && ev.streams[0]) {
      elAudio.srcObject = ev.streams[0];
      const p = elAudio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") chiudiConnessioneAudio(altroUid);
  };

  connessioniPeer[altroUid] = pc;
  return pc;
}

async function avviaConnessioneAudio(altroUid, sonoIoAdIniziare) {
  if (!altroUid || altroUid === mioUid) return;
  if (connessioniPeer[altroUid]) return;
  const pc = creaConnessionePeer(altroUid);
  if (!pc) return;

  if (sonoIoAdIniziare) {
    try {
      const offerta = await pc.createOffer();
      await pc.setLocalDescription(offerta);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ tipo: "webrtc-offer", partitaId, destinatarioUid: altroUid, sdp: pc.localDescription }));
      }
    } catch (e) {
      chiudiConnessioneAudio(altroUid);
    }
  }
}

async function gestisciOffertaRicevuta(mittenteUid, sdp) {
  if (!microfonoAttivo || !mittenteUid || !sdp) return;
  try {
    const pc = connessioniPeer[mittenteUid] || creaConnessionePeer(mittenteUid);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const risposta = await pc.createAnswer();
    await pc.setLocalDescription(risposta);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ tipo: "webrtc-answer", partitaId, destinatarioUid: mittenteUid, sdp: pc.localDescription }));
    }
  } catch (e) {}
}

async function gestisciRispostaRicevuta(mittenteUid, sdp) {
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !sdp) return;
  try { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch (e) {}
}

async function gestisciCandidatoRicevuto(mittenteUid, candidate) {
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
}

function chiudiConnessioneAudio(altroUid) {
  const pc = connessioniPeer[altroUid];
  if (pc) { try { pc.close(); } catch (e) {} delete connessioniPeer[altroUid]; }
  const elAudio = elementiAudioRemoti[altroUid];
  if (elAudio) { try { elAudio.srcObject = null; } catch (e) {} elAudio.remove(); delete elementiAudioRemoti[altroUid]; }
  coppieAudioAttive.delete(altroUid);
}

window.addEventListener("beforeunload", () => {
  if (flussoAudioLocale) flussoAudioLocale.getTracks().forEach((t) => t.stop());
  Object.keys(connessioniPeer).forEach(chiudiConnessioneAudio);
});

/* ============================================================
   DADI 3D
   ============================================================ */

const CORREZIONE_ANGOLI_DADO = {
  1: { x: 0, y: 0 }, 2: { x: 0, y: -90 }, 3: { x: -90, y: 0 },
  4: { x: 90, y: 0 }, 5: { x: 0, y: 90 }, 6: { x: 0, y: 180 }
};
let rotazioneAttuale = { dado1: { x: 0, y: 0 }, dado2: { x: 0, y: 0 } };

function normalizza360(g) { return ((g % 360) + 360) % 360; }

function calcolaNuovaRotazione(idDado, valore) {
  const c = CORREZIONE_ANGOLI_DADO[valore];
  if (!c) return rotazioneAttuale[idDado];
  const a = rotazioneAttuale[idDado];
  let dX = normalizza360(c.x) - normalizza360(a.x); if (dX < 0) dX += 360;
  let dY = normalizza360(c.y) - normalizza360(a.y); if (dY < 0) dY += 360;
  const nuova = {
    x: a.x + dX + (2 + Math.floor(Math.random() * 2)) * 360,
    y: a.y + dY + (2 + Math.floor(Math.random() * 2)) * 360
  };
  rotazioneAttuale[idDado] = nuova;
  return nuova;
}

function applicaRotazioneDado(idDado, valore) {
  const r = calcolaNuovaRotazione(idDado, valore);
  const cubo = document.querySelector("#" + idDado + " .cubo");
  if (cubo && r) cubo.style.transform = `rotateX(${r.x}deg) rotateY(${r.y}deg)`;
}

function mostraDadi(v1, v2) {
  const c1 = document.querySelector("#dado1 .cubo");
  const c2 = document.querySelector("#dado2 .cubo");
  if (c1) c1.style.transition = "none";
  if (c2) c2.style.transition = "none";
  if (v1 >= 1 && v1 <= 6) applicaRotazioneDado("dado1", v1);
  if (v2 >= 1 && v2 <= 6) applicaRotazioneDado("dado2", v2);
  if (c1) { void c1.offsetHeight; c1.style.transition = ""; }
  if (c2) { void c2.offsetHeight; c2.style.transition = ""; }
}

function animaLancioDadi(vf1, vf2, callback) {
  suonaTiroDadi();
  applicaRotazioneDado("dado1", vf1);
  applicaRotazioneDado("dado2", vf2);
  setTimeout(() => {
    suonaAtterraggioDadi();
    if (typeof callback === "function") callback();
  }, DURATA_LANCIO_DADI_MS);
}

/* ============================================================
   PEDINE
   ============================================================ */

function schiarisciColore(hex, p) { return mescolaColore(hex, 255, p); }
function scuriscColore(hex, p) { return mescolaColore(hex, 0, p); }

function mescolaColore(hex, target, p) {
  const num = parseInt(String(hex).replace("#", ""), 16);
  if (!Number.isFinite(num)) return `rgb(${target},${target},${target})`;
  let r = (num >> 16) & 255;
  let g = (num >> 8) & 255;
  let b = num & 255;
  r = Math.round(r + (target - r) * (p / 100));
  g = Math.round(g + (target - g) * (p / 100));
  b = Math.round(b + (target - b) * (p / 100));
  return `rgb(${r},${g},${b})`;
}

function coordinatePerCasella(casellaNumero) {
  const immagine = document.getElementById("immagine-tabellone");
  if (!immagine || !immagine.naturalWidth || !immagine.naturalHeight) return null;
  const scaleX = immagine.clientWidth / immagine.naturalWidth;
  const scaleY = immagine.clientHeight / immagine.naturalHeight;
  const casella = casellaNumero === 0 ? { x: 100, y: 1900 } : posizioniCaselle[casellaNumero];
  if (!casella) return null;
  return { left: casella.x * scaleX, top: casella.y * scaleY };
}

function posizionaPedina(pedina, casellaNumero) {
  if (!pedina) return;
  const coord = coordinatePerCasella(casellaNumero);
  if (!coord) return;
  pedina.style.left = coord.left + "px";
  pedina.style.top = coord.top + "px";
}

function ottieniOCreaPedina(idGiocatore, colore, indice) {
  if (!idGiocatore) return null;
  let pedina = document.getElementById("pedina-" + idGiocatore);
  if (!pedina) {
    pedina = document.createElement("div");
    pedina.id = "pedina-" + idGiocatore;
    pedina.className = "pedina";
    const idG = "gradPedina" + String(indice).replace(/[^a-zA-Z0-9_-]/g, "");
    pedina.innerHTML = `
      <div class="pedina-interno">
        <svg width="26" height="38" viewBox="0 0 34 48" aria-hidden="true">
          <defs>
            <radialGradient id="${idG}" cx="35%" cy="25%" r="75%">
              <stop offset="0%" stop-color="${schiarisciColore(colore, 55)}"/>
              <stop offset="55%" stop-color="${colore}"/>
              <stop offset="100%" stop-color="${scuriscColore(colore, 35)}"/>
            </radialGradient>
          </defs>
          <ellipse cx="17" cy="44" rx="12" ry="3.5" fill="rgba(0,0,0,0.3)"/>
          <ellipse cx="17" cy="42" rx="11" ry="4" fill="${scuriscColore(colore, 25)}"/>
          <path d="M17 42 C10 42 4 40 4 37 L10 15 C10 15 12 12 17 12 C22 12 24 15 24 15 L30 37 C30 40 24 42 17 42 Z" fill="url(#${idG})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
          <circle cx="17" cy="9" r="7.5" fill="url(#${idG})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
          <ellipse cx="14" cy="6" rx="2.5" ry="1.8" fill="rgba(255,255,255,0.55)"/>
        </svg>
      </div>
    `;
    const contenitore = document.getElementById("contenitore-pedine");
    if (contenitore) contenitore.appendChild(pedina);
  }
  return pedina;
}

function animaSaltoPedina(idGiocatore, percorso, callback) {
  const listaPercorso = Array.isArray(percorso) ? percorso : [];
  if (listaPercorso.length === 0) { if (typeof callback === "function") callback(); return; }

  const indice = ultimoStatoGiocatori.findIndex((g) => g.id === idGiocatore);
  const colore = coloriGiocatori[(indice >= 0 ? indice : 0) % coloriGiocatori.length];
  const pedina = ottieniOCreaPedina(idGiocatore, colore, indice >= 0 ? indice : 0);
  if (!pedina) { if (typeof callback === "function") callback(); return; }

  let passo = 0;
  function saltaProssimo() {
    if (passo >= listaPercorso.length) { if (typeof callback === "function") callback(); return; }
    const casella = listaPercorso[passo];
    pedina.classList.add("pedina-salta");
    posizionaPedina(pedina, casella);
    suonaPassoPedina();
    const et = document.getElementById("casella-" + idGiocatore);
    if (et) et.textContent = String(casella);
    setTimeout(() => { pedina.classList.remove("pedina-salta"); }, Math.max(1, DURATA_SALTO_MS * 0.6));
    passo++;
    setTimeout(saltaProssimo, DURATA_SALTO_MS);
  }
  saltaProssimo();
}

/* ============================================================
   AVVIO / AUTENTICAZIONE
   ============================================================ */

async function avvia() {
  try {
    const risposta = await fetch(URL_SERVER_HTTP + "/api/me", { credentials: "include" });
    if (!risposta.ok) { window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href); return; }
    const dati = await risposta.json();
    if (!dati || !dati.uid) { window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href); return; }
    mioUid = dati.uid;
    if (!partitaId) { mostraNotificaGioco("ID partita mancante."); return; }
    connetti();
  } catch (e) {
    window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
  }
}

/* ============================================================
   CONNESSIONE WEBSOCKET
   ============================================================ */

function pianificaRiconnessione() {
  if (timerRiconnessione) return;
  timerRiconnessione = setTimeout(() => {
    timerRiconnessione = null;
    if (socket && socket.readyState === WebSocket.OPEN) return;
    connetti();
  }, 3000);
}

function connetti() {
  if (tentativoRiconnessioneInCorso) return;
  tentativoRiconnessioneInCorso = true;

  try {
    socket = new WebSocket(URL_SERVER_WS);
  } catch (e) {
    tentativoRiconnessioneInCorso = false;
    pianificaRiconnessione();
    return;
  }

  socket.onopen = () => {
    tentativoRiconnessioneInCorso = false;
    if (timerRiconnessione) { clearTimeout(timerRiconnessione); timerRiconnessione = null; }
    const banner = document.getElementById("banner-disconnesso");
    if (banner) banner.classList.add("nascosto");
    socket.send(JSON.stringify({ tipo: "riprendiPartita", partitaId }));
  };

  socket.onclose = () => {
    tentativoRiconnessioneInCorso = false;
    const banner = document.getElementById("banner-disconnesso");
    if (banner) banner.classList.remove("nascosto");
    pianificaRiconnessione();
  };

  socket.onerror = () => {};

  socket.onmessage = (msg) => {
    let dati;
    try { dati = JSON.parse(msg.data); } catch (e) { return; }
    if (!dati || !dati.tipo) return;

    if (dati.tipo === "sessioneScaduta") {
      fermaCountdownCompleto();
      window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
      return;
    }

    if (dati.tipo === "statoDeterminazione") { gestisciStatoDeterminazione(dati); return; }
    if (dati.tipo === "risultatoDeterminazione") { gestisciRisultatoDeterminazione(dati); return; }
    if (dati.tipo === "ordineFinaleCalcolato") { gestisciOrdineFinaleCalcolato(dati); return; }
    if (dati.tipo === "determinazioneCompletata") { gestisciDeterminazioneCompletata(dati); return; }

    if (dati.tipo === "richiestaAudioRicevuta") { mostraRichiestaAudioRicevuta(dati.mittenteUid, dati.mittenteNome); return; }
    if (dati.tipo === "rispostaAudioRicevuta") {
      if (dati.mittenteUid) richiesteInviate.delete(dati.mittenteUid);
      if (dati.accettato && dati.mittenteUid) {
        coppieAudioAttive.add(dati.mittenteUid);
        disegnaGiocatori();
        avviaConnessioneAudio(dati.mittenteUid, true);
      } else {
        disegnaGiocatori();
      }
      return;
    }
    if (dati.tipo === "webrtc-offer") { gestisciOffertaRicevuta(dati.mittenteUid, dati.sdp); return; }
    if (dati.tipo === "webrtc-answer") { gestisciRispostaRicevuta(dati.mittenteUid, dati.sdp); return; }
    if (dati.tipo === "webrtc-ice-candidate") { gestisciCandidatoRicevuto(dati.mittenteUid, dati.candidate); return; }

    if (dati.tipo === "statoPartita") {
      faseAttuale = "normale";
      ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];

      const chatWrapper = document.getElementById("chat-wrapper");
      if (chatWrapper) chatWrapper.style.display = dati.chatAttiva === false ? "none" : "";

      if (dati.vittoria) {
        turnoAttualeId = null;
        mioTurno = false;
        fermaCountdownCompleto();
        azzeraDatiCountdown();

        const areaDadi = document.getElementById("area-dadi");
        if (areaDadi) areaDadi.classList.add("disabilitato");

        disegnaGiocatori();
        mostraVittoria(dati.vincitore);
      } else {
        aggiornaTurno(dati.turnoDiId || null);
        disegnaGiocatori();
      }

      if (Array.isArray(dati.messaggi) && dati.messaggi.length) {
        mostraMessaggioGiocoGrande(dati.messaggi.join(" "));
      }

      if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) {
        avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs, dati.scadenzaTurno || null);
      }
      return;
    }

    if (dati.tipo === "aggiornamentoPartita") {
      fermaCountdownCompleto();
      turnoLocalmenteCompletato = true;

      animaLancioDadi(Number(dati.dado1), Number(dati.dado2), () => {
        const completa = () => {
          ultimoStatoGiocatori = Array.isArray(dati.giocatori) ? dati.giocatori : [];

          const messaggiGioco = document.getElementById("messaggi-gioco");
          if (messaggiGioco) {
            messaggiGioco.textContent = "🎲 " + Number(dati.dado1 || 0) + " + " + Number(dati.dado2 || 0) + " = " + Number(dati.valoreDado || 0);
          }

          if (Array.isArray(dati.messaggi) && dati.messaggi.length) {
            mostraMessaggioGiocoGrande(dati.messaggi.join(" "));
          }

          if (dati.vittoria) {
            turnoAttualeId = null;
            mioTurno = false;
            fermaCountdownCompleto();
            azzeraDatiCountdown();

            const areaDadi = document.getElementById("area-dadi");
            if (areaDadi) areaDadi.classList.add("disabilitato");

            disegnaGiocatori();
            mostraVittoria(dati.vincitore);
          } else {
            disegnaGiocatori();
          }
        };

        if (Array.isArray(dati.percorso) && dati.percorso.length > 0 && dati.idGiocatoreCheHaTirato) {
          animaSaltoPedina(dati.idGiocatoreCheHaTirato, dati.percorso, completa);
        } else {
          completa();
        }
      });
      return;
    }

    if (dati.tipo === "chatPartita") { aggiungiMessaggioChatPartita(dati.nome, dati.testo); return; }

    if (dati.tipo === "errore") {
      mostraNotificaGioco(dati.messaggio || "Si è verificato un errore.");
      const testo = String(dati.messaggio || "");
      if (testo.indexOf("non trovata") !== -1 || testo.indexOf("Non fai parte") !== -1 || testo.indexOf("già terminata") !== -1) {
        fermaCountdownCompleto();
        setTimeout(() => { window.location.href = `lobby.html?stanza=${encodeURIComponent(stanza || "")}`; }, 2200);
      }
      return;
    }
  };
}

/* ============================================================
   TURNI
   ============================================================ */

function aggiornaTurno(turnoDiId) {
  const eraIlMioTurno = mioTurno;
  turnoAttualeId = turnoDiId || null;
  mioTurno = !!turnoDiId && turnoDiId === mioUid;

  if (mioTurno && !eraIlMioTurno) {
    turnoLocalmenteCompletato = false;
    suonaTuoTurno();
  }

  const rigaTurno = document.getElementById("riga-turno");
  if (rigaTurno) rigaTurno.textContent = mioTurno ? "🎲 È il tuo turno!" : "⏳ In attesa...";

  const areaDadi = document.getElementById("area-dadi");
  if (areaDadi) areaDadi.classList.toggle("disabilitato", !mioTurno);
}

/* ============================================================
   GIOCATORI
   ============================================================ */

function disegnaGiocatori() {
  const contenitore = document.getElementById("contenitore-pedine");
  if (!contenitore) return;

  Array.from(contenitore.children).forEach((p) => {
    if (!ultimoStatoGiocatori.some((g) => "pedina-" + g.id === p.id)) p.remove();
  });

  const listaPannello = document.getElementById("lista-giocatori");
  if (!listaPannello) return;
  listaPannello.innerHTML = "";

  ultimoStatoGiocatori.forEach((giocatore, indice) => {
    if (!giocatore || !giocatore.id) return;

    const colore = coloriGiocatori[indice % coloriGiocatori.length];
    const pedina = ottieniOCreaPedina(giocatore.id, colore, indice);
    if (pedina) posizionaPedina(pedina, Number(giocatore.posizione || 0));

    const avatarHtml = giocatore.avatar
      ? `<img class="avatar-mini" src="${giocatore.avatar}" alt="">`
      : `<div class="avatar-mini" style="background:${colore};">${iniziale(giocatore.nome)}</div>`;

    const eAttivo = giocatore.id === turnoAttualeId;
    const countdownHtml = eAttivo ? `<span class="countdown-turno" id="countdown-turno">⏱ --s</span>` : "";

    let audioHtml = "";
    if (giocatore.id !== mioUid) {
      if (coppieAudioAttive.has(giocatore.id)) {
        audioHtml = `<span class="stato-audio attivo" title="Chiamata attiva">🎤</span>`;
      } else if (richiesteInviate.has(giocatore.id)) {
        audioHtml = `<span class="stato-audio in-attesa" title="Richiesta inviata">⏳</span>`;
      } else if (microfonoAttivo) {
        audioHtml = `<button type="button" class="btn-chiama-audio" title="Chiedi di parlare" onclick="richiediAudioCon('${String(giocatore.id).replace(/'/g, "\\'")}')">📞</button>`;
      }
    }

    const card = document.createElement("div");
    card.className = "giocatore-card" + (eAttivo ? " attivo" : "");

    const nicknameHtml = `<a href="profilo-pubblico.html?nickname=${encodeURIComponent(giocatore.nome || "")}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;flex-grow:1;">${giocatore.nome || "Giocatore"}</a>`;

    card.innerHTML =
      `${avatarHtml}` + nicknameHtml + `${audioHtml}` + `${countdownHtml}` +
      `<span class="casella-mini" id="casella-${giocatore.id}">${Number(giocatore.posizione || 0)}</span>`;

    listaPannello.appendChild(card);
  });

  if (turnoAttualeId) aggiornaCountdownTurno();
}

/* ============================================================
   VITTORIA
   ============================================================ */

function mostraVittoria(nomeVincitore) {
  suonaVittoria();
  const testo = document.getElementById("testo-vincitore");
  if (testo) testo.textContent = "🎉 Ha vinto " + (nomeVincitore || "un giocatore") + "!";
  const overlay = document.getElementById("overlay-vittoria");
  if (overlay) overlay.classList.add("aperto");
}

/* ============================================================
   MENU / USCITA
   ============================================================ */

// FIX: "Torna alla Lobby" ora avvisa il server PRIMA di navigare (come già
// faceva "Abbandona partita"), invece di affidarsi solo alla chiusura della
// connessione — così la partita terminata viene ripulita subito, senza
// lasciarti segnato "In partita" dopo che sei già tornato in lobby.
function tornaAllaLobby() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ tipo: "abbandonaPartita", partitaId }));
  }
  fermaCountdownCompleto();
  window.location.href = `lobby.html?stanza=${encodeURIComponent(stanza || "")}`;
}

function abbandonaPartita() {
  if (!confirm("Sei sicuro di voler abbandonare la partita?")) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ tipo: "abbandonaPartita", partitaId }));
  }
  fermaCountdownCompleto();
  tornaAllaLobby();
}

function apriProfilo() { chiudiMenu(); window.location.href = "profilo.html"; }
function apriImpostazioni() { chiudiMenu(); window.location.href = "opzioni-account.html"; }
function chiudiMenu() {
  const pannello = document.getElementById("pannello-menu");
  if (pannello) pannello.classList.add("nascosto");
}

const btnMenu = document.getElementById("btn-menu");
if (btnMenu) {
  btnMenu.onclick = (e) => {
    e.stopPropagation();
    const pannello = document.getElementById("pannello-menu");
    if (pannello) pannello.classList.toggle("nascosto");
  };
}
document.addEventListener("click", () => { chiudiMenu(); });

/* ============================================================
   PANNELLO GIOCATORI
   ============================================================ */

const btnGiocatori = document.getElementById("btn-giocatori");
if (btnGiocatori) {
  btnGiocatori.onclick = (e) => {
    e.stopPropagation();
    const pannello = document.getElementById("pannello-giocatori");
    const backdrop = document.getElementById("backdrop-giocatori");
    if (pannello) pannello.classList.toggle("aperto");
    if (backdrop) backdrop.classList.toggle("aperto");
  };
}
const backdropGiocatori = document.getElementById("backdrop-giocatori");
if (backdropGiocatori) {
  backdropGiocatori.onclick = () => {
    const pannello = document.getElementById("pannello-giocatori");
    const backdrop = document.getElementById("backdrop-giocatori");
    if (pannello) pannello.classList.remove("aperto");
    if (backdrop) backdrop.classList.remove("aperto");
  };
}

/* ============================================================
   CHAT PARTITA
   ============================================================ */

let messaggiChatNonLetti = 0;

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
  const nomeEl = document.createElement("b");
  nomeEl.textContent = String(nome || "Giocatore") + ":";
  const testoEl = document.createTextNode(" " + String(testo || ""));
  riga.appendChild(nomeEl);
  riga.appendChild(testoEl);

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
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ tipo: "chatPartita", partitaId, testo }));
    input.value = "";
  }
}

const chatInput = document.getElementById("chat-input");
if (chatInput) {
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inviaChatPartita(); }
  });
}

const btnChat = document.getElementById("btn-chat");
if (btnChat) {
  btnChat.onclick = (e) => {
    e.stopPropagation();
    const pannello = document.getElementById("pannello-chat");
    if (!pannello) return;
    pannello.classList.toggle("nascosto");
    if (!pannello.classList.contains("nascosto")) {
      messaggiChatNonLetti = 0;
      aggiornaBadgeChatPartita();
    }
  };
}

/* ============================================================
   CLICK SUI DADI
   ============================================================ */

const areaDadi = document.getElementById("area-dadi");
if (areaDadi) {
  areaDadi.onclick = () => {
    const possoTirare = faseAttuale === "determinazione" ? possoTirareIoInDeterminazione : mioTurno;
    if (!possoTirare) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    fermaCountdownPerAzioneLocale();
    areaDadi.classList.add("disabilitato");

    if (faseAttuale === "determinazione") {
      socket.send(JSON.stringify({ tipo: "tiraDeterminazione", partitaId }));
    } else {
      socket.send(JSON.stringify({ tipo: "tiraDadi", partitaId }));
    }
  };
}

/* ============================================================
   STATO INIZIALE
   ============================================================ */

aggiornaTestoBottoneSuoni();
aggiornaTestoBottoneFullscreen();
aggiornaTestoBottoneMicrofono();
aggiornaBadgeChatPartita();

mostraDadi(1, 1);
inizializzaGestioneLayout();
avvia();
