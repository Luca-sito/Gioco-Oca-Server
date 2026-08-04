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
let mostrataRivelazioneOrdine = false;

// ===== SUONI =====
let suoniAttivi = localStorage.getItem("suoniAttivi") !== "off";
let contestoAudio = null;
function ottieniContestoAudio() {
  if (!contestoAudio) {
    const AudioContextClasse = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClasse) return null;
    contestoAudio = new AudioContextClasse();
  }
  if (contestoAudio.state === "suspended") contestoAudio.resume();
  return contestoAudio;
}
function suonaTono(frequenza, durataMs, tipoOnda, volume, ritardoMs) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  const inizio = ctx.currentTime + (ritardoMs || 0) / 1000;
  const oscillatore = ctx.createOscillator();
  const guadagno = ctx.createGain();
  oscillatore.type = tipoOnda || "sine";
  oscillatore.frequency.setValueAtTime(frequenza, inizio);
  guadagno.gain.setValueAtTime(0, inizio);
  guadagno.gain.linearRampToValueAtTime(volume || 0.12, inizio + 0.01);
  guadagno.gain.exponentialRampToValueAtTime(0.0001, inizio + durataMs / 1000);
  oscillatore.connect(guadagno);
  guadagno.connect(ctx.destination);
  oscillatore.start(inizio);
  oscillatore.stop(inizio + durataMs / 1000 + 0.02);
}
function suonaClick(volume, ritardoMs) {
  if (!suoniAttivi) return;
  const ctx = ottieniContestoAudio();
  if (!ctx) return;
  const inizio = ctx.currentTime + (ritardoMs || 0) / 1000;
  const durata = 0.045;
  const lunghezzaBuffer = Math.floor(ctx.sampleRate * durata);
  const buffer = ctx.createBuffer(1, lunghezzaBuffer, ctx.sampleRate);
  const dati = buffer.getChannelData(0);
  for (let i = 0; i < lunghezzaBuffer; i++) dati[i] = (Math.random() * 2 - 1) * (1 - i / lunghezzaBuffer);
  const sorgente = ctx.createBufferSource();
  sorgente.buffer = buffer;
  const guadagno = ctx.createGain();
  guadagno.gain.setValueAtTime(volume || 0.18, inizio);
  guadagno.gain.exponentialRampToValueAtTime(0.001, inizio + durata);
  sorgente.connect(guadagno);
  guadagno.connect(ctx.destination);
  sorgente.start(inizio);
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
function toggleSuoni() { impostaSuoni(!suoniAttivi); }
function impostaSuoni(attivi) { suoniAttivi = attivi; localStorage.setItem("suoniAttivi", attivi ? "on" : "off"); aggiornaTestoBottoneSuoni(); }
function aggiornaTestoBottoneSuoni() { const b = document.getElementById("btn-toggle-suoni"); if (b) b.textContent = suoniAttivi ? "🔊 Suoni: On" : "🔇 Suoni: Off"; }

// ===== TUTTO SCHERMO (presente e verificato) =====
function toggleFullscreen() {
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const richiesta = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (richiesta) richiesta.call(document.documentElement);
  } else {
    const esci = document.exitFullscreen || document.webkitExitFullscreen;
    if (esci) esci.call(document);
  }
}
function aggiornaTestoBottoneFullscreen() {
  const b = document.getElementById("btn-toggle-fullscreen");
  if (!b) return;
  b.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? "🡼 Esci da tutto schermo" : "⛶ Tutto schermo";
}
document.addEventListener("fullscreenchange", aggiornaTestoBottoneFullscreen);
document.addEventListener("webkitfullscreenchange", aggiornaTestoBottoneFullscreen);

// ===== ROTAZIONE VIA JAVASCRIPT =====
function calcolaEAggiornaOrientamento() {
  const larghezza = window.innerWidth, altezza = window.innerHeight;
  document.body.classList.toggle("richiede-rotazione", altezza > larghezza && Math.min(larghezza, altezza) <= 900);
  document.documentElement.style.setProperty("--altezza-reale", (window.visualViewport ? window.visualViewport.height : altezza) + "px");
}
function rilevaEImpostaModalitaDesktop() {
  const nonTouch = !("ontouchstart" in window) && (navigator.maxTouchPoints || 0) === 0;
  const puntatorePreciso = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  document.body.classList.toggle("modalita-desktop", nonTouch && puntatorePreciso && window.innerWidth >= 1000);
}
let timerDebounceResize = null;
function gestisciResize() {
  calcolaEAggiornaOrientamento();
  rilevaEImpostaModalitaDesktop();
  clearTimeout(timerDebounceResize);
  timerDebounceResize = setTimeout(riposizionaTuttePedine, 120);
}
function inizializzaGestioneOrientamento() {
  calcolaEAggiornaOrientamento();
  rilevaEImpostaModalitaDesktop();
  window.addEventListener("resize", gestisciResize);
  window.addEventListener("orientationchange", () => {
    setTimeout(gestisciResize, 50);
    setTimeout(gestisciResize, 300);
    setTimeout(gestisciResize, 700);
  });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", gestisciResize);
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
  timerFlashMessaggio = setTimeout(() => el.classList.remove("visibile"), 1000);
}

// ===== SCHERMATA "CHI INIZIA" =====
function mostraRivelazioneOrdineTurni(giocatoriOrdinati, punteggi) {
  const overlay = document.getElementById("overlay-ordine-turni");
  const lista = document.getElementById("lista-ordine-turni");
  if (!overlay || !lista) return;
  lista.innerHTML = "";
  overlay.classList.add("aperto");
  suonaTiroDadi();
  giocatoriOrdinati.forEach((g, indice) => {
    const riga = document.createElement("div");
    riga.className = "riga-ordine-turno";
    riga.style.animationDelay = (indice * 0.15) + "s";
    const punteggio = punteggi && punteggi[g.nome] != null ? punteggi[g.nome] : "?";
    riga.innerHTML = `<div class="posizione-turno">${indice + 1}</div><div class="nome-ordine">${g.nome}</div><div class="punteggio-ordine">🎲 ${punteggio}</div>`;
    lista.appendChild(riga);
  });
  setTimeout(() => overlay.classList.remove("aperto"), 1300 + giocatoriOrdinati.length * 150 + 1300);
}

// ===== COUNTDOWN LIVE DI TURNO =====
let tempoInizioTurnoAttuale = null;
let durataMossaMsAttuale = null;
let intervalCountdown = null;
let ultimoSecondoAvviso = null;
function avviaCountdownTurno(tempoInizio, durataMs) {
  tempoInizioTurnoAttuale = tempoInizio;
  durataMossaMsAttuale = durataMs;
  ultimoSecondoAvviso = null;
  if (intervalCountdown) clearInterval(intervalCountdown);
  intervalCountdown = setInterval(aggiornaCountdownTurno, 250);
  aggiornaCountdownTurno();
}
function aggiornaCountdownTurno() {
  const elemento = document.getElementById("countdown-turno");
  if (!elemento || tempoInizioTurnoAttuale == null || durataMossaMsAttuale == null) return;
  const secondiRimanenti = Math.max(0, Math.ceil((durataMossaMsAttuale - (Date.now() - tempoInizioTurnoAttuale)) / 1000));
  elemento.textContent = "⏱ " + secondiRimanenti + "s";
  elemento.classList.toggle("countdown-scaduto", secondiRimanenti <= 0);
  if (mioTurno && secondiRimanenti <= 3 && secondiRimanenti >= 1 && secondiRimanenti !== ultimoSecondoAvviso) {
    ultimoSecondoAvviso = secondiRimanenti;
    suonaAvvisoTempo();
  }
}

// ===== NUOVO: MICROFONO IN TEMPO REALE (solo tra amici, mai forzato) =====
let microfonoAttivo = false;
let flussoAudioLocale = null;
let connessioniPeer = {};
let elementiAudioRemoti = {};
let mieiAmiciUidPerAudio = new Set();
const CONFIGURAZIONE_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function caricaAmiciPerAudio() {
  try {
    const r = await fetch("https://gioco-oca-server.onrender.com/api/amici", { credentials: "include" });
    if (!r.ok) return;
    const d = await r.json();
    mieiAmiciUidPerAudio = new Set((d.amici || []).map(a => a.uid));
  } catch (e) {}
}
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
  if (mieiAmiciUidPerAudio.size === 0) await caricaAmiciPerAudio();
  ultimoStatoGiocatori.forEach(g => { if (g.id !== mioUid && mieiAmiciUidPerAudio.has(g.id)) avviaConnessioneAudio(g.id, true); });
}
function disattivaMicrofono() {
  microfonoAttivo = false;
  if (flussoAudioLocale) { flussoAudioLocale.getTracks().forEach(t => t.stop()); flussoAudioLocale = null; }
  Object.keys(connessioniPeer).forEach(chiudiConnessioneAudio);
  aggiornaTestoBottoneMicrofono();
}
function aggiornaTestoBottoneMicrofono() {
  const b = document.getElementById("btn-toggle-microfono");
  if (b) b.textContent = microfonoAttivo ? "🎤 Microfono: On" : "🔇 Microfono: Off";
}
function creaConnessionePeer(altroUid) {
  const pc = new RTCPeerConnection(CONFIGURAZIONE_ICE);
  if (flussoAudioLocale) flussoAudioLocale.getTracks().forEach(t => pc.addTrack(t, flussoAudioLocale));
  pc.onicecandidate = (evento) => {
    if (evento.candidate) socket.send(JSON.stringify({ tipo: "webrtc-ice-candidate", partitaId, destinatarioUid: altroUid, candidate: evento.candidate }));
  };
  pc.ontrack = (evento) => {
    let elementoAudio = elementiAudioRemoti[altroUid];
    if (!elementoAudio) {
      elementoAudio = document.createElement("audio");
      elementoAudio.autoplay = true;
      elementoAudio.id = "audio-remoto-" + altroUid;
      document.body.appendChild(elementoAudio);
      elementiAudioRemoti[altroUid] = elementoAudio;
    }
    elementoAudio.srcObject = evento.streams[0];
    disegnaGiocatori(); // aggiorna l'iconcina 🎤 accanto al giocatore ora collegato
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
  const elementoAudio = elementiAudioRemoti[altroUid];
  if (elementoAudio) { elementoAudio.remove(); delete elementiAudioRemoti[altroUid]; }
}
window.addEventListener("beforeunload", () => {
  if (flussoAudioLocale) flussoAudioLocale.getTracks().forEach(t => t.stop());
  Object.keys(connessioniPeer).forEach(chiudiConnessioneAudio);
});

// ===== DADI 3D =====
const CORREZIONE_ANGOLI_DADO = { 1: { x: 0, y: 0 }, 2: { x: 0, y: -90 }, 3: { x: -90, y: 0 }, 4: { x: 90, y: 0 }, 5: { x: 0, y: 90 }, 6: { x: 0, y: 180 } };
let rotazioneAttuale = { dado1: { x: 0, y: 0 }, dado2: { x: 0, y: 0 } };
function normalizza360(gradi) { return ((gradi % 360) + 360) % 360; }
function calcolaNuovaRotazione(idDado, valore) {
  const correzione = CORREZIONE_ANGOLI_DADO[valore];
  const attuale = rotazioneAttuale[idDado];
  let deltaX = normalizza360(correzione.x) - normalizza360(attuale.x); if (deltaX < 0) deltaX += 360;
  let deltaY = normalizza360(correzione.y) - normalizza360(attuale.y); if (deltaY < 0) deltaY += 360;
  const nuova = { x: attuale.x + deltaX + (2 + Math.floor(Math.random() * 2)) * 360, y: attuale.y + deltaY + (2 + Math.floor(Math.random() * 2)) * 360 };
  rotazioneAttuale[idDado] = nuova;
  return nuova;
}
function applicaRotazioneDado(idDado, valore) {
  const rotazione = calcolaNuovaRotazione(idDado, valore);
  const cubo = document.querySelector("#" + idDado + " .cubo");
  if (cubo) cubo.style.transform = `rotateX(${rotazione.x}deg) rotateY(${rotazione.y}deg)`;
}
function mostraDadi(v1, v2) {
  const cubo1 = document.querySelector("#dado1 .cubo"), cubo2 = document.querySelector("#dado2 .cubo");
  if (cubo1) cubo1.style.transition = "none";
  if (cubo2) cubo2.style.transition = "none";
  applicaRotazioneDado("dado1", v1);
  applicaRotazioneDado("dado2", v2);
  if (cubo1) cubo1.offsetHeight;
  if (cubo1) cubo1.style.transition = "";
  if (cubo2) cubo2.style.transition = "";
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
function iniziale(nome) { return (nome || "?").trim().charAt(0).toUpperCase(); }
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
    const idGradiente = "gradPedina" + indice;
    pedina.innerHTML = `
      <svg width="26" height="38" viewBox="0 0 34 48">
        <defs><radialGradient id="${idGradiente}" cx="35%" cy="25%" r="75%">
          <stop offset="0%" stop-color="${schiarisciColore(colore, 55)}"/>
          <stop offset="55%" stop-color="${colore}"/>
          <stop offset="100%" stop-color="${scuriscColore(colore, 35)}"/>
        </radialGradient></defs>
        <ellipse cx="17" cy="44" rx="12" ry="3.5" fill="rgba(0,0,0,0.3)"/>
        <ellipse cx="17" cy="42" rx="11" ry="4" fill="${scuriscColore(colore, 25)}"/>
        <path d="M17 42 C10 42 4 40 4 37 L10 15 C10 15 12 12 17 12 C22 12 24 15 24 15 L30 37 C30 40 24 42 17 42 Z" fill="url(#${idGradiente})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
        <circle cx="17" cy="9" r="7.5" fill="url(#${idGradiente})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
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
    const etichettaCasella = document.getElementById("casella-" + idGiocatore);
    if (etichettaCasella) etichettaCasella.textContent = casella;
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
    if (!timerRiconnessione) timerR
