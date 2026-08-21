/* ============================================================
   GIOCO DELL'OCA - GIOCHI SOCIETA
   Versione integrata:
   - turni sincronizzati
   - blocco anti-doppio tiro
   - countdown
   - ELO
   - microfono
   - videocamera
   - WebRTC
   - chat
   - dadi
   - determinazione iniziale
   ============================================================ */

"use strict";

/* ============================================================
   TABELLONE
   ============================================================ */

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

const DURATA_LANCIO_DADI_MS = 1300;
const DURATA_SALTO_MS = 260;

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

/*
 * BLOCCO IMPORTANTE:
 * impedisce di inviare due volte tiraDadi nello stesso turno.
 */
let azioneTurnoInviata = false;
let turnoBloccatoLocalmente = false;
let ultimoTurnoProcessato = null;

let timerRiconnessione = null;
let tentativoRiconnessioneInCorso = false;

let faseAttuale = "normale";
let possoTirareIoInDeterminazione = false;

let durataMossaMsAttuale = null;
let msResiduiRiferimento = null;
let momentoLocaleRiferimento = null;
let intervalCountdown = null;
let ultimoSecondoAvviso = null;
let turnoLocalmenteCompletato = false;

/* ============================================================
   UTILITY
   ============================================================ */

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

function escapeHtml(valore) {
  return String(valore ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ============================================================
   ELO
   ============================================================ */

function ottieniElo(giocatore) {
  if (!giocatore) return null;

  const candidati = [
    giocatore.elo,
    giocatore.puntiElo,
    giocatore.rating,
    giocatore.ELO
  ];

  for (const valore of candidati) {
    const numero = Number(valore);

    if (Number.isFinite(numero)) {
      return Math.round(numero);
    }
  }

  return null;
}

function htmlElo(giocatore) {
  const elo = ottieniElo(giocatore);

  if (elo === null) {
    return `<span class="elo-mini" title="Punti ELO">ELO --</span>`;
  }

  return `<span class="elo-mini" title="Punti ELO">ELO ${elo}</span>`;
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

      if (!C) {
        return null;
      }

      contestoAudio = new C();
    }

    if (contestoAudio.state === "suspended") {
      const promessa = contestoAudio.resume();

      if (promessa && typeof promessa.catch === "function") {
        promessa.catch(() => {});
      }
    }

    return contestoAudio;
  } catch (e) {
    return null;
  }
}

function suonaTono(
  frequenza,
  durataMs,
  tipoOnda,
  volume,
  ritardoMs
) {
  if (!suoniAttivi) return;

  const ctx = ottieniContestoAudio();

  if (!ctx) return;

  try {
    const inizio =
      ctx.currentTime +
      (ritardoMs || 0) / 1000;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.type = tipoOnda || "sine";

    osc.frequency.setValueAtTime(
      frequenza,
      inizio
    );

    g.gain.setValueAtTime(
      0.0001,
      inizio
    );

    g.gain.linearRampToValueAtTime(
      volume || 0.12,
      inizio + 0.01
    );

    g.gain.exponentialRampToValueAtTime(
      0.0001,
      inizio + durataMs / 1000
    );

    osc.connect(g);
    g.connect(ctx.destination);

    osc.start(inizio);

    osc.stop(
      inizio +
      durataMs / 1000 +
      0.02
    );
  } catch (e) {}
}

function suonaClick(volume, ritardoMs) {
  if (!suoniAttivi) return;

  const ctx = ottieniContestoAudio();

  if (!ctx) return;

  try {
    const inizio =
      ctx.currentTime +
      (ritardoMs || 0) / 1000;

    const durata = 0.045;

    const lung = Math.max(
      1,
      Math.floor(ctx.sampleRate * durata)
    );

    const buffer = ctx.createBuffer(
      1,
      lung,
      ctx.sampleRate
    );

    const dati = buffer.getChannelData(0);

    for (let i = 0; i < lung; i++) {
      dati[i] =
        (Math.random() * 2 - 1) *
        (1 - i / lung);
    }

    const s = ctx.createBufferSource();

    s.buffer = buffer;

    const g = ctx.createGain();

    g.gain.setValueAtTime(
      volume || 0.18,
      inizio
    );

    g.gain.exponentialRampToValueAtTime(
      0.001,
      inizio + durata
    );

    s.connect(g);
    g.connect(ctx.destination);

    s.start(inizio);
  } catch (e) {}
}

function suonaTiroDadi() {
  if (!suoniAttivi) return;

  for (let i = 0; i < 7; i++) {
    suonaClick(0.1, i * 100);
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

  suonaClick(0.15, 20);
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

function toggleSuoni() {
  impostaSuoni(!suoniAttivi);
}

function impostaSuoni(attivi) {
  suoniAttivi = !!attivi;

  localStorage.setItem(
    "suoniAttivi",
    suoniAttivi ? "on" : "off"
  );

  aggiornaTestoBottoneSuoni();
}

function aggiornaTestoBottoneSuoni() {
  const b =
    document.getElementById(
      "btn-toggle-suoni"
    );

  if (!b) return;

  b.textContent =
    suoniAttivi
      ? "🔊 Suoni: On"
      : "🔇 Suoni: Off";
}

/* ============================================================
   FULLSCREEN
   ============================================================ */

function toggleFullscreen() {
  try {
    if (
      !document.fullscreenElement &&
      !document.webkitFullscreenElement
    ) {
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
        richiesta.call(elemento);

      if (
        risultato &&
        typeof risultato.catch === "function"
      ) {
        risultato.catch(() => {});
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
  } catch (err) {}
}

function aggiornaTestoBottoneFullscreen() {
  const b =
    document.getElementById(
      "btn-toggle-fullscreen"
    );

  if (!b) return;

  b.textContent =
    (
      document.fullscreenElement ||
      document.webkitFullscreenElement
    )
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

/* ============================================================
   ORIENTAMENTO
   ============================================================ */

function eSchermoInLandscape() {
  if (
    window.screen &&
    window.screen.orientation &&
    typeof window.screen.orientation.type === "string"
  ) {
    const orientamento =
      window.screen.orientation.type;

    if (
      orientamento === "landscape-primary" ||
      orientamento === "landscape-secondary"
    ) {
      return true;
    }

    if (
      orientamento === "portrait-primary" ||
      orientamento === "portrait-secondary"
    ) {
      return false;
    }
  }

  return (
    window.innerWidth >
    window.innerHeight
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
    !eDesktop && !eLandscape
  );

  const altezzaReale =
    window.visualViewport
      ? window.visualViewport.height
      : window.innerHeight;

  document.documentElement.style.setProperty(
    "--altezza-reale",
    altezzaReale + "px"
  );
}

function rilevaEImpostaModalitaDesktop() {
  const puntatorePreciso =
    window.matchMedia &&
    window.matchMedia("(pointer: fine)").matches;

  const schermoAmpio =
    window.innerWidth >= 1000;

  document.body.classList.toggle(
    "modalita-desktop",
    !!(
      puntatorePreciso &&
      schermoAmpio
    )
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

  if (!areaTabellone || !immagine) {
    return;
  }

  const rapportoNaturale =
    (
      immagine.naturalWidth &&
      immagine.naturalHeight
    )
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

  let Wc;
  let Hc;

  if (eDesktop) {
    const margineOrizzontale =
      Math.max(
        16,
        larghezzaFinestra * 0.03
      );

    const margineVerticale =
      Math.max(
        16,
        altezzaReale * 0.03
      );

    const larghezzaDisponibile =
      larghezzaFinestra -
      margineOrizzontale * 2;

    const altezzaDisponibile =
      altezzaReale -
      margineVerticale * 2;

    Wc = Math.max(
      120,
      Math.min(
        larghezzaDisponibile,
        altezzaDisponibile *
          rapportoNaturale
      )
    );

    Hc =
      Wc /
      rapportoNaturale;
  } else if (eLandscape) {
    const margineOrizzontale = 8;
    const margineVerticale = 8;

    const larghezzaDisponibile =
      larghezzaFinestra -
      margineOrizzontale * 2;

    const altezzaDisponibile =
      altezzaReale -
      margineVerticale * 2;

    Wc = Math.min(
      larghezzaDisponibile,
      altezzaDisponibile *
        rapportoNaturale
    );

    Hc =
      Wc /
      rapportoNaturale;
  } else {
    const margine = 8;

    const spazioOrizzontale =
      larghezzaFinestra -
      margine * 2;

    const spazioVerticale =
      altezzaReale -
      margine * 2;

    Hc =
      spazioOrizzontale;

    Wc =
      Hc *
      rapportoNaturale;

    if (Wc > spazioVerticale) {
      Wc = spazioVerticale;
      Hc =
        Wc /
        rapportoNaturale;
    }
  }

  if (
    !Number.isFinite(Wc) ||
    !Number.isFinite(Hc)
  ) {
    return;
  }

  areaTabellone.style.width =
    Wc + "px";

  areaTabellone.style.height =
    Hc + "px";

  riposizionaTuttePedine();
}

let timerDebounceResize = null;

function gestisciResize() {
  rilevaEImpostaModalitaDesktop();

  calcolaEAggiornaOrientamento();

  clearTimeout(
    timerDebounceResize
  );

  timerDebounceResize =
    setTimeout(
      aggiornaLayoutTabellone,
      60
    );
}

function immagine_pronta() {
  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  return !!(
    immagine &&
    immagine.complete &&
    immagine.naturalWidth
  );
}

function inizializzaGestioneOrientamento() {
  rilevaEImpostaModalitaDesktop();

  calcolaEAggiornaOrientamento();

  aggiornaLayoutTabellone();

  window.addEventListener(
    "resize",
    gestisciResize
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
    }
  );

  if (window.visualViewport) {
    window.visualViewport.addEventListener(
      "resize",
      gestisciResize
    );
  }

  if (
    window.screen &&
    window.screen.orientation &&
    window.screen.orientation.addEventListener
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
      }
    );
  }

  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  if (immagine_pronta()) {
    aggiornaLayoutTabellone();
  } else if (immagine) {
    immagine.addEventListener(
      "load",
      aggiornaLayoutTabellone
    );
  }
}

/* ============================================================
   FLASH
   ============================================================ */

let timerFlashMessaggio = null;

function mostraMessaggioGiocoGrande(testo) {
  if (!testo) return;

  const el =
    document.getElementById(
      "flash-messaggio-gioco"
    );

  if (!el) return;

  if (
    testo
      .toLowerCase()
      .includes(
        "avanza dello stesso numero di caselle"
      )
  ) {
    return;
  }

  const span =
    el.querySelector("span");

  if (!span) return;

  span.textContent =
    testo;

  el.classList.remove(
    "visibile"
  );

  void el.offsetWidth;

  el.classList.add(
    "visibile"
  );

  if (timerFlashMessaggio) {
    clearTimeout(
      timerFlashMessaggio
    );
  }

  timerFlashMessaggio =
    setTimeout(() => {
      el.classList.remove(
        "visibile"
      );
    }, 1500);
}

/* ============================================================
   DETERMINAZIONE
   ============================================================ */

let areaDadiHomeGenitore = null;
let areaDadiHomeFratelloSuccessivo = null;

function spostaDadiInDeterminazione() {
  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  const slot =
    document.getElementById(
      "slot-dadi-determinazione"
    );

  if (!areaDadi || !slot) {
    return false;
  }

  if (areaDadi.parentNode === slot) {
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

function disegnaListaDeterminazione(
  giocatori,
  turnoInCorsoUid,
  gruppoSpareggio
) {
  const lista =
    document.getElementById(
      "lista-determinazione"
    );

  if (!lista) return;

  const elenco =
    Array.isArray(giocatori)
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

  lista.innerHTML =
    elenco
      .map((g) => {
        const avatarHtml =
          g.avatar
            ? `<img class="avatar-mini" src="${escapeHtml(g.avatar)}" alt="">`
            : `<div class="avatar-mini" style="background:${escapeHtml(coloreDaNome(g.nome))};">${escapeHtml(iniziale(g.nome))}</div>`;

        let statoHtml;

        if (
          g.risultato != null
        ) {
          statoHtml =
            `<span class="determinazione-risultato">🎲 ${escapeHtml(g.risultato)}</span>`;
        } else if (
          g.uid ===
          turnoInCorsoUid
        ) {
          statoHtml =
            `<span class="determinazione-in-corso">🎲 sta tirando...</span>`;
        } else {
          statoHtml =
            `<span class="determinazione-attesa">in attesa</span>`;
        }

        const tagSpareggio =
          spareggioSet.has(g.uid)
            ? `<span class="determinazione-tag-spareggio" title="In spareggio">⚔️</span>`
            : "";

        const evidenzia =
          g.uid === turnoInCorsoUid
            ? " determinazione-riga-attiva"
            : "";

        return `
          <div class="determinazione-riga${evidenzia}">
            ${avatarHtml}
            <span class="determinazione-nome">${escapeHtml(g.nome || "?")}</span>
            ${tagSpareggio}
            ${statoHtml}
          </div>
        `;
      })
      .join("");
}

function gestisciStatoDeterminazione(dati) {
  faseAttuale =
    "determinazione";

  const overlay =
    document.getElementById(
      "overlay-determinazione"
    );

  if (overlay) {
    overlay.classList.add(
      "aperto"
    );
  }

  const appenaEntrato =
    spostaDadiInDeterminazione();

  if (appenaEntrato) {
    mostraDadi(1, 1);
  }

  const giocatori =
    Array.isArray(dati.giocatori)
      ? dati.giocatori
      : [];

  disegnaListaDeterminazione(
    giocatori,
    dati.turnoInCorsoUid || null,
    dati.gruppoSpareggioAttuale || []
  );

  possoTirareIoInDeterminazione =
    dati.turnoInCorsoUid === mioUid;

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

  if (
    dati.gruppoSpareggioAttuale &&
    dati.gruppoSpareggioAttuale.length
  ) {
    const nomiSpareggio =
      dati.gruppoSpareggioAttuale
        .map((u) => {
          const g =
            giocatori.find(
              (x) => x.uid === u
            );

          return g
            ? g.nome
            : "?";
        })
        .join(", ");

    if (sottotitolo) {
      sottotitolo.textContent =
        "⚔️ Pareggio tra " +
        nomiSpareggio +
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
        (g) =>
          g.uid ===
          dati.turnoInCorsoUid
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
}

function gestisciRisultatoDeterminazione(
  dati
) {
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
          (dati.nome ||
            "Il giocatore") +
          " ha fatto " +
          Number(
            dati.valoreDado || 0
          ) +
          (dati.automatico
            ? " (tempo scaduto)"
            : "") +
          "!";
      }
    }
  );
}

function gestisciOrdineFinaleCalcolato(
  dati
) {
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

  if (!lista) return;

  const ordine =
    Array.isArray(
      dati.ordineGiocatori
    )
      ? dati.ordineGiocatori
      : [];

  lista.innerHTML =
    ordine
      .map(
        (nome, indice) => {
          const punteggio =
            dati.punteggi &&
            dati.punteggi[nome] != null
              ? dati.punteggi[nome]
              : "?";

          return `
            <div class="determinazione-riga determinazione-riga-finale"
                 style="animation-delay:${indice * 0.12}s;">
              <span class="determinazione-posizione-finale">
                ${indice + 1}°
              </span>

              <span class="determinazione-nome">
                ${escapeHtml(nome || "?")}
              </span>

              <span class="determinazione-risultato">
                🎲 ${escapeHtml(punteggio)}
              </span>
            </div>
          `;
        }
      )
      .join("");
}

function gestisciDeterminazioneCompletata(
  dati
) {
  faseAttuale = "normale";

  const overlay =
    document.getElementById(
      "overlay-determinazione"
    );

  if (overlay) {
    overlay.classList.remove(
      "aperto"
    );
  }

  riportaDadiAllaPartita();

  ultimoStatoGiocatori =
    Array.isArray(dati.giocatori)
      ? dati.giocatori
      : [];

  const primoMovimento =
    dati.primoMovimento || {};

  const messaggiGioco =
    document.getElementById(
      "messaggi-gioco"
    );

  if (messaggiGioco) {
    messaggiGioco.textContent =
      "🎲 " +
      (primoMovimento.nomeGiocatore || "?") +
      " ha fatto " +
      Number(
        primoMovimento.valoreDado || 0
      ) +
      " — avanza di " +
      Number(
        primoMovimento.valoreDado || 0
      ) +
      " caselle!";
  }

  animaSaltoPedina(
    primoMovimento.idGiocatore,
    primoMovimento.percorso || [],
    () => {
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

      ultimoTurnoProcessato =
        dati.turnoDiId || null;

      aggiornaTurno(
        dati.turnoDiId || null
      );

      if (
        dati.tempoInizioTurno != null &&
        dati.durataMossaMs != null
      ) {
        avviaCountdownTurno(
          dati.tempoInizioTurno,
          dati.durataMossaMs,
          dati.scadenzaTurno || null
        );
      }

      disegnaGiocatori();

      if (dati.vittoria) {
        turnoAttualeId = null;
        mioTurno = false;

        fermaCountdownCompleto();

        const areaDadi =
          document.getElementById(
            "area-dadi"
          );

        if (areaDadi) {
          areaDadi.classList.add(
            "disabilitato"
          );
        }

        mostraVittoria(
          dati.vincitore
        );
      }
    }
  );
}

/* ============================================================
   TIMER
   ============================================================ */

function fermaCountdownCompleto() {
  if (
    intervalCountdown !== null
  ) {
    clearInterval(
      intervalCountdown
    );

    intervalCountdown = null;
  }
}

function azzeraDatiCountdown() {
  durataMossaMsAttuale = null;
  msResiduiRiferimento = null;
  momentoLocaleRiferimento = null;
  ultimoSecondoAvviso = null;
}

function avviaCountdownTurno(
  tempoInizio,
  durataMs,
  scadenzaTurno = null
) {
  fermaCountdownCompleto();

  const durataNumero =
    Number(durataMs);

  durataMossaMsAttuale =
    Number.isFinite(
      durataNumero
    ) && durataNumero > 0
      ? durataNumero
      : null;

  if (
    durataMossaMsAttuale === null
  ) {
    msResiduiRiferimento = null;
    momentoLocaleRiferimento = null;

    aggiornaCountdownTurno();

    return;
  }

  const inizioNumero =
    Number(tempoInizio);

  const scadenzaNumero =
    Number(scadenzaTurno);

  let msRestantiAllArrivo;

  if (
    Number.isFinite(
      scadenzaNumero
    ) &&
    scadenzaNumero > 0
  ) {
    msRestantiAllArrivo =
      scadenzaNumero -
      Date.now();
  } else if (
    Number.isFinite(
      inizioNumero
    ) &&
    inizioNumero > 0
  ) {
    msRestantiAllArrivo =
      inizioNumero +
      durataMossaMsAttuale -
      Date.now();
  } else {
    msRestantiAllArrivo =
      durataMossaMsAttuale;
  }

  msResiduiRiferimento =
    Math.max(
      0,
      Math.min(
        durataMossaMsAttuale,
        msRestantiAllArrivo
      )
    );

  momentoLocaleRiferimento =
    performance.now();

  ultimoSecondoAvviso = null;

  turnoLocalmenteCompletato = false;

  aggiornaCountdownTurno();

  intervalCountdown =
    setInterval(
      aggiornaCountdownTurno,
      100
    );
}

function fermaCountdownPerAzioneLocale() {
  turnoLocalmenteCompletato = true;

  fermaCountdownCompleto();

  const el =
    document.getElementById(
      "countdown-turno"
    );

  if (el) {
    el.textContent = "✓";

    el.classList.remove(
      "countdown-scaduto"
    );

    el.classList.add(
      "countdown-fermo"
    );
  }
}

function aggiornaCountdownTurno() {
  const el =
    document.getElementById(
      "countdown-turno"
    );

  if (!el) return;

  if (turnoLocalmenteCompletato) {
    return;
  }

  if (
    msResiduiRiferimento === null ||
    momentoLocaleRiferimento === null
  ) {
    el.textContent = "⏱ --s";
    return;
  }

  const trascorsoLocaleMs =
    performance.now() -
    momentoLocaleRiferimento;

  const restanteMs =
    msResiduiRiferimento -
    trascorsoLocaleMs;

  const sec =
    Math.max(
      0,
      Math.ceil(
        restanteMs / 1000
      )
    );

  el.textContent =
    "⏱ " +
    sec +
    "s";

  el.classList.toggle(
    "countdown-scaduto",
    sec <= 0
  );

  el.classList.remove(
    "countdown-fermo"
  );

  if (
    sec >= 1 &&
    sec <= 3 &&
    sec !== ultimoSecondoAvviso
  ) {
    ultimoSecondoAvviso = sec;
    suonaAvvisoTempo();
  }
}

/* ============================================================
   AUDIO / VIDEO WEBRTC
   ============================================================ */

let microfonoAttivo = false;
let videocameraAttiva = false;

let flussoAudioLocale = null;
let flussoVideoLocale = null;

let connessioniAudioPeer = {};
let connessioniVideoPeer = {};

let elementiAudioRemoti = {};
let elementiVideoRemoti = {};

let uidRichiestaAudioInAttesa = null;
let uidRichiestaVideoInAttesa = null;

let richiesteInviateAudio = new Set();
let richiesteInviateVideo = new Set();

const CONFIGURAZIONE_ICE = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};

/* ============================================================
   CREAZIONE INTERFACCIA VIDEO
   ============================================================ */

function creaInterfacciaVideo() {
  if (!document.getElementById("btn-toggle-videocamera")) {
    const menu =
      document.getElementById(
        "pannello-menu"
      );

    if (menu) {
      const bottone =
        document.createElement("button");

      bottone.id =
        "btn-toggle-videocamera";

      bottone.type =
        "button";

      bottone.textContent =
        "📷 Videocamera: Off";

      bottone.onclick =
        toggleVideocamera;

      menu.insertBefore(
        bottone,
        menu.querySelector(
          ".voce-pericolo"
        ) || null
      );
    }
  }

  if (!document.getElementById("area-video-partita")) {
    const pannello =
      document.createElement("div");

    pannello.id =
      "area-video-partita";

    pannello.innerHTML = `
      <div id="video-locale-box">
        <video
          id="video-locale"
          autoplay
          muted
          playsinline>
        </video>

        <div class="video-locale-nome">
          Tu
        </div>
      </div>

      <div id="video-remoti"></div>
    `;

    document.body.appendChild(
      pannello
    );
  }

  inserisciStiliVideo();
}

function inserisciStiliVideo() {
  if (
    document.getElementById(
      "stili-video-dinamici"
    )
  ) {
    return;
  }

  const stile =
    document.createElement(
      "style"
    );

  stile.id =
    "stili-video-dinamici";

  stile.textContent = `
    #area-video-partita {
      position: fixed;
      right: 18px;
      top: 90px;
      z-index: 47000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: min(220px, 38vw);
      max-height: 70vh;
      overflow-y: auto;
      pointer-events: none;
    }

    #video-locale-box,
    .video-remoto-box {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      background: #0d1620;
      border: 1px solid rgba(255,215,0,0.35);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 22px rgba(0,0,0,0.5);
      pointer-events: auto;
    }

    #video-locale,
    .video-remoto {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      background: #000;
    }

    .video-locale-nome,
    .video-remoto-nome {
      position: absolute;
      left: 7px;
      bottom: 7px;
      padding: 4px 7px;
      border-radius: 7px;
      background: rgba(0,0,0,0.65);
      color: #fff;
      font-size: 11px;
      font-weight: bold;
    }

    #video-locale-box {
      display: none;
    }

    #video-remoti {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    @media (max-width: 700px) {
      #area-video-partita {
        width: min(160px, 34vw);
        right: 10px;
        top: 72px;
      }
    }
  `;

  document.head.appendChild(
    stile
  );
}

/* ============================================================
   MICROFONO
   ============================================================ */

async function toggleMicrofono() {
  if (microfonoAttivo) {
    disattivaMicrofono();
  } else {
    await attivaMicrofono();
  }
}

async function attivaMicrofono() {
  try {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !==
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
          audio: true,
          video: false
        }
      );
  } catch (e) {
    alert(
      "Non è stato possibile accedere al microfono. Controlla i permessi del browser."
    );

    return;
  }

  microfonoAttivo = true;

  aggiornaTestoBottoneMicrofono();

  disegnaGiocatori();
}

function disattivaMicrofono() {
  microfonoAttivo = false;

  if (flussoAudioLocale) {
    flussoAudioLocale
      .getTracks()
      .forEach((t) =>
        t.stop()
      );

    flussoAudioLocale = null;
  }

  Object.keys(
    connessioniAudioPeer
  ).forEach(
    chiudiConnessioneAudio
  );

  richiesteInviateAudio.clear();

  aggiornaTestoBottoneMicrofono();

  disegnaGiocatori();
}

function aggiornaTestoBottoneMicrofono() {
  const b =
    document.getElementById(
      "btn-toggle-microfono"
    );

  if (!b) return;

  b.textContent =
    microfonoAttivo
      ? "🎤 Microfono: On"
      : "🔇 Microfono: Off";
}

/* ============================================================
   VIDEOCAMERA
   ============================================================ */

async function toggleVideocamera() {
  if (videocameraAttiva) {
    disattivaVideocamera();
  } else {
    await attivaVideocamera();
  }
}

async function attivaVideocamera() {
  try {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !==
        "function"
    ) {
      alert(
        "Il tuo browser non permette l'accesso alla videocamera."
      );
      return;
    }

    flussoVideoLocale =
      await navigator.mediaDevices.getUserMedia(
        {
          audio: false,
          video: {
            facingMode: "user",
            width: {
              ideal: 640
            },
            height: {
              ideal: 400
            }
          }
        }
      );
  } catch (e) {
    alert(
      "Non è stato possibile accedere alla videocamera. Controlla i permessi del browser."
    );

    return;
  }

  videocameraAttiva = true;

  const video =
    document.getElementById(
      "video-locale"
    );

  const box =
    document.getElementById(
      "video-locale-box"
    );

  if (video) {
    video.srcObject =
      flussoVideoLocale;

    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    const p =
      video.play();

    if (
      p &&
      typeof p.catch === "function"
    ) {
      p.catch(() => {});
    }
  }

  if (box) {
    box.style.display =
      "block";
  }

  aggiornaTestoBottoneVideocamera();

  disegnaGiocatori();
}

function disattivaVideocamera() {
  videocameraAttiva = false;

  if (flussoVideoLocale) {
    flussoVideoLocale
      .getTracks()
      .forEach((t) =>
        t.stop()
      );

    flussoVideoLocale = null;
  }

  Object.keys(
    connessioniVideoPeer
  ).forEach(
    chiudiConnessioneVideo
  );

  const video =
    document.getElementById(
      "video-locale"
    );

  if (video) {
    video.srcObject = null;
  }

  const box =
    document.getElementById(
      "video-locale-box"
    );

  if (box) {
    box.style.display =
      "none";
  }

  richiesteInviateVideo.clear();

  aggiornaTestoBottoneVideocamera();

  disegnaGiocatori();
}

function aggiornaTestoBottoneVideocamera() {
  const b =
    document.getElementById(
      "btn-toggle-videocamera"
    );

  if (!b) return;

  b.textContent =
    videocameraAttiva
      ? "📹 Videocamera: On"
      : "📷 Videocamera: Off";
}

/* ============================================================
   RICHIESTE AUDIO
   ============================================================ */

function richiediAudioCon(
  altroUid
) {
  if (!microfonoAttivo) {
    alert(
      "Attiva prima il tuo microfono dal menu ☰."
    );

    return;
  }

  if (
    !altroUid ||
    altroUid === mioUid
  ) {
    return;
  }

  if (
    richiesteInviateAudio.has(
      altroUid
    ) ||
    connessioniAudioPeer[
      altroUid
    ]
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

  richiesteInviateAudio.add(
    altroUid
  );

  socket.send(
    JSON.stringify({
      tipo: "richiestaAudio",
      partitaId,
      destinatarioUid: altroUid
    })
  );

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
      " ti sta chiedendo di parlare in chiamata audio";
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

    if (!microfonoAttivo) {
      if (
        socket &&
        socket.readyState ===
          WebSocket.OPEN
      ) {
        socket.send(
          JSON.stringify({
            tipo: "rispostaAudio",
            partitaId,
            destinatarioUid:
              mittenteUid,
            accettato: false
          })
        );
      }

      return;
    }
  }

  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  socket.send(
    JSON.stringify({
      tipo: "rispostaAudio",
      partitaId,
      destinatarioUid:
        mittenteUid,
      accettato:
        !!accettato
    })
  );

  if (accettato) {
    avviaConnessioneAudio(
      mittenteUid,
      false
    );

    disegnaGiocatori();
  }
}

/* ============================================================
   RICHIESTE VIDEO
   ============================================================ */

function richiediVideoCon(
  altroUid
) {
  if (!videocameraAttiva) {
    alert(
      "Attiva prima la videocamera dal menu ☰."
    );

    return;
  }

  if (
    !altroUid ||
    altroUid === mioUid
  ) {
    return;
  }

  if (
    richiesteInviateVideo.has(
      altroUid
    ) ||
    connessioniVideoPeer[
      altroUid
    ]
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

  richiesteInviateVideo.add(
    altroUid
  );

  socket.send(
    JSON.stringify({
      tipo: "richiestaVideo",
      partitaId,
      destinatarioUid: altroUid
    })
  );

  disegnaGiocatori();
}

async function rispostaVideo(
  mittenteUid,
  accettato
) {
  if (!mittenteUid) return;

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify({
        tipo: "rispostaVideo",
        partitaId,
        destinatarioUid:
          mittenteUid,
        accettato:
          !!accettato
      })
    );
  }

  if (accettato) {
    if (!videocameraAttiva) {
      await attivaVideocamera();
    }

    if (videocameraAttiva) {
      await avviaConnessioneVideo(
        mittenteUid,
        false
      );
    }
  }
}

function mostraRichiestaVideoRicevuta(
  mittenteUid,
  mittenteNome
) {
  const accetta =
    confirm(
      (
        mittenteNome ||
        "Un giocatore"
      ) +
      " vuole avviare una videochiamata. Accettare?"
    );

  rispostaVideo(
    mittenteUid,
    accetta
  );
}

/* ============================================================
   PEER AUDIO
   ============================================================ */

function creaConnessionePeerAudio(
  altroUid
) {
  if (!altroUid) return null;

  if (
    connessioniAudioPeer[
      altroUid
    ]
  ) {
    return connessioniAudioPeer[
      altroUid
    ];
  }

  let pc;

  try {
    pc =
      new RTCPeerConnection(
        CONFIGURAZIONE_ICE
      );
  } catch (e) {
    return null;
  }

  if (flussoAudioLocale) {
    flussoAudioLocale
      .getTracks()
      .forEach((track) => {
        try {
          pc.addTrack(
            track,
            flussoAudioLocale
          );
        } catch (e) {}
      });
  }

  pc.onicecandidate =
    (ev) => {
      if (
        ev.candidate &&
        socket &&
        socket.readyState ===
          WebSocket.OPEN
      ) {
        socket.send(
          JSON.stringify({
            tipo:
              "webrtc-ice-candidate",
            partitaId,
            destinatarioUid:
              altroUid,
            candidate:
              ev.candidate,
            media: "audio"
          })
        );
      }
    };

  pc.ontrack =
    (ev) => {
      let elAudio =
        elementiAudioRemoti[
          altroUid
        ];

      if (!elAudio) {
        elAudio =
          document.createElement(
            "audio"
          );

        elAudio.autoplay = true;
        elAudio.playsInline = true;

        elAudio.id =
          "audio-remoto-" +
          altroUid;

        document.body.appendChild(
          elAudio
        );

        elementiAudioRemoti[
          altroUid
        ] = elAudio;
      }

      if (
        ev.streams &&
        ev.streams[0]
      ) {
        elAudio.srcObject =
          ev.streams[0];

        const p =
          elAudio.play();

        if (
          p &&
          typeof p.catch ===
            "function"
        ) {
          p.catch(() => {});
        }
      }
    };

  pc.onconnectionstatechange =
    () => {
      if (
        pc.connectionState ===
          "failed" ||
        pc.connectionState ===
          "closed"
      ) {
        chiudiConnessioneAudio(
          altroUid
        );
      }
    };

  connessioniAudioPeer[
    altroUid
  ] = pc;

  return pc;
}

async function avviaConnessioneAudio(
  altroUid,
  sonoIoAdIniziare
) {
  if (
    !altroUid ||
    altroUid === mioUid
  ) {
    return;
  }

  if (
    connessioniAudioPeer[
      altroUid
    ]
  ) {
    return;
  }

  const pc =
    creaConnessionePeerAudio(
      altroUid
    );

  if (!pc) return;

  if (sonoIoAdIniziare) {
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
              altroUid,
            sdp:
              pc.localDescription,
            media: "audio"
          })
        );
      }
    } catch (e) {
      chiudiConnessioneAudio(
        altroUid
      );
    }
  }
}

async function gestisciOffertaAudioRicevuta(
  mittenteUid,
  sdp
) {
  if (
    !microfonoAttivo ||
    !mittenteUid ||
    !sdp
  ) {
    return;
  }

  try {
    const pc =
      connessioniAudioPeer[
        mittenteUid
      ] ||
      creaConnessionePeerAudio(
        mittenteUid
      );

    if (!pc) return;

    await pc.setRemoteDescription(
      new RTCSessionDescription(
        sdp
      )
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
            mittenteUid,
          sdp:
            pc.localDescription,
          media: "audio"
        })
      );
    }
  } catch (e) {}
}

async function gestisciRispostaAudioRicevuta(
  mittenteUid,
  sdp
) {
  const pc =
    connessioniAudioPeer[
      mittenteUid
    ];

  if (!pc || !sdp) {
    return;
  }

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(
        sdp
      )
    );
  } catch (e) {}
}

async function gestisciCandidatoAudioRicevuto(
  mittenteUid,
  candidate
) {
  const pc =
    connessioniAudioPeer[
      mittenteUid
    ];

  if (!pc || !candidate) {
    return;
  }

  try {
    await pc.addIceCandidate(
      new RTCIceCandidate(
        candidate
      )
    );
  } catch (e) {}
}

function chiudiConnessioneAudio(
  altroUid
) {
  const pc =
    connessioniAudioPeer[
      altroUid
    ];

  if (pc) {
    try {
      pc.close();
    } catch (e) {}

    delete connessioniAudioPeer[
      altroUid
    ];
  }

  const elAudio =
    elementiAudioRemoti[
      altroUid
    ];

  if (elAudio) {
    try {
      elAudio.srcObject = null;
    } catch (e) {}

    elAudio.remove();

    delete elementiAudioRemoti[
      altroUid
    ];
  }

  richiesteInviateAudio.delete(
    altroUid
  );
}

/* ============================================================
   PEER VIDEO
   ============================================================ */

function creaConnessionePeerVideo(
  altroUid
) {
  if (!altroUid) return null;

  if (
    connessioniVideoPeer[
      altroUid
    ]
  ) {
    return connessioniVideoPeer[
      altroUid
    ];
  }

  let pc;

  try {
    pc =
      new RTCPeerConnection(
        CONFIGURAZIONE_ICE
      );
  } catch (e) {
    return null;
  }

  if (flussoVideoLocale) {
    flussoVideoLocale
      .getTracks()
      .forEach((track) => {
        try {
          pc.addTrack(
            track,
            flussoVideoLocale
          );
        } catch (e) {}
      });
  }

  pc.onicecandidate =
    (ev) => {
      if (
        ev.candidate &&
        socket &&
        socket.readyState ===
          WebSocket.OPEN
      ) {
        socket.send(
          JSON.stringify({
            tipo:
              "webrtc-ice-candidate",
            partitaId,
            destinatarioUid:
              altroUid,
            candidate:
              ev.candidate,
            media: "video"
          })
        );
      }
    };

  pc.ontrack =
    (ev) => {
      creaVideoRemoto(
        altroUid,
        ev.streams &&
          ev.streams[0]
          ? ev.streams[0]
          : null
      );
    };

  pc.onconnectionstatechange =
    () => {
      if (
        pc.connectionState ===
          "failed" ||
        pc.connectionState ===
          "closed"
      ) {
        chiudiConnessioneVideo(
          altroUid
        );
      }
    };

  connessioniVideoPeer[
    altroUid
  ] = pc;

  return pc;
}

function creaVideoRemoto(
  altroUid,
  stream
) {
  if (!stream) return;

  let contenitore =
    document.getElementById(
      "video-remoti"
    );

  if (!contenitore) {
    creaInterfacciaVideo();

    contenitore =
      document.getElementById(
        "video-remoti"
      );
  }

  let box =
    document.getElementById(
      "video-remoto-box-" +
        altroUid
    );

  let video =
    document.getElementById(
      "video-remoto-" +
        altroUid
    );

  if (!box) {
    box =
      document.createElement(
        "div"
      );

    box.className =
      "video-remoto-box";

    box.id =
      "video-remoto-box-" +
      altroUid;

    const giocatore =
      ultimoStatoGiocatori.find(
        (g) =>
          String(g.id) ===
          String(altroUid)
      );

    const nome =
      document.createElement(
        "div"
      );

    nome.className =
      "video-remoto-nome";

    nome.textContent =
      giocatore &&
      giocatore.nome
        ? giocatore.nome
        : "Giocatore";

    video =
      document.createElement(
        "video"
      );

    video.className =
      "video-remoto";

    video.id =
      "video-remoto-" +
      altroUid;

    video.autoplay = true;
    video.playsInline = true;

    box.appendChild(
      video
    );

    box.appendChild(
      nome
    );

    contenitore.appendChild(
      box
    );
  }

  video.srcObject =
    stream;

  const p =
    video.play();

  if (
    p &&
    typeof p.catch ===
      "function"
  ) {
    p.catch(() => {});
  }
}

async function avviaConnessioneVideo(
  altroUid,
  sonoIoAdIniziare
) {
  if (
    !altroUid ||
    altroUid === mioUid
  ) {
    return;
  }

  if (
    connessioniVideoPeer[
      altroUid
    ]
  ) {
    return;
  }

  const pc =
    creaConnessionePeerVideo(
      altroUid
    );

  if (!pc) return;

  if (sonoIoAdIniziare) {
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
              altroUid,
            sdp:
              pc.localDescription,
            media: "video"
          })
        );
      }
    } catch (e) {
      chiudiConnessioneVideo(
        altroUid
      );
    }
  }
}

async function gestisciOffertaVideoRicevuta(
  mittenteUid,
  sdp
) {
  if (
    !videocameraAttiva ||
    !mittenteUid ||
    !sdp
  ) {
    return;
  }

  try {
    const pc =
      connessioniVideoPeer[
        mittenteUid
      ] ||
      creaConnessionePeerVideo(
        mittenteUid
      );

    if (!pc) return;

    await pc.setRemoteDescription(
      new RTCSessionDescription(
        sdp
      )
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
            mittenteUid,
          sdp:
            pc.localDescription,
          media: "video"
        })
      );
    }
  } catch (e) {}
}

async function gestisciRispostaVideoRicevuta(
  mittenteUid,
  sdp
) {
  const pc =
    connessioniVideoPeer[
      mittenteUid
    ];

  if (!pc || !sdp) {
    return;
  }

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(
        sdp
      )
    );
  } catch (e) {}
}

async function gestisciCandidatoVideoRicevuto(
  mittenteUid,
  candidate
) {
  const pc =
    connessioniVideoPeer[
      mittenteUid
    ];

  if (!pc || !candidate) {
    return;
  }

  try {
    await pc.addIceCandidate(
      new RTCIceCandidate(
        candidate
      )
    );
  } catch (e) {}
}

function chiudiConnessioneVideo(
  altroUid
) {
  const pc =
    connessioniVideoPeer[
      altroUid
    ];

  if (pc) {
    try {
      pc.close();
    } catch (e) {}

    delete connessioniVideoPeer[
      altroUid
    ];
  }

  const box =
    document.getElementById(
      "video-remoto-box-" +
        altroUid
    );

  if (box) {
    box.remove();
  }

  richiesteInviateVideo.delete(
    altroUid
  );
}

/* ============================================================
   WEBRTC COMPATIBILE CON I MESSAGGI ESISTENTI
   ============================================================ */

function gestisciOffertaRicevuta(
  mittenteUid,
  sdp,
  media
) {
  if (media === "video") {
    return gestisciOffertaVideoRicevuta(
      mittenteUid,
      sdp
    );
  }

  return gestisciOffertaAudioRicevuta(
    mittenteUid,
    sdp
  );
}

function gestisciRispostaRicevuta(
  mittenteUid,
  sdp,
  media
) {
  if (media === "video") {
    return gestisciRispostaVideoRicevuta(
      mittenteUid,
      sdp
    );
  }

  return gestisciRispostaAudioRicevuta(
    mittenteUid,
    sdp
  );
}

function gestisciCandidatoRicevuto(
  mittenteUid,
  candidate,
  media
) {
  if (media === "video") {
    return gestisciCandidatoVideoRicevuto(
      mittenteUid,
      candidate
    );
  }

  return gestisciCandidatoAudioRicevuto(
    mittenteUid,
    candidate
  );
}

/* ============================================================
   PEDINE
   ============================================================ */

function schiarisciColore(
  hex,
  p
) {
  return mescolaColore(
    hex,
    255,
    p
  );
}

function scuriscColore(
  hex,
  p
) {
  return mescolaColore(
    hex,
    0,
    p
  );
}

function mescolaColore(
  hex,
  target,
  p
) {
  const num =
    parseInt(
      String(hex).replace(
        "#",
        ""
      ),
      16
    );

  if (!Number.isFinite(num)) {
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
    (num >> 16) & 255;

  let g =
    (num >> 8) & 255;

  let b =
    num & 255;

  r = Math.round(
    r +
    (target - r) *
      (p / 100)
  );

  g = Math.round(
    g +
    (target - g) *
      (p / 100)
  );

  b = Math.round(
    b +
    (target - b) *
      (p / 100)
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

  const scaleX =
    immagine.clientWidth /
    immagine.naturalWidth;

  const scaleY =
    immagine.clientHeight /
    immagine.naturalHeight;

  const casella =
    casellaNumero === 0
      ? {
          x: 100,
          y: 1900
        }
      : posizioniCaselle[
          casellaNumero
        ];

  if (!casella) {
    return null;
  }

  return {
    left:
      casella.x *
      scaleX,

    top:
      casella.y *
      scaleY
  };
}

function posizionaPedina(
  pedina,
  casellaNumero
) {
  if (!pedina) return;

  const coord =
    coordinatePerCasella(
      casellaNumero
    );

  if (!coord) return;

  pedina.style.left =
    coord.left + "px";

  pedina.style.top =
    coord.top + "px";
}

function ottieniOCreaPedina(
  idGiocatore,
  colore,
  indice
) {
  if (!idGiocatore) {
    return null;
  }

  let pedina =
    document.getElementById(
      "pedina-" +
        idGiocatore
    );

  if (!pedina) {
    pedina =
      document.createElement(
        "div"
      );

    pedina.id =
      "pedina-" +
      idGiocatore;

    pedina.className =
      "pedina";

    const idG =
      "gradPedina" +
      String(indice)
        .replace(
          /[^a-zA-Z0-9_-]/g,
          ""
        );

    pedina.innerHTML = `
      <svg width="26" height="38" viewBox="0 0 34 48" aria-hidden="true">
        <defs>
          <radialGradient id="${idG}" cx="35%" cy="25%" r="75%">
            <stop
              offset="0%"
              stop-color="${schiarisciColore(colore, 55)}"
            />

            <stop
              offset="55%"
              stop-color="${colore}"
            />

            <stop
              offset="100%"
              stop-color="${scuriscColore(colore, 35)}"
            />
          </radialGradient>
        </defs>

        <ellipse
          cx="17"
          cy="44"
          rx="12"
          ry="3.5"
          fill="rgba(0,0,0,0.3)"
        />

        <ellipse
          cx="17"
          cy="42"
          rx="11"
          ry="4"
          fill="${scuriscColore(colore, 25)}"
        />

        <path
          d="M17 42 C10 42 4 40 4 37 L10 15 C10 15 12 12 17 12 C22 12 24 15 24 15 L30 37 C30 40 24 42 17 42 Z"
          fill="url(#${idG})"
          stroke="${scuriscColore(colore, 45)}"
          stroke-width="0.8"
        />

        <circle
          cx="17"
          cy="9"
          r="7.5"
          fill="url(#${idG})"
          stroke="${scuriscColore(colore, 45)}"
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

    const contenitore =
      document.getElementById(
        "contenitore-pedine"
      );

    if (contenitore) {
      contenitore.appendChild(
        pedina
      );
    }
  }

  return pedina;
}

function riposizionaTuttePedine() {
  ultimoStatoGiocatori.forEach(
    (g) => {
      const p =
        document.getElementById(
          "pedina-" +
            g.id
        );

      if (p) {
        posizionaPedina(
          p,
          g.posizione
        );
      }
    }
  );
}

function animaSaltoPedina(
  idGiocatore,
  percorso,
  callback
) {
  const listaPercorso =
    Array.isArray(percorso)
      ? percorso
      : [];

  if (
    listaPercorso.length ===
    0
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
      (g) =>
        g.id ===
        idGiocatore
    );

  const colore =
    coloriGiocatori[
      (indice >= 0
        ? indice
        : 0) %
        coloriGiocatori.length
    ];

  const pedina =
    ottieniOCreaPedina(
      idGiocatore,
      colore,
      indice >= 0
        ? indice
        : 0
    );

  if (!pedina) {
    if (
      typeof callback ===
      "function"
    ) {
      callback();
    }

    return;
  }

  let passo = 0;

  function saltaProssimo() {
    if (
      passo >=
      listaPercorso.length
    ) {
      if (
        typeof callback ===
        "function"
      ) {
        callback();
      }

      return;
    }

    const casella =
      listaPercorso[
        passo
      ];

    pedina.classList.add(
      "pedina-salta"
    );

    posizionaPedina(
      pedina,
      casella
    );

    suonaPassoPedina();

    const et =
      document.getElementById(
        "casella-" +
          idGiocatore
      );

    if (et) {
      et.textContent =
        String(casella);
    }

    setTimeout(
      () => {
        pedina.classList.remove(
          "pedina-salta"
        );
      },
      Math.max(
        1,
        DURATA_SALTO_MS *
          0.6
      )
    );

    passo++;

    setTimeout(
      saltaProssimo,
      DURATA_SALTO_MS
    );
  }

  saltaProssimo();
}

/* ============================================================
   AVVIO
   ============================================================ */

async function avvia() {
  try {
    const risposta =
      await fetch(
        URL_SERVER_HTTP +
          "/api/me",
        {
          credentials:
            "include"
        }
      );

    if (!risposta.ok) {
      window.location.href =
        "login.html?redirect=" +
        encodeURIComponent(
          window.location.href
        );

      return;
    }

    const dati =
      await risposta.json();

    if (!dati || !dati.uid) {
      window.location.href =
        "login.html?redirect=" +
        encodeURIComponent(
          window.location.href
        );

      return;
    }

    mioUid =
      dati.uid;

    if (!partitaId) {
      alert(
        "ID partita mancante."
      );

      return;
    }

    creaInterfacciaVideo();

    connetti();
  } catch (e) {
    window.location.href =
      "login.html?redirect=" +
      encodeURIComponent(
        window.location.href
      );
  }
}

/* ============================================================
   RICONNESSIONE
   ============================================================ */

function pianificaRiconnessione() {
  if (timerRiconnessione) {
    return;
  }

  timerRiconnessione =
    setTimeout(
      () => {
        timerRiconnessione =
          null;

        if (
          socket &&
          socket.readyState ===
            WebSocket.OPEN
        ) {
          return;
        }

        connetti();
      },
      3000
    );
}

function connetti() {
  if (
    tentativoRiconnessioneInCorso
  ) {
    return;
  }

  tentativoRiconnessioneInCorso =
    true;

  try {
    socket =
      new WebSocket(
        URL_SERVER_WS
      );
  } catch (e) {
    tentativoRiconnessioneInCorso =
      false;

    pianificaRiconnessione();

    return;
  }

  socket.onopen =
    () => {
      tentativoRiconnessioneInCorso =
        false;

      if (timerRiconnessione) {
        clearTimeout(
          timerRiconnessione
        );

        timerRiconnessione =
          null;
      }

      socket.send(
        JSON.stringify({
          tipo:
            "riprendiPartita",
          partitaId
        })
      );
    };

  socket.onclose =
    () => {
      tentativoRiconnessioneInCorso =
        false;

      const rigaTurno =
        document.getElementById(
          "riga-turno"
        );

      if (rigaTurno) {
        rigaTurno.textContent =
          "🔴 Disconnesso, riconnessione...";
      }

      /*
       * Importante:
       * quando cade il socket il blocco locale rimane,
       * così non viene inviato un tiro mentre non siamo
       * sincronizzati con il server.
       */
      azioneTurnoInviata =
        true;

      mioTurno = false;

      pianificaRiconnessione();
    };

  socket.onerror =
    () => {};

  socket.onmessage =
    (msg) => {
      let dati;

      try {
        dati =
          JSON.parse(
            msg.data
          );
      } catch (e) {
        return;
      }

      if (
        !dati ||
        !dati.tipo
      ) {
        return;
      }

      /* ---------------- SESSIONE ---------------- */

      if (
        dati.tipo ===
        "sessioneScaduta"
      ) {
        fermaCountdownCompleto();

        window.location.href =
          "login.html?redirect=" +
          encodeURIComponent(
            window.location.href
          );

        return;
      }

      /* ---------------- DETERMINAZIONE ---------------- */

      if (
        dati.tipo ===
        "statoDeterminazione"
      ) {
        gestisciStatoDeterminazione(
          dati
        );

        return;
      }

      if (
        dati.tipo ===
        "risultatoDeterminazione"
      ) {
        gestisciRisultatoDeterminazione(
          dati
        );

        return;
      }

      if (
        dati.tipo ===
        "ordineFinaleCalcolato"
      ) {
        gestisciOrdineFinaleCalcolato(
          dati
        );

        return;
      }

      if (
        dati.tipo ===
        "determinazioneCompletata"
      ) {
        gestisciDeterminazioneCompletata(
          dati
        );

        return;
      }

      /* ---------------- AUDIO ---------------- */

      if (
        dati.tipo ===
        "richiestaAudioRicevuta"
      ) {
        mostraRichiestaAudioRicevuta(
          dati.mittenteUid,
          dati.mittenteNome
        );

        return;
      }

      if (
        dati.tipo ===
        "rispostaAudioRicevuta"
      ) {
        if (
          dati.mittenteUid
        ) {
          richiesteInviateAudio.delete(
            dati.mittenteUid
          );
        }

        if (
          dati.accettato &&
          dati.mittenteUid
        ) {
          avviaConnessioneAudio(
            dati.mittenteUid,
            true
          );
        }

        disegnaGiocatori();

        return;
      }

      /* ---------------- VIDEO ---------------- */

      if (
        dati.tipo ===
        "richiestaVideoRicevuta"
      ) {
        mostraRichiestaVideoRicevuta(
          dati.mittenteUid,
          dati.mittenteNome
        );

        return;
      }

      if (
        dati.tipo ===
        "rispostaVideoRicevuta"
      ) {
        if (
          dati.mittenteUid
        ) {
          richiesteInviateVideo.delete(
            dati.mittenteUid
          );
        }

        if (
          dati.accettato &&
          dati.mittenteUid
        ) {
          avviaConnessioneVideo(
            dati.mittenteUid,
            true
          );
        }

        disegnaGiocatori();

        return;
      }

      /* ---------------- WEBRTC ---------------- */

      if (
        dati.tipo ===
        "webrtc-offer"
      ) {
        gestisciOffertaRicevuta(
          dati.mittenteUid,
          dati.sdp,
          dati.media
        );

        return;
      }

      if (
        dati.tipo ===
        "webrtc-answer"
      ) {
        gestisciRispostaRicevuta(
          dati.mittenteUid,
          dati.sdp,
          dati.media
        );

        return;
      }

      if (
        dati.tipo ===
        "webrtc-ice-candidate"
      ) {
        gestisciCandidatoRicevuto(
          dati.mittenteUid,
          dati.candidate,
          dati.media
        );

        return;
      }

      /* ---------------- STATO PARTITA ---------------- */

      if (
        dati.tipo ===
        "statoPartita"
      ) {
        faseAttuale =
          "normale";

        ultimoStatoGiocatori =
          Array.isArray(
            dati.giocatori
          )
            ? dati.giocatori
            : [];

        const chatWrapper =
          document.getElementById(
            "chat-wrapper"
          );

        if (chatWrapper) {
          chatWrapper.style.display =
            dati.chatAttiva ===
            false
              ? "none"
              : "";
        }

        /*
         * Questo è importante per la ripresa della partita.
         */
        if (
          dati.iniziata ===
          false
        ) {
          faseAttuale =
            "normale";
        }

        if (dati.vittoria) {
          turnoAttualeId =
            null;

          mioTurno =
            false;

          azioneTurnoInviata =
            true;

          fermaCountdownCompleto();

          azzeraDatiCountdown();

          const areaDadi =
            document.getElementById(
              "area-dadi"
            );

          if (areaDadi) {
            areaDadi.classList.add(
              "disabilitato"
            );
          }

          disegnaGiocatori();

          mostraVittoria(
            dati.vincitore
          );
        } else {
          aggiornaTurno(
            dati.turnoDiId ||
              dati.turnoAttuale ||
              null
          );

          disegnaGiocatori();

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
          }
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

        return;
      }

      /* ---------------- AGGIORNAMENTO MOSSA ---------------- */

      if (
        dati.tipo ===
        "aggiornamentoPartita"
      ) {
        /*
         * BLOCCO DEL TURNO:
         * la mossa è stata ricevuta dal server,
         * quindi il tiro corrente è definitivamente consumato.
         */
        azioneTurnoInviata =
          true;

        turnoLocalmenteCompletato =
          true;

        fermaCountdownCompleto();

        animaLancioDadi(
          Number(
            dati.dado1
          ),
          Number(
            dati.dado2
          ),
          () => {
            const completa =
              () => {
                ultimoStatoGiocatori =
                  Array.isArray(
                    dati.giocatori
                  )
                    ? dati.giocatori
                    : [];

                const messaggiGioco =
                  document.getElementById(
                    "messaggi-gioco"
                  );

                if (messaggiGioco) {
                  messaggiGioco.textContent =
                    "🎲 " +
                    Number(
                      dati.dado1 ||
                        0
                    ) +
                    " + " +
                    Number(
                      dati.dado2 ||
                        0
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
                 * CORREZIONE PRINCIPALE DEI TURNI.
                 * Prima questa parte mancava.
                 */
                if (
                  dati.vittoria
                ) {
                  turnoAttualeId =
                    null;

                  mioTurno =
                    false;

                  azioneTurnoInviata =
                    true;

                  fermaCountdownCompleto();

                  azzeraDatiCountdown();

                  disegnaGiocatori();

                  mostraVittoria(
                    dati.vincitore
                  );

                  return;
                }

                /*
                 * Il server deve essere l'autorità sul turno.
                 */
                const nuovoTurno =
                  dati.turnoDiId ||
                  dati.turnoAttuale ||
                  dati.prossimoTurnoDiId ||
                  null;

                aggiornaTurno(
                  nuovoTurno
                );

                disegnaGiocatori();

                /*
                 * Riavvia il countdown del nuovo turno.
                 */
                if (
                  dati.tempoInizioTurno !=
                    null &&
                  dati.durataMossaMs !=
                    null &&
                  nuovoTurno
                ) {
                  avviaCountdownTurno(
                    dati.tempoInizioTurno,
                    dati.durataMossaMs,
                    dati.scadenzaTurno ||
                      null
                  );
                }
              };

            if (
              Array.isArray(
                dati.percorso
              ) &&
              dati.percorso.length >
                0 &&
              dati.idGiocatoreCheHaTirato
            ) {
              animaSaltoPedina(
                dati.idGiocatoreCheHaTirato,
                dati.percorso,
                completa
              );
            } else {
              completa();
            }
          }
        );

        return;
      }

      /* ---------------- CHAT ---------------- */

      if (
        dati.tipo ===
        "chatPartita"
      ) {
        aggiungiMessaggioChatPartita(
          dati.nome,
          dati.testo
        );

        return;
      }

      /* ---------------- ERRORI ---------------- */

      if (
        dati.tipo ===
        "errore"
      ) {
        /*
         * Se il server rifiuta perché il turno non è più valido,
         * si riabilita solo quando il server ci comunica il turno corretto.
         */
        if (
          dati.codice ===
            "NON_TURNO" ||
          dati.codice ===
            "TURNO_NON_VALIDO"
        ) {
          azioneTurnoInviata =
            false;

          turnoBloccatoLocalmente =
            false;
        }

        alert(
          dati.messaggio ||
            "Si è verificato un errore."
        );

        return;
      }
    };
}

/* ============================================================
   TURNI
   ============================================================ */

function aggiornaTurno(
  turnoDiId
) {
  const nuovoTurno =
    turnoDiId || null;

  const precedente =
    mioTurno;

  const precedenteId =
    turnoAttualeId;

  turnoAttualeId =
    nuovoTurno;

  mioTurno =
    !!nuovoTurno &&
    nuovoTurno ===
      mioUid;

  /*
   * Quando cambia il turno abbiamo un nuovo permesso
   * di tiro.
   */
  if (
    nuovoTurno !==
    precedenteId
  ) {
    azioneTurnoInviata =
      false;

    turnoBloccatoLocalmente =
      false;

    ultimoTurnoProcessato =
      nuovoTurno;

    turnoLocalmenteCompletato =
      false;
  }

  if (
    mioTurno &&
    !precedente
  ) {
    suonaTuoTurno();
  }

  const rigaTurno =
    document.getElementById(
      "riga-turno"
    );

  if (rigaTurno) {
    rigaTurno.textContent =
      mioTurno
        ? "🎲 È il tuo turno!"
        : "⏳ In attesa...";
  }

  const areaDadi =
    document.getElementById(
      "area-dadi"
    );

  if (areaDadi) {
    areaDadi.classList.toggle(
      "disabilitato",
      !mioTurno ||
        azioneTurnoInviata
    );
  }
}

/* ============================================================
   GIOCATORI
   ============================================================ */

function disegnaGiocatori() {
  const contenitore =
    document.getElementById(
      "contenitore-pedine"
    );

  if (!contenitore) {
    return;
  }

  Array.from(
    contenitore.children
  ).forEach((p) => {
    if (
      !ultimoStatoGiocatori.some(
        (g) =>
          "pedina-" +
            g.id ===
          p.id
      )
    ) {
      p.remove();
    }
  });

  const listaPannello =
    document.getElementById(
      "lista-giocatori"
    );

  if (!listaPannello) {
    return;
  }

  listaPannello.innerHTML =
    "";

  ultimoStatoGiocatori.forEach(
    (giocatore, indice) => {
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
        posizionaPedina(
          pedina,
          Number(
            giocatore.posizione ||
              0
          )
        );
      }

      const avatarHtml =
        giocatore.avatar
          ? `<img class="avatar-mini" src="${escapeHtml(giocatore.avatar)}" alt="">`
          : `<div class="avatar-mini" style="background:${escapeHtml(colore)};">${escapeHtml(iniziale(giocatore.nome))}</div>`;

      const eAttivo =
        giocatore.id ===
        turnoAttualeId;

      const countdownHtml =
        eAttivo
          ? `<span class="countdown-turno" id="countdown-turno">⏱ --s</span>`
          : "";

      const eloHtml =
        htmlElo(
          giocatore
        );

      let audioHtml =
        "";

      if (
        giocatore.id !==
        mioUid
      ) {
        if (
          connessioniAudioPeer[
            giocatore.id
          ]
        ) {
          audioHtml =
            `<span class="stato-audio attivo" title="Chiamata audio attiva">🎤</span>`;
        } else if (
          richiesteInviateAudio.has(
            giocatore.id
          )
        ) {
          audioHtml =
            `<span class="stato-audio in-attesa" title="Richiesta audio inviata">⏳</span>`;
        } else if (
          microfonoAttivo
        ) {
          const uidEsc =
            String(
              giocatore.id
            ).replace(
              /\\/g,
              "\\\\"
            ).replace(
              /'/g,
              "\\'"
            );

          audioHtml =
            `<button type="button" class="btn-chiama-audio" title="Chiedi di parlare" onclick="richiediAudioCon('${uidEsc}')">📞</button>`;
        }
      }

      let videoHtml =
        "";

      if (
        giocatore.id !==
        mioUid &&
        videocameraAttiva
      ) {
        if (
          connessioniVideoPeer[
            giocatore.id
          ]
        ) {
          videoHtml =
            `<span class="stato-audio attivo" title="Video attivo">📹</span>`;
        } else if (
          richiesteInviateVideo.has(
            giocatore.id
          )
        ) {
          videoHtml =
            `<span class="stato-audio in-attesa" title="Richiesta video inviata">⏳</span>`;
        } else {
          const uidEsc =
            String(
              giocatore.id
            ).replace(
              /\\/g,
              "\\\\"
            ).replace(
              /'/g,
              "\\'"
            );

          videoHtml =
            `<button type="button" class="btn-chiama-audio" title="Chiedi videochiamata" onclick="richiediVideoCon('${uidEsc}')">📹</button>`;
        }
      }

      const card =
        document.createElement(
          "div"
        );

      card.className =
        "giocatore-card" +
        (
          eAttivo
            ? " attivo"
            : ""
        );

      const nicknameHtml =
        `<a href="profilo-pubblico.html?nickname=${encodeURIComponent(giocatore.nome || "")}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none;flex-grow:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(giocatore.nome || "Giocatore")}</a>`;

      card.innerHTML =
        avatarHtml +
        nicknameHtml +
        eloHtml +
        audioHtml +
        videoHtml +
        countdownHtml +
        `<span class="casella-mini" id="casella-${escapeHtml(giocatore.id)}">${Number(giocatore.posizione || 0)}</span>`;

      listaPannello.appendChild(
        card
      );
    }
  );

  if (turnoAttualeId) {
    aggiornaCountdownTurno();
  }
}

/* ============================================================
   VITTORIA
   ============================================================ */

function mostraVittoria(
  nomeVincitore
) {
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
}

/* ============================================================
   MENU
   ============================================================ */

function tornaAllaLobby() {
  window.location.href =
    "lobby.html?stanza=" +
    encodeURIComponent(
      stanza || ""
    );
}

function abbandonaPartita() {
  if (
    !confirm(
      "Sei sicuro di voler abbandonare la partita?"
    )
  ) {
    return;
  }

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify({
        tipo:
          "abbandonaPartita",
        partitaId
      })
    );
  }

  fermaCountdownCompleto();

  disattivaMicrofono();
  disattivaVideocamera();

  tornaAllaLobby();
}

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

const btnMenu =
  document.getElementById(
    "btn-menu"
  );

if (btnMenu) {
  btnMenu.onclick =
    (e) => {
      e.stopPropagation();

      const pannello =
        document.getElementById(
          "pannello-menu"
        );

      if (pannello) {
        pannello.classList.toggle(
          "nascosto"
        );
      }
    };
}

document.addEventListener(
  "click",
  () => {
    chiudiMenu();
  }
);

/* ============================================================
   GIOCATORI
   ============================================================ */

const btnGiocatori =
  document.getElementById(
    "btn-giocatori"
  );

if (btnGiocatori) {
  btnGiocatori.onclick =
    (e) => {
      e.stopPropagation();

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
    };
}

const backdropGiocatori =
  document.getElementById(
    "backdrop-giocatori"
  );

if (backdropGiocatori) {
  backdropGiocatori.onclick =
    () => {
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
    };
}

/* ============================================================
   CHAT
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

  if (!box) {
    return;
  }

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

  if (!input) {
    return;
  }

  const testo =
    input.value.trim();

  if (!testo) {
    return;
  }

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {
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
  }
}

const chatInput =
  document.getElementById(
    "chat-input"
  );

if (chatInput) {
  chatInput.addEventListener(
    "keypress",
    (e) => {
      if (
        e.key ===
        "Enter"
      ) {
        e.preventDefault();

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
  btnChat.onclick =
    (e) => {
      e.stopPropagation();

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
    };
}

/* ============================================================
   DADI
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

function normalizza360(g) {
  return (
    ((g % 360) + 360) %
    360
  );
}

function calcolaNuovaRotazione(
  idDado,
  valore
) {
  const c =
    CORREZIONE_ANGOLI_DADO[
      valore
    ];

  if (!c) {
    return rotazioneAttuale[
      idDado
    ];
  }

  const a =
    rotazioneAttuale[
      idDado
    ];

  let dX =
    normalizza360(
      c.x
    ) -
    normalizza360(
      a.x
    );

  if (dX < 0) {
    dX += 360;
  }

  let dY =
    normalizza360(
      c.y
    ) -
    normalizza360(
      a.y
    );

  if (dY < 0) {
    dY += 360;
  }

  const nuova = {
    x:
      a.x +
      dX +
      (2 +
        Math.floor(
          Math.random() * 2
        )) *
        360,

    y:
      a.y +
      dY +
      (2 +
        Math.floor(
          Math.random() * 2
        )) *
        360
  };

  rotazioneAttuale[
    idDado
  ] = nuova;

  return nuova;
}

function applicaRotazioneDado(
  idDado,
  valore
) {
  const r =
    calcolaNuovaRotazione(
      idDado,
      valore
    );

  const cubo =
    document.querySelector(
      "#" +
        idDado +
        " .cubo"
    );

  if (
    cubo &&
    r
  ) {
    cubo.style.transform =
      `rotateX(${r.x}deg) rotateY(${r.y}deg)`;
  }
}

function mostraDadi(
  v1,
  v2
) {
  const c1 =
    document.querySelector(
      "#dado1 .cubo"
    );

  const c2 =
    document.querySelector(
      "#dado2 .cubo"
    );

  if (c1) {
    c1.style.transition =
      "none";
  }

  if (c2) {
    c2.style.transition =
      "none";
  }

  if (
    v1 >= 1 &&
    v1 <= 6
  ) {
    applicaRotazioneDado(
      "dado1",
      v1
    );
  }

  if (
    v2 >= 1 &&
    v2 <= 6
  ) {
    applicaRotazioneDado(
      "dado2",
      v2
    );
  }

  if (c1) {
    void c1.offsetHeight;
    c1.style.transition =
      "";
  }

  if (c2) {
    void c2.offsetHeight;
    c2.style.transition =
      "";
  }
}

function animaLancioDadi(
  vf1,
  vf2,
  callback
) {
  suonaTiroDadi();

  applicaRotazioneDado(
    "dado1",
    vf1
  );

  applicaRotazioneDado(
    "dado2",
    vf2
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
   CLICK DADI
   ============================================================ */

const areaDadi =
  document.getElementById(
    "area-dadi"
  );

function eseguiTiroDadi() {
  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  if (
    faseAttuale ===
    "determinazione"
  ) {
    if (
      !possoTirareIoInDeterminazione
    ) {
      return;
    }

    /*
     * Anche nella determinazione impediamo doppi click.
     */
    if (
      azioneTurnoInviata
    ) {
      return;
    }

    azioneTurnoInviata =
      true;

    areaDadi?.classList.add(
      "disabilitato"
    );

    socket.send(
      JSON.stringify({
        tipo:
          "tiraDeterminazione",
        partitaId
      })
    );

    return;
  }

  /*
   * AUTORIZZAZIONE COMPLETA:
   * 1. deve essere il mio turno
   * 2. non devo aver già inviato l'azione
   * 3. non devo essere localmente bloccato
   */
  if (!mioTurno) {
    return;
  }

  if (
    azioneTurnoInviata ||
    turnoBloccatoLocalmente
  ) {
    return;
  }

  azioneTurnoInviata =
    true;

  turnoBloccatoLocalmente =
    true;

  fermaCountdownPerAzioneLocale();

  areaDadi?.classList.add(
    "disabilitato"
  );

  socket.send(
    JSON.stringify({
      tipo:
        "tiraDadi",
      partitaId
    })
  );
}

if (areaDadi) {
  areaDadi.onclick =
    (e) => {
      e.preventDefault();
      e.stopPropagation();

      eseguiTiroDadi();
    };

  areaDadi.addEventListener(
    "keydown",
    (e) => {
      if (
        e.key ===
          "Enter" ||
        e.key ===
          " "
      ) {
        e.preventDefault();
        eseguiTiroDadi();
      }
    }
  );
}

/* ============================================================
   CHIUSURA
   ============================================================ */

window.addEventListener(
  "beforeunload",
  () => {
    if (
      flussoAudioLocale
    ) {
      flussoAudioLocale
        .getTracks()
        .forEach(
          (t) => t.stop()
        );
    }

    if (
      flussoVideoLocale
    ) {
      flussoVideoLocale
        .getTracks()
        .forEach(
          (t) => t.stop()
        );
    }

    Object.keys(
      connessioniAudioPeer
    ).forEach(
      chiudiConnessioneAudio
    );

    Object.keys(
      connessioniVideoPeer
    ).forEach(
      chiudiConnessioneVideo
    );
  }
);

/* ============================================================
   INIZIALIZZAZIONE
   ============================================================ */

aggiornaTestoBottoneSuoni();
aggiornaTestoBottoneFullscreen();
aggiornaTestoBottoneMicrofono();

creaInterfacciaVideo();

aggiornaTestoBottoneVideocamera();

aggiornaBadgeChatPartita();

mostraDadi(
  1,
  1
);

inizializzaGestioneOrientamento();

avvia();
