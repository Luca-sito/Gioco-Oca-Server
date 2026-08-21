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
  "#6a2c70",
  "#dddddd",
  "#1e40af",
  "#43a047",
  "#f57c00",
  "#c0ca33",
  "#e53935",
  "#2b2b2b"
];

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

// =========================================================
// AUDIO / WEBCAM - WEBRTC AUTOMATICO
// =========================================================

const CONFIGURAZIONE_ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

let flussoMediaLocale = null;
let microfonoLocaleAttivo = false;
let webcamLocaleAttiva = false;

const connessioniMedia = {};
const peerInfoMedia = {};

function aggiornaStatoMedia(testo, visibile = true) {
  const el = document.getElementById("media-stato");
  if (!el) return;

  el.textContent = testo || "";
  el.style.display = visibile && testo ? "block" : "none";
}

function aggiornaPulsantiMedia() {
  const m = document.getElementById("btn-microfono");
  const c = document.getElementById("btn-webcam");

  if (m) {
    m.textContent = microfonoLocaleAttivo
      ? "🎤 Microfono: On"
      : "🔇 Microfono: Off";

    m.style.opacity = microfonoLocaleAttivo ? "1" : ".72";
  }

  if (c) {
    c.textContent = webcamLocaleAttiva
      ? "📷 Webcam: On"
      : "🚫 Webcam: Off";

    c.style.opacity = webcamLocaleAttiva ? "1" : ".72";
  }
}

function fermaMediaLocale() {
  if (flussoMediaLocale) {
    flussoMediaLocale.getTracks().forEach(track => {
      try {
        track.stop();
      } catch (_) {}
    });
  }

  flussoMediaLocale = null;
  microfonoLocaleAttivo = false;
  webcamLocaleAttiva = false;
}

async function ottieniMediaLocale({ audio = true, video = true } = {}) {
  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {
    aggiornaStatoMedia(
      "Il browser non supporta audio/video."
    );
    return false;
  }

  try {
    if (!flussoMediaLocale) {
      flussoMediaLocale =
        await navigator.mediaDevices.getUserMedia({
          audio: !!audio,
          video: !!video
        });
    }

    microfonoLocaleAttivo =
      flussoMediaLocale
        .getAudioTracks()
        .some(
          track =>
            track.readyState === "live" &&
            track.enabled
        );

    webcamLocaleAttiva =
      flussoMediaLocale
        .getVideoTracks()
        .some(
          track =>
            track.readyState === "live" &&
            track.enabled
        );

    aggiornaPulsantiMedia();
    creaTileLocale();

    aggiornaStatoMedia(
      "Connessione audio/video attiva",
      false
    );

    return true;
  } catch (errore) {
    console.error(
      "Errore accesso dispositivi multimediali:",
      errore
    );

    aggiornaStatoMedia(
      "Permesso microfono/webcam non concesso."
    );

    return false;
  }
}

function creaTileLocale() {
  const box = document.getElementById("media-videos");
  if (!box) return;

  let tile =
    document.getElementById("media-locale");

  if (
    !flussoMediaLocale ||
    !webcamLocaleAttiva
  ) {
    if (tile) tile.remove();
    return;
  }

  if (!tile) {
    tile = document.createElement("div");
    tile.id = "media-locale";
    tile.className = "media-tile";

    tile.innerHTML = `
      <video
        autoplay
        muted
        playsinline>
      </video>
      <div class="media-name">Tu</div>
    `;

    box.prepend(tile);
  }

  const video = tile.querySelector("video");

  if (
    video &&
    video.srcObject !== flussoMediaLocale
  ) {
    video.srcObject = flussoMediaLocale;
  }
}

function chiudiConnessioneMedia(uid) {
  const pc = connessioniMedia[uid];

  if (pc) {
    try {
      pc.close();
    } catch (_) {}

    delete connessioniMedia[uid];
  }

  const tile =
    document.getElementById(
      "media-remoto-" + uid
    );

  if (tile) tile.remove();
}

function creaTileRemoto(
  uid,
  nome,
  videoAttivo
) {
  const box =
    document.getElementById("media-videos");

  if (!box) return null;

  let tile =
    document.getElementById(
      "media-remoto-" + uid
    );

  if (!tile) {
    tile = document.createElement("div");

    tile.id =
      "media-remoto-" + uid;

    tile.className =
      "media-tile" +
      (videoAttivo ? "" : " audio-only");

    tile.innerHTML = `
      <video
        autoplay
        playsinline>
      </video>
      <div class="media-name"></div>
    `;

    box.appendChild(tile);
  }

  tile.classList.toggle(
    "audio-only",
    !videoAttivo
  );

  const nomeEl =
    tile.querySelector(".media-name");

  if (nomeEl) {
    nomeEl.textContent =
      nome || "Giocatore";
  }

  return tile.querySelector("video");
}

function aggiungiStreamRemoto(
  uid,
  nome,
  stream
) {
  const hasVideo =
    stream
      .getVideoTracks()
      .some(
        track =>
          track.readyState !== "ended"
      );

  const video =
    creaTileRemoto(
      uid,
      nome,
      hasVideo
    );

  if (!video) return;

  video.srcObject = stream;
  video.muted = false;

  const playPromise = video.play();

  if (
    playPromise &&
    typeof playPromise.catch === "function"
  ) {
    playPromise.catch(() => {});
  }
}

async function creaConnessioneMedia(
  uid,
  nome,
  deveCreareOfferta
) {
  if (!uid || uid === mioUid) {
    return null;
  }

  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return null;
  }

  if (connessioniMedia[uid]) {
    return connessioniMedia[uid];
  }

  const pc =
    new RTCPeerConnection(
      CONFIGURAZIONE_ICE
    );

  connessioniMedia[uid] = pc;

  peerInfoMedia[uid] = {
    nome:
      nome || "Giocatore"
  };

  if (!flussoMediaLocale) {
    await ottieniMediaLocale({
      audio: true,
      video: true
    });
  }

  if (flussoMediaLocale) {
    flussoMediaLocale
      .getTracks()
      .forEach(track => {
        try {
          pc.addTrack(
            track,
            flussoMediaLocale
          );
        } catch (_) {}
      });
  }

  pc.onicecandidate = event => {
    if (
      !event.candidate ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    socket.send(
      JSON.stringify({
        tipo: "webrtc-ice-candidate",
        partitaId,
        destinatarioUid: uid,
        candidate: event.candidate
      })
    );
  };

  pc.ontrack = event => {
    const stream =
      event.streams &&
      event.streams[0]
        ? event.streams[0]
        : null;

    if (stream) {
      aggiungiStreamRemoto(
        uid,
        nome,
        stream
      );
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed" ||
      pc.connectionState === "disconnected"
    ) {
      chiudiConnessioneMedia(uid);
    }
  };

  if (deveCreareOfferta) {
    try {
      const offer =
        await pc.createOffer();

      await pc.setLocalDescription(
        offer
      );

      if (
        socket &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.send(
          JSON.stringify({
            tipo: "webrtc-offer",
            partitaId,
            destinatarioUid: uid,
            sdp: pc.localDescription
          })
        );
      }
    } catch (errore) {
      console.error(
        "Errore creazione offerta WebRTC:",
        errore
      );
    }
  }

  return pc;
}

async function gestisciAvvioMediaAutomatico(
  dati
) {
  const peers =
    Array.isArray(dati.peer)
      ? dati.peer
      : [];

  if (!peers.length) return;

  const ok =
    await ottieniMediaLocale({
      audio: true,
      video: true
    });

  if (!ok) return;

  const offerte =
    new Set(
      dati.iniziaOffertaVerso || []
    );

  for (const peer of peers) {
    if (!peer || !peer.uid) continue;

    await creaConnessioneMedia(
      peer.uid,
      peer.nome,
      offerte.has(peer.uid)
    );
  }
}

async function gestisciWebRTCOffer(
  dati
) {
  const uid =
    dati.mittenteUid;

  if (!uid || !dati.sdp) return;

  const pc =
    await creaConnessioneMedia(
      uid,
      peerInfoMedia[uid]
        ? peerInfoMedia[uid].nome
        : "Giocatore",
      false
    );

  if (!pc) return;

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(
        dati.sdp
      )
    );

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(
      answer
    );

    if (
      socket &&
      socket.readyState === WebSocket.OPEN
    ) {
      socket.send(
        JSON.stringify({
          tipo: "webrtc-answer",
          partitaId,
          destinatarioUid: uid,
          sdp: pc.localDescription
        })
      );
    }
  } catch (errore) {
    console.error(
      "Errore gestione offerta WebRTC:",
      errore
    );
  }
}

async function gestisciWebRTCAnswer(
  dati
) {
  const uid =
    dati.mittenteUid;

  const pc =
    connessioniMedia[uid];

  if (!pc || !dati.sdp) return;

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(
        dati.sdp
      )
    );
  } catch (errore) {
    console.error(
      "Errore gestione risposta WebRTC:",
      errore
    );
  }
}

async function gestisciICECandidate(
  dati
) {
  const uid =
    dati.mittenteUid;

  const pc =
    connessioniMedia[uid];

  if (!pc || !dati.candidate) return;

  try {
    await pc.addIceCandidate(
      new RTCIceCandidate(
        dati.candidate
      )
    );
  } catch (errore) {
    console.warn(
      "ICE candidate non accettato:",
      errore
    );
  }
}

function toggleMicrofonoLocale() {
  if (!flussoMediaLocale) {
    ottieniMediaLocale({
      audio: true,
      video: true
    });

    return;
  }

  const tracks =
    flussoMediaLocale.getAudioTracks();

  if (!tracks.length) {
    ottieniMediaLocale({
      audio: true,
      video: webcamLocaleAttiva
    });

    return;
  }

  microfonoLocaleAttivo =
    !microfonoLocaleAttivo;

  tracks.forEach(track => {
    track.enabled =
      microfonoLocaleAttivo;
  });

  aggiornaPulsantiMedia();
}

function toggleWebcamLocale() {
  if (!flussoMediaLocale) {
    ottieniMediaLocale({
      audio: true,
      video: true
    });

    return;
  }

  const tracks =
    flussoMediaLocale.getVideoTracks();

  if (!tracks.length) {
    ottieniMediaLocale({
      audio: microfonoLocaleAttivo,
      video: true
    });

    return;
  }

  webcamLocaleAttiva =
    !webcamLocaleAttiva;

  tracks.forEach(track => {
    track.enabled =
      webcamLocaleAttiva;
  });

  if (webcamLocaleAttiva) {
    creaTileLocale();
  } else {
    const tile =
      document.getElementById(
        "media-locale"
      );

    if (tile) tile.remove();
  }

  aggiornaPulsantiMedia();
}

function chiudiTutteConnessioniMedia() {
  Object.keys(
    connessioniMedia
  ).forEach(uid =>
    chiudiConnessioneMedia(uid)
  );

  fermaMediaLocale();

  const box =
    document.getElementById(
      "media-videos"
    );

  if (box) {
    box.innerHTML = "";
  }

  aggiornaPulsantiMedia();
}

// =========================================================
// DADI
// =========================================================

function creaFacciaDado(valore) {
  const posizioniPip = {
    1: [[50, 50]],
    2: [[25, 25], [75, 75]],
    3: [[25, 25], [50, 50], [75, 75]],
    4: [[25, 25], [75, 25], [25, 75], [75, 75]],
    5: [[25, 25], [75, 25], [50, 50], [25, 75], [75, 75]],
    6: [[25, 25], [75, 25], [25, 50], [75, 50], [25, 75], [75, 75]]
  };

  const colorePip =
    valore === 1 || valore === 4
      ? "#e53935"
      : "#222";

  const pips =
    posizioniPip[valore]
      .map(
        ([x, y]) =>
          `<circle cx="${x}" cy="${y}" r="8" fill="${colorePip}"/>`
      )
      .join("");

  return `
    <svg
      width="55"
      height="55"
      viewBox="0 0 100 100">
      <rect
        x="4"
        y="4"
        width="92"
        height="92"
        rx="14"
        fill="#fff"
        stroke="#ccc"
        stroke-width="3"/>
      ${pips}
    </svg>
  `;
}

function mostraDadi(v1, v2) {
  document.getElementById(
    "dado1"
  ).innerHTML =
    creaFacciaDado(v1);

  document.getElementById(
    "dado2"
  ).innerHTML =
    creaFacciaDado(v2);
}

function animaLancioDadi(
  vf1,
  vf2,
  callback
) {
  const dado1El =
    document.getElementById("dado1");

  const dado2El =
    document.getElementById("dado2");

  dado1El.classList.add(
    "dado-rotola"
  );

  dado2El.classList.add(
    "dado-rotola"
  );

  let cicli = 0;

  const intervallo =
    setInterval(() => {
      dado1El.innerHTML =
        creaFacciaDado(
          Math.floor(Math.random() * 6) + 1
        );

      dado2El.innerHTML =
        creaFacciaDado(
          Math.floor(Math.random() * 6) + 1
        );

      cicli++;

      if (cicli >= 8) {
        clearInterval(intervallo);

        dado1El.classList.remove(
          "dado-rotola"
        );

        dado2El.classList.remove(
          "dado-rotola"
        );

        mostraDadi(vf1, vf2);

        if (callback) {
          callback();
        }
      }
    }, 80);
}

function schiarisciColore(hex, p) {
  return mescolaColore(
    hex,
    255,
    p
  );
}

function scuriscColore(hex, p) {
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
      hex.replace("#", ""),
      16
    );

  let r =
    (num >> 16) & 255;

  let g =
    (num >> 8) & 255;

  let b =
    num & 255;

  r =
    Math.round(
      r +
        (target - r) *
          (p / 100)
    );

  g =
    Math.round(
      g +
        (target - g) *
          (p / 100)
    );

  b =
    Math.round(
      b +
        (target - b) *
          (p / 100)
    );

  return `rgb(${r},${g},${b})`;
}

function iniziale(nome) {
  return (
    nome || "?"
  )
    .trim()
    .charAt(0)
    .toUpperCase();
}

function coordinatePerCasella(
  casellaNumero
) {
  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

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
      casella.x * scaleX,
    top:
      casella.y * scaleY
  };
}

function posizionaPedina(
  pedina,
  casellaNumero
) {
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
  let pedina =
    document.getElementById(
      "pedina-" + idGiocatore
    );

  if (!pedina) {
    pedina =
      document.createElement("div");

    pedina.id =
      "pedina-" + idGiocatore;

    pedina.className =
      "pedina";

    const idGradiente =
      "gradPedina" + indice;

    pedina.innerHTML = `
      <svg
        width="26"
        height="38"
        viewBox="0 0 34 48">

        <defs>
          <radialGradient
            id="${idGradiente}"
            cx="35%"
            cy="25%"
            r="75%">

            <stop
              offset="0%"
              stop-color="${schiarisciColore(
                colore,
                55
              )}"/>

            <stop
              offset="55%"
              stop-color="${colore}"/>

            <stop
              offset="100%"
              stop-color="${scuriscColore(
                colore,
                35
              )}"/>
          </radialGradient>
        </defs>

        <ellipse
          cx="17"
          cy="44"
          rx="12"
          ry="3.5"
          fill="rgba(0,0,0,0.3)"/>

        <ellipse
          cx="17"
          cy="42"
          rx="11"
          ry="4"
          fill="${scuriscColore(
            colore,
            25
          )}"/>

        <path
          d="M17 42 C10 42 4 40 4 37
          L10 15 C10 15 12 12 17 12
          C22 12 24 15 24 15 L30 37
          C30 40 24 42 17 42 Z"
          fill="url(#${idGradiente})"
          stroke="${scuriscColore(
            colore,
            45
          )}"
          stroke-width="0.8"/>

        <circle
          cx="17"
          cy="9"
          r="7.5"
          fill="url(#${idGradiente})"
          stroke="${scuriscColore(
            colore,
            45
          )}"
          stroke-width="0.8"/>

        <ellipse
          cx="14"
          cy="6"
          rx="2.5"
          ry="1.8"
          fill="rgba(255,255,255,0.55)"/>
      </svg>
    `;

    document
      .getElementById(
        "contenitore-pedine"
      )
      .appendChild(pedina);
  }

  return pedina;
}

function animaSaltoPedina(
  idGiocatore,
  percorso,
  callback
) {
  if (
    !percorso ||
    percorso.length === 0
  ) {
    if (callback) callback();
    return;
  }

  const indice =
    ultimoStatoGiocatori.findIndex(
      g =>
        g.id === idGiocatore
    );

  const colore =
    coloriGiocatori[
      (indice >= 0 ? indice : 0) %
        coloriGiocatori.length
    ];

  const pedina =
    ottieniOCreaPedina(
      idGiocatore,
      colore,
      indice >= 0 ? indice : 0
    );

  let passo = 0;

  function saltaProssimo() {
    if (
      passo >= percorso.length
    ) {
      if (callback) {
        callback();
      }

      return;
    }

    const casella =
      percorso[passo];

    pedina.classList.add(
      "pedina-salta"
    );

    posizionaPedina(
      pedina,
      casella
    );

    const etichettaCasella =
      document.getElementById(
        "casella-" + idGiocatore
      );

    if (etichettaCasella) {
      etichettaCasella.textContent =
        casella;
    }

    setTimeout(
      () =>
        pedina.classList.remove(
          "pedina-salta"
        ),
      DURATA_SALTO_MS * 0.6
    );

    passo++;

    setTimeout(
      saltaProssimo,
      DURATA_SALTO_MS
    );
  }

  saltaProssimo();
}

// =========================================================
// AVVIO
// =========================================================

async function avvia() {
  try {
    const risposta =
      await fetch(
        "https://gioco-oca-server.onrender.com/api/me",
        {
          credentials: "include"
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

    mioUid = dati.uid;

    connetti();
  } catch (e) {
    window.location.href =
      "login.html?redirect=" +
      encodeURIComponent(
        window.location.href
      );
  }
}

function connetti() {
  socket =
    new WebSocket(
      "wss://gioco-oca-server.onrender.com"
    );

  socket.onopen = () => {
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

  socket.onclose = () => {
    const riga =
      document.getElementById(
        "riga-turno"
      );

    if (riga) {
      riga.textContent =
        "🔴 Disconnesso, riconnessione...";
    }

    if (!timerRiconnessione) {
      timerRiconnessione =
        setTimeout(() => {
          timerRiconnessione = null;
          connetti();
        }, 3000);
    }
  };

  socket.onmessage = (
    msg
  ) => {
    let dati;

    try {
      dati =
        JSON.parse(msg.data);
    } catch (e) {
      return;
    }

    if (
      dati.tipo ===
      "sessioneScaduta"
    ) {
      window.location.href =
        "login.html?redirect=" +
        encodeURIComponent(
          window.location.href
        );

      return;
    }

    // =====================================================
    // AUDIO / VIDEO AUTOMATICO
    // =====================================================

    if (
      dati.tipo ===
      "vocaleAutoAvvio"
    ) {
      gestisciAvvioMediaAutomatico(
        dati
      );
      return;
    }

    if (
      dati.tipo ===
      "webrtc-offer"
    ) {
      gestisciWebRTCOffer(
        dati
      );
      return;
    }

    if (
      dati.tipo ===
      "webrtc-answer"
    ) {
      gestisciWebRTCAnswer(
        dati
      );
      return;
    }

    if (
      dati.tipo ===
      "webrtc-ice-candidate"
    ) {
      gestisciICECandidate(
        dati
      );
      return;
    }

    // =====================================================
    // STATO PARTITA
    // =====================================================

    if (
      dati.tipo ===
      "statoPartita"
    ) {
      ultimoStatoGiocatori =
        dati.giocatori;

      if (dati.vittoria) {
        turnoAttualeId =
          null;

        document
          .getElementById(
            "area-dadi"
          )
          .classList.add(
            "disabilitato"
          );

        disegnaGiocatori();

        mostraVittoria(
          dati.vincitore
        );
      } else {
        aggiornaTurno(
          dati.turnoDiId
        );

        disegnaGiocatori();
      }

      if (
        dati.messaggi &&
        dati.messaggi.length
      ) {
        document.getElementById(
          "messaggi-gioco"
        ).textContent =
          dati.messaggi.join(
            " "
          );
      }

      mostraDadi(1, 1);
    }

    if (
      dati.tipo ===
      "aggiornamentoPartita"
    ) {
      animaLancioDadi(
        dati.dado1,
        dati.dado2,
        () => {
          if (
            dati.percorso &&
            dati.idGiocatoreCheHaTirato
          ) {
            animaSaltoPedina(
              dados = dados,
              dati.idGiocatoreCheHaTirato,
              dati.percorso,
              () => {
                ultimoStatoGiocatori =
                  dati.giocatori;

                document.getElementById(
                  "messaggi-gioco"
                ).textContent =
                  "🎲 " +
                  dados.dado1 +
                  " + " +
                  dados.dado2 +
                  " = " +
                  dados.valoreDado +
                  (
                    dados.messaggi &&
                    dados.messaggi.length
                      ? " — " +
                        dados.messaggi.join(
                          " "
                        )
                      : ""
                  );

                if (dados.vittoria) {
                  turnoAttualeId =
                    null;

                  document
                    .getElementById(
                      "area-dadi"
                    )
                    .classList.add(
                      "disabilitato"
                    );

                  disegnaGiocatori();

                  mostraVittoria(
                    dados.vincitore
                  );
                } else {
                  aggiornaTurno(
                    dados.turnoDiId
                  );

                  disegnaGiocatori();
                }
              }
            );
          } else {
            ultimoStatoGiocatori =
              dati.giocatori;

            document.getElementById(
              "messaggi-gioco"
            ).textContent =
              "🎲 " +
              dati.dado1 +
              " + " +
              dati.dado2 +
              " = " +
              dati.valoreDado +
              (
                dati.messaggi &&
                dati.messaggi.length
                  ? " — " +
                    dati.messaggi.join(
                      " "
                    )
                  : ""
              );

            if (dati.vittoria) {
              turnoAttualeId =
                null;

              document
                .getElementById(
                  "area-dadi"
                )
                .classList.add(
                  "disabilitato"
                );

              disegnaGiocatori();

              mostraVittoria(
                dati.vincitore
              );
            } else {
              aggiornaTurno(
                dati.turnoDiId
              );

              disegnaGiocatori();
            }
          }
        }
      );
    }

    if (
      dati.tipo ===
      "chatPartita"
    ) {
      aggiungiMessaggioChatPartita(
        dati.nome,
        dati.testo
      );
    }

    if (
      dati.tipo ===
      "errore"
    ) {
      alert(
        dati.messaggio
      );

      if (mioTurno) {
        document
          .getElementById(
            "area-dadi"
          )
          .classList.remove(
            "disabilitato"
          );
      }
    }
  };
}

// =========================================================
// TURNO
// =========================================================

function aggiornaTurno(
  turnoDiId
) {
  turnoAttualeId =
    turnoDiId;

  mioTurno =
    turnoDiId === mioUid;

  document.getElementById(
    "riga-turno"
  ).textContent =
    mioTurno
      ? "🎲 È il tuo turno!"
      : "⏳ In attesa...";

  document
    .getElementById(
      "area-dadi"
    )
    .classList.toggle(
      "disabilitato",
      !mioTurno
    );
}

// =========================================================
// GIOCATORI
// =========================================================

function disegnaGiocatori() {
  const contenitore =
    document.getElementById(
      "contenitore-pedine"
    );

  Array.from(
    contenitore.children
  ).forEach(pedina => {
    if (
      !ultimoStatoGiocatori.some(
        g =>
          "pedina-" +
            g.id ===
          pedina.id
      )
    ) {
      pedina.remove();
    }
  });

  const listaPannello =
    document.getElementById(
      "lista-giocatori"
    );

  listaPannello.innerHTML =
    "";

  ultimoStatoGiocatori.forEach(
    (
      giocatore,
      indice
    ) => {
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

      posizionaPedina(
        pedina,
        giocatore.posizione
      );

      const avatarHtml =
        giocatore.avatar
          ? `
            <img
              class="avatar-mini"
              src="${giocatore.avatar}">
          `
          : `
            <div
              class="avatar-mini"
              style="background:${colore};">
              ${iniziale(
                giocatore.nome
              )}
            </div>
          `;

      const card =
        document.createElement(
          "div"
        );

      card.className =
        "giocatore-card" +
        (
          giocatore.id ===
          turnoAttualeId
            ? " attivo"
            : ""
        );

      card.innerHTML = `
        ${avatarHtml}

        <a
          href="profilo-pubblico.html?nickname=${encodeURIComponent(
            giocatore.nome
          )}"
          target="_blank"
          style="
            color:inherit;
            text-decoration:none;
            flex-grow:1;
          ">
          ${giocatore.nome}
        </a>

        <span
          class="casella-mini"
          id="casella-${giocatore.id}">
          ${giocatore.posizione}
        </span>
      `;

      listaPannello.appendChild(
        card
      );
    }
  );
}

// =========================================================
// VITTORIA / USCITA
// =========================================================

function mostraVittoria(
  nomeVincitore
) {
  document.getElementById(
    "testo-vincitore"
  ).textContent =
    "🎉 Ha vinto " +
    nomeVincitore +
    "!";

  document
    .getElementById(
      "overlay-vittoria"
    )
    .classList.add(
      "aperto"
    );
}

function tornaAllaLobby() {
  chiudiTutteConnessioniMedia();

  window.location.href =
    `lobby.html?stanza=${stanza}`;
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

  chiudiTutteConnessioniMedia();

  tornaAllaLobby();
}

// =========================================================
// MENU
// =========================================================

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
  document
    .getElementById(
      "pannello-menu"
    )
    .classList.add(
      "nascosto"
    );
}

document
  .getElementById(
    "btn-menu"
  )
  .onclick =
  e => {
    e.stopPropagation();

    document
      .getElementById(
        "pannello-menu"
      )
      .classList.toggle(
        "nascosto"
      );
  };

document.addEventListener(
  "click",
  () => chiudiMenu()
);

// =========================================================
// CHAT
// =========================================================

function aggiungiMessaggioChatPartita(
  nome,
  testo
) {
  const box =
    document.getElementById(
      "chat-messaggi"
    );

  const riga =
    document.createElement(
      "div"
    );

  riga.className =
    "chat-msg";

  riga.innerHTML =
    `<b>${nome}:</b> ${testo}`;

  box.appendChild(
    riga
  );

  box.scrollTop =
    box.scrollHeight;
}

function inviaChatPartita() {
  const input =
    document.getElementById(
      "chat-input"
    );

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
  }

  input.value = "";
}

document
  .getElementById(
    "chat-input"
  )
  .addEventListener(
    "keypress",
    e => {
      if (
        e.key ===
        "Enter"
      ) {
        inviaChatPartita();
      }
    }
  );

document
  .getElementById(
    "btn-chat"
  )
  .onclick =
  e => {
    e.stopPropagation();

    document
      .getElementById(
        "pannello-chat"
      )
      .classList.toggle(
        "nascosto"
      );
  };

// =========================================================
// DADO
// =========================================================

document
  .getElementById(
    "area-dadi"
  )
  .onclick =
  () => {
    if (!mioTurno) {
      return;
    }

    if (
      !socket ||
      socket.readyState !==
        WebSocket.OPEN
    ) {
      return;
    }

    document
      .getElementById(
        "area-dadi"
      )
      .classList.add(
        "disabilitato"
      );

    socket.send(
      JSON.stringify({
        tipo:
          "tiraDadi",
        partitaId
      })
    );
  };

// =========================================================
// PULSANTI AUDIO / VIDEO
// =========================================================

const btnMicrofono =
  document.getElementById(
    "btn-microfono"
  );

const btnWebcam =
  document.getElementById(
    "btn-webcam"
  );

if (btnMicrofono) {
  btnMicrofono.addEventListener(
    "click",
    toggleMicrofonoLocale
  );
}

if (btnWebcam) {
  btnWebcam.addEventListener(
    "click",
    toggleWebcamLocale
  );
}

aggiornaPulsantiMedia();

window.addEventListener(
  "beforeunload",
  chiudiTutteConnessioniMedia
);

// =========================================================
// AVVIO INIZIALE
// =========================================================

mostraDadi(1, 1);
avvia();
