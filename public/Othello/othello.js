"use strict";

/* =========================================================
   OTHELLO / REVERSI
   Client:
   - il server resta autorità dello stato ufficiale
   - il client calcola le mosse legali localmente
   - gli snapshot vecchi non possono sovrascrivere quelli nuovi
   - una sola animazione può essere attiva alla volta
   - le riconnessioni invalidano le operazioni asincrone precedenti
   ========================================================= */

/* =========================================================
   CONFIGURAZIONE
   ========================================================= */

const origineConfigurata =
  typeof window.GIOCO_SERVER_URL === "string"
    ? window.GIOCO_SERVER_URL.trim()
    : "";

const hostLocale =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "[::1]";

const paginaSulServerUfficiale =
  window.location.hostname === "api.giochisocieta.com";

const ORIGINE_SERVER = (
  origineConfigurata ||
  ((hostLocale || paginaSulServerUfficiale)
    ? window.location.origin
    : "https://api.giochisocieta.com")
).replace(/\/$/, "");

const URL_WEBSOCKET = ORIGINE_SERVER
  .replace(/^http:/, "ws:")
  .replace(/^https:/, "wss:");

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita") || params.get("id") || "";
const stanza = params.get("stanza") || "othello";
const CHIAVE_TOKEN_AUTH = "giochiSocietaAuthToken";

/* =========================================================
   VARIABILI GLOBALI
   ========================================================= */

let socket = null;
let timerRiconnessione = null;
let paginaInChiusura = false;
let generazioneSocket = 0;

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

/* =========================================================
   STATO
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

let ultimoStatoRicevuto = copiaStato(stato);
let attesaSnapshot = true;

/* =========================================================
   UTILITÀ STATO
   ========================================================= */

function copiaTavola(tavola) {
  return tavola.map(riga => riga.slice());
}

function copiaStato(s) {
  return {
    ...s,
    tavola: tavolaValida(s?.tavola)
      ? copiaTavola(s.tavola)
      : tavolaInizialeOthello(),
    giocatori: s?.giocatori && typeof s.giocatori === "object"
      ? { ...s.giocatori }
      : {}
  };
}

function numeroMossaValido(valore) {
  const n = Number(valore);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function tavolaValida(tavola) {
  return Array.isArray(tavola) &&
    tavola.length === 8 &&
    tavola.every(riga =>
      Array.isArray(riga) &&
      riga.length === 8 &&
      riga.every(cella =>
        cella === null ||
        cella === "nero" ||
        cella === "bianco"
      )
    );
}

function statoBaseValido(partita) {
  if (!partita || typeof partita !== "object") return false;

  if (!tavolaValida(partita.tavola)) return false;

  if (
    partita.turno !== "nero" &&
    partita.turno !== "bianco"
  ) {
    return false;
  }

  const fasi = [
    "attesa_giocatori",
    "in_corso",
    "terminata"
  ];

  if (partita.fase && !fasi.includes(partita.fase)) {
    return false;
  }

  return true;
}

function statoObsoleto(prossimo, precedente) {
  const nuovo = numeroMossaValido(prossimo.numeroMossa);
  const vecchio = numeroMossaValido(precedente.numeroMossa);

  if (nuovo === null || vecchio === null) return false;

  return nuovo < vecchio;
}

function stessoSnapshot(a, b) {
  const na = numeroMossaValido(a?.numeroMossa);
  const nb = numeroMossaValido(b?.numeroMossa);

  if (na !== null && nb !== null && na !== nb) {
    return false;
  }

  return JSON.stringify(a?.tavola) === JSON.stringify(b?.tavola) &&
    a?.turno === b?.turno &&
    a?.fase === b?.fase;
}

/* =========================================================
   REGOLE OTHELLO
   ========================================================= */

function catturePerCella(tavola, r, c, colore) {
  if (
    !tavolaValida(tavola) ||
    !colore ||
    !tavola[r] ||
    tavola[r][c]
  ) {
    return [];
  }

  const avversario =
    colore === "nero" ? "bianco" : "nero";

  const totali = [];

  for (const [dr, dc] of DIREZIONI_OTHELLO) {
    let rr = r + dr;
    let cc = c + dc;

    const linea = [];

    while (
      rr >= 0 &&
      rr < 8 &&
      cc >= 0 &&
      cc < 8 &&
      tavola[rr][cc] === avversario
    ) {
      linea.push({ r: rr, c: cc });
      rr += dr;
      cc += dc;
    }

    if (
      linea.length > 0 &&
      rr >= 0 &&
      rr < 8 &&
      cc >= 0 &&
      cc < 8 &&
      tavola[rr][cc] === colore
    ) {
      totali.push(...linea);
    }
  }

  return totali;
}

function mosseLegaliPer(tavola, colore) {
  if (!tavolaValida(tavola)) return [];

  const mosse = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const catture = catturePerCella(
        tavola,
        r,
        c,
        colore
      );

      if (catture.length) {
        mosse.push({
          r,
          c,
          catture
        });
      }
    }
  }

  return mosse;
}

function contaDischi(tavola) {
  let nero = 0;
  let bianco = 0;

  if (!tavolaValida(tavola)) {
    return { nero: 0, bianco: 0 };
  }

  for (const riga of tavola) {
    for (const cella of riga) {
      if (cella === "nero") nero++;
      else if (cella === "bianco") bianco++;
    }
  }

  return { nero, bianco };
}

/* =========================================================
   TOKEN / SOCKET
   ========================================================= */

function tokenAutenticazione() {
  try {
    const hash = new URLSearchParams(
      location.hash.replace(/^#/, "")
    );

    const daUrl = hash.get("auth_token");

    if (daUrl) {
      sessionStorage.setItem(
        CHIAVE_TOKEN_AUTH,
        daUrl
      );

      hash.delete("auth_token");

      history.replaceState(
        null,
        "",
        location.pathname +
          location.search +
          (hash.toString()
            ? "#" + hash.toString()
            : "")
      );

      return daUrl;
    }

    return sessionStorage.getItem(
      CHIAVE_TOKEN_AUTH
    ) || "";
  } catch (_) {
    return "";
  }
}

function inviaSocket(dati, ws = socket) {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return false;
  }

  try {
    const token = tokenAutenticazione();

    const payload = token
      ? { ...dati, token }
      : dati;

    ws.send(JSON.stringify(payload));
    return true;
  } catch (errore) {
    console.error(
      "Invio WebSocket non riuscito:",
      errore
    );

    return false;
  }
}

function impostaStatoConnessione(disconnesso) {
  const banner =
    document.getElementById("banner-disconnesso");

  if (banner) {
    banner.classList.toggle(
      "nascosto",
      !disconnesso
    );
  }

  document.body.classList.toggle(
    "disconnesso",
    disconnesso
  );
}

/* =========================================================
   CARICAMENTO
   ========================================================= */

function aggiornaCaricamento(testo, percentuale) {
  const testoEl =
    document.getElementById("caricamento-testo");

  const barra =
    document.getElementById(
      "caricamento-progress-bar"
    );

  const progresso =
    document.getElementById(
      "caricamento-progress"
    );

  if (testoEl && testo) {
    testoEl.textContent = testo;
  }

  if (Number.isFinite(percentuale)) {
    percentualeCaricamento = Math.max(
      percentualeCaricamento,
      Math.max(
        0,
        Math.min(100, percentuale)
      )
    );

    if (barra) {
      barra.style.width =
        percentualeCaricamento + "%";
    }

    if (progresso) {
      progresso.setAttribute(
        "aria-valuenow",
        String(percentualeCaricamento)
      );
    }
  }
}

function terminaCaricamento(testoFinale) {
  const overlay =
    document.getElementById(
      "overlay-caricamento"
    );

  if (
    !overlay ||
    overlay.classList.contains(
      "caricamento-finito"
    )
  ) {
    return;
  }

  aggiornaCaricamento(
    testoFinale || "Partita pronta",
    100
  );

  document.body.classList.remove(
    "caricamento-in-corso"
  );

  if (timerMassimoCaricamento) {
    clearTimeout(timerMassimoCaricamento);
    timerMassimoCaricamento = null;
  }

  setTimeout(() => {
    overlay.classList.add(
      "caricamento-finito"
    );
  }, 180);
}

function verificaFineCaricamento() {
  if (
    graficaCaricata &&
    statoInizialeRicevuto
  ) {
    terminaCaricamento();
  }
}

function segnalaGraficaCaricata() {
  graficaCaricata = true;

  aggiornaCaricamento(
    statoInizialeRicevuto
      ? "Partita pronta"
      : "Connessione alla partita…",
    statoInizialeRicevuto
      ? 100
      : 55
  );

  verificaFineCaricamento();
}

function segnalaStatoInizialeRicevuto() {
  if (statoInizialeRicevuto) return;

  statoInizialeRicevuto = true;

  aggiornaCaricamento(
    graficaCaricata
      ? "Partita pronta"
      : "Caricamento tavola…",
    graficaCaricata ? 100 : 85
  );

  verificaFineCaricamento();
}

/* =========================================================
   NOTIFICHE
   ========================================================= */

function mostraNotificaGioco(testo) {
  const contenitore =
    document.getElementById(
      "contenitore-notifiche-gioco"
    );

  if (!contenitore) {
    console.error(testo);
    return;
  }

  const toast =
    document.createElement("div");

  toast.className =
    "notifica-toast-gioco";

  toast.textContent = String(testo || "");

  contenitore.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 5000);
}

let timerFlashMessaggio = null;

function mostraMessaggioGiocoGrande(
  testo,
  opzioni = {}
) {
  const overlay =
    document.getElementById(
      "flash-messaggio-gioco"
    );

  const titolo =
    document.getElementById(
      "flash-titolo-gioco"
    );

  const dettaglio =
    document.getElementById(
      "flash-dettaglio-gioco"
    );

  const icona =
    document.getElementById(
      "flash-icona-gioco"
    );

  if (!overlay || !titolo) return;

  clearTimeout(timerFlashMessaggio);

  titolo.textContent = String(testo || "");

  if (dettaglio) {
    dettaglio.textContent =
      opzioni.dettaglio || "";

    dettaglio.hidden =
      !opzioni.dettaglio;
  }

  if (icona) {
    icona.textContent =
      opzioni.icona || "";

    icona.hidden =
      !opzioni.icona;
  }

  const durata = Math.max(
    900,
    Number(opzioni.durata) || 2200
  );

  overlay.style.setProperty(
    "--durata-flash-gioco",
    durata + "ms"
  );

  overlay.classList.remove("visibile");

  void overlay.offsetWidth;

  overlay.classList.add("visibile");

  timerFlashMessaggio =
    setTimeout(() => {
      overlay.classList.remove(
        "visibile"
      );
    }, durata);
}

/* =========================================================
   AUDIO
   ========================================================= */

let suoniAttivi = true;

try {
  suoniAttivi =
    localStorage.getItem(
      "suoniAttivi"
    ) !== "off";
} catch (_) {}

let contestoAudio = null;
let interazioneUtenteRegistrata = false;

function ottieniContestoAudio() {
  if (!interazioneUtenteRegistrata) {
    return null;
  }

  if (!contestoAudio) {
    const C =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!C) return null;

    try {
      contestoAudio = new C();
    } catch (_) {
      return null;
    }
  }

  if (
    contestoAudio.state === "suspended"
  ) {
    const p =
      contestoAudio.resume();

    if (
      p &&
      typeof p.catch === "function"
    ) {
      p.catch(() => {});
    }
  }

  return contestoAudio;
}

function registraPrimaInterazioneAudio() {
  interazioneUtenteRegistrata = true;

  document.removeEventListener(
    "pointerdown",
    registraPrimaInterazioneAudio,
    true
  );

  document.removeEventListener(
    "keydown",
    registraPrimaInterazioneAudio,
    true
  );

  if (suoniAttivi) {
    ottieniContestoAudio();
  }
}

document.addEventListener(
  "pointerdown",
  registraPrimaInterazioneAudio,
  {
    capture: true,
    passive: true
  }
);

document.addEventListener(
  "keydown",
  registraPrimaInterazioneAudio,
  true
);

function suonaTono(
  frequenza,
  durataMs,
  tipoOnda = "sine",
  volume = 0.1,
  ritardoMs = 0
) {
  if (!suoniAttivi) return;

  const ctx =
    ottieniContestoAudio();

  if (!ctx) return;

  const inizio =
    ctx.currentTime +
    ritardoMs / 1000;

  const osc =
    ctx.createOscillator();

  const gain =
    ctx.createGain();

  osc.type = tipoOnda;

  osc.frequency.setValueAtTime(
    frequenza,
    inizio
  );

  gain.gain.setValueAtTime(
    0,
    inizio
  );

  gain.gain.linearRampToValueAtTime(
    volume,
    inizio + 0.01
  );

  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    inizio + durataMs / 1000
  );

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(inizio);

  osc.stop(
    inizio +
      durataMs / 1000 +
      0.02
  );
}

function suonaPosa() {
  suonaTono(
    500,
    55,
    "sine",
    0.09
  );
}

function suonaFlip(ritardoMs = 0) {
  suonaTono(
    320,
    70,
    "triangle",
    0.07,
    ritardoMs
  );
}

function suonaTuoTurno() {
  suonaTono(
    660,
    120,
    "sine",
    0.11
  );

  suonaTono(
    880,
    160,
    "sine",
    0.11,
    120
  );
}

function suonaVittoria() {
  suonaTono(523, 130, "sine", 0.13, 0);
  suonaTono(659, 130, "sine", 0.13, 130);
  suonaTono(784, 130, "sine", 0.13, 260);
  suonaTono(1047, 260, "sine", 0.14, 390);
}

function suonaMessaggioChat() {
  suonaTono(
    740,
    70,
    "sine",
    0.08
  );
}

function suonaAvvisoTempo() {
  suonaTono(
    300,
    90,
    "triangle",
    0.14
  );
}

function toggleSuoni() {
  impostaSuoni(!suoniAttivi);
}

function impostaSuoni(attivi) {
  suoniAttivi = !!attivi;

  try {
    localStorage.setItem(
      "suoniAttivi",
      suoniAttivi ? "on" : "off"
    );
  } catch (_) {}

  if (
    suoniAttivi &&
    interazioneUtenteRegistrata
  ) {
    ottieniContestoAudio();
  }

  aggiornaTestoBottoneSuoni();
}

function aggiornaTestoBottoneSuoni() {
  const b =
    document.getElementById(
      "btn-toggle-suoni"
    );

  if (b) {
    b.textContent =
      suoniAttivi
        ? "🔊 Suoni: On"
        : "🔇 Suoni: Off";
  }
}

/* =========================================================
   FULLSCREEN
   ========================================================= */

function toggleFullscreen() {
  try {
    const fullscreen =
      document.fullscreenElement ||
      document.webkitFullscreenElement;

    if (!fullscreen) {
      const elemento =
        document.documentElement;

      const richiesta =
        elemento.requestFullscreen ||
        elemento.webkitRequestFullscreen ||
        elemento.mozRequestFullScreen ||
        elemento.msRequestFullScreen;

      if (!richiesta) {
        mostraNotificaGioco(
          "Il tuo browser non supporta lo schermo intero."
        );
        return;
      }

      const risultato =
        richiesta.call(elemento);

      if (
        risultato &&
        typeof risultato.catch === "function"
      ) {
        risultato.catch(() => {
          mostraNotificaGioco(
            "Non è stato possibile attivare lo schermo intero."
          );
        });
      }
    } else {
      const esci =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;

      if (esci) {
        esci.call(document);
      }
    }
  } catch (_) {
    mostraNotificaGioco(
      "Errore durante l'attivazione dello schermo intero."
    );
  }
}

function aggiornaTestoBottoneFullscreen() {
  const b =
    document.getElementById(
      "btn-toggle-fullscreen"
    );

  if (!b) return;

  b.textContent =
    document.fullscreenElement ||
    document.webkitFullscreenElement
      ? "🡼 Esci da tutto schermo"
      : "⛶ Tutto schermo";
}

document.addEventListener(
  "fullscreenchange",
  aggiornaTestoBottoneFullscreen
);

document.addEventListener(
  "webkitfullscreenchange",
  aggiornaTestoBottoneFullscreen
);

/* =========================================================
   LAYOUT
   ========================================================= */

function rilevaEImpostaModalitaDesktop() {
  const puntatorePreciso =
    !!(
      window.matchMedia &&
      window.matchMedia(
        "(pointer: fine)"
      ).matches
    );

  const eDesktop =
    puntatorePreciso &&
    window.innerWidth >= 1000;

  document.body.classList.toggle(
    "modalita-desktop",
    eDesktop
  );
}

function aggiornaLayoutTabellone() {
  const areaTabellone =
    document.getElementById(
      "area-tabellone"
    );

  const mondo =
    document.getElementById(
      "mondo-ruotato"
    );

  if (!areaTabellone || !mondo) {
    return;
  }

  const larghezzaFinestra =
    window.visualViewport
      ? window.visualViewport.width
      : window.innerWidth;

  const altezzaReale =
    window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;

  document.documentElement.style.setProperty(
    "--altezza-reale",
    altezzaReale + "px"
  );

  mondo.style.width =
    larghezzaFinestra + "px";

  mondo.style.height =
    altezzaReale + "px";

  const altezzaRaccolta =
    larghezzaFinestra < 600
      ? 46
      : 54;

  document.documentElement.style.setProperty(
    "--altezza-raccolta",
    altezzaRaccolta + "px"
  );

  const margineOrizzontale =
    larghezzaFinestra < 600
      ? 10
      : 26;

  const spazioRaccolte =
    2 * (altezzaRaccolta + 12);

  const larghezzaDisponibile =
    Math.max(
      120,
      larghezzaFinestra -
        margineOrizzontale * 2
    );

  const altezzaDisponibile =
    Math.max(
      120,
      altezzaReale -
        spazioRaccolte -
        56
    );

  const lato = Math.max(
    120,
    Math.min(
      larghezzaDisponibile,
      altezzaDisponibile
    )
  );

  const puntatorePreciso =
    !!window.matchMedia?.(
      "(pointer: fine)"
    ).matches;

  document.body.classList.toggle(
    "modalita-desktop",
    puntatorePreciso &&
      larghezzaFinestra >= 1000 &&
      larghezzaFinestra - lato >= 600
  );

  areaTabellone.style.width =
    lato + "px";

  areaTabellone.style.height =
    lato + "px";
}

let timerDebounceResize = null;

function gestisciResize() {
  rilevaEImpostaModalitaDesktop();

  clearTimeout(timerDebounceResize);

  timerDebounceResize =
    setTimeout(
      aggiornaLayoutTabellone,
      60
    );
}

function inizializzaGestioneLayout() {
  rilevaEImpostaModalitaDesktop();
  aggiornaLayoutTabellone();

  window.addEventListener(
    "resize",
    gestisciResize
  );

  window.addEventListener(
    "orientationchange",
    () =>
      setTimeout(
        gestisciResize,
        300
      )
  );

  if (window.visualViewport) {
    window.visualViewport.addEventListener(
      "resize",
      gestisciResize
    );
  }

  requestAnimationFrame(() => {
    aggiornaLayoutTabellone();
    segnalaGraficaCaricata();
  });
}

/* =========================================================
   PRESENTAZIONE SFIDA
   ========================================================= */

function chiavePresentazioneSfida() {
  return (
    "giochi-societa:othello:" +
    "presentazione-sfida:" +
    (partitaId || "sconosciuta")
  );
}

function presentazioneSfidaGiaVista() {
  try {
    return (
      sessionStorage.getItem(
        chiavePresentazioneSfida()
      ) === "1"
    );
  } catch (_) {
    return false;
  }
}

function marcaPresentazioneSfidaVista() {
  try {
    sessionStorage.setItem(
      chiavePresentazioneSfida(),
      "1"
    );
  } catch (_) {}
}

function iniziale(nome) {
  return (
    (nome || "?")
      .trim()
      .charAt(0)
      .toUpperCase() || "?"
  );
}

function coloreDaNome(nome) {
  const colori = [
    "#6a2c70",
    "#1e40af",
    "#43a047",
    "#f57c00",
    "#c0ca33",
    "#e53935",
    "#00838f",
    "#8d6e63"
  ];

  let somma = 0;

  const testo = nome || "?";

  for (let i = 0; i < testo.length; i++) {
    somma += testo.charCodeAt(i);
  }

  return colori[
    somma % colori.length
  ];
}

function escapeHtml(valore) {
  return String(
    valore == null ? "" : valore
  )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function stelleDaElo(elo) {
  const valore =
    Number.isFinite(Number(elo))
      ? Number(elo)
      : 1500;

  if (valore < 1300) return 1;
  if (valore < 1500) return 2;
  if (valore < 1700) return 3;
  if (valore < 1900) return 4;

  return 5;
}

function htmlStelle(elo) {
  const piene =
    stelleDaElo(elo);

  let html = "";

  for (let i = 1; i <= 5; i++) {
    html +=
      i <= piene
        ? "★"
        : '<span class="vuota">★</span>';
  }

  return html;
}

function htmlAvatar(giocatore) {
  const nome =
    escapeHtml(
      giocatore.nome ||
      giocatore.nickname ||
      "Giocatore"
    );

  if (
    typeof giocatore.avatar === "string" &&
    giocatore.avatar.trim()
  ) {
    return `
      <div class="sfida-avatar">
        <img
          src="${escapeHtml(giocatore.avatar)}"
          alt="Avatar di ${nome}"
          referrerpolicy="no-referrer"
        >
      </div>
    `;
  }

  return `
    <div
      class="sfida-avatar"
      style="background:${coloreDaNome(
        giocatore.nome ||
        giocatore.nickname
      )}"
    >
      ${escapeHtml(
        iniziale(
          giocatore.nome ||
          giocatore.nickname
        )
      )}
    </div>
  `;
}

function probabilitaVittoriaElo(
  eloA,
  eloB
) {
  const a =
    Number.isFinite(Number(eloA))
      ? Number(eloA)
      : 1500;

  const b =
    Number.isFinite(Number(eloB))
      ? Number(eloB)
      : 1500;

  return 1 / (
    1 +
    Math.pow(
      10,
      (b - a) / 400
    )
  );
}

function variazioniElo(
  eloA,
  eloB
) {
  const a =
    Number.isFinite(Number(eloA))
      ? Number(eloA)
      : 1500;

  const b =
    Number.isFinite(Number(eloB))
      ? Number(eloB)
      : 1500;

  const p =
    probabilitaVittoriaElo(a, b);

  const vittoria =
    Math.round(32 * (1 - p));

  const sconfitta =
    Math.round(32 * (0 - p));

  return {
    vittoria,
    sconfitta
  };
}

function giocatoriStato() {
  if (
    !stato.giocatori ||
    typeof stato.giocatori !== "object"
  ) {
    return [];
  }

  return Object.entries(
    stato.giocatori
  ).map(([uid, g]) => ({
    uid,
    ...(g || {})
  }));
}

function disegnaPresentazioneSfida() {
  const contenitore =
    document.getElementById(
      "sfida-giocatori"
    );

  if (!contenitore) return;

  const elenco =
    giocatoriStato();

  if (elenco.length < 2) {
    contenitore.innerHTML =
      '<div class="sfida-caricamento">In attesa dell\'avversario…</div>';

    return;
  }

  const sx =
    elenco.find(
      g => g.colore === "nero"
    ) || elenco[0];

  const dx =
    elenco.find(
      g => g.colore === "bianco"
    ) || elenco[1];

  const card = (g, lato) => {
    const destra =
      lato === "destra"
        ? " sfida-giocatore-destra"
        : "";

    const nome =
      escapeHtml(
        g.nome ||
        g.nickname ||
        "Giocatore"
      );

    const elo =
      Number.isFinite(Number(g.elo))
        ? Math.round(Number(g.elo))
        : 1500;

    return `
      <article class="sfida-giocatore${destra}">
        <div class="sfida-identita">
          ${htmlAvatar(g)}

          <div class="sfida-nome-wrap">
            <div
              class="sfida-nome"
              title="${nome}"
            >
              ${nome}
            </div>

            <div
              class="sfida-stelle"
              aria-label="Indicatore grafico ELO"
            >
              ${htmlStelle(elo)}
            </div>
          </div>
        </div>

        <div class="sfida-stat-riga">
          <div class="sfida-stat-barra">
            <div
              class="sfida-stat-riempimento"
              style="width:${Math.max(
                8,
                Math.min(100, elo / 20)
              )}%"
            ></div>
          </div>

          <span class="sfida-stat-valore">
            ${elo}
          </span>
        </div>

        <div class="sfida-stat-riga">
          <div class="sfida-stat-barra">
            <div
              class="sfida-stat-riempimento"
              style="width:0%"
            ></div>
          </div>

          <span class="sfida-stat-valore">—</span>
        </div>

        <div class="sfida-stat-riga">
          <div class="sfida-stat-barra">
            <div
              class="sfida-stat-riempimento"
              style="width:0%"
            ></div>
          </div>

          <span class="sfida-stat-valore">—</span>
        </div>
      </article>
    `;
  };

  contenitore.innerHTML = `
    <div class="sfida-duello">
      ${card(sx, "sinistra")}

      <div
        class="sfida-vs-colonna"
        aria-hidden="true"
      >
        <div class="sfida-vs">VS</div>
        <div class="sfida-vs-etichetta">ELO</div>
        <div class="sfida-vs-etichetta">Giocate</div>
        <div class="sfida-vs-etichetta">Vinte</div>
      </div>

      ${card(dx, "destra")}
    </div>
  `;

  const mio =
    elenco.find(
      g => g.uid === mioUid
    ) || sx;

  const avversario =
    elenco.find(
      g => g.uid !== mio.uid
    ) || dx;

  const variazione =
    variazioniElo(
      mio.elo,
      avversario.elo
    );

  const classificata =
    stato.classificata !== false;

  const boxVariazione =
    document.getElementById(
      "sfida-box-variazione-elo"
    );

  if (boxVariazione) {
    boxVariazione.hidden =
      !classificata;
  }

  const v =
    document.getElementById(
      "sfida-elo-vittoria"
    );

  const s =
    document.getElementById(
      "sfida-elo-sconfitta"
    );

  if (v) {
    v.textContent =
      classificata
        ? (
            variazione.vittoria >= 0
              ? "+"
              : ""
          ) +
          variazione.vittoria
        : "";
  }

  if (s) {
    s.textContent =
      classificata
        ? String(
            variazione.sconfitta
          )
        : "";
  }

  const streak =
    document.getElementById(
      "sfida-streak"
    );

  const wr =
    document.getElementById(
      "sfida-winrate"
    );

  if (streak) streak.textContent = "—";
  if (wr) wr.textContent = "—";
}

function mostraPresentazioneSfida() {
  if (
    presentazioneSfidaAperta ||
    presentazioneSfidaGiaVista() ||
    giocatoriStato().length < 2
  ) {
    return;
  }

  const overlay =
    document.getElementById(
      "overlay-presentazione-sfida"
    );

  if (!overlay) return;

  const classificata =
    stato.classificata !== false;

  const testoModalita =
    document.getElementById(
      "sfida-modalita-testo"
    );

  const descrizione =
    document.getElementById(
      "sfida-descrizione-modalita"
    );

  const statoSfida =
    document.getElementById(
      "sfida-stato"
    );

  if (testoModalita) {
    testoModalita.textContent =
      classificata
        ? "Partita classificata · Othello · ELO attivo"
        : "Partita Divertimento · Othello · ELO invariato";
  }

  if (descrizione) {
    descrizione.textContent =
      classificata
        ? "Giocatori reali · il risultato modifica il rating ELO della modalità Othello"
        : "Giocatori reali · questa partita non modifica il rating ELO";
  }

  if (statoSfida) {
    statoSfida.textContent =
      classificata
        ? "Confronto ELO Othello · K = 32"
        : "Modalità Divertimento: ELO invariato";
  }

  disegnaPresentazioneSfida();

  presentazioneSfidaAperta = true;

  overlay.classList.add("aperto");
  overlay.setAttribute(
    "aria-hidden",
    "false"
  );

  clearTimeout(
    timerChiusuraPresentazioneSfida
  );

  timerChiusuraPresentazioneSfida =
    setTimeout(() => {
      chiudiPresentazioneSfida();
    }, 6000);

  setTimeout(() => {
    document
      .getElementById(
        "btn-entra-partita"
      )
      ?.focus();
  }, 0);
}

function chiudiPresentazioneSfida() {
  if (!presentazioneSfidaAperta) {
    return;
  }

  clearTimeout(
    timerChiusuraPresentazioneSfida
  );

  timerChiusuraPresentazioneSfida = null;
  presentazioneSfidaAperta = false;

  marcaPresentazioneSfidaVista();

  const overlay =
    document.getElementById(
      "overlay-presentazione-sfida"
    );

  if (overlay) {
    overlay.classList.remove(
      "aperto"
    );

    overlay.setAttribute(
      "aria-hidden",
      "true"
    );
  }
}

document
  .getElementById(
    "btn-entra-partita"
  )
  ?.addEventListener(
    "click",
    chiudiPresentazioneSfida
  );

/* =========================================================
   TAVOLA / DISCHI
   ========================================================= */

function nomeColore(colore) {
  if (colore === "nero") return "Nero";
  if (colore === "bianco") return "Bianco";
  return "—";
}

const posizioniDischi = new Map();
const caselleTavola = new Map();

let tavolaDisegnata = null;

let animazioneCorrente = null;
let animazioneGenerazione = 0;

let animazioniDischiAttive = true;

try {
  animazioniDischiAttive =
    localStorage.getItem(
      "othello:animazioni"
    ) !== "off";
} catch (_) {}

function aggiornaBottoneAnimazioniOthello() {
  const bottone =
    document.getElementById(
      "btn-animazioni-othello"
    );

  if (!bottone) return;

  bottone.textContent =
    "Animazioni dischi: " +
    (
      animazioniDischiAttive
        ? "attive"
        : "disattivate"
    );

  bottone.setAttribute(
    "aria-pressed",
    String(
      animazioniDischiAttive
    )
  );
}

function toggleAnimazioniOthello() {
  animazioniDischiAttive =
    !animazioniDischiAttive;

  try {
    localStorage.setItem(
      "othello:animazioni",
      animazioniDischiAttive
        ? "on"
        : "off"
    );
  } catch (_) {}

  if (!animazioniDischiAttive) {
    annullaAnimazioneDischi();
    if (stato.tavola) {
      sincronizzaDischiIstantaneo(
        stato.tavola
      );
    }
  }

  aggiornaBottoneAnimazioniOthello();
}

aggiornaBottoneAnimazioniOthello();

function chiaveCasella(r, c) {
  return r + "," + c;
}

function coordinateVisive(r, c) {
  return mioColore === "bianco"
    ? {
        r: 7 - r,
        c: 7 - c
      }
    : {
        r,
        c
      };
}

function creaFacciaDisco(colore) {
  const elemento =
    document.createElement("div");

  elemento.className =
    "othello-disco";

  elemento.dataset.colore =
    colore;

  const bianco =
    document.createElement("div");

  bianco.className =
    "othello-disco-faccia bianco";

  const nero =
    document.createElement("div");

  nero.className =
    "othello-disco-faccia nero";

  elemento.append(
    bianco,
    nero
  );

  return elemento;
}

function preparaTavola() {
  const tavola =
    document.getElementById(
      "othello-tavola"
    );

  if (!tavola) return null;

  if (caselleTavola.size) {
    return tavola;
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const casella =
        document.createElement(
          "button"
        );

      casella.type = "button";
      casella.setAttribute(
        "role",
        "gridcell"
      );

      casella.dataset.r =
        String(r);

      casella.dataset.c =
        String(c);

      casella.addEventListener(
        "click",
        () => cliccaCasella(r, c)
      );

      casella.addEventListener(
        "keydown",
        evento => {
          if (
            evento.key !== "Enter" &&
            evento.key !== " "
          ) {
            return;
          }

          evento.preventDefault();
          cliccaCasella(r, c);
        }
      );

      tavola.appendChild(
        casella
      );

      caselleTavola.set(
        chiaveCasella(r, c),
        casella
      );
    }
  }

  let strato =
    document.getElementById(
      "othello-strato-dischi"
    );

  if (!strato) {
    strato =
      document.createElement("div");

    strato.id =
      "othello-strato-dischi";

    strato.setAttribute(
      "aria-hidden",
      "true"
    );

    tavola.appendChild(
      strato
    );
  }

  return tavola;
}

function impostaPosizioneDisco(
  elemento,
  r,
  c
) {
  const visiva =
    coordinateVisive(r, c);

  elemento.style.left =
    visiva.c * 12.5 + "%";

  elemento.style.top =
    visiva.r * 12.5 + "%";
}

function sincronizzaDischiIstantaneo(
  tavolaStato
) {
  if (!tavolaValida(tavolaStato)) {
    return;
  }

  preparaTavola();

  const strato =
    document.getElementById(
      "othello-strato-dischi"
    );

  if (!strato) return;

  strato.innerHTML = "";

  posizioniDischi.clear();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const colore =
        tavolaStato[r][c];

      if (!colore) continue;

      const posizione =
        document.createElement("div");

      posizione.className =
        "othello-posizione";

      posizione.appendChild(
        creaFacciaDisco(colore)
      );

      strato.appendChild(
        posizione
      );

      impostaPosizioneDisco(
        posizione,
        r,
        c
      );

      posizioniDischi.set(
        chiaveCasella(r, c),
        posizione
      );
    }
  }

  tavolaDisegnata =
    copiaTavola(tavolaStato);
}

function annullaAnimazioneDischi() {
  animazioneGenerazione++;

  if (animazioneCorrente) {
    animazioneCorrente.abort =
      true;

    animazioneCorrente =
      null;
  }

  const strato =
    document.getElementById(
      "othello-strato-dischi"
    );

  if (strato) {
    strato
      .querySelectorAll(
        ".in-animazione, .appena-giocato"
      )
      .forEach(el => {
        el.classList.remove(
          "in-animazione",
          "appena-giocato"
        );
      });
  }
}

function estraiDifferenzeTavola(
  precedente,
  prossima
) {
  const nuove = [];
  const girati = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const prima =
        precedente[r][c];

      const dopo =
        prossima[r][c];

      if (prima === dopo) {
        continue;
      }

      if (!prima && dopo) {
        nuove.push({
          r,
          c,
          colore: dopo
        });
      } else if (
        prima &&
        dopo &&
        prima !== dopo
      ) {
        girati.push({
          r,
          c,
          colore: dopo
        });
      }
    }
  }

  return {
    nuove,
    girati
  };
}

function distanzaScacchi(a, b) {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.c - b.c)
  );
}

function attendi(ms, controllo) {
  return new Promise(resolve => {
    const timer =
      setTimeout(() => {
        resolve(
          !controllo ||
          controllo()
        );
      }, ms);

    if (
      controllo &&
      controllo.__timers
    ) {
      controllo.__timers.push(
        timer
      );
    }
  });
}

async function animaVersoTavola(
  prossimaTavola,
  istantanea
) {
  const generazione =
    ++animazioneGenerazione;

  annullaAnimazioneDischi();

  if (
    istantanea ||
    !tavolaDisegnata ||
    !animazioniDischiAttive
  ) {
    sincronizzaDischiIstantaneo(
      prossimaTavola
    );

    return;
  }

  const precedente =
    copiaTavola(
      tavolaDisegnata
    );

  const {
    nuove,
    girati
  } = estraiDifferenzeTavola(
    precedente,
    prossimaTavola
  );

  if (
    !nuove.length &&
    !girati.length
  ) {
    tavolaDisegnata =
      copiaTavola(
        prossimaTavola
      );

    return;
  }

  const strato =
    document.getElementById(
      "othello-strato-dischi"
    );

  if (!strato) {
    sincronizzaDischiIstantaneo(
      prossimaTavola
    );

    return;
  }

  const controllo = {
    abort: false,
    __timers: []
  };

  animazioneCorrente =
    controllo;

  const ancoraValida = () =>
    !controllo.abort &&
    generazione ===
      animazioneGenerazione;

  try {
    const centro =
      nuove[0] ||
      girati[0] || {
        r: 3.5,
        c: 3.5
      };

    for (const cella of nuove) {
      if (!ancoraValida()) {
        return;
      }

      const key =
        chiaveCasella(
          cella.r,
          cella.c
        );

      let posizione =
        posizioniDischi.get(key);

      if (!posizione) {
        posizione =
          document.createElement(
            "div"
          );

        posizione.className =
          "othello-posizione appena-giocato";

        posizione.appendChild(
          creaFacciaDisco(
            cella.colore
          )
        );

        strato.appendChild(
          posizione
        );

        impostaPosizioneDisco(
          posizione,
          cella.r,
          cella.c
        );

        posizioniDischi.set(
          key,
          posizione
        );

        if (
          cella === nuove[0]
        ) {
          suonaPosa();
        }
      }
    }

    for (
      const cella of girati
    ) {
      if (!ancoraValida()) {
        return;
      }

      const posizione =
        posizioniDischi.get(
          chiaveCasella(
            cella.r,
            cella.c
          )
        );

      if (!posizione) {
        sincronizzaDischiIstantaneo(
          prossimaTavola
        );

        return;
      }

      const disco =
        posizione.querySelector(
          ".othello-disco"
        );

      if (!disco) continue;

      const ritardo =
        Math.max(
          0,
          distanzaScacchi(
            centro,
            cella
          ) - 1
        ) * 70;

      const ok =
        await new Promise(
          resolve => {
            const timer =
              setTimeout(() => {
                if (
                  !ancoraValida()
                ) {
                  resolve(false);
                  return;
                }

                posizione.classList.add(
                  "in-animazione"
                );

                const classeFlip =
                  cella.colore ===
                  "bianco"
                    ? "girando-a-bianco"
                    : "girando-a-nero";

                suonaFlip(0);

                let conclusa =
                  false;

                const termina =
                  () => {
                    if (conclusa) return;

                    conclusa = true;

                    disco.classList.remove(
                      classeFlip
                    );

                    disco.dataset.colore =
                      cella.colore;

                    posizione.classList.remove(
                      "in-animazione"
                    );

                    resolve(
                      ancoraValida()
                    );
                  };

                disco.addEventListener(
                  "animationend",
                  termina,
                  {
                    once: true
                  }
                );

                disco.classList.add(
                  classeFlip
                );

                /*
                 * Fallback: se animationend non
                 * arriva perché il CSS viene
                 * modificato/disabilitato.
                 */
                setTimeout(
                  termina,
                  700
                );
              }, ritardo);

            controllo.__timers.push(
              timer
            );
          }
        );

      if (!ok) return;
    }

    if (!ancoraValida()) {
      return;
    }

    tavolaDisegnata =
      copiaTavola(
        prossimaTavola
      );
  } finally {
    if (
      animazioneCorrente ===
      controllo
    ) {
      animazioneCorrente =
        null;
    }

    controllo.__timers.forEach(
      clearTimeout
    );
  }
}

/* =========================================================
   RENDER TAVOLA
   ========================================================= */

function renderTavola() {
  const tavola =
    preparaTavola();

  if (!tavola) return;

  if (!tavolaDisegnata) {
    sincronizzaDischiIstantaneo(
      stato.tavola
    );
  }

  const inCorso =
    stato.fase === "in_corso";

  const mioTurno =
    inCorso &&
    !!mioColore &&
    stato.turno === mioColore;

  const destinazioni =
    new Map();

  if (
    mioTurno &&
    !mossaInAttesa &&
    !animazioneCorrente
  ) {
    for (
      const mossa of
      mosseLegaliCorrenti
    ) {
      destinazioni.set(
        chiaveCasella(
          mossa.r,
          mossa.c
        ),
        true
      );
    }
  }

  const bloccata =
    !!animazioneCorrente ||
    mossaInAttesa ||
    attesaSnapshot;

  tavola.setAttribute(
    "aria-busy",
    bloccata
      ? "true"
      : "false"
  );

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const key =
        chiaveCasella(r, c);

      const casella =
        caselleTavola.get(key);

      if (!casella) continue;

      const visiva =
        coordinateVisive(r, c);

      casella.style.gridRow =
        String(visiva.r + 1);

      casella.style.gridColumn =
        String(visiva.c + 1);

      const giocabile =
        destinazioni.has(key) &&
        !bloccata;

      casella.className =
        "othello-casella" +
        (
          giocabile
            ? " giocabile destinazione"
            : ""
        );

      const ultimo =
        stato.ultimoMovimento ||
        {};

      if (
        ultimo.a &&
        ultimo.a.r === r &&
        ultimo.a.c === c
      ) {
        casella.classList.add(
          "ultima-mossa"
        );
      }

      const occupata =
        tavolaDisegnata?.[r]?.[c];

      casella.setAttribute(
        "aria-label",
        "Casella " +
          (r * 8 + c + 1) +
          (
            occupata
              ? ", disco " +
                nomeColore(
                  occupata
                ).toLowerCase()
              : ", vuota"
          ) +
          (
            giocabile
              ? ", mossa disponibile"
              : ""
          )
      );

      casella.disabled =
        bloccata ||
        !giocabile;
    }
  }
}

/* =========================================================
   PUNTEGGIO
   ========================================================= */

function renderPunteggio() {
  const conteggio =
    contaDischi(stato.tavola);

  const mioConteggio =
    mioColore === "bianco"
      ? conteggio.bianco
      : conteggio.nero;

  const avversarioColore =
    mioColore === "bianco"
      ? "nero"
      : "bianco";

  const avversarioConteggio =
    mioColore === "bianco"
      ? conteggio.nero
      : conteggio.bianco;

  const giocatore =
    giocatoriStato().find(
      g => g.colore === mioColore
    );

  const avversario =
    giocatoriStato().find(
      g =>
        g.colore ===
        avversarioColore
    );

  const etGiocatore =
    document.getElementById(
      "punteggio-giocatore-etichetta"
    );

  const etAvversario =
    document.getElementById(
      "punteggio-avversario-etichetta"
    );

  if (etGiocatore) {
    etGiocatore.textContent =
      mioColore
        ? "Tu (" +
          nomeColore(
            mioColore
          ) +
          ")"
        : "Tu";
  }

  if (etAvversario) {
    etAvversario.textContent =
      avversario
        ? (
            avversario.nome ||
            avversario.nickname ||
            nomeColore(
              avversarioColore
            )
          )
        : "Avversario";
  }

  const cGiocatore =
    document.getElementById(
      "punteggio-giocatore-conteggio"
    );

  const cAvversario =
    document.getElementById(
      "punteggio-avversario-conteggio"
    );

  if (cGiocatore) {
    cGiocatore.textContent =
      String(mioConteggio);
  }

  if (cAvversario) {
    cAvversario.textContent =
      String(avversarioConteggio);
  }

  const dGiocatore =
    document.getElementById(
      "punteggio-giocatore-disco"
    );

  const dAvversario =
    document.getElementById(
      "punteggio-avversario-disco"
    );

  if (dGiocatore) {
    dGiocatore.classList.toggle(
      "bianco",
      mioColore === "bianco"
    );
  }

  if (dAvversario) {
    dAvversario.classList.toggle(
      "bianco",
      avversarioColore === "bianco"
    );
  }
}

/* =========================================================
   GIOCATORI
   ========================================================= */

function creaAvatarMini(
  nome,
  avatar
) {
  if (
    typeof avatar === "string" &&
    avatar.trim()
  ) {
    const immagine =
      document.createElement("img");

    immagine.className =
      "avatar-mini";

    immagine.src =
      avatar;

    immagine.alt =
      "Avatar di " +
      (nome || "giocatore");

    immagine.referrerPolicy =
      "no-referrer";

    return immagine;
  }

  const inizialeEl =
    document.createElement("div");

  inizialeEl.className =
    "avatar-mini";

  inizialeEl.style.background =
    coloreDaNome(nome);

  inizialeEl.textContent =
    iniziale(nome);

  inizialeEl.setAttribute(
    "aria-hidden",
    "true"
  );

  return inizialeEl;
}

function renderPannelloGiocatori() {
  const lista =
    document.getElementById(
      "lista-giocatori"
    );

  if (!lista) return;

  lista.textContent = "";

  const giocatori =
    giocatoriStato().sort(
      (a, b) => {
        if (a.colore === b.colore) {
          return 0;
        }

        return a.colore === "nero"
          ? -1
          : 1;
      }
    );

  for (
    const giocatore of giocatori
  ) {
    const attivo =
      stato.fase === "in_corso" &&
      giocatore.colore ===
        stato.turno;

    const card =
      document.createElement("div");

    card.className =
      "giocatore-card" +
      (
        attivo
          ? " attivo"
          : ""
      );

    card.appendChild(
      creaAvatarMini(
        giocatore.nome ||
        giocatore.nickname,
        giocatore.avatar
      )
    );

    const link =
      document.createElement("a");

    link.href =
      "/profilo-pubblico.html?nickname=" +
      encodeURIComponent(
        giocatore.nome ||
        giocatore.nickname ||
        ""
      );

    link.target = "_blank";
    link.rel = "noopener";

    link.style.color = "inherit";
    link.style.textDecoration =
      "none";
    link.style.flexGrow = "1";

    link.textContent =
      giocatore.nome ||
      giocatore.nickname ||
      "Giocatore";

    card.appendChild(link);

    const elo =
      document.createElement(
        "span"
      );

    elo.className =
      "stato-media";

    elo.textContent =
      "ELO " +
      (
        Number.isFinite(
          Number(giocatore.elo)
        )
          ? Math.round(
              Number(
                giocatore.elo
              )
            )
          : "—"
      );

    elo.title =
      "ELO Othello";

    card.appendChild(elo);

    if (attivo) {
      const countdown =
        document.createElement(
          "span"
        );

      countdown.className =
        "countdown-turno";

      countdown.id =
        "countdown-turno";

      countdown.textContent =
        "⏱ --s";

      card.appendChild(
        countdown
      );
    }

    const colore =
      document.createElement(
        "span"
      );

    colore.className =
      "othello-colore-riga";

    colore.textContent =
      nomeColore(
        giocatore.colore
      );

    card.appendChild(
      colore
    );

    lista.appendChild(card);
  }
}

function aggiornaInterfacciaPartita() {
  const rigaTurno =
    document.getElementById(
      "riga-turno"
    );

  const messaggi =
    document.getElementById(
      "messaggi-gioco"
    );

  const inCorso =
    stato.fase === "in_corso";

  const mioTurno =
    inCorso &&
    !!mioColore &&
    stato.turno === mioColore;

  if (rigaTurno) {
    if (
      stato.fase ===
      "attesa_giocatori"
    ) {
      rigaTurno.textContent =
        "⏳ In attesa dell'avversario…";
    } else if (
      stato.fase ===
      "terminata"
    ) {
      rigaTurno.textContent =
        "Partita terminata";
    } else {
      rigaTurno.textContent =
        mioTurno
          ? "● È il tuo turno!"
          : "⏳ In attesa…";
    }
  }

  if (messaggi) {
    if (
      stato.fase ===
      "attesa_giocatori"
    ) {
      messaggi.textContent =
        "In attesa dell'avversario…";
    } else if (
      stato.fase ===
      "terminata"
    ) {
      messaggi.textContent =
        "Partita terminata";
    } else if (
      mioTurno &&
      !mosseLegaliCorrenti.length
    ) {
      messaggi.textContent =
        "Nessuna mossa disponibile: passa il turno";
    } else {
      messaggi.textContent =
        "";
    }
  }
}

function render() {
  mosseLegaliCorrenti =
    stato.fase === "in_corso" &&
    mioColore
      ? mosseLegaliPer(
          stato.tavola,
          mioColore
        )
      : [];

  renderTavola();
  renderPunteggio();
  renderPannelloGiocatori();
  aggiornaInterfacciaPartita();
}

/* =========================================================
   TIMER
   ========================================================= */

function aggiornaCountdownTurno() {
  const el =
    document.getElementById(
      "countdown-turno"
    );

  if (!el) return;

  if (
    !stato.scadenzaTurno ||
    stato.fase !== "in_corso"
  ) {
    el.textContent =
      "⏱ --s";

    return;
  }

  const scadenza =
    Number(
      stato.scadenzaTurno
    );

  if (!Number.isFinite(scadenza)) {
    el.textContent =
      "⏱ --s";

    return;
  }

  const secondi =
    Math.max(
      0,
      Math.ceil(
        (scadenza -
          Date.now()) /
          1000
      )
    );

  el.textContent =
    "⏱ " +
    secondi +
    "s";

  el.classList.toggle(
    "countdown-scaduto",
    secondi <= 5
  );

  const chiave =
    stato.numeroMossa +
    ":" +
    stato.turno;

  if (
    secondi <= 10 &&
    secondi > 0 &&
    avvisoTempoChiave !== chiave &&
    stato.turno === mioColore
  ) {
    avvisoTempoChiave =
      chiave;

    suonaAvvisoTempo();
  }
}

/* =========================================================
   APPLICAZIONE STATO
   ========================================================= */

let codaStato = Promise.resolve();

function applicaStatoPartita(
  partita,
  istantanea = false
) {
  /*
   * Serializziamo l'applicazione degli snapshot.
   * Questo evita che due `await` contemporanei
   * modifichino lo stato in ordine sbagliato.
   */
  codaStato =
    codaStato
      .catch(() => {})
      .then(() =>
        applicaStatoPartitaInterno(
          partita,
          istantanea
        )
      );

  return codaStato;
}

async function applicaStatoPartitaInterno(
  partita,
  istantanea = false
) {
  if (!partita || typeof partita !== "object") {
    return;
  }

  const prossimo = {
    ...ultimoStatoRicevuto,
    ...partita
  };

  if (!statoBaseValido(prossimo)) {
    mostraNotificaGioco(
      "Stato della partita non valido: attendo la sincronizzazione."
    );

    return;
  }

  if (
    !istantanea &&
    statoObsoleto(
      prossimo,
      ultimoStatoRicevuto
    )
  ) {
    return;
  }

  if (
    !istantanea &&
    stessoSnapshot(
      prossimo,
      ultimoStatoRicevuto
    )
  ) {
    return;
  }

  prossimo.tavola =
    copiaTavola(
      prossimo.tavola
    );

  /*
   * Lo stato viene considerato autorevole
   * prima dell'animazione.
   */
  const precedente =
    copiaStato(stato);

  ultimoStatoRicevuto =
    copiaStato(prossimo);

  stato =
    copiaStato(prossimo);

  if (istantanea) {
    annullaAnimazioneDischi();
    tavolaDisegnata = null;
  }

  if (
    mioColore &&
    mioColore !== stato.turno
  ) {
    /* nessuna azione */
  }

  const numeroPrecedente =
    numeroMossaValido(
      precedente.numeroMossa
    );

  const numeroNuovo =
    numeroMossaValido(
      stato.numeroMossa
    );

  const numeroCambiato =
    numeroNuovo !== null &&
    numeroPrecedente !== null &&
    numeroNuovo !==
      numeroPrecedente;

  if (numeroCambiato) {
    mossaInAttesa = false;

    clearTimeout(
      timerMossaInAttesa
    );

    timerMossaInAttesa =
      null;

    avvisoTempoChiave =
      "";
  }

  if (
    istantanea ||
    stato.fase !== "in_corso"
  ) {
    mossaInAttesa = false;

    clearTimeout(
      timerMossaInAttesa
    );

    timerMossaInAttesa =
      null;
  }

  render();

  /*
   * L'animazione è puramente visuale:
   * non blocca la validità dello stato.
   */
  await animaVersoTavola(
    stato.tavola,
    istantanea
  );

  /*
   * Se nel frattempo è arrivato un altro
   * snapshot, non tocchiamo più il DOM.
   */
  if (
    ultimoStatoRicevuto.numeroMossa !==
    stato.numeroMossa
  ) {
    return;
  }

  render();

  if (
    stato.fase === "in_corso" &&
    numeroCambiato &&
    stato.turno ===
      precedente.turno &&
    giocatoriStato().length >= 2
  ) {
    const chiNonMuove =
      giocatoriStato().find(
        g =>
          g.colore !==
          stato.turno
      );

    mostraMessaggioGiocoGrande(
      (
        chiNonMuove?.nome ||
        chiNonMuove?.nickname ||
        "L'avversario"
      ) +
        " non ha mosse disponibili",
      {
        dettaglio:
          "Tocca ancora a " +
          (
            stato.turno ===
            mioColore
              ? "te"
              : nomeColore(
                  stato.turno
                ).toLowerCase()
          ),
        icona: "⏭️",
        durata: 2400
      }
    );
  }

  if (
    stato.fase === "in_corso" &&
    stato.turno === mioColore &&
    numeroCambiato
  ) {
    suonaTuoTurno();
  }

  if (
    stato.fase === "in_corso" &&
    giocatoriStato().length >= 2 &&
    !presentazioneSfidaGiaVista()
  ) {
    setTimeout(() => {
      if (
        stato.fase ===
        "in_corso"
      ) {
        mostraPresentazioneSfida();
      }
    }, 260);
  }

  if (
    stato.fase === "terminata"
  ) {
    mostraVittoria(stato);
  }
}

/* =========================================================
   MOSSA
   ========================================================= */

function cliccaCasella(r, c) {
  if (
    animazioneCorrente ||
    mossaInAttesa ||
    attesaSnapshot
  ) {
    return;
  }

  if (
    stato.fase !== "in_corso" ||
    !mioColore ||
    stato.turno !== mioColore
  ) {
    return;
  }

  const mossa =
    mosseLegaliCorrenti.find(
      m =>
        m.r === r &&
        m.c === c
    );

  if (!mossa) return;

  const ws = socket;

  if (
    !inviaSocket(
      {
        tipo: "othello_mossa",
        partitaId:
          stato.id ||
          partitaId,
        a: { r, c }
      },
      ws
    )
  ) {
    mostraNotificaGioco(
      "Connessione assente: la mossa non è stata inviata."
    );

    return;
  }

  mossaInAttesa = true;

  clearTimeout(
    timerMossaInAttesa
  );

  timerMossaInAttesa =
    setTimeout(() => {
      if (!mossaInAttesa) {
        return;
      }

      mostraNotificaGioco(
        "Conferma della mossa in ritardo: sincronizzazione in corso…"
      );

      attesaSnapshot = true;

      if (
        !inviaSocket(
          {
            tipo: "othello_entra",
            partitaId:
              stato.id ||
              partitaId,
            stanza
          },
          ws
        )
      ) {
        try {
          if (
            socket === ws
          ) {
            ws.close();
          }
        } catch (_) {}
      }

      renderTavola();
    }, 8000);

  renderTavola();
}

/* =========================================================
   VITTORIA
   ========================================================= */

function mostraVittoria(
  dati = {}
) {
  if (vittoriaMostrata) {
    return;
  }

  vittoriaMostrata = true;

  chiudiPresentazioneSfida();

  suonaVittoria();

  const vincitoreUid =
    dati.vincitoreUid ??
    stato.vincitoreUid ??
    null;

  const vincitore =
    vincitoreUid
      ? (
          stato.giocatori?.[
            vincitoreUid
          ] || null
        )
      : null;

  const conteggio =
    contaDischi(
      stato.tavola
    );

  const testo =
    document.getElementById(
      "testo-vincitore"
    );

  if (testo) {
    if (!vincitoreUid) {
      testo.textContent =
        "🤝 Partita terminata in parità (" +
        conteggio.nero +
        "-" +
        conteggio.bianco +
        ")";
    } else if (
      vincitoreUid === mioUid
    ) {
      testo.textContent =
        "🎉 Hai vinto! (" +
        conteggio.nero +
        "-" +
        conteggio.bianco +
        ")";
    } else {
      testo.textContent =
        "🎉 Ha vinto " +
        (
          vincitore?.nome ||
          vincitore?.nickname ||
          "l'avversario"
        ) +
        " (" +
        conteggio.nero +
        "-" +
        conteggio.bianco +
        ")";
    }
  }

  const overlay =
    document.getElementById(
      "overlay-vittoria"
    );

  if (overlay) {
    overlay.classList.add(
      "aperto"
    );

    const bottone =
      overlay.querySelector(
        "button"
      );

    if (bottone) {
      bottone.focus();
    }
  }
}

/* =========================================================
   CHAT
   ========================================================= */

function aggiornaBadgeChatPartita() {
  const badge =
    document.getElementById(
      "badge-chat-partita"
    );

  if (!badge) return;

  if (
    messaggiChatNonLetti > 0
  ) {
    badge.style.display =
      "flex";

    badge.textContent =
      messaggiChatNonLetti > 9
        ? "9+"
        : String(
            messaggiChatNonLetti
          );
  } else {
    badge.style.display =
      "none";
  }
}

function aggiungiMessaggioChatPartita(
  nome,
  testo
) {
  suonaMessaggioChat();

  const box =
    document.getElementById(
      "chat-messaggi"
    );

  if (!box) return;

  const riga =
    document.createElement("div");

  riga.className =
    "chat-msg";

  const autore =
    document.createElement("b");

  autore.textContent =
    (nome || "Giocatore") +
    ":";

  riga.append(
    autore,
    document.createTextNode(
      " " +
      (testo || "")
    )
  );

  box.appendChild(riga);

  box.scrollTop =
    box.scrollHeight;

  const pannelloChat =
    document.getElementById(
      "pannello-chat"
    );

  if (
    pannelloChat &&
    pannelloChat.classList.contains(
      "nascosto"
    )
  ) {
    messaggiChatNonLetti++;

    aggiornaBadgeChatPartita();
  }
}

function inviaChatPartita() {
  const input =
    document.getElementById(
      "chat-input"
    );

  if (!input) return;

  const testo =
    input.value.trim();

  if (!testo) return;

  if (
    inviaSocket({
      tipo: "othello_chat",
      partitaId:
        stato.id ||
        partitaId,
      messaggio: testo
    })
  ) {
    input.value = "";
  } else {
    mostraNotificaGioco(
      "Connessione assente: il messaggio non è stato inviato."
    );
  }
}

/* =========================================================
   MENU
   ========================================================= */

function chiudiMenu() {
  const pannello =
    document.getElementById(
      "pannello-menu"
    );

  const bottone =
    document.getElementById(
      "btn-menu"
    );

  if (pannello) {
    pannello.classList.add(
      "nascosto"
    );
  }

  if (bottone) {
    bottone.setAttribute(
      "aria-expanded",
      "false"
    );

    bottone.setAttribute(
      "aria-label",
      "Apri menu"
    );
  }
}

function chiudiPannelloGiocatori() {
  document
    .getElementById(
      "pannello-giocatori"
    )
    ?.classList.remove(
      "aperto"
    );

  document
    .getElementById(
      "backdrop-giocatori"
    )
    ?.classList.remove(
      "aperto"
    );

  const bottone =
    document.getElementById(
      "btn-giocatori"
    );

  if (bottone) {
    bottone.setAttribute(
      "aria-expanded",
      "false"
    );

    bottone.setAttribute(
      "aria-label",
      "Mostra giocatori"
    );
  }
}

function chiudiChat() {
  document
    .getElementById(
      "pannello-chat"
    )
    ?.classList.add(
      "nascosto"
    );

  const bottone =
    document.getElementById(
      "btn-chat"
    );

  if (bottone) {
    bottone.setAttribute(
      "aria-expanded",
      "false"
    );

    bottone.setAttribute(
      "aria-label",
      "Apri chat"
    );
  }
}

function apriProfilo() {
  chiudiMenu();

  window.location.href =
    ORIGINE_SERVER +
    "/profilo.html";
}

function apriImpostazioni() {
  chiudiMenu();

  window.location.href =
    ORIGINE_SERVER +
    "/account.html";
}

function urlLobby() {
  return stanza
    ? "lobbyothello.html?stanza=" +
        encodeURIComponent(
          stanza
        )
    : "lobbyothello.html";
}

function tornaAllaLobby() {
  paginaInChiusura = true;

  window.location.replace(
    urlLobby()
  );
}

/* =========================================================
   CONFERMA ABBANDONO
   ========================================================= */

let risolviConfermaGioco = null;

function chiudiConfermaGioco(
  esito
) {
  const overlay =
    document.getElementById(
      "overlay-conferma-gioco"
    );

  if (overlay) {
    overlay.classList.remove(
      "aperto"
    );

    overlay.setAttribute(
      "aria-hidden",
      "true"
    );
  }

  const risolvi =
    risolviConfermaGioco;

  risolviConfermaGioco =
    null;

  if (
    typeof risolvi ===
    "function"
  ) {
    risolvi(!!esito);
  }
}

function chiediConfermaGioco({
  titolo,
  messaggio,
  testoConferma
} = {}) {
  const overlay =
    document.getElementById(
      "overlay-conferma-gioco"
    );

  const titoloEl =
    document.getElementById(
      "titolo-conferma-gioco"
    );

  const testoEl =
    document.getElementById(
      "testo-conferma-gioco"
    );

  const annulla =
    document.getElementById(
      "btn-annulla-conferma-gioco"
    );

  const conferma =
    document.getElementById(
      "btn-conferma-gioco"
    );

  if (
    !overlay ||
    !annulla ||
    !conferma
  ) {
    return Promise.resolve(false);
  }

  if (risolviConfermaGioco) {
    chiudiConfermaGioco(false);
  }

  if (titoloEl) {
    titoloEl.textContent =
      titolo ||
      "Confermare l'operazione?";
  }

  if (testoEl) {
    testoEl.textContent =
      messaggio ||
      "Vuoi continuare?";
  }

  conferma.textContent =
    testoConferma ||
    "Conferma";

  overlay.classList.add(
    "aperto"
  );

  overlay.setAttribute(
    "aria-hidden",
    "false"
  );

  return new Promise(resolve => {
    risolviConfermaGioco =
      resolve;

    annulla.onclick =
      () =>
        chiudiConfermaGioco(
          false
        );

    conferma.onclick =
      () =>
        chiudiConfermaGioco(
          true
        );

    overlay.onclick =
      evento => {
        if (
          evento.target ===
          overlay
        ) {
          chiudiConfermaGioco(
            false
          );
        }
      };

    annulla.focus();
  });
}

async function abbandonaPartita() {
  chiudiMenu();

  const confermato =
    await chiediConfermaGioco({
      titolo:
        "Abbandonare la partita?",
      messaggio:
        "Uscirai dalla partita e tornerai alla Lobby.",
      testoConferma:
        "Abbandona"
    });

  if (!confermato) {
    return;
  }

  if (
    !inviaSocket({
      tipo: "othello_abbandona",
      partitaId:
        stato.id ||
        partitaId
    })
  ) {
    mostraNotificaGioco(
      "Connessione assente: attendi la riconnessione prima di abbandonare la partita."
    );

    return;
  }

  paginaInChiusura = true;

  setTimeout(
    tornaAllaLobby,
    120
  );
}

function toggleMicrofonoMedia() {
  mostraNotificaGioco(
    "La videochiamata non è attiva in questa partita di Othello."
  );
}

function toggleWebcamMedia() {
  mostraNotificaGioco(
    "La videochiamata non è attiva in questa partita di Othello."
  );
}

function sbloccaRiproduzioneMedia() {
  mostraNotificaGioco(
    "La videochiamata non è attiva in questa partita di Othello."
  );
}

/* =========================================================
   WEBSOCKET
   ========================================================= */

function gestisciMessaggioSocket(
  dati,
  ws
) {
  if (
    !dati ||
    typeof dati !== "object"
  ) {
    return;
  }

  /*
   * Se è arrivato un messaggio da una
   * connessione vecchia, ignoralo.
   */
  if (ws && socket !== ws) {
    return;
  }

  if (
    dati.tipo ===
    "othello_identita"
  ) {
    if (dati.uid) {
      mioUid = dati.uid;
    }

    if (
      dati.colore === "nero" ||
      dati.colore === "bianco"
    ) {
      if (
        mioColore !==
        dati.colore
      ) {
        mioColore =
          dati.colore;

        tavolaDisegnata =
          null;

        render();
      }
    }

    return;
  }

  if (
    dati.tipo ===
    "othello_stato"
  ) {
    if (dati.uid) {
      mioUid = dati.uid;
    }

    if (
      dati.colore === "nero" ||
      dati.colore === "bianco"
    ) {
      if (
        mioColore !==
        dati.colore
      ) {
        mioColore =
          dati.colore;

        tavolaDisegnata =
          null;
      }
    }

    if (
      !dati.partita ||
      !tavolaValida(
        dati.partita.tavola
      )
    ) {
      return;
    }

    const istantanea =
      attesaSnapshot;

    attesaSnapshot = false;

    applicaStatoPartita(
      dati.partita,
      istantanea
    );

    segnalaStatoInizialeRicevuto();

    return;
  }

  if (
    dati.tipo ===
    "othello_chat"
  ) {
    aggiungiMessaggioChatPartita(
      dati.nickname ||
        "Giocatore",
      dati.messaggio ||
        ""
    );

    return;
  }

  if (
    dati.tipo ===
    "othello_fine"
  ) {
    const conclusa = {
      ...(dati.partita || {}),
      fase: "terminata"
    };

    if (
      Object.prototype.hasOwnProperty.call(
        dati,
        "vincitoreUid"
      )
    ) {
      conclusa.vincitoreUid =
        dati.vincitoreUid;
    }

    if (dati.motivo) {
      conclusa.motivoFine =
        dati.motivo;
    }

    applicaStatoPartita(
      conclusa
    );

    return;
  }

  if (
    dati.tipo ===
    "othello_rivincita"
  ) {
    mostraNotificaGioco(
      dati.messaggio ||
        "L'avversario chiede una rivincita."
    );

    return;
  }

  if (
    dati.tipo ===
    "othello_errore"
  ) {
    mossaInAttesa =
      false;

    clearTimeout(
      timerMossaInAttesa
    );

    timerMossaInAttesa =
      null;

    renderTavola();

    const errore =
      dati.errore ||
      "Operazione non consentita.";

    mostraNotificaGioco(
      errore
    );

    const minuscolo =
      errore.toLowerCase();

    if (
      minuscolo.includes(
        "non trovata"
      ) ||
      minuscolo.includes(
        "non fai parte"
      )
    ) {
      setTimeout(
        tornaAllaLobby,
        2200
      );
    }

    return;
  }

  if (
    dati.tipo ===
    "sessioneScaduta"
  ) {
    paginaInChiusura = true;

    window.location.href =
      ORIGINE_SERVER +
      "/login.html?redirect=" +
      encodeURIComponent(
        window.location.href
      );
  }
}

function programmaRiconnessione() {
  if (paginaInChiusura) {
    return;
  }

  clearTimeout(
    timerRiconnessione
  );

  timerRiconnessione =
    setTimeout(
      connetti,
      1800
    );
}

function connetti() {
  clearTimeout(
    timerRiconnessione
  );

  if (paginaInChiusura) {
    return;
  }

  if (
    socket &&
    (
      socket.readyState ===
        WebSocket.OPEN ||
      socket.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  const q =
    new URLSearchParams({
      gioco: "othello",
      stanza
    });

  const token =
    tokenAutenticazione();

  if (token) {
    q.set(
      "token",
      token
    );
  }

  if (partitaId) {
    q.set(
      "partita",
      partitaId
    );
  }

  const miaGenerazione =
    ++generazioneSocket;

  let ws;

  try {
    ws =
      new WebSocket(
        URL_WEBSOCKET +
          "/?" +
          q.toString()
      );
  } catch (errore) {
    console.error(
      "Apertura WebSocket non riuscita:",
      errore
    );

    impostaStatoConnessione(
      true
    );

    programmaRiconnessione();

    return;
  }

  socket = ws;

  ws.onopen = () => {
    /*
     * Una nuova connessione significa
     * che vogliamo uno snapshot autorevole.
     */
    if (
      socket !== ws ||
      miaGenerazione !==
        generazioneSocket
    ) {
      return;
    }

    attesaSnapshot = true;

    mossaInAttesa =
      false;

    clearTimeout(
      timerMossaInAttesa
    );

    timerMossaInAttesa =
      null;

    impostaStatoConnessione(
      false
    );

    aggiornaCaricamento(
      "Sincronizzazione partita…",
      70
    );

    inviaSocket(
      {
        tipo: "othello_entra",
        partitaId:
          partitaId ||
          null,
        stanza
      },
      ws
    );
  };

  ws.onmessage = evento => {
    if (
      socket !== ws ||
      miaGenerazione !==
        generazioneSocket
    ) {
      return;
    }

    let dati;

    try {
      dati =
        JSON.parse(
          evento.data
        );
    } catch (errore) {
      console.error(
        "Messaggio WebSocket non valido:",
        errore
      );

      return;
    }

    gestisciMessaggioSocket(
      dati,
      ws
    );
  };

  ws.onerror = () => {
    /*
     * onclose gestisce la riconnessione.
     * Non facciamo due riconnessioni.
     */
  };

  ws.onclose = () => {
    if (
      socket !== ws ||
      miaGenerazione !==
        generazioneSocket
    ) {
      return;
    }

    socket = null;

    if (paginaInChiusura) {
      return;
    }

    /*
     * Qualsiasi operazione asincrona
     * precedente non deve più considerarsi
     * autorevole.
     */
    ++generazioneSocket;

    attesaSnapshot = true;

    mossaInAttesa =
      false;

    clearTimeout(
      timerMossaInAttesa
    );

    timerMossaInAttesa =
      null;

    annullaAnimazioneDischi();

    impostaStatoConnessione(
      true
    );

    const messaggi =
      document.getElementById(
        "messaggi-gioco"
      );

    if (messaggi) {
      messaggi.textContent =
        "Connessione persa — riconnessione in corso…";
    }

    programmaRiconnessione();
  };
}

/* =========================================================
   AVVIO
   ========================================================= */

async function avvia() {
  inizializzaGestioneLayout();

  aggiornaTestoBottoneSuoni();

  render();

  if (!partitaId) {
    aggiornaCaricamento(
      "Partita non specificata",
      100
    );

    terminaCaricamento(
      "Partita non specificata"
    );

    mostraNotificaGioco(
      "Manca l'identificativo della partita. Ritorno alla lobby…"
    );

    setTimeout(
      tornaAllaLobby,
      1800
    );

    return;
  }

  timerMassimoCaricamento =
    setTimeout(() => {
      const overlay =
        document.getElementById(
          "overlay-caricamento"
        );

      if (
        overlay &&
        !overlay.classList.contains(
          "caricamento-finito"
        )
      ) {
        document.body.classList.remove(
          "caricamento-in-corso"
        );

        overlay.classList.add(
          "caricamento-finito"
        );

        mostraNotificaGioco(
          "Il caricamento sta richiedendo più tempo del previsto. La connessione continuerà in automatico."
        );
      }
    }, 20000);

  aggiornaCaricamento(
    "Verifica accesso…",
    25
  );

  try {
    const token =
      tokenAutenticazione();

    const opzioni = {
      credentials: "include",
      cache: "no-store",
      headers: token
        ? {
            Authorization:
              "Bearer " +
              token
          }
        : {}
    };

    let risposta =
      await fetch(
        ORIGINE_SERVER +
          "/api/me-menu",
        opzioni
      );

    if (
      token &&
      (
        risposta.status ===
          401 ||
        risposta.status ===
          403
      )
    ) {
      risposta =
        await fetch(
          ORIGINE_SERVER +
            "/api/me-menu",
          {
            credentials:
              "include",
            cache:
              "no-store"
          }
        );

      if (risposta.ok) {
        try {
          if (
            sessionStorage.getItem(
              CHIAVE_TOKEN_AUTH
            ) === token
          ) {
            sessionStorage.removeItem(
              CHIAVE_TOKEN_AUTH
            );
          }
        } catch (_) {}
      }
    }

    if (
      risposta.status === 401 ||
      risposta.status === 403
    ) {
      paginaInChiusura =
        true;

      window.location.href =
        ORIGINE_SERVER +
        "/login.html?redirect=" +
        encodeURIComponent(
          window.location.href
        );

      return;
    }

    if (risposta.ok) {
      const profilo =
        await risposta.json();

      if (
        profilo &&
        profilo.uid
      ) {
        mioUid =
          profilo.uid;
      }
    }
  } catch (errore) {
    console.warn(
      "Verifica HTTP non disponibile, provo il WebSocket:",
      errore
    );
  }

  aggiornaCaricamento(
    "Connessione alla partita…",
    55
  );

  connetti();
}

/* =========================================================
   EVENTI UI
   ========================================================= */

const btnMenu =
  document.getElementById(
    "btn-menu"
  );

if (btnMenu) {
  btnMenu.onclick =
    evento => {
      evento.stopPropagation();

      const pannello =
        document.getElementById(
          "pannello-menu"
        );

      if (!pannello) {
        return;
      }

      const staPerAprirsi =
        pannello.classList.contains(
          "nascosto"
        );

      if (staPerAprirsi) {
        chiudiChat();
        chiudiPannelloGiocatori();
      }

      const aperto =
        !pannello.classList.toggle(
          "nascosto"
        );

      btnMenu.setAttribute(
        "aria-expanded",
        aperto
          ? "true"
          : "false"
      );

      btnMenu.setAttribute(
        "aria-label",
        aperto
          ? "Chiudi menu"
          : "Apri menu"
      );
    };
}

document.addEventListener(
  "click",
  evento => {
    /*
     * Non chiudere il menu quando il click
     * parte direttamente dal bottone.
     */
    if (
      evento.target.closest?.(
        "#btn-menu"
      )
    ) {
      return;
    }

    chiudiMenu();
  }
);

const btnGiocatori =
  document.getElementById(
    "btn-giocatori"
  );

if (btnGiocatori) {
  btnGiocatori.onclick =
    evento => {
      evento.stopPropagation();

      const pannello =
        document.getElementById(
          "pannello-giocatori"
        );

      if (!pannello) return;

      const staPerAprirsi =
        !pannello.classList.contains(
          "aperto"
        );

      if (staPerAprirsi) {
        chiudiMenu();
        chiudiChat();
      }

      const aperto =
        pannello.classList.toggle(
          "aperto"
        );

      document
        .getElementById(
          "backdrop-giocatori"
        )
        ?.classList.toggle(
          "aperto",
          aperto
        );

      btnGiocatori.setAttribute(
        "aria-expanded",
        aperto
          ? "true"
          : "false"
      );

      btnGiocatori.setAttribute(
        "aria-label",
        aperto
          ? "Nascondi giocatori"
          : "Mostra giocatori"
      );
    };
}

document
  .getElementById(
    "backdrop-giocatori"
  )
  ?.addEventListener(
    "click",
    chiudiPannelloGiocatori
  );

const btnChat =
  document.getElementById(
    "btn-chat"
  );

if (btnChat) {
  btnChat.onclick =
    evento => {
      evento.stopPropagation();

      const pannello =
        document.getElementById(
          "pannello-chat"
        );

      if (!pannello) return;

      const staPerAprirsi =
        pannello.classList.contains(
          "nascosto"
        );

      if (staPerAprirsi) {
        chiudiMenu();
        chiudiPannelloGiocatori();
      }

      const aperto =
        !pannello.classList.toggle(
          "nascosto"
        );

      btnChat.setAttribute(
        "aria-expanded",
        aperto
          ? "true"
          : "false"
      );

      btnChat.setAttribute(
        "aria-label",
        aperto
          ? "Chiudi chat"
          : "Apri chat"
      );

      if (aperto) {
        messaggiChatNonLetti =
          0;

        aggiornaBadgeChatPartita();

        setTimeout(
          () =>
            document
              .getElementById(
                "chat-input"
              )
              ?.focus(),
          0
        );
      }
    };
}

document
  .getElementById(
    "chat-input"
  )
  ?.addEventListener(
    "keydown",
    evento => {
      if (
        evento.key === "Enter" &&
        !evento.isComposing
      ) {
        evento.preventDefault();

        inviaChatPartita();
      }
    }
  );

document.addEventListener(
  "keydown",
  evento => {
    if (
      evento.key !== "Escape"
    ) {
      return;
    }

    chiudiMenu();
    chiudiChat();
    chiudiPannelloGiocatori();

    if (
      risolviConfermaGioco
    ) {
      chiudiConfermaGioco(
        false
      );
    }
  }
);

/* =========================================================
   LIFECYCLE PAGINA
   ========================================================= */

function chiudiConnessionePagina() {
  paginaInChiusura = true;

  clearTimeout(
    timerRiconnessione
  );

  clearTimeout(
    timerMossaInAttesa
  );

  clearTimeout(
    timerChiusuraPresentazioneSfida
  );

  annullaAnimazioneDischi();

  try {
    socket?.close();
  } catch (_) {}

  socket = null;
}

window.addEventListener(
  "pagehide",
  chiudiConnessionePagina
);

window.addEventListener(
  "beforeunload",
  chiudiConnessionePagina
);

window.addEventListener(
  "pageshow",
  evento => {
    /*
     * Se la pagina è stata ripristinata
     * dalla BFCache, ristabiliamo la
     * connessione.
     */
    if (
      evento.persisted
    ) {
      paginaInChiusura =
        false;

      attesaSnapshot =
        true;

      vittoriaMostrata =
        false;

      tavolaDisegnata =
        null;

      ++generazioneSocket;

      connetti();
    }
  }
);

/* =========================================================
   TIMER GLOBALE
   ========================================================= */

setInterval(
  aggiornaCountdownTurno,
  250
);

/* =========================================================
   AVVIO
   ========================================================= */

avvia();
