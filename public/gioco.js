/* ============================================================
   GIOCO.JS
   CLIENT MULTIPLAYER REAL-TIME
   ============================================================

   PRINCIPI DI SINCRONIZZAZIONE

   1. Il SERVER è l'autorità assoluta:
      - turno attuale
      - tempo di inizio turno
      - scadenza turno
      - risultato dei dadi
      - posizione reale delle pedine
      - passaggio del turno
      - vittoria

   2. Il CLIENT:
      - visualizza il countdown usando timestamp assoluti
      - anima dadi e pedine
      - gestisce menu/chat/audio
      - invia solamente richieste di azione

   3. Il countdown NON viene mai calcolato accumulando
      decrementi locali. Viene sempre calcolato come:

          scadenzaTurno - Date.now()

      Questo evita progressivamente lo sfasamento.

   4. Durante l'animazione di una mossa, il nuovo stato ricevuto
      dal server può essere memorizzato senza spostare subito
      le pedine. Alla fine dell'animazione viene applicato.

   ============================================================ */

/* ============================================================
   CONFIGURAZIONE
   ============================================================ */

const URL_SERVER_HTTP =
  "https://gioco-oca-server.onrender.com";

const URL_SERVER_WS =
  "wss://gioco-oca-server.onrender.com";

/*
 * Devono corrispondere al server.
 */
const DURATA_LANCIO_DADI_MS = 700;
const DURATA_SALTO_MS = 220;
const DURATA_ANIMAZIONE_MASSIMA_MS = 6000;

/*
 * Tolleranza visiva locale.
 *
 * Il server resta comunque l'autorità:
 * questo valore NON viene usato per autorizzare un tiro.
 */
const TOLLERANZA_VISIVA_MS = 2000;

/* ============================================================
   POSIZIONI CASELLE
   ============================================================ */

const posizioniCaselle = {
  1: { x: 2246, y: 817 },
  2: { x: 2227, y: 1064 },
  3: { x: 2102, y: 1329 },
  4: { x: 1801, y: 1545 },
  5: { x: 1421, y: 1599 },
  6: { x: 1126, y: 1591 },
  7: { x: 873, y: 1591 },
  8: { x: 567, y: 1518 },
  9: { x: 321, y: 1286 },
  10: { x: 249, y: 1017 },
  11: { x: 244, y: 759 },
  12: { x: 334, y: 492 },
  13: { x: 591, y: 298 },
  14: { x: 897, y: 258 },
  15: { x: 1139, y: 257 },
  16: { x: 1366, y: 246 },
  17: { x: 1674, y: 286 },
  18: { x: 1933, y: 490 },
  19: { x: 2008, y: 720 },
  20: { x: 2016, y: 974 },
  21: { x: 1930, y: 1232 },
  22: { x: 1694, y: 1395 },
  23: { x: 1325, y: 1423 },
  24: { x: 993, y: 1428 },
  25: { x: 673, y: 1386 },
  26: { x: 465, y: 1205 },
  27: { x: 435, y: 992 },
  28: { x: 425, y: 802 },
  29: { x: 480, y: 590 },
  30: { x: 685, y: 427 },
  31: { x: 999, y: 403 },
  32: { x: 1287, y: 398 },
  33: { x: 1578, y: 425 },
  34: { x: 1779, y: 579 },
  35: { x: 1811, y: 766 },
  36: { x: 1816, y: 943 },
  37: { x: 1765, y: 1134 },
  38: { x: 1566, y: 1264 },
  39: { x: 1269, y: 1275 },
  40: { x: 1022, y: 1267 },
  41: { x: 776, y: 1248 },
  42: { x: 622, y: 1106 },
  43: { x: 606, y: 967 },
  44: { x: 592, y: 829 },
  45: { x: 629, y: 676 },
  46: { x: 767, y: 554 },
  47: { x: 1044, y: 546 },
  48: { x: 1260, y: 527 },
  49: { x: 1505, y: 546 },
  50: { x: 1635, y: 722 },
  51: { x: 1639, y: 979 },
  52: { x: 1484, y: 1135 },
  53: { x: 1243, y: 1146 },
  54: { x: 1049, y: 1143 },
  55: { x: 857, y: 1129 },
  56: { x: 739, y: 986 },
  57: { x: 733, y: 798 },
  58: { x: 866, y: 679 },
  59: { x: 1040, y: 670 },
  60: { x: 1236, y: 668 },
  61: { x: 1400, y: 665 },
  62: { x: 1506, y: 738 },
  63: { x: 1486, y: 926 }
};

/* ============================================================
   COLORI PEDINE
   ============================================================ */

const coloriGiocatori = [
  "#6a2c70",
  "#dddddd",
  "#1e40af",
  "#43a047",
  "#f57c00",
  "#c0ca33",
  "#e53935",
  "#2b2b2b"
];

const coloriAvatarFallback = [
  "#6a2c70",
  "#1e40af",
  "#43a047",
  "#f57c00",
  "#c0ca33",
  "#e53935",
  "#00838f",
  "#8d6e63"
];

/* ============================================================
   PARAMETRI URL
   ============================================================ */

const params =
  new URLSearchParams(
    window.location.search
  );

const partitaId =
  params.get("partita");

const stanza =
  params.get("stanza");

/* ============================================================
   STATO GLOBALE PARTITA
   ============================================================ */

let mioUid = null;
let mioNickname = null;

let socket = null;

let ultimoStatoGiocatori = [];

let mioTurno = false;
let turnoAttualeId = null;

let faseAttuale = "connessione";

/*
 * "animazioneMovimentoInCorso" protegge la scena
 * dal salto improvviso della pedina quando arriva
 * il messaggio "statoPartita" subito dopo "aggiornamentoPartita".
 */
let animazioneMovimentoInCorso = false;

let statoPartitaInCoda = null;

/*
 * Impedisce di mostrare due volte la vittoria.
 */
let partitaTerminataLocale = false;

/*
 * Ultima azione inviata dal client.
 * Serve per evitare doppi click molto rapidi.
 */
let azioneLocaleInCorso = false;

/* ============================================================
   RICONNESSIONE
   ============================================================ */

let timerRiconnessione = null;
let tentativoRiconnessioneInCorso = false;

let numeroTentativiRiconnessione = 0;

const MAX_RICONNESSIONE_MS = 10000;

/* ============================================================
   TIMER CLIENT
   ============================================================ */

let tempoInizioTurnoAttuale = null;
let durataMossaMsAttuale = null;
let scadenzaTurnoAttuale = null;

let intervalCountdown = null;

let ultimoSecondoAvviso = null;

let turnoLocalmenteCompletato = false;

/* ============================================================
   DETERMINAZIONE ORDINE
   ============================================================ */

let possoTirareIoInDeterminazione = false;

/* ============================================================
   SUONI
   ============================================================ */

let suoniAttivi =
  localStorage.getItem(
    "suoniAttivi"
  ) !== "off";

let contestoAudio = null;

function ottieniContestoAudio() {
  try {
    if (!contestoAudio) {
      const AudioContextCtor =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContextCtor) {
        return null;
      }

      contestoAudio =
        new AudioContextCtor();
    }

    if (
      contestoAudio.state ===
      "suspended"
    ) {
      const promessa =
        contestoAudio.resume();

      if (
        promessa &&
        typeof promessa.catch ===
          "function"
      ) {
        promessa.catch(() => {});
      }
    }

    return contestoAudio;
  } catch {
    return null;
  }
}

function suonaTono(
  frequenza,
  durataMs,
  tipoOnda = "sine",
  volume = 0.12,
  ritardoMs = 0
) {
  if (!suoniAttivi) {
    return;
  }

  const ctx =
    ottieniContestoAudio();

  if (!ctx) {
    return;
  }

  try {
    const inizio =
      ctx.currentTime +
      Math.max(
        0,
        Number(ritardoMs) || 0
      ) /
        1000;

    const durataSecondi =
      Math.max(
        0.02,
        Number(durataMs) / 1000
      );

    const osc =
      ctx.createOscillator();

    const gain =
      ctx.createGain();

    osc.type =
      tipoOnda || "sine";

    osc.frequency.setValueAtTime(
      Number(frequenza) || 440,
      inizio
    );

    gain.gain.setValueAtTime(
      0.0001,
      inizio
    );

    gain.gain.linearRampToValueAtTime(
      Math.max(
        0.0001,
        Number(volume) || 0.12
      ),
      inizio + 0.01
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      inizio + durataSecondi
    );

    osc.connect(gain);
    gain.connect(
      ctx.destination
    );

    osc.start(inizio);

    osc.stop(
      inizio +
        durataSecondi +
        0.03
    );
  } catch {}
}

function suonaClick(
  volume = 0.18,
  ritardoMs = 0
) {
  if (!suoniAttivi) {
    return;
  }

  const ctx =
    ottieniContestoAudio();

  if (!ctx) {
    return;
  }

  try {
    const inizio =
      ctx.currentTime +
      Math.max(
        0,
        Number(ritardoMs) || 0
      ) /
        1000;

    const durata =
      0.045;

    const lunghezza =
      Math.max(
        1,
        Math.floor(
          ctx.sampleRate *
            durata
        )
      );

    const buffer =
      ctx.createBuffer(
        1,
        lunghezza,
        ctx.sampleRate
      );

    const dati =
      buffer.getChannelData(0);

    for (
      let i = 0;
      i < lunghezza;
      i++
    ) {
      const decadimento =
        1 -
        i / lunghezza;

      dati[i] =
        (Math.random() * 2 - 1) *
        decadimento;
    }

    const source =
      ctx.createBufferSource();

    source.buffer =
      buffer;

    const gain =
      ctx.createGain();

    gain.gain.setValueAtTime(
      Number(volume) || 0.18,
      inizio
    );

    gain.gain.exponentialRampToValueAtTime(
      0.001,
      inizio + durata
    );

    source.connect(gain);
    gain.connect(
      ctx.destination
    );

    source.start(inizio);
  } catch {}
}

function suonaTiroDadi() {
  if (!suoniAttivi) {
    return;
  }

  for (
    let i = 0;
    i < 7;
    i++
  ) {
    suonaClick(
      0.085,
      i * 100
    );
  }
}

function suonaAtterraggioDadi() {
  suonaTono(
    180,
    90,
    "square",
    0.14,
    0
  );

  suonaClick(
    0.15,
    20
  );
}

function suonaPassoPedina() {
  suonaTono(
    520,
    55,
    "sine",
    0.09,
    0
  );
}

function suonaTuoTurno() {
  suonaTono(
    660,
    120,
    "sine",
    0.11,
    0
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
  suonaTono(
    523,
    130,
    "sine",
    0.13,
    0
  );

  suonaTono(
    659,
    130,
    "sine",
    0.13,
    130
  );

  suonaTono(
    784,
    130,
    "sine",
    0.13,
    260
  );

  suonaTono(
    1047,
    260,
    "sine",
    0.14,
    390
  );
}

function suonaMessaggioChat() {
  suonaTono(
    740,
    70,
    "sine",
    0.08,
    0
  );
}

function suonaAvvisoTempo() {
  suonaTono(
    300,
    90,
    "triangle",
    0.14,
    0
  );
}

function suonaRichiestaAudio() {
  suonaTono(
    700,
    90,
    "sine",
    0.12,
    0
  );

  suonaTono(
    900,
    120,
    "sine",
    0.12,
    130
  );
}

function impostaSuoni(attivi) {
  suoniAttivi =
    Boolean(attivi);

  localStorage.setItem(
    "suoniAttivi",
    suoniAttivi
      ? "on"
      : "off"
  );

  aggiornaTestoBottoneSuoni();
}

function toggleSuoni() {
  impostaSuoni(
    !suoniAttivi
  );
}

function aggiornaTestoBottoneSuoni() {
  const bottone =
    document.getElementById(
      "btn-toggle-suoni"
    );

  if (!bottone) {
    return;
  }

  bottone.textContent =
    suoniAttivi
      ? "🔊 Suoni: On"
      : "🔇 Suoni: Off";
}

/* ============================================================
   UTILITY TESTO / HTML
   ============================================================ */

function iniziale(nome) {
  const testo =
    String(nome || "?")
      .trim();

  return (
    testo.charAt(0)
      .toUpperCase() ||
    "?"
  );
}

function coloreDaNome(nome) {
  const testo =
    String(nome || "?");

  let somma = 0;

  for (
    let i = 0;
    i < testo.length;
    i++
  ) {
    somma +=
      testo.charCodeAt(i);
  }

  return (
    coloriAvatarFallback[
      somma %
        coloriAvatarFallback.length
    ]
  );
}

function escapeHtmlTesto(testo) {
  const div =
    document.createElement("div");

  div.textContent =
    String(testo || "");

  return div.innerHTML;
}

function isImageDataUriValida(
  valore
) {
  if (
    typeof valore !==
    "string"
  ) {
    return false;
  }

  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(
    valore
  );
}

/* ============================================================
   FULLSCREEN
   ============================================================ */

function toggleFullscreen() {
  try {
    const fullscreenAttivo =
      Boolean(
        document.fullscreenElement ||
          document.webkitFullscreenElement
      );

    if (!fullscreenAttivo) {
      const elemento =
        document.documentElement;

      const richiesta =
        elemento.requestFullscreen ||
        elemento.webkitRequestFullscreen ||
        elemento.mozRequestFullScreen ||
        elemento.msRequestFullscreen;

      if (!richiesta) {
        alert(
          "Il tuo browser non supporta lo schermo intero."
        );

        return;
      }

      const risultato =
        richiesta.call(
          elemento
        );

      if (
        risultato &&
        typeof risultato.catch ===
          "function"
      ) {
        risultato.catch(
          () => {}
        );
      }
    } else {
      const esci =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;

      if (esci) {
        const risultato =
          esci.call(
            document
          );

        if (
          risultato &&
          typeof risultato.catch ===
            "function"
        ) {
          risultato.catch(
            () => {}
          );
        }
      }
    }
  } catch {
    alert(
      "Non è stato possibile modificare lo schermo intero."
    );
  }
}

function aggiornaTestoBottoneFullscreen() {
  const bottone =
    document.getElementById(
      "btn-toggle-fullscreen"
    );

  if (!bottone) {
    return;
  }

  const attivo =
    Boolean(
      document.fullscreenElement ||
        document.webkitFullscreenElement
    );

  bottone.textContent =
    attivo
      ? "🡼 Esci da tutto schermo"
      : "⛶ Tutto schermo";
}

/* ============================================================
   ORIENTAMENTO / LAYOUT
   ============================================================ */

function eSchermoInLandscape() {
  try {
    if (
      window.screen &&
      window.screen.orientation &&
      typeof window.screen.orientation
        .type ===
        "string"
    ) {
      const orientamento =
        window.screen.orientation.type;

      if (
        orientamento ===
          "landscape-primary" ||
        orientamento ===
          "landscape-secondary"
      ) {
        return true;
      }

      if (
        orientamento ===
          "portrait-primary" ||
        orientamento ===
          "portrait-secondary"
      ) {
        return false;
      }
    }
  } catch {}

  return (
    window.innerWidth >
    window.innerHeight
  );
}

function rilevaEImpostaModalitaDesktop() {
  const puntatorePreciso =
    Boolean(
      window.matchMedia &&
        window.matchMedia(
          "(pointer: fine)"
        ).matches
    );

  const schermoAmpio =
    window.innerWidth >=
    1000;

  document.body.classList.toggle(
    "modalita-desktop",
    Boolean(
      puntatorePreciso &&
        schermoAmpio
    )
  );
}

function calcolaEAggiornaOrientamento() {
  const eDesktop =
    document.body.classList.contains(
      "modalita-desktop"
    );

  const eLandscape =
    eSchermoInLandscape();

  document.body.classList.remove(
    "richiede-rotazione"
  );

  document.body.classList.toggle(
    "tabellone-ruotato",
    !eDesktop &&
      !eLandscape
  );

  const altezzaReale =
    window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;

  document.documentElement.style.setProperty(
    "--altezza-reale",
    altezzaReale +
      "px"
  );
}

function immaginePronta() {
  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  return Boolean(
    immagine &&
      immagine.complete &&
      immagine.naturalWidth >
        0 &&
      immagine.naturalHeight >
        0
  );
}

function aggiornaLayoutTabellone() {
  const areaTabellone =
    document.getElementById(
      "area-tabellone"
    );

  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  if (
    !areaTabellone ||
    !immagine
  ) {
    return;
  }

  const rapportoNaturale =
    immagine.naturalWidth >
      0 &&
    immagine.naturalHeight >
      0
      ? immagine.naturalWidth /
        immagine.naturalHeight
      : 1.48;

  const eDesktop =
    document.body.classList.contains(
      "modalita-desktop"
    );

  const eLandscape =
    eSchermoInLandscape();

  const larghezzaFinestra =
    window.visualViewport
      ? window.visualViewport.width
      : window.innerWidth;

  const altezzaReale =
    window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;

  let larghezza;
  let altezza;

  if (eDesktop) {
    const margineOrizzontale =
      Math.max(
        16,
        larghezzaFinestra *
          0.03
      );

    const margineVerticale =
      Math.max(
        16,
        altezzaReale *
          0.03
      );

    const larghezzaDisponibile =
      Math.max(
        120,
        larghezzaFinestra -
          margineOrizzontale *
            2
      );

    const altezzaDisponibile =
      Math.max(
        120,
        altezzaReale -
          margineVerticale *
            2
      );

    larghezza =
      Math.min(
        larghezzaDisponibile,
        altezzaDisponibile *
          rapportoNaturale
      );

    altezza =
      larghezza /
      rapportoNaturale;
  } else if (eLandscape) {
    const margineOrizzontale = 8;
    const margineVerticale = 8;

    const larghezzaDisponibile =
      Math.max(
        120,
        larghezzaFinestra -
          margineOrizzontale *
            2
      );

    const altezzaDisponibile =
      Math.max(
        120,
        altezzaReale -
          margineVerticale *
            2
      );

    larghezza =
      Math.min(
        larghezzaDisponibile,
        altezzaDisponibile *
          rapportoNaturale
      );

    altezza =
      larghezza /
      rapportoNaturale;
  } else {
    const margine = 8;

    const larghezzaDisponibile =
      Math.max(
        120,
        larghezzaFinestra -
          margine *
            2
      );

    const altezzaDisponibile =
      Math.max(
        120,
        altezzaReale -
          margine *
            2
      );

    altezza =
      larghezzaDisponibile;

    larghezza =
      altezza *
      rapportoNaturale;

    if (
      larghezza >
      altezzaDisponibile
    ) {
      larghezza =
        altezzaDisponibile;

      altezza =
        larghezza /
        rapportoNaturale;
    }
  }

  if (
    !Number.isFinite(
      larghezza
    ) ||
    !Number.isFinite(
      altezza
    )
  ) {
    return;
  }

  areaTabellone.style.width =
    larghezza + "px";

  areaTabellone.style.height =
    altezza + "px";

  riposizionaTuttePedine();
}

let timerDebounceResize =
  null;

function gestisciResize() {
  rilevaEImpostaModalitaDesktop();

  calcolaEAggiornaOrientamento();

  clearTimeout(
    timerDebounceResize
  );

  timerDebounceResize =
    setTimeout(
      () => {
        aggiornaLayoutTabellone();
      },
      60
    );
}

function inizializzaGestioneOrientamento() {
  rilevaEImpostaModalitaDesktop();
  calcolaEAggiornaOrientamento();

  if (immaginePronta()) {
    aggiornaLayoutTabellone();
  }

  window.addEventListener(
    "resize",
    gestisciResize,
    {
      passive: true
    }
  );

  window.addEventListener(
    "orientationchange",
    () => {
      setTimeout(
        gestisciResize,
        50
      );

      setTimeout(
        gestisciResize,
        300
      );

      setTimeout(
        gestisciResize,
        700
      );
    },
    {
      passive: true
    }
  );

  if (
    window.visualViewport
  ) {
    window.visualViewport.addEventListener(
      "resize",
      gestisciResize,
      {
        passive: true
      }
    );
  }

  if (
    window.screen &&
    window.screen.orientation &&
    typeof window.screen
      .orientation
      .addEventListener ===
      "function"
  ) {
    window.screen.orientation.addEventListener(
      "change",
      () => {
        setTimeout(
          gestisciResize,
          50
        );

        setTimeout(
          gestisciResize,
          300
        );
      },
      {
        passive: true
      }
    );
  }

  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  if (
    immagine &&
    !immaginePronta()
  ) {
    immagine.addEventListener(
      "load",
      () => {
        aggiornaLayoutTabellone();
      },
      {
        once: true
      }
    );
  }
}

/* ============================================================
   MESSAGGIO GRANDE
   ============================================================ */

let timerFlashMessaggio =
  null;

function mostraMessaggioGiocoGrande(
  testo
) {
  const testoPulito =
    String(testo || "").trim();

  if (!testoPulito) {
    return;
  }

  const elemento =
    document.getElementById(
      "flash-messaggio-gioco"
    );

  if (!elemento) {
    return;
  }

  if (
    testoPulito
      .toLowerCase()
      .includes(
        "avanza dello stesso numero di caselle"
      )
  ) {
    return;
  }

  const span =
    elemento.querySelector(
      "span"
    );

  if (!span) {
    return;
  }

  if (
    span.textContent ===
      testoPulito &&
    elemento.classList.contains(
      "visibile"
    )
  ) {
    return;
  }

  span.textContent =
    testoPulito;

  elemento.classList.remove(
    "visibile"
  );

  void elemento.offsetWidth;

  elemento.classList.add(
    "visibile"
  );

  if (
    timerFlashMessaggio
  ) {
    clearTimeout(
      timerFlashMessaggio
    );
  }

  timerFlashMessaggio =
    setTimeout(
      () => {
        elemento.classList.remove(
          "visibile"
        );
      },
      1800
    );
}

/* ============================================================
   DETERMINAZIONE DADI
   ============================================================ */

let areaDadiHomeGenitore =
  null;

let areaDadiHomeFratelloSuccessivo =
  null;

function spostaDadiInDeterminazione() {
  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  const slot =
    document.getElementById(
      "slot-dadi-determinazione"
    );

  if (
    !areaDadi ||
    !slot
  ) {
    return false;
  }

  if (
    areaDadi.parentNode ===
    slot
  ) {
    return false;
  }

  areaDadiHomeGenitore =
    areaDadi.parentNode;

  areaDadiHomeFratelloSuccessivo =
    areaDadi.nextSibling;

  slot.appendChild(
    areaDadi
  );

  areaDadi.classList.add(
    "dadi-in-popup"
  );

  return true;
}

function riportaDadiAllaPartita() {
  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  if (
    !areaDadi ||
    !areaDadiHomeGenitore
  ) {
    return;
  }

  if (
    areaDadiHomeFratelloSuccessivo &&
    areaDadiHomeFratelloSuccessivo.parentNode ===
      areaDadiHomeGenitore
  ) {
    areaDadiHomeGenitore.insertBefore(
      areaDadi,
      areaDadiHomeFratelloSuccessivo
    );
  } else {
    areaDadiHomeGenitore.appendChild(
      areaDadi
    );
  }

  areaDadi.classList.remove(
    "dadi-in-popup"
  );
}

function creaAvatarMini(
  nome,
  avatar,
  colore
) {
  if (
    isImageDataUriValida(
      avatar
    )
  ) {
    const img =
      document.createElement(
        "img"
      );

    img.className =
      "avatar-mini";

    img.alt = "";

    img.loading =
      "lazy";

    img.decoding =
      "async";

    img.src = avatar;

    return img;
  }

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "avatar-mini";

  div.style.background =
    colore ||
    coloreDaNome(
      nome
    );

  div.textContent =
    iniziale(nome);

  return div;
}

function disegnaListaDeterminazione(
  giocatori,
  turnoInCorsoUid,
  gruppoSpareggio
) {
  const lista =
    document.getElementById(
      "lista-determinazione"
    );

  if (!lista) {
    return;
  }

  lista.replaceChildren();

  const elenco =
    Array.isArray(
      giocatori
    )
      ? giocatori
      : [];

  const spareggioSet =
    new Set(
      Array.isArray(
        gruppoSpareggio
      )
        ? gruppoSpareggio
        : []
    );

  elenco.forEach(
    g => {
      const riga =
        document.createElement(
          "div"
        );

      riga.className =
        "determinazione-riga" +
        (
          String(g.uid) ===
          String(
            turnoInCorsoUid
          )
            ? " determinazione-riga-attiva"
            : ""
        );

      const avatar =
        creaAvatarMini(
          g.nome,
          g.avatar,
          coloreDaNome(
            g.nome
          )
        );

      riga.appendChild(
        avatar
      );

      const nome =
        document.createElement(
          "span"
        );

      nome.className =
        "determinazione-nome";

      nome.textContent =
        g.nome ||
        "Giocatore";

      riga.appendChild(
        nome
      );

      if (
        spareggioSet.has(
          g.uid
        )
      ) {
        const tag =
          document.createElement(
            "span"
          );

        tag.className =
          "determinazione-tag-spareggio";

        tag.title =
          "In spareggio";

        tag.textContent =
          "⚔️";

        riga.appendChild(
          tag
        );
      }

      if (
        g.risultato !==
          null &&
        g.risultato !==
          undefined
      ) {
        const risultato =
          document.createElement(
            "span"
          );

        risultato.className =
          "determinazione-risultato";

        risultato.textContent =
          "🎲 " +
          String(
            g.risultato
          );

        riga.appendChild(
          risultato
        );
      } else if (
        String(g.uid) ===
        String(
          turnoInCorsoUid
        )
      ) {
        const stato =
          document.createElement(
            "span"
          );

        stato.className =
          "determinazione-in-corso";

        stato.textContent =
          "🎲 sta tirando...";

        riga.appendChild(
          stato
        );
      } else {
        const stato =
          document.createElement(
            "span"
          );

        stato.className =
          "determinazione-attesa";

        stato.textContent =
          "in attesa";

        riga.appendChild(
          stato
        );
      }

      lista.appendChild(
        riga
      );
    }
  );
}

function gestisciStatoDeterminazione(
  dati
) {
  faseAttuale =
    "determinazione";

  azioneLocaleInCorso =
    false;

  const overlay =
    document.getElementById(
      "overlay-determinazione"
    );

  if (overlay) {
    overlay.classList.add(
      "aperto"
    );
  }

  spostaDadiInDeterminazione();

  if (
    !document.querySelector(
      "#dado1 .cubo"
    )
  ) {
    mostraDadi(
      1,
      1
    );
  }

  const giocatori =
    Array.isArray(
      dati.giocatori
    )
      ? dati.giocatori
      : [];

  disegnaListaDeterminazione(
    giocatori,
    dati.turnoInCorsoUid ||
      null,
    dati.gruppoSpareggioAttuale ||
      []
  );

  possoTirareIoInDeterminazione =
    String(
      dati.turnoInCorsoUid ||
        ""
    ) ===
    String(
      mioUid ||
        ""
    ) &&
    Boolean(
      dati.turnoInCorsoUid
    );

  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  if (areaDadi) {
    areaDadi.classList.toggle(
      "disabilitato",
      !possoTirareIoInDeterminazione
    );
  }

  const sottotitolo =
    document.getElementById(
      "sottotitolo-determinazione"
    );

  const gruppoSpareggio =
    Array.isArray(
      dati.gruppoSpareggioAttuale
    )
      ? dati.gruppoSpareggioAttuale
      : [];

  if (
    gruppoSpareggio.length
  ) {
    const nomi =
      gruppoSpareggio
        .map(
          uid => {
            const trovato =
              giocatori.find(
                g =>
                  String(
                    g.uid
                  ) ===
                  String(uid)
              );

            return trovato
              ? trovato.nome
              : "?";
          }
        )
        .join(", ");

    if (sottotitolo) {
      sottotitolo.textContent =
        "⚔️ Pareggio tra " +
        nomi +
        " — nuovo tiro per decidere l'ordine tra loro!";
    }
  } else if (
    possoTirareIoInDeterminazione
  ) {
    if (sottotitolo) {
      sottotitolo.textContent =
        "Tocca a te: tira i dadi!";
    }
  } else {
    const inAttesaDi =
      giocatori.find(
        g =>
          String(
            g.uid
          ) ===
          String(
            dati.turnoInCorsoUid ||
              ""
          )
      );

    if (sottotitolo) {
      sottotitolo.textContent =
        inAttesaDi
          ? "In attesa che " +
            inAttesaDi.nome +
            " tiri..."
          : "I giocatori tirano i dadi uno alla volta.";
    }
  }

  /*
   * Il server invia già scadenzaTurno.
   * La usiamo direttamente, senza ricostruire
   * il timer a partire da un numero di secondi locale.
   */
  const haTimer =
    dati.tempoInizioTurno !=
      null &&
    dati.durataMossaMs !=
      null;

  if (haTimer) {
    avviaCountdownTurno(
      dati.tempoInizioTurno,
      dati.durataMossaMs,
      dati.scadenzaTurno ||
        null
    );
  } else {
    fermaCountdownCompleto();
    azzeraDatiCountdown();
  }
}

function gestisciRisultatoDeterminazione(
  dati
) {
  /*
   * Il server ha già fermato il timer
   * quando ha registrato il risultato.
   */
  fermaCountdownCompleto();

  turnoLocalmenteCompletato =
    true;

  mostraDadi(
    dati.dado1,
    dati.dado2
  );

  animaLancioDadi(
    Number(dati.dado1),
    Number(dati.dado2),
    () => {
      const sottotitolo =
        document.getElementById(
          "sottotitolo-determinazione"
        );

      if (sottotitolo) {
        sottotitolo.textContent =
          (
            dati.nome ||
            "Il giocatore"
          ) +
          " ha fatto " +
          Number(
            dati.valoreDado ||
              0
          ) +
          (
            dati.automatico
              ? " (tempo scaduto)"
              : ""
          ) +
          "!";
      }
    }
  );
}

function gestisciOrdineFinaleCalcolato(
  dati
) {
  faseAttuale =
    "determinazione";

  const sottotitolo =
    document.getElementById(
      "sottotitolo-determinazione"
    );

  if (sottotitolo) {
    sottotitolo.textContent =
      "Ordine deciso! La partita inizia tra un istante...";
  }

  const lista =
    document.getElementById(
      "lista-determinazione"
    );

  if (!lista) {
    return;
  }

  lista.replaceChildren();

  const ordine =
    Array.isArray(
      dati.ordineGiocatori
    )
      ? dati.ordineGiocatori
      : [];

  ordine.forEach(
    (
      nome,
      indice
    ) => {
      const riga =
        document.createElement(
          "div"
        );

      riga.className =
        "determinazione-riga determinazione-riga-finale";

      riga.style.animationDelay =
        indice *
          0.12 +
        "s";

      const posizione =
        document.createElement(
          "span"
        );

      posizione.className =
        "determinazione-posizione-finale";

      posizione.textContent =
        indice +
        1 +
        "°";

      riga.appendChild(
        posizione
      );

      const nomeEl =
        document.createElement(
          "span"
        );

      nomeEl.className =
        "determinazione-nome";

      nomeEl.textContent =
        nome ||
        "?";

      riga.appendChild(
        nomeEl
      );

      const punteggio =
        document.createElement(
          "span"
        );

      punteggio.className =
        "determinazione-risultato";

      punteggio.textContent =
        "🎲 " +
        String(
          dati.punteggi?.[
            nome
          ] ??
            "?"
        );

      riga.appendChild(
        punteggio
      );

      lista.appendChild(
        riga
      );
    }
  );
}

function gestisciDeterminazioneCompletata(
  dati
) {
  faseAttuale =
    "normale";

  possoTirareIoInDeterminazione =
    false;

  riportaDadiAllaPartita();

  const overlay =
    document.getElementById(
      "overlay-determinazione"
    );

  if (overlay) {
    overlay.classList.remove(
      "aperto"
    );
  }

  ultimoStatoGiocatori =
    Array.isArray(
      dati.giocatori
    )
      ? dati.giocatori
      : [];

  aggiornaTurno(
    dati.turnoDiId ||
      null
  );

  disegnaGiocatori();

  const messaggiGioco =
    document.getElementById(
      "messaggi-gioco"
    );

  const primoMovimento =
    dati.primoMovimento ||
    {};

  if (messaggiGioco) {
    messaggiGioco.textContent =
      "🎲 Ordine deciso! " +
      (
        primoMovimento.nomeGiocatore ||
        "Un giocatore"
      ) +
      " inizia la partita.";
  }

  /*
   * Nella struttura attuale del server
   * primoMovimento.percorso è vuoto.
   *
   * Quindi non rallentiamo l'inizio del countdown:
   * il timer appartiene già al nuovo turno.
   */
  if (
    dati.tempoInizioTurno !=
      null &&
    dati.durataMossaMs !=
      null
  ) {
    avviaCountdownTurno(
      dati.tempoInizioTurno,
      dati.durataMossaMs,
      dati.scadenzaTurno ||
        null
    );
  } else {
    fermaCountdownCompleto();
  }

  if (
    Array.isArray(
      primoMovimento.messaggi
    ) &&
    primoMovimento.messaggi.length
  ) {
    mostraMessaggioGiocoGrande(
      primoMovimento.messaggi.join(
        " "
      )
    );
  }
}

/* ============================================================
   TIMER
   ============================================================ */

function fermaCountdownCompleto() {
  if (
    intervalCountdown !==
    null
  ) {
    clearInterval(
      intervalCountdown
    );

    intervalCountdown =
      null;
  }
}

function azzeraDatiCountdown() {
  tempoInizioTurnoAttuale =
    null;

  durataMossaMsAttuale =
    null;

  scadenzaTurnoAttuale =
    null;

  ultimoSecondoAvviso =
    null;
}

function ottieniElementoCountdown() {
  return document.getElementById(
    "countdown-turno"
  );
}

function avviaCountdownTurno(
  tempoInizio,
  durataMs,
  scadenzaTurno = null
) {
  fermaCountdownCompleto();

  const inizio =
    Number(
      tempoInizio
    );

  const durata =
    Number(
      durataMs
    );

  let scadenza =
    Number(
      scadenzaTurno
    );

  /*
   * Controllo robusto:
   * se il server ha inviato un timestamp in secondi
   * anziché millisecondi, lo normalizziamo.
   *
   * Il server attuale usa millisecondi.
   */
  if (
    Number.isFinite(
      scadenza
    ) &&
    scadenza > 0 &&
    scadenza < 100000000000
  ) {
    scadenza *= 1000;
  }

  let inizioNormalizzato =
    Number.isFinite(
      inizio
    ) &&
    inizio > 0
      ? inizio
      : null;

  if (
    inizioNormalizzato !==
      null &&
    inizioNormalizzato <
      100000000000
  ) {
    inizioNormalizzato *=
      1000;
  }

  tempoInizioTurnoAttuale =
    inizioNormalizzato;

  durataMossaMsAttuale =
    Number.isFinite(
      durata
    ) &&
    durata > 0
      ? durata
      : null;

  if (
    Number.isFinite(
      scadenza
    ) &&
    scadenza > 0
  ) {
    scadenzaTurnoAttuale =
      scadenza;
  } else if (
    tempoInizioTurnoAttuale !==
      null &&
    durataMossaMsAttuale !==
      null
  ) {
    scadenzaTurnoAttuale =
      tempoInizioTurnoAttuale +
      durataMossaMsAttuale;
  } else {
    scadenzaTurnoAttuale =
      null;
  }

  ultimoSecondoAvviso =
    null;

  turnoLocalmenteCompletato =
    false;

  aggiornaCountdownTurno();

  if (
    scadenzaTurnoAttuale !==
    null
  ) {
    intervalCountdown =
      setInterval(
        aggiornaCountdownTurno,
        100
      );
  }
}

function fermaCountdownPerAzioneLocale() {
  turnoLocalmenteCompletato =
    true;

  fermaCountdownCompleto();

  const elemento =
    ottieniElementoCountdown();

  if (elemento) {
    elemento.textContent =
      "✓";

    elemento.classList.remove(
      "countdown-scaduto"
    );

    elemento.classList.add(
      "countdown-fermo"
    );
  }
}

function aggiornaCountdownTurno() {
  const elemento =
    ottieniElementoCountdown();

  if (!elemento) {
    return;
  }

  if (
    turnoLocalmenteCompletato
  ) {
    return;
  }

  if (
    scadenzaTurnoAttuale ===
    null
  ) {
    elemento.textContent =
      "⏱ --s";

    elemento.classList.remove(
      "countdown-scaduto",
      "countdown-fermo"
    );

    return;
  }

  const restanteMs =
    scadenzaTurnoAttuale -
    Date.now();

  const secondi =
    Math.max(
      0,
      Math.ceil(
        restanteMs /
          1000
      )
    );

  elemento.textContent =
    "⏱ " +
    secondi +
    "s";

  elemento.classList.toggle(
    "countdown-scaduto",
    secondi <= 0
  );

  elemento.classList.remove(
    "countdown-fermo"
  );

  if (
    secondi >= 1 &&
    secondi <= 3 &&
    secondi !==
      ultimoSecondoAvviso
  ) {
    ultimoSecondoAvviso =
      secondi;

    suonaAvvisoTempo();
  }

  /*
   * Non mandiamo nulla al server.
   * Il server ha già il proprio timer.
   */
}

/* ============================================================
   DADI 3D
   ============================================================ */

const CORREZIONE_ANGOLI_DADO = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: -90, y: 0 },
  4: { x: 90, y: 0 },
  5: { x: 0, y: 90 },
  6: { x: 0, y: 180 }
};

let rotazioneAttuale = {
  dado1: {
    x: 0,
    y: 0
  },

  dado2: {
    x: 0,
    y: 0
  }
};

function normalizza360(
  gradi
) {
  return (
    (
      Number(gradi) %
        360
    ) +
    360
  ) %
    360;
}

function calcolaNuovaRotazione(
  idDado,
  valore
) {
  const correzione =
    CORREZIONE_ANGOLI_DADO[
      valore
    ];

  if (!correzione) {
    return (
      rotazioneAttuale[
        idDado
      ] || {
        x: 0,
        y: 0
      }
    );
  }

  const attuale =
    rotazioneAttuale[
      idDado
    ] || {
      x: 0,
      y: 0
    };

  let differenzaX =
    normalizza360(
      correzione.x
    ) -
    normalizza360(
      attuale.x
    );

  if (
    differenzaX < 0
  ) {
    differenzaX +=
      360;
  }

  let differenzaY =
    normalizza360(
      correzione.y
    ) -
    normalizza360(
      attuale.y
    );

  if (
    differenzaY < 0
  ) {
    differenzaY +=
      360;
  }

  /*
   * 2-3 giri completi:
   * il dado percorre realmente una rotazione.
   */
  const nuova = {
    x:
      attuale.x +
      differenzaX +
      (
        2 +
        Math.floor(
          Math.random() * 2
        )
      ) *
        360,

    y:
      attuale.y +
      differenzaY +
      (
        2 +
        Math.floor(
          Math.random() * 2
        )
      ) *
        360
  };

  rotazioneAttuale[
    idDado
  ] = nuova;

  return nuova;
}

function trovaCuboDado(
  idDado
) {
  return document.querySelector(
    "#" +
      idDado +
      " .cubo"
  );
}

function impostaRotazioneDado(
  idDado,
  rotazione,
  durataMs = 0,
  animato = false
) {
  const cubo =
    trovaCuboDado(
      idDado
    );

  if (!cubo) {
    return;
  }

  if (!animato) {
    cubo.style.transition =
      "none";
  } else {
    cubo.style.transition =
      "transform " +
      Math.max(
        0,
        durataMs
      ) +
      "ms cubic-bezier(.15,.75,.25,1)";
  }

  if (
    rotazione &&
    Number.isFinite(
      Number(rotazione.x)
    ) &&
    Number.isFinite(
      Number(rotazione.y)
    )
  ) {
    cubo.style.transform =
      "rotateX(" +
      rotazione.x +
      "deg) rotateY(" +
      rotazione.y +
      "deg)";
  }

  if (!animato) {
    void cubo.offsetHeight;
    cubo.style.transition =
      "";
  }
}

function mostraDadi(
  v1,
  v2
) {
  const cubo1 =
    trovaCuboDado(
      "dado1"
    );

  const cubo2 =
    trovaCuboDado(
      "dado2"
    );

  if (cubo1) {
    cubo1.style.transition =
      "none";
  }

  if (cubo2) {
    cubo2.style.transition =
      "none";
  }

  if (
    Number(v1) >= 1 &&
    Number(v1) <= 6
  ) {
    const c =
      CORREZIONE_ANGOLI_DADO[
        Number(v1)
      ];

    if (c) {
      rotazioneAttuale.dado1 = {
        x: c.x,
        y: c.y
      };

      impostaRotazioneDado(
        "dado1",
        rotazioneAttuale.dado1,
        0,
        false
      );
    }
  }

  if (
    Number(v2) >= 1 &&
    Number(v2) <= 6
  ) {
    const c =
      CORREZIONE_ANGOLI_DADO[
        Number(v2)
      ];

    if (c) {
      rotazioneAttuale.dado2 = {
        x: c.x,
        y: c.y
      };

      impostaRotazioneDado(
        "dado2",
        rotazioneAttuale.dado2,
        0,
        false
      );
    }
  }
}

function animaLancioDadi(
  vf1,
  vf2,
  callback
) {
  const valore1 =
    Number(vf1);

  const valore2 =
    Number(vf2);

  if (
    valore1 < 1 ||
    valore1 > 6 ||
    valore2 < 1 ||
    valore2 > 6
  ) {
    if (
      typeof callback ===
      "function"
    ) {
      callback();
    }

    return;
  }

  suonaTiroDadi();

  const r1 =
    calcolaNuovaRotazione(
      "dado1",
      valore1
    );

  const r2 =
    calcolaNuovaRotazione(
      "dado2",
      valore2
    );

  impostaRotazioneDado(
    "dado1",
    r1,
    DURATA_LANCIO_DADI_MS,
    true
  );

  impostaRotazioneDado(
    "dado2",
    r2,
    DURATA_LANCIO_DADI_MS,
    true
  );

  setTimeout(
    () => {
      suonaAtterraggioDadi();

      if (
        typeof callback ===
        "function"
      ) {
        callback();
      }
    },
    DURATA_LANCIO_DADI_MS
  );
}

/* ============================================================
   PEDINE
   ============================================================ */

function mescolaColore(
  hex,
  target,
  percentuale
) {
  const testo =
    String(hex || "")
      .replace("#", "");

  const numero =
    parseInt(
      testo,
      16
    );

  if (
    !Number.isFinite(
      numero
    )
  ) {
    return (
      "rgb(" +
      target +
      "," +
      target +
      "," +
      target +
      ")"
    );
  }

  let r =
    (numero >> 16) &
    255;

  let g =
    (numero >> 8) &
    255;

  let b =
    numero & 255;

  const p =
    Math.max(
      0,
      Math.min(
        100,
        Number(
          percentuale
        ) || 0
      )
    ) /
    100;

  r =
    Math.round(
      r +
        (target - r) *
          p
    );

  g =
    Math.round(
      g +
        (target - g) *
          p
    );

  b =
    Math.round(
      b +
        (target - b) *
          p
    );

  return (
    "rgb(" +
    r +
    "," +
    g +
    "," +
    b +
    ")"
  );
}

function schiarisciColore(
  hex,
  percentuale
) {
  return mescolaColore(
    hex,
    255,
    percentuale
  );
}

function scurisciColore(
  hex,
  percentuale
) {
  return mescolaColore(
    hex,
    0,
    percentuale
  );
}

function coordinatePerCasella(
  casellaNumero
) {
  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  if (
    !immagine ||
    !immagine.naturalWidth ||
    !immagine.naturalHeight
  ) {
    return null;
  }

  const scalaX =
    immagine.clientWidth /
    immagine.naturalWidth;

  const scalaY =
    immagine.clientHeight /
    immagine.naturalHeight;

  const casella =
    Number(casellaNumero) ===
    0
      ? {
          x: 100,
          y: 1900
        }
      : posizioniCaselle[
          Number(casellaNumero)
        ];

  if (!casella) {
    return null;
  }

  return {
    left:
      casella.x *
      scalaX,

    top:
      casella.y *
      scalaY
  };
}

function posizionaPedina(
  pedina,
  casellaNumero,
  durataMs = null
) {
  if (!pedina) {
    return;
  }

  const coordinate =
    coordinatePerCasella(
      casellaNumero
    );

  if (!coordinate) {
    return;
  }

  if (
    durataMs !== null &&
    Number.isFinite(
      Number(durataMs)
    )
  ) {
    pedina.style.transition =
      "left " +
      Math.max(
        0,
        Number(durataMs)
      ) +
      "ms linear, top " +
      Math.max(
        0,
        Number(durataMs)
      ) +
      "ms linear";
  }

  pedina.style.left =
    coordinate.left +
    "px";

  pedina.style.top =
    coordinate.top +
    "px";
}

function creaSvgPedina(
  pedina,
  colore,
  indice
) {
  const idG =
    "gradPedina" +
    String(indice)
      .replace(
        /[^a-zA-Z0-9_-]/g,
        ""
      );

  pedina.innerHTML =
    `
      <svg
        width="26"
        height="38"
        viewBox="0 0 34 48"
        aria-hidden="true"
      >
        <defs>
          <radialGradient
            id="${idG}"
            cx="35%"
            cy="25%"
            r="75%"
          >
            <stop
              offset="0%"
              stop-color="${schiarisciColore(
                colore,
                55
              )}"
            />

            <stop
              offset="55%"
              stop-color="${colore}"
            />

            <stop
              offset="100%"
              stop-color="${scurisciColore(
                colore,
                35
              )}"
            />
          </radialGradient>
        </defs>

        <ellipse
          cx="17"
          cy="44"
          rx="12"
          ry="3.5"
          fill="rgba(0,0,0,0.30)"
        />

        <ellipse
          cx="17"
          cy="42"
          rx="11"
          ry="4"
          fill="${scurisciColore(
            colore,
            25
          )}"
        />

        <path
          d="
            M17 42
            C10 42 4 40 4 37
            L10 15
            C10 15 12 12 17 12
            C22 12 24 15 24 15
            L30 37
            C30 40 24 42 17 42 Z
          "
          fill="url(#${idG})"
          stroke="${scurisciColore(
            colore,
            45
          )}"
          stroke-width="0.8"
        />

        <circle
          cx="17"
          cy="9"
          r="7.5"
          fill="url(#${idG})"
          stroke="${scurisciColore(
            colore,
            45
          )}"
          stroke-width="0.8"
        />

        <ellipse
          cx="14"
          cy="6"
          rx="2.5"
          ry="1.8"
          fill="rgba(255,255,255,0.55)"
        />
      </svg>
    `;
}

function ottieniOCreaPedina(
  idGiocatore,
  colore,
  indice
) {
  if (!idGiocatore) {
    return null;
  }

  const id =
    "pedina-" +
    String(
      idGiocatore
    );

  let pedina =
    document.getElementById(
      id
    );

  if (!pedina) {
    pedina =
      document.createElement(
        "div"
      );

    pedina.id =
      id;

    pedina.className =
      "pedina";

    creaSvgPedina(
      pedina,
      colore,
      indice
    );

    const contenitore =
      document.getElementById(
        "contenitore-pedine"
      );

    if (
      contenitore
    ) {
      contenitore.appendChild(
        pedina
      );
    }
  }

  return pedina;
}

function riposizionaTuttePedine() {
  ultimoStatoGiocatori.forEach(
    g => {
      if (!g || !g.id) {
        return;
      }

      const pedina =
        document.getElementById(
          "pedina-" +
          g.id
        );

      if (pedina) {
        posizionaPedina(
          pedina,
          Number(
            g.posizione ||
              0
          ),
          null
        );
      }
    }
  );
}

/*
 * Per mantenere la durata totale inviata dal server:

 * totale = lancio dadi + spostamento pedina
 *
 * Se il server applica la sua durata massima,
 * adattiamo la durata per casella.
 */
function calcolaDurataPassoClient(
  percorso,
  durataAnimazioneServer
) {
  const lunghezza =
    Array.isArray(
      percorso
    )
      ? percorso.length
      : 0;

  if (
    lunghezza ===
    0
  ) {
    return DURATA_SALTO_MS;
  }

  const totale =
    Number(
      durataAnimazioneServer
    );

  if (
    Number.isFinite(
      totale
    ) &&
    totale >=
      DURATA_LANCIO_DADI_MS
  ) {
    const tempoMovimento =
      totale -
      DURATA_LANCIO_DADI_MS;

    return Math.max(
      1,
      tempoMovimento /
        lunghezza
    );
  }

  return DURATA_SALTO_MS;
}

function animaSaltoPedina(
  idGiocatore,
  percorso,
  callback,
  durataAnimazioneServer = null
) {
  const listaPercorso =
    Array.isArray(
      percorso
    )
      ? percorso
      : [];

  const pedina =
    document.getElementById(
      "pedina-" +
      idGiocatore
    );

  if (
    listaPercorso.length ===
      0 ||
    !pedina
  ) {
    if (
      typeof callback ===
      "function"
    ) {
      callback();
    }

    return;
  }

  const indice =
    ultimoStatoGiocatori.findIndex(
      g =>
        String(g.id) ===
        String(
          idGiocatore
        )
    );

  const indiceColore =
    indice >= 0
      ? indice
      : 0;

  const colore =
    coloriGiocatori[
      indiceColore %
        coloriGiocatori.length
    ];

  /*
   * Se la pedina esiste già ma il colore
   * è stato riassegnato, non la ricreiamo:
   * l'ordine del server rimane stabile.
   */

  const durataPasso =
    calcolaDurataPassoClient(
      listaPercorso,
      durataAnimazioneServer
    );

  let indicePercorso =
    0;

  function prossimoPasso() {
    if (
      indicePercorso >=
      listaPercorso.length
    ) {
      pedina.classList.remove(
        "pedina-salta"
      );

      pedina.style.transition =
        "";

      if (
        typeof callback ===
        "function"
      ) {
        callback();
      }

      return;
    }

    const casella =
      Number(
        listaPercorso[
          indicePercorso
        ]
      );

    pedina.classList.add(
      "pedina-salta"
    );

    posizionaPedina(
      pedina,
      casella,
      durataPasso
    );

    suonaPassoPedina();

    const elementoCasella =
      document.getElementById(
        "casella-" +
        idGiocatore
      );

    if (
      elementoCasella
    ) {
      elementoCasella.textContent =
        String(
          casella
        );
    }

    const durataSalto =
      Math.max(
        1,
        durataPasso *
          0.65
      );

    setTimeout(
      () => {
        pedina.classList.remove(
          "pedina-salta"
        );
      },
      durataSalto
    );

    indicePercorso +=
      1;

    setTimeout(
      prossimoPasso,
      durataPasso
    );
  }

  prossimoPasso();
}

/* ============================================================
   GIOCATORI
   ============================================================ */

function creaBottoneAudio(
  giocatore
) {
  if (
    !giocatore ||
    String(
      giocatore.id
    ) ===
      String(mioUid)
  ) {
    return null;
  }

  if (
    coppieAudioAttive.has(
      String(
        giocatore.id
      )
    )
  ) {
    const span =
      document.createElement(
        "span"
      );

    span.className =
      "stato-audio attivo";

    span.title =
      "Chiamata audio attiva";

    span.textContent =
      "🎤";

    return span;
  }

  if (
    richiesteInviate.has(
      String(
        giocatore.id
      )
    )
  ) {
    const span =
      document.createElement(
        "span"
      );

    span.className =
      "stato-audio in-attesa";

    span.title =
      "Richiesta inviata";

    span.textContent =
      "⏳";

    return span;
  }

  if (
    microfonoAttivo
  ) {
    const bottone =
      document.createElement(
        "button"
      );

    bottone.type =
      "button";

    bottone.className =
      "btn-chiama-audio";

    bottone.title =
      "Chiedi di parlare";

    bottone.textContent =
      "📞";

    bottone.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        richiediAudioCon(
          giocatore.id
        );
      }
    );

    return bottone;
  }

  return null;
}

function creaCardGiocatore(
  giocatore,
  indice
) {
  const card =
    document.createElement(
      "div"
    );

  const attivo =
    String(
      giocatore.id
    ) ===
    String(
      turnoAttualeId
    );

  card.className =
    "giocatore-card" +
    (
      attivo
        ? " attivo"
        : ""
    );

  const colore =
    coloriGiocatori[
      indice %
        coloriGiocatori.length
    ];

  const avatar =
    creaAvatarMini(
      giocatore.nome,
      giocatore.avatar,
      colore
    );

  card.appendChild(
    avatar
  );

  const link =
    document.createElement(
      "a"
    );

  link.href =
    "profilo-pubblico.html?nickname=" +
    encodeURIComponent(
      giocatore.nome ||
        ""
    );

  link.target =
    "_blank";

  link.rel =
    "noopener noreferrer";

  link.style.color =
    "inherit";

  link.style.textDecoration =
    "none";

  link.style.flexGrow =
    "1";

  link.textContent =
    giocatore.nome ||
    "Giocatore";

  card.appendChild(
    link
  );

  const audio =
    creaBottoneAudio(
      giocatore
    );

  if (audio) {
    card.appendChild(
      audio
    );
  }

  if (
    attivo
  ) {
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

  const casella =
    document.createElement(
      "span"
    );

  casella.className =
    "casella-mini";

  casella.id =
    "casella-" +
    giocatore.id;

  casella.textContent =
    String(
      Number(
        giocatore.posizione ||
          0
      )
    );

  card.appendChild(
    casella
  );

  return card;
}

function disegnaGiocatori(
  forza = false
) {
  const contenitore =
    document.getElementById(
      "contenitore-pedine"
    );

  if (
    contenitore
  ) {
    const idsValidi =
      new Set(
        ultimoStatoGiocatori
          .filter(
            g =>
              g &&
              g.id
          )
          .map(
            g =>
              "pedina-" +
              g.id
          )
      );

    Array.from(
      contenitore.children
    ).forEach(
      elemento => {
        if (
          !idsValidi.has(
            elemento.id
          )
        ) {
          elemento.remove();
        }
      }
    );

    ultimoStatoGiocatori.forEach(
      (
        giocatore,
        indice
      ) => {
        if (
          !giocatore ||
          !giocatore.id
        ) {
          return;
        }

        const colore =
          coloriGiocatori[
            indice %
              coloriGiocatori.length
          ];

        const pedina =
          ottieniOCreaPedina(
            giocatore.id,
            colore,
            indice
          );

        if (pedina) {
          /*
           * Se stiamo riproducendo un movimento,
           * NON spostiamo la pedina direttamente.
           */
          if (
            !animazioneMovimentoInCorso ||
            forza
          ) {
            posizionaPedina(
              pedina,
              Number(
                giocatore.posizione ||
                  0
              ),
              null
            );
          }
        }
      }
    );
  }

  const pannello =
    document.getElementById(
      "lista-giocatori"
    );

  if (!pannello) {
    return;
  }

  pannello.replaceChildren();

  ultimoStatoGiocatori.forEach(
    (
      giocatore,
      indice
    ) => {
      if (
        !giocatore ||
        !giocatore.id
      ) {
        return;
      }

      pannello.appendChild(
        creaCardGiocatore(
          giocatore,
          indice
        )
      );
    }
  );

  if (
    turnoAttualeId
  ) {
    aggiornaCountdownTurno();
  }
}

/* ============================================================
   TURNI
   ============================================================ */

function aggiornaTurno(
  turnoDiId
) {
  const eraIlMioTurno =
    mioTurno;

  turnoAttualeId =
    turnoDiId || null;

  mioTurno =
    Boolean(
      turnoDiId &&
        String(
          turnoDiId
        ) ===
          String(
            mioUid
          )
    );

  if (
    mioTurno &&
    !eraIlMioTurno
  ) {
    turnoLocalmenteCompletato =
      false;

    azioneLocaleInCorso =
      false;

    suonaTuoTurno();
  }

  const rigaTurno =
    document.getElementById(
      "riga-turno"
    );

  if (rigaTurno) {
    if (
      faseAttuale ===
      "determinazione"
    ) {
      rigaTurno.textContent =
        possoTirareIoInDeterminazione
          ? "🎲 Tira per determinare l'ordine"
          : "⏳ Determinazione dell'ordine...";
    } else if (
      mioTurno
    ) {
      rigaTurno.textContent =
        "🎲 È il tuo turno!";
    } else if (
      turnoDiId
    ) {
      const giocatore =
        ultimoStatoGiocatori.find(
          g =>
            String(
              g.id
            ) ===
            String(
              turnoDiId
            )
        );

      rigaTurno.textContent =
        giocatore
          ? "⏳ Tocca a " +
            giocatore.nome +
            "..."
          : "⏳ In attesa...";
    } else {
      rigaTurno.textContent =
        "⏳ In attesa...";
    }
  }

  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  if (areaDadi) {
    const disabilitato =
      faseAttuale ===
        "determinazione"
        ? !possoTirareIoInDeterminazione
        : !mioTurno ||
          azioneLocaleInCorso ||
          partitaTerminataLocale;

    areaDadi.classList.toggle(
      "disabilitato",
      disabilitato
    );
  }

  aggiornaCountdownTurno();
}

/* ============================================================
   VITTORIA
   ============================================================ */

function mostraVittoria(
  nomeVincitore
) {
  if (
    partitaTerminataLocale
  ) {
    return;
  }

  partitaTerminataLocale =
    true;

  mioTurno =
    false;

  turnoAttualeId =
    null;

  fermaCountdownCompleto();
  azzeraDatiCountdown();

  azioneLocaleInCorso =
    false;

  suonaVittoria();

  const testo =
    document.getElementById(
      "testo-vincitore"
    );

  if (testo) {
    testo.textContent =
      "🎉 Ha vinto " +
      (
        nomeVincitore ||
        "un giocatore"
      ) +
      "!";
  }

  const overlay =
    document.getElementById(
      "overlay-vittoria"
    );

  if (overlay) {
    overlay.classList.add(
      "aperto"
    );
  }

  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  if (areaDadi) {
    areaDadi.classList.add(
      "disabilitato"
    );
  }

  const rigaTurno =
    document.getElementById(
      "riga-turno"
    );

  if (rigaTurno) {
    rigaTurno.textContent =
      "🏆 Partita terminata";
  }
}

/* ============================================================
   STATO PARTITA
   ============================================================ */

function applicaStatoPartita(
  dati
) {
  if (
    !dati ||
    !Array.isArray(
      dati.giocatori
    )
  ) {
    return;
  }

  ultimoStatoGiocatori =
    dati.giocatori;

  if (
    dati.chatAttiva ===
    false
  ) {
    const chatWrapper =
      document.getElementById(
        "chat-wrapper"
      );

    if (chatWrapper) {
      chatWrapper.style.display =
        "none";
    }
  } else {
    const chatWrapper =
      document.getElementById(
        "chat-wrapper"
      );

    if (chatWrapper) {
      chatWrapper.style.display =
        "";
    }
  }

  if (
    dati.vittoria
  ) {
    aggiornaTurno(
      null
    );

    fermaCountdownCompleto();
    azzeraDatiCountdown();

    disegnaGiocatori(
      true
    );

    mostraVittoria(
      dati.vincitore
    );

    return;
  }

  aggiornaTurno(
    dati.turnoDiId ||
      null
  );

  disegnaGiocatori(
    true
  );

  if (
    dati.tempoInizioTurno !=
      null &&
    dati.durataMossaMs !=
      null
  ) {
    avviaCountdownTurno(
      dati.tempoInizioTurno,
      dati.durataMossaMs,
      dati.scadenzaTurno ||
        null
    );
  } else {
    fermaCountdownCompleto();
    azzeraDatiCountdown();
  }

  if (
    Array.isArray(
      dati.messaggi
    ) &&
    dati.messaggi.length &&
    dati.idGiocatoreCheHaTirato ===
      mioUid
  ) {
    mostraMessaggioGiocoGrande(
      dati.messaggi.join(
        " "
      )
    );
  }
}

function riceviStatoPartita(
  dati
) {
  /*
   * Se stiamo animando una mossa,
   * il server potrebbe avere già inviato
   * il nuovo turno.
   *
   * Salviamo il risultato e lo applichiamo
   * alla fine dell'animazione.
   */
  if (
    animazioneMovimentoInCorso
  ) {
    statoPartitaInCoda =
      dati;
    return;
  }

  applicaStatoPartita(
    dati
  );
}

/* ============================================================
   AGGIORNAMENTO PARTITA
   ============================================================ */

function gestisciAggiornamentoPartita(
  dati
) {
  if (
    partitaTerminataLocale
  ) {
    return;
  }

  /*
   * Il server ha già fermato il timer
   * nel momento in cui accetta il tiro.
   */
  fermaCountdownCompleto();

  turnoLocalmenteCompletato =
    true;

  azioneLocaleInCorso =
    false;

  /*
   * Conserviamo le posizioni corrette del server,
   * ma NON le disegniamo direttamente:
   * la pedina deve percorrere il percorso.
   */
  ultimoStatoGiocatori =
    Array.isArray(
      dati.giocatori
    )
      ? dati.giocatori
      : ultimoStatoGiocatori;

  disegnaGiocatori();

  const messaggiGioco =
    document.getElementById(
      "messaggi-gioco"
    );

  if (messaggiGioco) {
    messaggiGioco.textContent =
      "🎲 " +
      Number(
        dati.dado1 || 0
      ) +
      " + " +
      Number(
        dati.dado2 || 0
      ) +
      " = " +
      Number(
        dati.valoreDado ||
          0
      );
  }

  if (
    Array.isArray(
      dati.messaggi
    ) &&
    dati.messaggi.length
  ) {
    mostraMessaggioGiocoGrande(
      dati.messaggi.join(
        " "
      )
    );
  }

  /*
   * Vittoria:
   * la partita viene rimossa immediatamente dal server,
   * quindi non aspettiamo statoPartita.
   */
  if (
    dati.vittoria
  ) {
    animazioneMovimentoInCorso =
      true;

    animaLancioDadi(
      Number(dati.dado1),
      Number(dati.dado2),
      () => {
        const fine =
          () => {
            animazioneMovimentoInCorso =
              false;

            disegnaGiocatori(
              true
            );

            mostraVittoria(
              dati.vincitore
            );
          };

        if (
          Array.isArray(
            dati.percorso
          ) &&
          dati.percorso.length &&
          dati.idGiocatoreCheHaTirato
        ) {
          animaSaltoPedina(
            dati.idGiocatoreCheHaTirato,
            dati.percorso,
            fine,
            dati.durataAnimazioneMs
          );
        } else {
          fine();
        }
      }
    );

    return;
  }

  animazioneMovimentoInCorso =
    true;

  /*
   * Se non c'è percorso, l'animazione
   * è comunque quella dei dadi.
   */
  animaLancioDadi(
    Number(dati.dado1),
    Number(dati.dado2),
    () => {
      const fineAnimazione =
        () => {
          animazioneMovimentoInCorso =
            false;

          const statoDaApplicare =
            statoPartitaInCoda;

          statoPartitaInCoda =
            null;

          if (
            statoDaApplicare
          ) {
            applicaStatoPartita(
              statoDaApplicare
            );
          } else {
            /*
             * Se il nuovo stato non è ancora arrivato,
             * manteniamo la scena sincronizzata
             * con le ultime posizioni ricevute.
             */
            disegnaGiocatori();
          }
        };

      if (
        Array.isArray(
          dati.percorso
        ) &&
        dati.percorso.length &&
        dati.idGiocatoreCheHaTirato
      ) {
        animaSaltoPedina(
          dati.idGiocatoreCheHaTirato,
          dati.percorso,
          fineAnimazione,
          dati.durataAnimazioneMs
        );
      } else {
        fineAnimazione();
      }
    }
  );
}

/* ============================================================
   MENU
   ============================================================ */

function apriProfilo() {
  chiudiMenu();

  window.location.href =
    "profilo.html";
}

function apriImpostazioni() {
  chiudiMenu();

  window.location.href =
    "opzioni-account.html";
}

function chiudiMenu() {
  const pannello =
    document.getElementById(
      "pannello-menu"
    );

  if (pannello) {
    pannello.classList.add(
      "nascosto"
    );
  }
}

function configuraMenu() {
  const btnMenu =
    document.getElementById(
      "btn-menu"
    );

  if (btnMenu) {
    btnMenu.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        const pannello =
          document.getElementById(
            "pannello-menu"
          );

        if (pannello) {
          pannello.classList.toggle(
            "nascosto"
          );
        }
      }
    );
  }

  document.addEventListener(
    "click",
    () => {
      chiudiMenu();
    }
  );
}

/* ============================================================
   PANNELLO GIOCATORI
   ============================================================ */

function chiudiPannelloGiocatori() {
  const pannello =
    document.getElementById(
      "pannello-giocatori"
    );

  const backdrop =
    document.getElementById(
      "backdrop-giocatori"
    );

  if (pannello) {
    pannello.classList.remove(
      "aperto"
    );
  }

  if (backdrop) {
    backdrop.classList.remove(
      "aperto"
    );
  }
}

function configuraPannelloGiocatori() {
  const btn =
    document.getElementById(
      "btn-giocatori"
    );

  if (btn) {
    btn.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        const pannello =
          document.getElementById(
            "pannello-giocatori"
          );

        const backdrop =
          document.getElementById(
            "backdrop-giocatori"
          );

        if (pannello) {
          pannello.classList.toggle(
            "aperto"
          );
        }

        if (backdrop) {
          backdrop.classList.toggle(
            "aperto"
          );
        }
      }
    );
  }

  const backdrop =
    document.getElementById(
      "backdrop-giocatori"
    );

  if (backdrop) {
    backdrop.addEventListener(
      "click",
      chiudiPannelloGiocatori
    );
  }
}

/* ============================================================
   CHAT PARTITA
   ============================================================ */

let messaggiChatNonLetti =
  0;

function aggiornaBadgeChatPartita() {
  const badge =
    document.getElementById(
      "badge-chat-partita"
    );

  if (!badge) {
    return;
  }

  if (
    messaggiChatNonLetti >
    0
  ) {
    badge.style.display =
      "flex";

    badge.textContent =
      messaggiChatNonLetti >
      9
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
  const box =
    document.getElementById(
      "chat-messaggi"
    );

  if (!box) {
    return;
  }

  suonaMessaggioChat();

  const riga =
    document.createElement(
      "div"
    );

  riga.className =
    "chat-msg";

  const nomeEl =
    document.createElement(
      "b"
    );

  nomeEl.textContent =
    String(
      nome ||
        "Giocatore"
    ) + ":";

  const testoEl =
    document.createTextNode(
      " " +
      String(
        testo || ""
      )
    );

  riga.appendChild(
    nomeEl
  );

  riga.appendChild(
    testoEl
  );

  box.appendChild(
    riga
  );

  box.scrollTop =
    box.scrollHeight;

  const pannello =
    document.getElementById(
      "pannello-chat"
    );

  if (
    pannello &&
    pannello.classList.contains(
      "nascosto"
    )
  ) {
    messaggiChatNonLetti +=
      1;

    aggiornaBadgeChatPartita();
  }
}

function inviaChatPartita() {
  const input =
    document.getElementById(
      "chat-input"
    );

  if (!input) {
    return;
  }

  const testo =
    String(
      input.value || ""
    ).trim();

  if (!testo) {
    return;
  }

  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  try {
    socket.send(
      JSON.stringify({
        tipo:
          "chatPartita",

        partitaId,

        testo
      })
    );

    input.value =
      "";
  } catch {}
}

function configuraChat() {
  const input =
    document.getElementById(
      "chat-input"
    );

  if (input) {
    input.addEventListener(
      "keypress",
      event => {
        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();

          inviaChatPartita();
        }
      }
    );
  }

  const btnChat =
    document.getElementById(
      "btn-chat"
    );

  if (btnChat) {
    btnChat.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        const pannello =
          document.getElementById(
            "pannello-chat"
          );

        if (!pannello) {
          return;
        }

        pannello.classList.toggle(
          "nascosto"
        );

        if (
          !pannello.classList.contains(
            "nascosto"
          )
        ) {
          messaggiChatNonLetti =
            0;

          aggiornaBadgeChatPartita();
        }
      }
    );
  }
}

/* ============================================================
   AUDIO / WEBRTC
   ============================================================ */

let microfonoAttivo =
  false;

let flussoAudioLocale =
  null;

const connessioniPeer =
  {};

const elementiAudioRemoti =
  {};

const candidatiICEInAttesa =
  {};

let uidRichiestaAudioInAttesa =
  null;

const richiesteInviate =
  new Set();

const coppieAudioAttive =
  new Set();

const CONFIGURAZIONE_ICE = {
  iceServers: [
    {
      urls:
        "stun:stun.l.google.com:19302"
    }
  ]
};

async function toggleMicrofono() {
  if (
    microfonoAttivo
  ) {
    disattivaMicrofono();
  } else {
    await attivaMicrofono();
  }
}

async function attivaMicrofono() {
  try {
    if (
      !navigator.mediaDevices ||
      typeof navigator
        .mediaDevices
        .getUserMedia !==
        "function"
    ) {
      alert(
        "Il tuo browser non permette l'accesso al microfono."
      );

      return;
    }

    flussoAudioLocale =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: {
            echoCancellation:
              true,

            noiseSuppression:
              true,

            autoGainControl:
              true
          },

          video:
            false
        }
      );
  } catch {
    alert(
      "Non è stato possibile accedere al microfono. Controlla i permessi del browser."
    );

    return;
  }

  microfonoAttivo =
    true;

  aggiornaTestoBottoneMicrofono();
  disegnaGiocatori();

  /*
   * Se avevamo già peer approvati,
   * aggiungiamo la traccia locale.
   */
  Object.entries(
    connessioniPeer
  ).forEach(
    ([
      altroUid,
      pc
    ]) => {
      if (
        !pc ||
        !flussoAudioLocale
      ) {
        return;
      }

      try {
        const transceivers =
          pc.getTransceivers
            ? pc.getTransceivers()
            : [];

        const senderEsistente =
          transceivers.find(
            transceiver =>
              transceiver.receiver
                ?.track
                ?.kind ===
                "audio"
          );

        if (
          senderEsistente
            ?.sender
        ) {
          return;
        }

        flussoAudioLocale
          .getTracks()
          .forEach(
            track => {
              try {
                pc.addTrack(
                  track,
                  flussoAudioLocale
                );
              } catch {}
            }
          );
      } catch {}
    }
  );
}

function disattivaMicrofono() {
  microfonoAttivo =
    false;

  if (
    flussoAudioLocale
  ) {
    flussoAudioLocale
      .getTracks()
      .forEach(
        track => {
          try {
            track.stop();
          } catch {}
        }
      );

    flussoAudioLocale =
      null;
  }

  Object.keys(
    connessioniPeer
  ).forEach(
    chiudiConnessioneAudio
  );

  richiesteInviate.clear();

  coppieAudioAttive.clear();

  aggiornaTestoBottoneMicrofono();
  disegnaGiocatori();
}

function aggiornaTestoBottoneMicrofono() {
  const bottone =
    document.getElementById(
      "btn-toggle-microfono"
    );

  if (bottone) {
    bottone.textContent =
      microfonoAttivo
        ? "🎤 Microfono: On"
        : "🔇 Microfono: Off";
  }
}

function richiediAudioCon(
  altroUid
) {
  const uid =
    String(
      altroUid || ""
    );

  if (!microfonoAttivo) {
    alert(
      "Attiva prima il tuo microfono dal menu ☰."
    );

    return;
  }

  if (
    !uid ||
    uid ===
      String(mioUid)
  ) {
    return;
  }

  if (
    richiesteInviate.has(
      uid
    ) ||
    coppieAudioAttive.has(
      uid
    )
  ) {
    return;
  }

  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  richiesteInviate.add(
    uid
  );

  try {
    socket.send(
      JSON.stringify({
        tipo:
          "richiestaAudio",

        partitaId,

        destinatarioUid:
          uid
      })
    );
  } catch {
    richiesteInviate.delete(
      uid
    );
  }

  disegnaGiocatori();
}

function mostraRichiestaAudioRicevuta(
  mittenteUid,
  mittenteNome
) {
  uidRichiestaAudioInAttesa =
    mittenteUid;

  suonaRichiestaAudio();

  const testo =
    document.getElementById(
      "testo-richiesta-audio"
    );

  if (testo) {
    testo.textContent =
      (
        mittenteNome ||
        "Un giocatore"
      ) +
      " ti sta chiedendo di parlare in chiamata audio.";
  }

  const popup =
    document.getElementById(
      "popup-richiesta-audio"
    );

  if (popup) {
    popup.classList.remove(
      "nascosto"
    );
  }
}

async function rispondiRichiestaAudioRicevuta(
  accettato
) {
  const mittenteUid =
    uidRichiestaAudioInAttesa;

  const popup =
    document.getElementById(
      "popup-richiesta-audio"
    );

  if (popup) {
    popup.classList.add(
      "nascosto"
    );
  }

  uidRichiestaAudioInAttesa =
    null;

  if (!mittenteUid) {
    return;
  }

  if (
    accettato &&
    !microfonoAttivo
  ) {
    await attivaMicrofono();

    if (
      !microfonoAttivo
    ) {
      inviaRispostaAudio(
        mittenteUid,
        false
      );

      return;
    }
  }

  inviaRispostaAudio(
    mittenteUid,
    Boolean(
      accettato
    )
  );

  if (
    accettato
  ) {
    coppieAudioAttive.add(
      String(
        mittenteUid
      )
    );

    disegnaGiocatori();
  }
}

function inviaRispostaAudio(
  destinatarioUid,
  accettato
) {
  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  try {
    socket.send(
      JSON.stringify({
        tipo:
          "rispostaAudio",

        partitaId,

        destinatarioUid:
          String(
            destinatarioUid
          ),

        accettato:
          Boolean(
            accettato
          )
      })
    );
  } catch {}
}

function creaConnessionePeer(
  altroUid
) {
  const uid =
    String(
      altroUid || ""
    );

  if (!uid) {
    return null;
  }

  if (
    connessioniPeer[uid]
  ) {
    return connessioniPeer[
      uid
    ];
  }

  if (
    typeof RTCPeerConnection ===
    "undefined"
  ) {
    return null;
  }

  let pc;

  try {
    pc =
      new RTCPeerConnection(
        CONFIGURAZIONE_ICE
      );
  } catch {
    return null;
  }

  if (
    flussoAudioLocale
  ) {
    flussoAudioLocale
      .getTracks()
      .forEach(
        track => {
          try {
            pc.addTrack(
              track,
              flussoAudioLocale
            );
          } catch {}
        }
      );
  }

  pc.onicecandidate =
    event => {
      if (
        !event.candidate ||
        !socket ||
        socket.readyState !==
          WebSocket.OPEN
      ) {
        return;
      }

      try {
        socket.send(
          JSON.stringify({
            tipo:
              "webrtc-ice-candidate",

            partitaId,

            destinatarioUid:
              uid,

            candidate:
              event.candidate
          })
        );
      } catch {}
    };

  pc.ontrack =
    event => {
      let audio =
        elementiAudioRemoti[
          uid
        ];

      if (!audio) {
        audio =
          document.createElement(
            "audio"
          );

        audio.autoplay =
          true;

        audio.playsInline =
          true;

        audio.id =
          "audio-remoto-" +
          uid;

        audio.style.position =
          "fixed";

        audio.style.width =
          "1px";

        audio.style.height =
          "1px";

        audio.style.opacity =
          "0";

        audio.style.pointerEvents =
          "none";

        document.body.appendChild(
          audio
        );

        elementiAudioRemoti[
          uid
        ] =
          audio;
      }

      if (
        event.streams &&
        event.streams[0]
      ) {
        audio.srcObject =
          event.streams[0];

        const promise =
          audio.play();

        if (
          promise &&
          typeof promise.catch ===
            "function"
        ) {
          promise.catch(
            () => {}
          );
        }
      }
    };

  pc.onconnectionstatechange =
    () => {
      const stato =
        pc.connectionState;

      if (
        stato ===
          "failed" ||
        stato ===
          "closed" ||
        stato ===
          "disconnected"
      ) {
        if (
          stato !==
          "disconnected"
        ) {
          chiudiConnessioneAudio(
            uid
          );
        }
      }
    };

  connessioniPeer[
    uid
  ] =
    pc;

  return pc;
}

async function avviaConnessioneAudio(
  altroUid,
  sonoIoAdIniziare
) {
  const uid =
    String(
      altroUid || ""
    );

  if (
    !uid ||
    uid ===
      String(mioUid)
  ) {
    return;
  }

  if (
    connessioniPeer[
      uid
    ]
  ) {
    return;
  }

  const pc =
    creaConnessionePeer(
      uid
    );

  if (!pc) {
    return;
  }

  if (
    sonoIoAdIniziare
  ) {
    try {
      const offerta =
        await pc.createOffer();

      await pc.setLocalDescription(
        offerta
      );

      if (
        socket &&
        socket.readyState ===
          WebSocket.OPEN
      ) {
        socket.send(
          JSON.stringify({
            tipo:
              "webrtc-offer",

            partitaId,

            destinatarioUid:
              uid,

            sdp:
              pc.localDescription
          })
        );
      }
    } catch {
      chiudiConnessioneAudio(
        uid
      );
    }
  }
}

async function aggiungiCandidatiICEInCoda(
  uid,
  pc
) {
  const coda =
    candidatiICEInAttesa[
      uid
    ];

  if (
    !Array.isArray(
      coda
    ) ||
    !pc
  ) {
    return;
  }

  delete candidatiICEInAttesa[
    uid
  ];

  for (
    const candidate of coda
  ) {
    try {
      await pc.addIceCandidate(
        new RTCIceCandidate(
          candidate
        )
      );
    } catch {}
  }
}

async function gestisciOffertaRicevuta(
  mittenteUid,
  sdp
) {
  const uid =
    String(
      mittenteUid || ""
    );

  if (
    !uid ||
    !sdp ||
    !microfonoAttivo
  ) {
    return;
  }

  try {
    const pc =
      connessioniPeer[
        uid
      ] ||
      creaConnessionePeer(
        uid
      );

    if (!pc) {
      return;
    }

    await pc.setRemoteDescription(
      new RTCSessionDescription(
        sdp
      )
    );

    await aggiungiCandidatiICEInCoda(
      uid,
      pc
    );

    const risposta =
      await pc.createAnswer();

    await pc.setLocalDescription(
      risposta
    );

    if (
      socket &&
      socket.readyState ===
        WebSocket.OPEN
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "webrtc-answer",

          partitaId,

          destinatarioUid:
            uid,

          sdp:
            pc.localDescription
        })
      );
    }
  } catch {}
}

async function gestisciRispostaRicevuta(
  mittenteUid,
  sdp
) {
  const uid =
    String(
      mittenteUid || ""
    );

  const pc =
    connessioniPeer[
      uid
    ];

  if (
    !pc ||
    !sdp
  ) {
    return;
  }

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(
        sdp
      )
    );

    await aggiungiCandidatiICEInCoda(
      uid,
      pc
    );
  } catch {}
}

async function gestisciCandidatoRicevuto(
  mittenteUid,
  candidate
) {
  const uid =
    String(
      mittenteUid || ""
    );

  if (
    !uid ||
    !candidate
  ) {
    return;
  }

  const pc =
    connessioniPeer[
      uid
    ];

  /*
   * Se l'offerta/answer non è ancora impostata,
   * mettiamo il candidate in coda.
   */
  if (
    !pc ||
    !pc.remoteDescription
  ) {
    if (
      !candidatiICEInAttesa[
        uid
      ]
    ) {
      candidatiICEInAttesa[
        uid
      ] =
        [];
    }

    candidatiICEInAttesa[
      uid
    ].push(
      candidate
    );

    return;
  }

  try {
    await pc.addIceCandidate(
      new RTCIceCandidate(
        candidate
      )
    );
  } catch {}
}

function chiudiConnessioneAudio(
  altroUid
) {
  const uid =
    String(
      altroUid || ""
    );

  const pc =
    connessioniPeer[
      uid
    ];

  if (pc) {
    try {
      pc.ontrack =
        null;

      pc.onicecandidate =
        null;

      pc.onconnectionstatechange =
        null;

      pc.close();
    } catch {}

    delete connessioniPeer[
      uid
    ];
  }

  const audio =
    elementiAudioRemoti[
      uid
    ];

  if (audio) {
    try {
      audio.srcObject =
        null;

      audio.remove();
    } catch {}

    delete elementiAudioRemoti[
      uid
    ];
  }

  delete candidatiICEInAttesa[
    uid
  ];

  coppieAudioAttive.delete(
    uid
  );
}

function distruggiTuttoAudio() {
  if (
    flussoAudioLocale
  ) {
    flussoAudioLocale
      .getTracks()
      .forEach(
        track => {
          try {
            track.stop();
          } catch {}
        }
      );

    flussoAudioLocale =
      null;
  }

  Object.keys(
    connessioniPeer
  ).forEach(
    chiudiConnessioneAudio
  );

  richiesteInviate.clear();
  coppieAudioAttive.clear();
}

/* ============================================================
   MENU / USCITA PARTITA
   ============================================================ */

function tornaAllaLobby() {
  const url =
    "lobby.html?stanza=" +
    encodeURIComponent(
      stanza || ""
    );

  window.location.href =
    url;
}

function abbandonaPartita() {
  if (
    partitaTerminataLocale
  ) {
    tornaAllaLobby();
    return;
  }

  const conferma =
    window.confirm(
      "Sei sicuro di voler abbandonare la partita?"
    );

  if (!conferma) {
    return;
  }

  fermaCountdownCompleto();

  azioneLocaleInCorso =
    true;

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {
    try {
      socket.send(
        JSON.stringify({
          tipo:
            "abbandonaPartita",

          partitaId
        })
      );
    } catch {}
  }

  /*
   * Un piccolo ritardo permette al WebSocket
   * di accodare il messaggio prima della navigazione.
   */
  setTimeout(
    () => {
      tornaAllaLobby();
    },
    120
  );
}

/* ============================================================
   DADI - INPUT
   ============================================================ */

function gestisciClickDadi() {
  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  if (!areaDadi) {
    return;
  }

  areaDadi.addEventListener(
    "click",
    () => {
      if (
        partitaTerminataLocale
      ) {
        return;
      }

      const possoTirare =
        faseAttuale ===
        "determinazione"
          ? possoTirareIoInDeterminazione
          : mioTurno;

      if (!possoTirare) {
        return;
      }

      if (
        azioneLocaleInCorso
      ) {
        return;
      }

      if (
        !socket ||
        socket.readyState !==
          WebSocket.OPEN
      ) {
        return;
      }

      /*
       * Blocco immediato del doppio click.
       */
      azioneLocaleInCorso =
        true;

      fermaCountdownPerAzioneLocale();

      areaDadi.classList.add(
        "disabilitato"
      );

      try {
        if (
          faseAttuale ===
          "determinazione"
        ) {
          socket.send(
            JSON.stringify({
              tipo:
                "tiraDeterminazione",

              partitaId
            })
          );
        } else {
          socket.send(
            JSON.stringify({
              tipo:
                "tiraDadi",

              partitaId
            })
          );
        }
      } catch {
        azioneLocaleInCorso =
          false;

        areaDadi.classList.remove(
          "disabilitato"
        );
      }
    }
  );
}

/* ============================================================
   AUTENTICAZIONE
   ============================================================ */

function reindirizzaLogin() {
  const redirect =
    encodeURIComponent(
      window.location.href
    );

  window.location.href =
    "login.html?redirect=" +
    redirect;
}

async function avvia() {
  if (!partitaId) {
    alert(
      "ID partita mancante."
    );

    return;
  }

  try {
    const risposta =
      await fetch(
        URL_SERVER_HTTP +
          "/api/me",
        {
          method:
            "GET",

          credentials:
            "include",

          cache:
            "no-store"
        }
      );

    if (
      !risposta.ok
    ) {
      reindirizzaLogin();
      return;
    }

    const dati =
      await risposta.json();

    if (
      !dati ||
      !dati.uid
    ) {
      reindirizzaLogin();
      return;
    }

    mioUid =
      String(
        dati.uid
      );

    mioNickname =
      dati.nickname ||
      null;

    const elementoNickname =
      document.getElementById(
        "mio-nickname"
      );

    if (
      elementoNickname
    ) {
      elementoNickname.textContent =
        mioNickname ||
        "";
    }

    faseAttuale =
      "connessione";

    connetti();
  } catch {
    reindirizzaLogin();
  }
}

/* ============================================================
   RICONNESSIONE
   ============================================================ */

function pianificaRiconnessione() {
  if (
    timerRiconnessione
  ) {
    return;
  }

  if (
    partitaTerminataLocale
  ) {
    return;
  }

  numeroTentativiRiconnessione +=
    1;

  const ritardo =
    Math.min(
      MAX_RICONNESSIONE_MS,
      1000 *
        Math.pow(
          1.6,
          Math.min(
            5,
            numeroTentativiRiconnessione
          )
        )
    );

  timerRiconnessione =
    setTimeout(
      () => {
        timerRiconnessione =
          null;

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

        connetti();
      },
      ritardo
    );
}

function aggiornaStatoConnessione(
  testo,
  classe
) {
  const elemento =
    document.getElementById(
      "riga-turno"
    );

  if (
    elemento &&
    testo
  ) {
    elemento.textContent =
      testo;
  }

  document.body.classList.toggle(
    "connessione-problematica",
    Boolean(classe)
  );
}

function connetti() {
  if (
    partitaTerminataLocale
  ) {
    return;
  }

  if (
    tentativoRiconnessioneInCorso
  ) {
    return;
  }

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {
    return;
  }

  tentativoRiconnessioneInCorso =
    true;

  faseAttuale =
    "connessione";

  aggiornaStatoConnessione(
    "🟡 Connessione al server...",
    false
  );

  let nuovoSocket;

  try {
    nuovoSocket =
      new WebSocket(
        URL_SERVER_WS
      );
  } catch {
    tentativoRiconnessioneInCorso =
      false;

    pianificaRiconnessione();

    return;
  }

  socket =
    nuovoSocket;

  socket.onopen =
    () => {
      if (
        socket !==
        nuovoSocket
      ) {
        return;
      }

      tentativoRiconnessioneInCorso =
        false;

      numeroTentativiRiconnessione =
        0;

      if (
        timerRiconnessione
      ) {
        clearTimeout(
          timerRiconnessione
        );

        timerRiconnessione =
          null;
      }

      aggiornaStatoConnessione(
        mioTurno
          ? "🎲 È il tuo turno!"
          : "⏳ In attesa...",
        false
      );

      try {
        socket.send(
          JSON.stringify({
            tipo:
              "riprendiPartita",

            partitaId
          })
        );
      } catch {}
    };

  socket.onmessage =
    event => {
      if (
        socket !==
        nuovoSocket
      ) {
        return;
      }

      gestisciMessaggioServer(
        event.data
      );
    };

  socket.onerror =
    () => {
      if (
        socket !==
        nuovoSocket
      ) {
        return;
      }

      aggiornaStatoConnessione(
        "🟠 Connessione instabile...",
        true
      );
    };

  socket.onclose =
    () => {
      if (
        socket !==
        nuovoSocket
      ) {
        return;
      }

      tentativoRiconnessioneInCorso =
        false;

      if (
        partitaTerminataLocale
      ) {
        return;
      }

      aggiornaStatoConnessione(
        "🔴 Disconnesso, riconnessione...",
        true
      );

      pianificaRiconnessione();
    };
}

/* ============================================================
   MESSAGGI SERVER
   ============================================================ */

function gestisciMessaggioServer(
  rawData
) {
  let dati;

  try {
    dati =
      typeof rawData ===
        "string"
        ? JSON.parse(
            rawData
          )
        : rawData;
  } catch {
    return;
  }

  if (
    !dati ||
    typeof dati !==
      "object" ||
    !dati.tipo
  ) {
    return;
  }

  switch (
    dati.tipo
  ) {
    case "sessioneScaduta":
      gestisciSessioneScaduta();
      return;

    case "statoDeterminazione":
      gestisciStatoDeterminazione(
        dati
      );
      return;

    case "risultatoDeterminazione":
      gestisciRisultatoDeterminazione(
        dati
      );
      return;

    case "ordineFinaleCalcolato":
      gestisciOrdineFinaleCalcolato(
        dati
      );
      return;

    case "determinazioneCompletata":
      gestisciDeterminazioneCompletata(
        dati
      );
      return;

    case "statoPartita":
      riceviStatoPartita(
        dati
      );
      return;

    case "aggiornamentoPartita":
      gestisciAggiornamentoPartita(
        dati
      );
      return;

    case "chatPartita":
      aggiungiMessaggioChatPartita(
        dati.nome,
        dati.testo
      );
      return;

    case "richiestaAudioRicevuta":
      mostraRichiestaAudioRicevuta(
        dati.mittenteUid,
        dati.mittenteNome
      );
      return;

    case "rispostaAudioRicevuta":
      gestisciRispostaAudioRicevuta(
        dati
      );
      return;

    case "webrtc-offer":
      gestisciOffertaRicevuta(
        dati.mittenteUid,
        dati.sdp
      );
      return;

    case "webrtc-answer":
      gestisciRispostaRicevuta(
        dati.mittenteUid,
        dati.sdp
      );
      return;

    case "webrtc-ice-candidate":
      gestisciCandidatoRicevuto(
        dati.mittenteUid,
        dati.candidate
      );
      return;

    case "errore":
      gestisciErroreServer(
        dati
      );
      return;

    default:
      /*
       * Messaggi di lobby o altro
       * non interessano questa pagina.
       */
      return;
  }
}

function gestisciSessioneScaduta() {
  fermaCountdownCompleto();

  distruggiTuttoAudio();

  reindirizzaLogin();
}

function gestisciRispostaAudioRicevuta(
  dati
) {
  const mittenteUid =
    String(
      dati.mittenteUid ||
        ""
    );

  if (
    mittenteUid
  ) {
    richiesteInviate.delete(
      mittenteUid
    );
  }

  if (
    dati.accettato &&
    mittenteUid
  ) {
    coppieAudioAttive.add(
      mittenteUid
    );

    disegnaGiocatori();

    avviaConnessioneAudio(
      mittenteUid,
      true
    );
  } else {
    disegnaGiocatori();
  }
}

function gestisciErroreServer(
  dati
) {
  const messaggio =
    String(
      dati.messaggio ||
        "Si è verificato un errore."
    );

  /*
   * L'errore "Partita non trovata"
   * dopo una vittoria può essere normale:
   * il server ha già eliminato la partita.
   */
  if (
    partitaTerminataLocale
  ) {
    return;
  }

  /*
   * Quando il server rifiuta un tiro,
   * possiamo riabilitare il pulsante.
   */
  if (
    messaggio
      .toLowerCase()
      .includes(
        "non è il tuo turno"
      ) ||
    messaggio
      .toLowerCase()
      .includes(
        "non è il tuo turno per tirare"
      ) ||
    messaggio
      .toLowerCase()
      .includes(
        "partita non trovata"
      )
  ) {
    azioneLocaleInCorso =
      false;

    disegnaGiocatori();
  }

  /*
   * Un errore di rete non deve automaticamente
   * distruggere il countdown che ci ha inviato
   * il server, quindi non lo azzeriamo qui.
   */
  alert(
    messaggio
  );
}

/* ============================================================
   EVENTI GLOBALI
   ============================================================ */

function configuraEventiGlobali() {
  document.addEventListener(
    "fullscreenchange",
    aggiornaTestoBottoneFullscreen
  );

  document.addEventListener(
    "webkitfullscreenchange",
    aggiornaTestoBottoneFullscreen
  );

  const btnFullscreen =
    document.getElementById(
      "btn-toggle-fullscreen"
    );

  if (btnFullscreen) {
    btnFullscreen.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        toggleFullscreen();
      }
    );
  }

  const btnSuoni =
    document.getElementById(
      "btn-toggle-suoni"
    );

  if (btnSuoni) {
    btnSuoni.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        toggleSuoni();
      }
    );
  }

  const btnMicrofono =
    document.getElementById(
      "btn-toggle-microfono"
    );

  if (btnMicrofono) {
    btnMicrofono.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        toggleMicrofono();
      }
    );
  }

  const btnAbbandona =
    document.getElementById(
      "btn-abbandona-partita"
    );

  if (btnAbbandona) {
    btnAbbandona.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        abbandonaPartita();
      }
    );
  }

  const btnTornaLobby =
    document.getElementById(
      "btn-torna-lobby"
    );

  if (btnTornaLobby) {
    btnTornaLobby.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        tornaAllaLobby();
      }
    );
  }

  /*
   * Alcuni HTML potrebbero chiamare queste funzioni
   * direttamente tramite onclick.
   */
  window.toggleFullscreen =
    toggleFullscreen;

  window.toggleSuoni =
    toggleSuoni;

  window.toggleMicrofono =
    toggleMicrofono;

  window.abbandonaPartita =
    abbandonaPartita;

  window.tornaAllaLobby =
    tornaAllaLobby;

  window.apriProfilo =
    apriProfilo;

  window.apriImpostazioni =
    apriImpostazioni;

  window.chiudiMenu =
    chiudiMenu;

  window.richiediAudioCon =
    richiediAudioCon;

  window.rispondiRichiestaAudioRicevuta =
    rispondiRichiestaAudioRicevuta;

  window.inviaChatPartita =
    inviaChatPartita;
}

/* ============================================================
   CHIUSURA / VISIBILITÀ PAGINA
   ============================================================ */

document.addEventListener(
  "visibilitychange",
  () => {
    /*
     * NON fermiamo il timer:
     * il tempo reale appartiene al server.
     *
     * Al ritorno della tab la visualizzazione
     * viene semplicemente ricalcolata usando Date.now().
     */
    if (
      document.visibilityState ===
      "visible"
    ) {
      aggiornaCountdownTurno();

      aggiornaLayoutTabellone();
    }
  }
);

window.addEventListener(
  "beforeunload",
  () => {
    distruggiTuttoAudio();

    /*
     * Non inviamo "abbandonaPartita" qui:
     * beforeunload non garantisce l'invio WebSocket.
     */
  }
);

/* ============================================================
   INIZIALIZZAZIONE
   ============================================================ */

function inizializzaGioco() {
  aggiornaTestoBottoneSuoni();
  aggiornaTestoBottoneFullscreen();
  aggiornaTestoBottoneMicrofono();
  aggiornaBadgeChatPartita();

  mostraDadi(
    1,
    1
  );

  configuraEventiGlobali();
  configuraMenu();
  configuraPannelloGiocatori();
  configuraChat();

  gestisciClickDadi();

  inizializzaGestioneOrientamento();

  if (!partitaId) {
    alert(
      "ID partita mancante."
    );

    return;
  }

  avvia();
}

if (
  document.readyState ===
  "loading"
) {
  document.addEventListener(
    "DOMContentLoaded",
    inizializzaGioco,
    {
      once: true
    }
  );
} else {
  inizializzaGioco();
}
