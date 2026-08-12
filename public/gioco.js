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
const DURATA_SALTO_MS = 380;

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita");
const stanza = params.get("stanza");
let mioUid = null;

let socket;
let ultimoStatoGiocatori = [];
let mioTurno = false;
let turnoAttualeId = null;
let timerRiconnessione = null;

let faseAttuale = "normale";
let possoTirareIoInDeterminazione = false;

function iniziale(nome) { return (nome || "?").trim().charAt(0).toUpperCase(); }
function coloreDaNome(nome) {
  const colori = ["#6a2c70", "#1e40af", "#43a047", "#f57c00", "#c0ca33", "#e53935", "#00838f", "#8d6e63"];
  let somma = 0;
  for (let i = 0; i < (nome || "?").length; i++) somma += nome.charCodeAt(i);
  return colori[somma % colori.length];
}

// ===== SUONI =====
let suoniAttivi = localStorage.getItem("suoniAttivi") !== "off";
let contestoAudio = null;
function ottieniContestoAudio() {
  if (!contestoAudio) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    contestoAudio = new C();
  }
  if (contestoAudio.state === "suspended") contestoAudio.resume();
  return contestoAudio;
}
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
function impostaSuoni(attivi) { suoniAttivi = attivi; localStorage.setItem("suoniAttivi", attivi ? "on" : "off"); aggiornaTestoBottoneSuoni(); }
function aggiornaTestoBottoneSuoni() { const b = document.getElementById("btn-toggle-suoni"); if (b) b.textContent = suoniAttivi ? "🔊 Suoni: On" : "🔇 Suoni: Off"; }

// ===== TUTTO SCHERMO — ora avvolto in try/catch e con più prefissi per browser
// diversi; la visibilità del bottone dipende da rilevaEImpostaModalitaDesktop qui sotto =====
function toggleFullscreen() {
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const elemento = document.documentElement;
      const richiesta = elemento.requestFullscreen || elemento.webkitRequestFullscreen || elemento.mozRequestFullScreen || elemento.msRequestFullscreen;
      if (!richiesta) { alert("Il tuo browser non supporta lo schermo intero."); return; }
      const risultato = richiesta.call(elemento);
      if (risultato && typeof risultato.catch === "function") {
        risultato.catch((err) => { alert("Non è stato possibile attivare lo schermo intero" + (err && err.message ? (": " + err.message) : ".")); });
      }
    } else {
      const esci = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (esci) esci.call(document);
    }
  } catch (err) {
    alert("Errore durante l'attivazione dello schermo intero" + (err && err.message ? (": " + err.message) : "."));
  }
}
function aggiornaTestoBottoneFullscreen() {
  const b = document.getElementById("btn-toggle-fullscreen");
  if (!b) return;
  b.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? "🡼 Esci da tutto schermo" : "⛶ Tutto schermo";
}
document.addEventListener("fullscreenchange", aggiornaTestoBottoneFullscreen);
document.addEventListener("webkitfullscreenchange", aggiornaTestoBottoneFullscreen);

// ===== ORIENTAMENTO: confronto diretto larghezza/altezza (NON matchMedia
// sull'orientation, che su alcuni browser — Samsung Internet incluso — può
// comportarsi in modo incoerente). Niente rotazione grafica: in verticale il
// gioco è bloccato da un overlay; in orizzontale il tabellone si dimensiona per
// riempire lo spazio reale disponibile. =====
function eSchermoInLandscape() {
  const larghezza = window.visualViewport ? window.visualViewport.width : window.innerWidth;
  const altezza = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  return larghezza > altezza;
}
function calcolaEAggiornaOrientamento() {
  const eDesktop = document.body.classList.contains("modalita-desktop");
  document.body.classList.toggle("richiede-rotazione", !eDesktop && !eSchermoInLandscape());

  const altezzaReale = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--altezza-reale", altezzaReale + "px");
}
// Non richiede più "niente touch": molti Computer hanno schermo touch ma si usano
// comunque col mouse — basta un puntatore preciso disponibile più uno schermo largo
function rilevaEImpostaModalitaDesktop() {
  const puntatorePreciso = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  const schermoAmpio = window.innerWidth >= 1000;
  document.body.classList.toggle("modalita-desktop", puntatorePreciso && schermoAmpio);
}

function aggiornaLayoutTabellone() {
  const areaTabellone = document.getElementById("area-tabellone");
  const immagine = document.getElementById("immagine-tabellone");
  if (!areaTabellone || !immagine) return;

  const rapportoNaturale = (immagine.naturalWidth && immagine.naturalHeight) ? immagine.naturalWidth / immagine.naturalHeight : 1.48;

  const eDesktop = document.body.classList.contains("modalita-desktop");
  const larghezzaFinestra = window.innerWidth;
  const altezzaReale = window.visualViewport ? window.visualViewport.height : window.innerHeight;

  const margineOrizzontale = Math.max(16, larghezzaFinestra * 0.03);
  const margineVerticale = eDesktop ? Math.max(16, altezzaReale * 0.03) : Math.max(56, altezzaReale * 0.11);

  const larghezzaDisponibile = larghezzaFinestra - margineOrizzontale * 2;
  const altezzaDisponibile = altezzaReale - margineVerticale * 2;

  const Wc = Math.max(120, Math.min(larghezzaDisponibile, altezzaDisponibile * rapportoNaturale));
  const Hc = Wc / rapportoNaturale;

  areaTabellone.style.width = Wc + "px";
  areaTabellone.style.height = Hc + "px";

  riposizionaTuttePedine();
}

let timerDebounceResize = null;
function gestisciResize() {
  calcolaEAggiornaOrientamento();
  rilevaEImpostaModalitaDesktop();
  clearTimeout(timerDebounceResize);
  timerDebounceResize = setTimeout(aggiornaLayoutTabellone, 60);
}
function inizializzaGestioneOrientamento() {
  calcolaEAggiornaOrientamento();
  rilevaEImpostaModalitaDesktop();
  aggiornaLayoutTabellone();

  window.addEventListener("resize", gestisciResize);
  window.addEventListener("orientationchange", () => {
    setTimeout(gestisciResize, 50);
    setTimeout(gestisciResize, 300);
    setTimeout(gestisciResize, 700);
  });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", gestisciResize);
  // Ridondanza per dispositivi dove orientationchange/resize non bastano da soli
  if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
    window.screen.orientation.addEventListener("change", () => { setTimeout(gestisciResize, 50); setTimeout(gestisciResize, 300); });
  }

  if (immagine_pronta()) aggiornaLayoutTabellone();
  else document.getElementById("immagine-tabellone").addEventListener("load", aggiornaLayoutTabellone);
}
function immagine_pronta() {
  const immagine = document.getElementById("immagine-tabellone");
  return immagine && immagine.complete && immagine.naturalWidth;
}
function riposizionaTuttePedine() {
  ultimoStatoGiocatori.forEach(g => { const p = document.getElementById("pedina-" + g.id); if (p) posizionaPedina(p, g.posizione); });
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

// Ora restituisce true SOLO se lo spostamento avviene davvero in questo momento
// (cioè al primo ingresso nel popup) — serve a chiamare mostraDadi(1,1) una volta
// sola, mai più dopo: era quello a interrompere l'animazione di ogni tiro successivo.
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

function disegnaListaDeterminazione(giocatori, turnoInCorsoUid, gruppoSpareggio) {
  const lista = document.getElementById("lista-determinazione");
  if (!lista) return;
  const spareggioSet = new Set(gruppoSpareggio || []);
  lista.innerHTML = giocatori.map(g => {
    const avatarHtml = g.avatar ? `<img class="avatar-mini" src="${g.avatar}">` : `<div class="avatar-mini" style="background:${coloreDaNome(g.nome)};">${iniziale(g.nome)}</div>`;
    let statoHtml;
    if (g.risultato != null) statoHtml = `<span class="determinazione-risultato">🎲 ${g.risultato}</span>`;
    else if (g.uid === turnoInCorsoUid) statoHtml = `<span class="determinazione-in-corso">🎲 sta tirando...</span>`;
    else statoHtml = `<span class="determinazione-attesa">in attesa</span>`;
    const tagSpareggio = spareggioSet.has(g.uid) ? `<span class="determinazione-tag-spareggio" title="In spareggio">⚔️</span>` : "";
    const evidenzia = g.uid === turnoInCorsoUid ? " determinazione-riga-attiva" : "";
    return `<div class="determinazione-riga${evidenzia}">${avatarHtml}<span class="determinazione-nome">${g.nome}</span>${tagSpareggio}${statoHtml}</div>`;
  }).join("");
}

function gestisciStatoDeterminazione(dati) {
  faseAttuale = "determinazione";
  document.getElementById("overlay-determinazione").classList.add("aperto");
  const appenaEntrato = spostaDadiInDeterminazione();
  if (appenaEntrato) mostraDadi(1, 1);

  disegnaListaDeterminazione(dati.giocatori, dati.turnoInCorsoUid, dati.gruppoSpareggioAttuale);

  possoTirareIoInDeterminazione = dati.turnoInCorsoUid === mioUid;
  document.getElementById("area-dadi").classList.toggle("disabilitato", !possoTirareIoInDeterminazione);

  const sottotitolo = document.getElementById("sottotitolo-determinazione");
  if (dati.gruppoSpareggioAttuale && dati.gruppoSpareggioAttuale.length) {
    const nomiSpareggio = dati.gruppoSpareggioAttuale.map(u => { const g = dati.giocatori.find(x => x.uid === u); return g ? g.nome : "?"; }).join(", ");
    sottotitolo.textContent = "⚔️ Pareggio tra " + nomiSpareggio + " — nuovo tiro per decidere l'ordine tra loro!";
  } else if (possoTirareIoInDeterminazione) {
    sottotitolo.textContent = "Tocca a te: tira i dadi!";
  } else {
    const inAttesaDi = dati.giocatori.find(g => g.uid === dati.turnoInCorsoUid);
    sottotitolo.textContent = inAttesaDi ? ("In attesa che " + inAttesaDi.nome + " tiri...") : "I giocatori tirano i dadi uno alla volta.";
  }

  if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
  else if (appenaEntrato) mostraDadi(1, 1);
}

function gestisciRisultatoDeterminazione(dati) {
  animaLancioDadi(dati.dado1, dati.dado2, () => {
    const sottotitolo = document.getElementById("sottotitolo-determinazione");
    if (sottotitolo) sottotitolo.textContent = dati.nome + " ha fatto " + dati.valoreDado + (dati.automatico ? " (tempo scaduto)" : "") + "!";
  });
}

// NUOVO: quando tutti hanno tirato, il server manda prima questo — la classifica
// finale calcolata, mostrata per un paio di secondi PRIMA che il tabellone si apra
// — così il calcolo "dal più alto al più basso" si vede accadere, non sembra un
// salto improvviso su chi ha tirato per ultimo.
function gestisciOrdineFinaleCalcolato(dati) {
  const sottotitolo = document.getElementById("sottotitolo-determinazione");
  if (sottotitolo) sottotitolo.textContent = "Ordine deciso! La partita inizia tra un istante...";
  const lista = document.getElementById("lista-determinazione");
  if (!lista) return;
  lista.innerHTML = dati.ordineGiocatori.map((nome, indice) => {
    const punteggio = dati.punteggi && dati.punteggi[nome] != null ? dati.punteggi[nome] : "?";
    return `<div class="determinazione-riga determinazione-riga-finale" style="animation-delay:${indice * 0.12}s;">
      <span class="determinazione-posizione-finale">${indice + 1}°</span>
      <span class="determinazione-nome">${nome}</span>
      <span class="determinazione-risultato">🎲 ${punteggio}</span>
    </div>`;
  }).join("");
}

function gestisciDeterminazioneCompletata(dati) {
  faseAttuale = "normale";
  document.getElementById("overlay-determinazione").classList.remove("aperto");
  riportaDadiAllaPartita();

  ultimoStatoGiocatori = dati.giocatori;

  document.getElementById("messaggi-gioco").textContent =
    "🎲 " + dati.primoMovimento.nomeGiocatore + " ha fatto " + dati.primoMovimento.valoreDado + " — avanza di " + dati.primoMovimento.valoreDado + " caselle!";

  animaSaltoPedina(dati.primoMovimento.idGiocatore, dati.primoMovimento.percorso, () => {
    if (dati.primoMovimento.messaggi && dati.primoMovimento.messaggi.length) mostraMessaggioGiocoGrande(dati.primoMovimento.messaggi.join(" "));
    if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);

    if (dati.vittoria) {
      turnoAttualeId = null;
      document.getElementById("area-dadi").classList.add("disabilitato");
      disegnaGiocatori();
      mostraVittoria(dati.vincitore);
    } else {
      aggiornaTurno(dati.turnoDiId);
      disegnaGiocatori();
    }
  });
}

// ===== COUNTDOWN DI TURNO — ora al click l'interval viene DAVVERO fermato (non solo
// un flag che ne blocca l'output), e il numero è sostituito da un ✓ inequivocabile =====
let tempoInizioTurnoAttuale = null, durataMossaMsAttuale = null, intervalCountdown = null, ultimoSecondoAvviso = null;
let turnoLocalmenteCompletato = false;

function avviaCountdownTurno(tempoInizio, durataMs) {
  tempoInizioTurnoAttuale = tempoInizio;
  durataMossaMsAttuale = durataMs;
  ultimoSecondoAvviso = null;
  turnoLocalmenteCompletato = false;
  if (intervalCountdown) clearInterval(intervalCountdown);
  intervalCountdown = setInterval(aggiornaCountdownTurno, 250);
  aggiornaCountdownTurno();
}
function fermaCountdownPerAzioneLocale() {
  turnoLocalmenteCompletato = true;
  if (intervalCountdown) { clearInterval(intervalCountdown); intervalCountdown = null; }
  const el = document.getElementById("countdown-turno");
  if (el) {
    el.textContent = "✓";
    el.classList.remove("countdown-scaduto");
    el.classList.add("countdown-fermo");
  }
}
function aggiornaCountdownTurno() {
  const el = document.getElementById("countdown-turno");
  if (!el || tempoInizioTurnoAttuale == null || durataMossaMsAttuale == null) return;
  if (turnoLocalmenteCompletato) return;
  const sec = Math.max(0, Math.ceil((durataMossaMsAttuale - (Date.now() - tempoInizioTurnoAttuale)) / 1000));
  el.textContent = "⏱ " + sec + "s";
  el.classList.toggle("countdown-scaduto", sec <= 0);
  if (sec <= 3 && sec >= 1 && sec !== ultimoSecondoAvviso) { ultimoSecondoAvviso = sec; suonaAvvisoTempo(); }
}

// ===== MICROFONO: consenso reciproco per coppia, aperto a chiunque nella partita =====
let microfonoAttivo = false;
let flussoAudioLocale = null;
let connessioniPeer = {};
let elementiAudioRemoti = {};
let uidRichiestaAudioInAttesa = null;
let richiesteInviate = new Set();
let coppieAudioAttive = new Set();
const CONFIGURAZIONE_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function toggleMicrofono() { if (microfonoAttivo) disattivaMicrofono(); else await attivaMicrofono(); }
async function attivaMicrofono() {
  try {
    flussoAudioLocale = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    alert("Non è stato possibile accedere al microfono. Controlla i permessi del browser.");
    return;
  }
  microfonoAttivo = true;
  aggiornaTestoBottoneMicrofono();
  disegnaGiocatori();
}
function disattivaMicrofono() {
  microfonoAttivo = false;
  if (flussoAudioLocale) { flussoAudioLocale.getTracks().forEach(t => t.stop()); flussoAudioLocale = null; }
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
  if (!microfonoAttivo) { alert("Attiva prima il tuo microfono dal menu ☰."); return; }
  if (richiesteInviate.has(altroUid) || coppieAudioAttive.has(altroUid)) return;
  richiesteInviate.add(altroUid);
  socket.send(JSON.stringify({ tipo: "richiestaAudio", partitaId, destinatarioUid: altroUid }));
  disegnaGiocatori();
}
function mostraRichiestaAudioRicevuta(mittenteUid, mittenteNome) {
  uidRichiestaAudioInAttesa = mittenteUid;
  suonaRichiestaAudio();
  document.getElementById("testo-richiesta-audio").textContent = mittenteNome + " ti sta chiedendo di parlare in chiamata audio";
  document.getElementById("popup-richiesta-audio").classList.remove("nascosto");
}
async function rispondiRichiestaAudioRicevuta(accettato) {
  const mittenteUid = uidRichiestaAudioInAttesa;
  document.getElementById("popup-richiesta-audio").classList.add("nascosto");
  uidRichiestaAudioInAttesa = null;
  if (!mittenteUid) return;

  if (accettato && !microfonoAttivo) {
    await attivaMicrofono();
    if (!microfonoAttivo) { socket.send(JSON.stringify({ tipo: "rispostaAudio", partitaId, destinatarioUid: mittenteUid, accettato: false })); return; }
  }
  socket.send(JSON.stringify({ tipo: "rispostaAudio", partitaId, destinatarioUid: mittenteUid, accettato }));
  if (accettato) { coppieAudioAttive.add(mittenteUid); disegnaGiocatori(); }
}
function creaConnessionePeer(altroUid) {
  const pc = new RTCPeerConnection(CONFIGURAZIONE_ICE);
  if (flussoAudioLocale) flussoAudioLocale.getTracks().forEach(t => pc.addTrack(t, flussoAudioLocale));
  pc.onicecandidate = (ev) => { if (ev.candidate) socket.send(JSON.stringify({ tipo: "webrtc-ice-candidate", partitaId, destinatarioUid: altroUid, candidate: ev.candidate })); };
  pc.ontrack = (ev) => {
    let elAudio = elementiAudioRemoti[altroUid];
    if (!elAudio) {
      elAudio = document.createElement("audio");
      elAudio.autoplay = true;
      elAudio.id = "audio-remoto-" + altroUid;
      document.body.appendChild(elAudio);
      elementiAudioRemoti[altroUid] = elAudio;
    }
    elAudio.srcObject = ev.streams[0];
  };
  connessioniPeer[altroUid] = pc;
  return pc;
}
async function avviaConnessioneAudio(altroUid, sonoIoAdIniziare) {
  if (connessioniPeer[altroUid]) return;
  const pc = creaConnessionePeer(altroUid);
  if (sonoIoAdIniziare) {
    const offerta = await pc.createOffer();
    await pc.setLocalDescription(offerta);
    socket.send(JSON.stringify({ tipo: "webrtc-offer", partitaId, destinatarioUid: altroUid, sdp: offerta }));
  }
}
async function gestisciOffertaRicevuta(mittenteUid, sdp) {
  if (!microfonoAttivo) return;
  const pc = connessioniPeer[mittenteUid] || creaConnessionePeer(mittenteUid);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const risposta = await pc.createAnswer();
  await pc.setLocalDescription(risposta);
  socket.send(JSON.stringify({ tipo: "webrtc-answer", partitaId, destinatarioUid: mittenteUid, sdp: risposta }));
}
async function gestisciRispostaRicevuta(mittenteUid, sdp) {
  const pc = connessioniPeer[mittenteUid];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}
async function gestisciCandidatoRicevuto(mittenteUid, candidate) {
  const pc = connessioniPeer[mittenteUid];
  if (!pc || !candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
}
function chiudiConnessioneAudio(altroUid) {
  const pc = connessioniPeer[altroUid];
  if (pc) { pc.close(); delete connessioniPeer[altroUid]; }
  const elAudio = elementiAudioRemoti[altroUid];
  if (elAudio) { elAudio.remove(); delete elementiAudioRemoti[altroUid]; }
  coppieAudioAttive.delete(altroUid);
}
window.addEventListener("beforeunload", () => {
  if (flussoAudioLocale) flussoAudioLocale.getTracks().forEach(t => t.stop());
  Object.keys(connessioniPeer).forEach(chiudiConnessioneAudio);
});

// ===== DADI 3D =====
const CORREZIONE_ANGOLI_DADO = { 1: { x: 0, y: 0 }, 2: { x: 0, y: -90 }, 3: { x: -90, y: 0 }, 4: { x: 90, y: 0 }, 5: { x: 0, y: 90 }, 6: { x: 0, y: 180 } };
let rotazioneAttuale = { dado1: { x: 0, y: 0 }, dado2: { x: 0, y: 0 } };
function normalizza360(g) { return ((g % 360) + 360) % 360; }
function calcolaNuovaRotazione(idDado, valore) {
  const c = CORREZIONE_ANGOLI_DADO[valore];
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
function mostraDadi(v1, v2) {
  const c1 = document.querySelector("#dado1 .cubo"), c2 = document.querySelector("#dado2 .cubo");
  if (c1) c1.style.transition = "none";
  if (c2) c2.style.transition = "none";
  applicaRotazioneDado("dado1", v1);
  applicaRotazioneDado("dado2", v2);
  if (c1) c1.offsetHeight;
  if (c1) c1.style.transition = "";
  if (c2) c2.style.transition = "";
}
function animaLancioDadi(vf1, vf2, callback) {
  suonaTiroDadi();
  applicaRotazioneDado("dado1", vf1);
  applicaRotazioneDado("dado2", vf2);
  setTimeout(() => { suonaAtterraggioDadi(); if (callback) callback(); }, 1080);
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
      </svg>`;
    document.getElementById("contenitore-pedine").appendChild(pedina);
  }
  return pedina;
}
function animaSaltoPedina(idGiocatore, percorso, callback) {
  if (!percorso || percorso.length === 0) { if (callback) callback(); return; }
  const indice = ultimoStatoGiocatori.findIndex(g => g.id === idGiocatore);
  const colore = coloriGiocatori[(indice >= 0 ? indice : 0) % coloriGiocatori.length];
  const pedina = ottieniOCreaPedina(idGiocatore, colore, indice >= 0 ? indice : 0);
  let passo = 0;
  function saltaProssimo() {
    if (passo >= percorso.length) { if (callback) callback(); return; }
    const casella = percorso[passo];
    pedina.classList.add("pedina-salta");
    posizionaPedina(pedina, casella);
    suonaPassoPedina();
    const et = document.getElementById("casella-" + idGiocatore);
    if (et) et.textContent = casella;
    setTimeout(() => pedina.classList.remove("pedina-salta"), DURATA_SALTO_MS * 0.6);
    passo++;
    setTimeout(saltaProssimo, DURATA_SALTO_MS);
  }
  saltaProssimo();
}

async function avvia() {
  try {
    const risposta = await fetch("https://gioco-oca-server.onrender.com/api/me", { credentials: "include" });
    if (!risposta.ok) { window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href); return; }
    mioUid = (await risposta.json()).uid;
    connetti();
  } catch (e) {
    window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
  }
}

function connetti() {
  socket = new WebSocket("wss://gioco-oca-server.onrender.com");
  socket.onopen = () => {
    if (timerRiconnessione) { clearTimeout(timerRiconnessione); timerRiconnessione = null; }
    socket.send(JSON.stringify({ tipo: "riprendiPartita", partitaId }));
  };
  socket.onclose = () => {
    document.getElementById("riga-turno").textContent = "🔴 Disconnesso, riconnessione...";
    if (!timerRiconnessione) timerRiconnessione = setTimeout(() => { timerRiconnessione = null; connetti(); }, 3000);
  };
  socket.onmessage = (msg) => {
    const dati = JSON.parse(msg.data);

    if (dati.tipo === "sessioneScaduta") { window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href); return; }

    if (dati.tipo === "statoDeterminazione") { gestisciStatoDeterminazione(dati); return; }
    if (dati.tipo === "risultatoDeterminazione") { gestisciRisultatoDeterminazione(dati); return; }
    if (dati.tipo === "ordineFinaleCalcolato") { gestisciOrdineFinaleCalcolato(dati); return; }
    if (dati.tipo === "determinazioneCompletata") { gestisciDeterminazioneCompletata(dati); return; }

    if (dati.tipo === "richiestaAudioRicevuta") { mostraRichiestaAudioRicevuta(dati.mittenteUid, dati.mittenteNome); return; }
    if (dati.tipo === "rispostaAudioRicevuta") {
      richiesteInviate.delete(dati.mittenteUid);
      if (dati.accettato) { coppieAudioAttive.add(dati.mittenteUid); disegnaGiocatori(); avviaConnessioneAudio(dati.mittenteUid, true); }
      else { disegnaGiocatori(); }
      return;
    }
    if (dati.tipo === "webrtc-offer") { gestisciOffertaRicevuta(dati.mittenteUid, dati.sdp); return; }
    if (dati.tipo === "webrtc-answer") { gestisciRispostaRicevuta(dati.mittenteUid, dati.sdp); return; }
    if (dati.tipo === "webrtc-ice-candidate") { gestisciCandidatoRicevuto(dati.mittenteUid, dati.candidate); return; }

    if (dati.tipo === "statoPartita") {
      faseAttuale = "normale";
      ultimoStatoGiocatori = dati.giocatori;
      const chatWrapper = document.getElementById("chat-wrapper");
      if (chatWrapper) chatWrapper.style.display = dati.chatAttiva === false ? "none" : "";

      if (dati.vittoria) {
        turnoAttualeId = null;
        document.getElementById("area-dadi").classList.add("disabilitato");
        disegnaGiocatori();
        mostraVittoria(dati.vincitore);
      } else {
        aggiornaTurno(dati.turnoDiId);
        disegnaGiocatori();
      }
      if (dati.messaggi && dati.messaggi.length) mostraMessaggioGiocoGrande(dati.messaggi.join(" "));
      if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
      mostraDadi(1, 1);
      return;
    }

    if (dati.tipo === "aggiornamentoPartita") {
      animaLancioDadi(dati.dado1, dati.dado2, () => {
        const completa = () => {
          ultimoStatoGiocatori = dati.giocatori;
          document.getElementById("messaggi-gioco").textContent = "🎲 " + dati.dado1 + " + " + dati.dado2 + " = " + dati.valoreDado;
          if (dati.messaggi && dati.messaggi.length) mostraMessaggioGiocoGrande(dati.messaggi.join(" "));
          if (dati.tempoInizioTurno != null && dati.durataMossaMs != null) avviaCountdownTurno(dati.tempoInizioTurno, dati.durataMossaMs);
          if (dati.vittoria) {
            turnoAttualeId = null;
            document.getElementById("area-dadi").classList.add("disabilitato");
            disegnaGiocatori();
            mostraVittoria(dati.vincitore);
          } else {
            aggiornaTurno(dati.turnoDiId);
            disegnaGiocatori();
          }
        };
        if (dati.percorso && dati.idGiocatoreCheHaTirato) animaSaltoPedina(dati.idGiocatoreCheHaTirato, dati.percorso, completa);
        else completa();
      });
      return;
    }

    if (dati.tipo === "chatPartita") { aggiungiMessaggioChatPartita(dati.nome, dati.testo); return; }
    if (dati.tipo === "errore") {
      alert(dati.messaggio);
      if (mioTurno || possoTirareIoInDeterminazione) {
        document.getElementById("area-dadi").classList.remove("disabilitato");
        if (tempoInizioTurnoAttuale != null && durataMossaMsAttuale != null) avviaCountdownTurno(tempoInizioTurnoAttuale, durataMossaMsAttuale);
      }
      return;
    }
  };
}

function aggiornaTurno(turnoDiId) {
  const eraIlMioTurno = mioTurno;
  turnoAttualeId = turnoDiId;
  mioTurno = (turnoDiId === mioUid);
  if (mioTurno && !eraIlMioTurno) suonaTuoTurno();
  document.getElementById("riga-turno").textContent = mioTurno ? "🎲 È il tuo turno!" : "⏳ In attesa...";
  document.getElementById("area-dadi").classList.toggle("disabilitato", !mioTurno);
}

function disegnaGiocatori() {
  const contenitore = document.getElementById("contenitore-pedine");
  Array.from(contenitore.children).forEach(p => { if (!ultimoStatoGiocatori.some(g => "pedina-" + g.id === p.id)) p.remove(); });

  const listaPannello = document.getElementById("lista-giocatori");
  listaPannello.innerHTML = "";
  ultimoStatoGiocatori.forEach((giocatore, indice) => {
    const colore = coloriGiocatori[indice % coloriGiocatori.length];
    const pedina = ottieniOCreaPedina(giocatore.id, colore, indice);
    posizionaPedina(pedina, giocatore.posizione);
    const avatarHtml = giocatore.avatar
      ? `<img class="avatar-mini" src="${giocatore.avatar}">`
      : `<div class="avatar-mini" style="background:${colore};">${iniziale(giocatore.nome)}</div>`;

    const eAttivo = giocatore.id === turnoAttualeId;
    const countdownHtml = eAttivo ? `<span class="countdown-turno" id="countdown-turno">⏱ --s</span>` : "";

    let audioHtml = "";
    if (giocatore.id !== mioUid) {
      if (coppieAudioAttive.has(giocatore.id)) audioHtml = `<span class="stato-audio attivo" title="Chiamata attiva">🎤</span>`;
      else if (richiesteInviate.has(giocatore.id)) audioHtml = `<span class="stato-audio in-attesa" title="Richiesta inviata">⏳</span>`;
      else if (microfonoAttivo) audioHtml = `<button class="btn-chiama-audio" title="Chiedi di parlare" onclick="richiediAudioCon('${giocatore.id}')">📞</button>`;
    }

    const card = document.createElement("div");
    card.className = "giocatore-card" + (eAttivo ? " attivo" : "");
    card.innerHTML = `${avatarHtml}<a href="profilo-pubblico.html?nickname=${encodeURIComponent(giocatore.nome)}" target="_blank" style="color:inherit;text-decoration:none;flex-grow:1;">${giocatore.nome}</a>${audioHtml}${countdownHtml}<span class="casella-mini" id="casella-${giocatore.id}">${giocatore.posizione}</span>`;
    listaPannello.appendChild(card);
  });
}

function mostraVittoria(nomeVincitore) {
  suonaVittoria();
  document.getElementById("testo-vincitore").textContent = "🎉 Ha vinto " + nomeVincitore + "!";
  document.getElementById("overlay-vittoria").classList.add("aperto");
}
function tornaAllaLobby() { window.location.href = `lobby.html?stanza=${stanza}`; }
function abbandonaPartita() {
  if (!confirm("Sei sicuro di voler abbandonare la partita?")) return;
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ tipo: "abbandonaPartita", partitaId }));
  tornaAllaLobby();
}
function apriProfilo() { chiudiMenu(); window.location.href = "profilo.html"; }
function apriImpostazioni() { chiudiMenu(); window.location.href = "opzioni-account.html"; }
function chiudiMenu() { document.getElementById("pannello-menu").classList.add("nascosto"); }
document.getElementById("btn-menu").onclick = (e) => { e.stopPropagation(); document.getElementById("pannello-menu").classList.toggle("nascosto"); };
document.addEventListener("click", () => chiudiMenu());

document.getElementById("btn-giocatori").onclick = (e) => {
  e.stopPropagation();
  document.getElementById("pannello-giocatori").classList.toggle("aperto");
  document.getElementById("backdrop-giocatori").classList.toggle("aperto");
};
document.getElementById("backdrop-giocatori").onclick = () => {
  document.getElementById("pannello-giocatori").classList.remove("aperto");
  document.getElementById("backdrop-giocatori").classList.remove("aperto");
};

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
  riga.innerHTML = `<b>${nome}:</b> ${testo}`;
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
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ tipo: "chatPartita", partitaId, testo }));
  input.value = "";
}
document.getElementById("chat-input").addEventListener("keypress", (e) => { if (e.key === "Enter") inviaChatPartita(); });
document.getElementById("btn-chat").onclick = (e) => {
  e.stopPropagation();
  const pannello = document.getElementById("pannello-chat");
  pannello.classList.toggle("nascosto");
  if (!pannello.classList.contains("nascosto")) { messaggiChatNonLetti = 0; aggiornaBadgeChatPartita(); }
};

// Click sui dadi: unico gestore per entrambe le fasi. Ferma DAVVERO il countdown
// (interval incluso) nell'istante del click, non solo un flag — fix del bug 3.
document.getElementById("area-dadi").onclick = () => {
  const possoTirare = faseAttuale === "determinazione" ? possoTirareIoInDeterminazione : mioTurno;
  if (!possoTirare) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  fermaCountdownPerAzioneLocale();
  document.getElementById("area-dadi").classList.add("disabilitato");
  if (faseAttuale === "determinazione") socket.send(JSON.stringify({ tipo: "tiraDeterminazione", partitaId }));
  else socket.send(JSON.stringify({ tipo: "tiraDadi", partitaId }));
};

aggiornaTestoBottoneSuoni();
aggiornaTestoBottoneMicrofono();
mostraDadi(1, 1);
inizializzaGestioneOrientamento();
avvia();
