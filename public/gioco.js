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
const DURATA_ANIMAZIONE_DADI_MS = 640;

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita");
const stanza = params.get("stanza");

let mioUid = null;
let socket = null;

let ultimoStatoGiocatori = [];
let mioTurno = false;
let turnoAttualeId = null;

let timerRiconnessione = null;

let determinazioneAttiva = false;
let determinazioneTurnoUid = null;
let risultatiDeterminazione = {};
let ordineDeterminazione = [];
let gruppoSpareggioAttuale = [];

let timerDeterminazione = null;
let scadenzaDeterminazione = null;

let timerTurno = null;
let scadenzaTurnoServer = null;

let partitaTerminata = false;

// =========================================================
// CREAZIONE DINAMICA ELEMENTI MEDIA
// =========================================================

function creaInterfacciaMedia() {
  let box = document.getElementById("media-box");

  if (!box) {
    box = document.createElement("div");
    box.id = "media-box";

    box.style.position = "fixed";
    box.style.bottom = "18px";
    box.style.left = "18px";
    box.style.zIndex = "80";
    box.style.display = "flex";
    box.style.flexDirection = "column";
    box.style.gap = "8px";
    box.style.maxWidth = "min(420px, calc(100vw - 36px))";
    box.style.pointerEvents = "none";

    document.body.appendChild(box);
  }

  let controlli = document.getElementById("media-controlli");

  if (!controlli) {
    controlli = document.createElement("div");
    controlli.id = "media-controlli";

    controlli.style.display = "flex";
    controlli.style.gap = "8px";
    controlli.style.pointerEvents = "auto";

    controlli.innerHTML = `
      <button id="btn-microfono" type="button"
        style="
          border:none;
          border-radius:12px;
          padding:9px 12px;
          background:rgba(10,16,22,.88);
          color:#fff;
          border:1px solid rgba(255,215,0,.3);
          cursor:pointer;
          font-weight:bold;
        ">
        🔇 Microfono: Off
      </button>

      <button id="btn-webcam" type="button"
        style="
          border:none;
          border-radius:12px;
          padding:9px 12px;
          background:rgba(10,16,22,.88);
          color:#fff;
          border:1px solid rgba(255,215,0,.3);
          cursor:pointer;
          font-weight:bold;
        ">
        🚫 Webcam: Off
      </button>
    `;

    box.appendChild(controlli);
  }

  let stato = document.getElementById("media-stato");

  if (!stato) {
    stato = document.createElement("div");
    stato.id = "media-stato";

    stato.style.display = "none";
    stato.style.background = "rgba(10,16,22,.88)";
    stato.style.border = "1px solid rgba(255,215,0,.25)";
    stato.style.borderRadius = "10px";
    stato.style.padding = "8px 10px";
    stato.style.fontSize = "12px";
    stato.style.color = "#fff";
    stato.style.pointerEvents = "none";

    box.appendChild(stato);
  }

  let videos = document.getElementById("media-videos");

  if (!videos) {
    videos = document.createElement("div");
    videos.id = "media-videos";

    videos.style.display = "grid";
    videos.style.gridTemplateColumns = "repeat(2, minmax(120px, 1fr))";
    videos.style.gap = "8px";
    videos.style.pointerEvents = "none";

    box.appendChild(videos);
  }

  if (!document.getElementById("media-styles")) {
    const style = document.createElement("style");
    style.id = "media-styles";

    style.textContent = `
      .media-tile {
        position:relative;
        width:150px;
        height:106px;
        background:#111820;
        border:1px solid rgba(255,215,0,.24);
        border-radius:12px;
        overflow:hidden;
        box-shadow:0 8px 24px rgba(0,0,0,.45);
      }

      .media-tile video {
        width:100%;
        height:100%;
        object-fit:cover;
        display:block;
        background:#000;
      }

      .media-name {
        position:absolute;
        left:7px;
        right:7px;
        bottom:6px;
        padding:4px 6px;
        border-radius:7px;
        background:rgba(0,0,0,.58);
        color:#fff;
        font-size:11px;
        font-weight:bold;
      }

      .media-tile.audio-only {
        height:52px;
      }

      .media-tile.audio-only video {
        display:none;
      }

      @media (max-width:600px) {
        #media-box {
          left:8px !important;
          bottom:8px !important;
          max-width:calc(100vw - 16px) !important;
        }

        .media-tile {
          width:120px;
          height:84px;
        }
      }
    `;

    document.head.appendChild(style);
  }
}

creaInterfacciaMedia();

// =========================================================
// AUDIO / WEBCAM - WEBRTC
// =========================================================

const CONFIGURAZIONE_ICE = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
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

    m.style.opacity = microfonoLocaleAttivo ? "1" : ".7";
  }

  if (c) {
    c.textContent = webcamLocaleAttiva
      ? "📷 Webcam: On"
      : "🚫 Webcam: Off";

    c.style.opacity = webcamLocaleAttiva ? "1" : ".7";
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
    aggiornaStatoMedia("Il browser non supporta audio/video.");
    return false;
  }

  try {
    let constraints = {
      audio: !!audio,
      video: !!video
    };

    if (!audio && !video) {
      constraints = {
        audio: false,
        video: false
      };
    }

    if (!flussoMediaLocale) {
      flussoMediaLocale =
        await navigator.mediaDevices.getUserMedia(constraints);
    } else {
      const audioRichiesto = !!audio;
      const videoRichiesto = !!video;

      const haAudio =
        flussoMediaLocale.getAudioTracks().length > 0;

      const haVideo =
        flussoMediaLocale.getVideoTracks().length > 0;

      if (audioRichiesto !== haAudio || videoRichiesto !== haVideo) {
        flussoMediaLocale.getTracks().forEach(track => {
          try {
            track.stop();
          } catch (_) {}
        });

        flussoMediaLocale =
          await navigator.mediaDevices.getUserMedia(constraints);
      }
    }

    microfonoLocaleAttivo =
      flussoMediaLocale
        .getAudioTracks()
        .some(track => track.enabled && track.readyState === "live");

    webcamLocaleAttiva =
      flussoMediaLocale
        .getVideoTracks()
        .some(track => track.enabled && track.readyState === "live");

    aggiornaPulsantiMedia();
    creaTileLocale();

    aggiornaStatoMedia(
      "Connessione audio/video attiva",
      false
    );

    return true;
  } catch (errore) {
    console.error("Errore accesso dispositivi multimediali:", errore);

    aggiornaStatoMedia(
      "Permesso microfono/webcam non concesso."
    );

    return false;
  }
}

function creaTileLocale() {
  const box = document.getElementById("media-videos");
  if (!box) return;

  let tile = document.getElementById("media-locale");

  if (!flussoMediaLocale || !webcamLocaleAttiva) {
    if (tile) tile.remove();
    return;
  }

  if (!tile) {
    tile = document.createElement("div");
    tile.id = "media-locale";
    tile.className = "media-tile";

    tile.innerHTML = `
      <video autoplay muted playsinline></video>
      <div class="media-name">Tu</div>
    `;

    box.prepend(tile);
  }

  const video = tile.querySelector("video");

  if (video && video.srcObject !== flussoMediaLocale) {
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

  delete peerInfoMedia[uid];

  const tile = document.getElementById(
    "media-remoto-" + uid
  );

  if (tile) tile.remove();
}

function creaTileRemoto(uid, nome, videoAttivo) {
  const box = document.getElementById("media-videos");

  if (!box) return null;

  let tile = document.getElementById(
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
      <video autoplay playsinline></video>
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

function aggiungiStreamRemoto(uid, nome, stream) {
  const hasVideo =
    stream
      .getVideoTracks()
      .some(track => track.readyState !== "ended");

  const video =
    creaTileRemoto(uid, nome, hasVideo);

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
  deveCreareOfferta,
  videoAttivoRemoto = true
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

  const pc = new RTCPeerConnection(
    CONFIGURAZIONE_ICE
  );

  connessioniMedia[uid] = pc;

  peerInfoMedia[uid] = {
    nome: nome || "Giocatore",
    webcamAttiva: !!videoAttivoRemoto
  };

  if (!flussoMediaLocale) {
    await ottieniMediaLocale({
      audio: true,
      video: webcamLocaleAttiva
    });
  }

  if (flussoMediaLocale) {
    flussoMediaLocale.getTracks().forEach(track => {
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
      event.streams && event.streams[0]
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
      pc.connectionState === "closed"
    ) {
      chiudiConnessioneMedia(uid);
    }
  };

  if (deveCreareOfferta) {
    try {
      const offer = await pc.createOffer();

      await pc.setLocalDescription(offer);

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

async function gestisciAvvioMediaAutomatico(dati) {
  const peers =
    Array.isArray(dati.peer)
      ? dati.peer
      : [];

  if (!peers.length) {
    return;
  }

  const vuoleAudio =
    peers.length > 0;

  const ok =
    await ottieniMediaLocale({
      audio: vuoleAudio,
      video: webcamLocaleAttiva
    });

  if (!ok) {
    return;
  }

  const offerte =
    new Set(
      dati.iniziaOffertaVerso || []
    );

  for (const peer of peers) {
    if (!peer || !peer.uid) {
      continue;
    }

    await creaConnessioneMedia(
      peer.uid,
      peer.nome,
      offerte.has(peer.uid),
      !!peer.webcamAttiva
    );
  }
}

async function gestisciWebRTCOffer(dati) {
  const uid = dati.mittenteUid;

  if (!uid || !dati.sdp) return;

  const pc =
    await creaConnessioneMedia(
      uid,
      peerInfoMedia[uid]
        ? peerInfoMedia[uid].nome
        : "Giocatore",
      false,
      peerInfoMedia[uid]
        ? !!peerInfoMedia[uid].webcamAttiva
        : true
    );

  if (!pc) return;

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(dati.sdp)
    );

    const answer =
      await pc.createAnswer();

    await pc.setLocalDescription(answer);

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

async function gestisciWebRTCAnswer(dati) {
  const uid = dati.mittenteUid;

  const pc =
    connessioniMedia[uid];

  if (!pc || !dati.sdp) return;

  try {
    await pc.setRemoteDescription(
      new RTCSessionDescription(dati.sdp)
    );
  } catch (errore) {
    console.error(
      "Errore gestione risposta WebRTC:",
      errore
    );
  }
}

async function gestisciICECandidate(dati) {
  const uid =
    dati.mittenteUid;

  const pc =
    connessioniMedia[uid];

  if (!pc || !dati.candidate) return;

  try {
    await pc.addIceCandidate(
      new RTCIceCandidate(dati.candidate)
    );
  } catch (errore) {
    console.warn(
      "ICE candidate non accettato:",
      errore
    );
  }
}

async function toggleMicrofonoLocale() {
  if (!flussoMediaLocale) {
    await ottieniMediaLocale({
      audio: true,
      video: webcamLocaleAttiva
    });

    return;
  }

  const tracks =
    flussoMediaLocale.getAudioTracks();

  if (!tracks.length) {
    await ottieniMediaLocale({
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

async function toggleWebcamLocale() {
  if (!flussoMediaLocale) {
    await ottieniMediaLocale({
      audio: microfonoLocaleAttivo,
      video: true
    });

    return;
  }

  const tracks =
    flussoMediaLocale.getVideoTracks();

  if (!tracks.length) {
    await ottieniMediaLocale({
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

    if (tile) {
      tile.remove();
    }
  }

  aggiornaPulsantiMedia();
}

function chiudiTutteConnessioniMedia() {
  Object.keys(connessioniMedia).forEach(uid => {
    chiudiConnessioneMedia(uid);
  });

  fermaMediaLocale();

  const box =
    document.getElementById("media-videos");

  if (box) {
    box.innerHTML = "";
  }

  aggiornaPulsantiMedia();
}

// =========================================================
// INTERFACCIA "CHI INIZIA?"
//
// Viene creata direttamente dal JS, quindi non devi
// modificare gioco.html.
// =========================================================

function creaOverlayDeterminazione() {
  let overlay =
    document.getElementById(
      "overlay-determinazione"
    );

  if (overlay) {
    return overlay;
  }

  overlay =
    document.createElement("div");

  overlay.id =
    "overlay-determinazione";

  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.display = "none";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(0,0,0,.76)";
  overlay.style.zIndex = "900";
  overlay.style.padding = "20px";

  const popup =
    document.createElement("div");

  popup.style.width =
    "min(520px, 94vw)";

  popup.style.maxHeight =
    "88vh";

  popup.style.overflow =
    "auto";

  popup.style.background =
    "#121c26";

  popup.style.border =
    "2px solid #ffd700";

  popup.style.borderRadius =
    "16px";

  popup.style.padding =
    "24px";

  popup.style.boxShadow =
    "0 20px 60px rgba(0,0,0,.55)";

  popup.innerHTML = `
    <h2
      style="
        margin:0;
        color:#ffd700;
        text-align:center;
      ">
      🎲 Chi inizia?
    </h2>

    <p
      id="determinazione-sottotitolo"
      style="
        margin:8px 0 18px;
        text-align:center;
        color:#ccc;
        font-size:14px;
      ">
      Ogni giocatore tira due dadi.
    </p>

    <div id="lista-determinazione"></div>

    <div
      id="determinazione-controlli"
      style="
        display:flex;
        justify-content:center;
        margin-top:16px;
      ">
    </div>
  `;

  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  return overlay;
}

function aggiornaOverlayDeterminazione() {
  const overlay =
    creaOverlayDeterminazione();

  overlay.style.display =
    determinazioneAttiva
      ? "flex"
      : "none";

  const lista =
    document.getElementById(
      "lista-determinazione"
    );

  if (!lista) return;

  lista.innerHTML = "";

  ordineDeterminazione.forEach(uid => {
    const giocatore =
      ultimoStatoGiocatori.find(
        g => g.id === uid
      );

    const riga =
      document.createElement("div");

    riga.style.display = "flex";
    riga.style.alignItems = "center";
    riga.style.gap = "10px";
    riga.style.padding = "10px 12px";
    riga.style.marginBottom = "8px";
    riga.style.borderRadius = "10px";
    riga.style.background =
      uid === determinazioneTurnoUid
        ? "rgba(255,215,0,.13)"
        : "rgba(255,255,255,.04)";

    riga.style.border =
      uid === determinazioneTurnoUid
        ? "1px solid rgba(255,215,0,.45)"
        : "1px solid rgba(255,255,255,.06)";

    const nome =
      giocatore
        ? giocatore.nome
        : "Giocatore";

    const risultato =
      risultatiDeterminazione[uid];

    let testoRisultato =
      "In attesa...";

    let coloreRisultato =
      "#888";

    if (risultato != null) {
      testoRisultato =
        "🎲 " + risultato;

      coloreRisultato =
        "#ffd700";
    } else if (
      uid === determinazioneTurnoUid
    ) {
      testoRisultato =
        "È il suo turno";

      coloreRisultato =
        "#ffd700";
    }

    riga.innerHTML = `
      <div
        style="
          width:28px;
          height:28px;
          border-radius:50%;
          background:${coloriGiocatori[
            Math.max(
              0,
              ordineDeterminazione.indexOf(uid)
            ) % coloriGiocatori.length
          ]};
          display:flex;
          align-items:center;
          justify-content:center;
          font-weight:bold;
          color:#fff;
          flex-shrink:0;
        ">
        ${iniziale(nome)}
      </div>

      <div
        style="
          flex:1;
          min-width:0;
          color:#eee;
          font-weight:
            ${uid === determinazioneTurnoUid ? "bold" : "normal"};
        ">
        ${nome}
      </div>

      <div
        style="
          color:${coloreRisultato};
          font-weight:bold;
          font-size:13px;
          flex-shrink:0;
        ">
        ${testoRisultato}
      </div>
    `;

    lista.appendChild(riga);
  });

  const gruppo =
    gruppoSpareggioAttuale || [];

  const sottotitolo =
    document.getElementById(
      "determinazione-sottotitolo"
    );

  if (sottotitolo) {
    if (gruppo.length > 1) {
      const nomi =
        gruppo
          .map(uid => {
            const g =
              ultimoStatoGiocatori.find(
                x => x.id === uid
              );

            return g
              ? g.nome
              : "Giocatore";
          })
          .join(", ");

      sottotitolo.textContent =
        "Pareggio! Nuovo spareggio tra: " +
        nomi;
    } else if (
      determinazioneTurnoUid === mioUid
    ) {
      sottotitolo.textContent =
        "È il tuo turno: tira i dadi!";
    } else {
      sottotitolo.textContent =
        "Aspetta che gli altri giocatori tirino.";
    }
  }

  const controlli =
    document.getElementById(
      "determinazione-controlli"
    );

  if (!controlli) return;

  controlli.innerHTML = "";

  if (
    determinazioneTurnoUid === mioUid &&
    !risultatiDeterminazione[mioUid]
  ) {
    const btn =
      document.createElement("button");

    btn.id =
      "btn-tira-determinazione";

    btn.textContent =
      "🎲 Tira i dadi";

    btn.style.border = "none";
    btn.style.borderRadius = "10px";
    btn.style.padding = "12px 22px";
    btn.style.background = "#ffd700";
    btn.style.color = "#000";
    btn.style.fontWeight = "bold";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "14px";

    btn.onclick =
      tiraDeterminazione;

    controlli.appendChild(btn);
  } else if (
    determinazioneTurnoUid
  ) {
    const attesa =
      document.createElement("div");

    attesa.textContent =
      "⏳ In attesa...";

    attesa.style.color =
      "#aaa";

    attesa.style.fontSize =
      "13px";

    controlli.appendChild(
      attesa
    );
  }
}

function apriDeterminazione(
  giocatori,
  turnoUid,
  risultati,
  gruppo
) {
  ultimoStatoGiocatori =
    Array.isArray(giocatori)
      ? giocatori
      : ultimoStatoGiocatori;

  determinazioneAttiva =
    true;

  determinazioneTurnoUid =
    turnoUid || null;

  risultatiDeterminazione =
    risultati || {};

  ordineDeterminazione =
    Array.isArray(
      giocatori
    )
      ? giocatori.map(g => g.id)
      : ordineDeterminazione;

  gruppoSpareggioAttuale =
    Array.isArray(gruppo)
      ? gruppo
      : [];

  aggiornaOverlayDeterminazione();

  fermaTimerDeterminazione();
}

function chiudiDeterminazione() {
  determinazioneAttiva =
    false;

  determinazioneTurnoUid =
    null;

  risultatiDeterminazione =
    {};

  gruppoSpareggioAttuale =
    [];

  fermaTimerDeterminazione();

  const overlay =
    document.getElementById(
      "overlay-determinazione"
    );

  if (overlay) {
    overlay.style.display =
      "none";
  }
}

function fermaTimerDeterminazione() {
  if (timerDeterminazione) {
    clearInterval(
      timerDeterminazione
    );

    timerDeterminazione =
      null;
  }

  scadenzaDeterminazione =
    null;
}

function avviaTimerDeterminazioneLocale(
  tempoInizio,
  durata
) {
  fermaTimerDeterminazione();

  if (!tempoInizio || !durata) {
    return;
  }

  scadenzaDeterminazione =
    Number(tempoInizio) +
    Number(durata);

  timerDeterminazione =
    setInterval(() => {
      if (
        !determinazioneAttiva
      ) {
        fermaTimerDeterminazione();
        return;
      }

      if (
        Date.now() >=
        scadenzaDeterminazione
      ) {
        aggiornaOverlayDeterminazione();
        return;
      }

      aggiornaOverlayDeterminazione();
    }, 250);
}

function tiraDeterminazione() {
  if (
    !determinazioneAttiva ||
    determinazioneTurnoUid !== mioUid
  ) {
    return;
  }

  if (
    risultatiDeterminazione[mioUid] != null
  ) {
    return;
  }

  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  const btn =
    document.getElementById(
      "btn-tira-determinazione"
    );

  if (btn) {
    btn.disabled =
      true;

    btn.style.opacity =
      ".5";

    btn.textContent =
      "🎲 Tiro in corso...";
  }

  socket.send(
    JSON.stringify({
      tipo: "tiraDeterminazione",
      partitaId
    })
  );
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
      .map(([x, y]) =>
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
  const d1 =
    document.getElementById("dado1");

  const d2 =
    document.getElementById("dado2");

  if (d1) {
    d1.innerHTML =
      creaFacciaDado(v1);
  }

  if (d2) {
    d2.innerHTML =
      creaFacciaDado(v2);
  }
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

  if (!dado1El || !dado2El) {
    if (callback) {
      callback();
    }

    return;
  }

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

        mostraDadi(
          vf1,
          vf2
        );

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

function mescolaColore(hex, target, p) {
  const num =
    parseInt(
      String(hex).replace("#", ""),
      16
    );

  let r = (num >> 16) & 255;
  let g = (num >> 8) & 255;
  let b = num & 255;

  r = Math.round(
    r + (target - r) * (p / 100)
  );

  g = Math.round(
    g + (target - g) * (p / 100)
  );

  b = Math.round(
    b + (target - b) * (p / 100)
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

// =========================================================
// TABELLONE / PEDINE
// =========================================================

function coordinatePerCasella(casellaNumero) {
  const immagine =
    document.getElementById(
      "immagine-tabellone"
    );

  if (!immagine) {
    return null;
  }

  const naturalWidth =
    immagine.naturalWidth || 1;

  const naturalHeight =
    immagine.naturalHeight || 1;

  const scaleX =
    immagine.clientWidth /
    naturalWidth;

  const scaleY =
    immagine.clientHeight /
    naturalHeight;

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
  const coord =
    coordinatePerCasella(
      casellaNumero
    );

  if (!coord) {
    return;
  }

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
      "pedina-" +
      idGiocatore
    );

  if (!pedina) {
    pedina =
      document.createElement("div");

    pedina.id =
      "pedina-" +
      idGiocatore;

    pedina.className =
      "pedina";

    const idGradiente =
      "gradPedina" +
      indice;

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

function animaSaltoPedina(
  idGiocatore,
  percorso,
  callback
) {
  if (
    !Array.isArray(percorso) ||
    percorso.length === 0
  ) {
    if (callback) {
      callback();
    }

    return;
  }

  const indice =
    ultimoStatoGiocatori.findIndex(
      g =>
        g.id === idGiocatore
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
    if (callback) {
      callback();
    }

    return;
  }

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

    const etichetta =
      document.getElementById(
        "casella-" +
        idGiocatore
      );

    if (etichetta) {
      etichetta.textContent =
        casella;
    }

    setTimeout(() => {
      pedina.classList.remove(
        "pedina-salta"
      );
    }, DURATA_SALTO_MS * 0.6);

    passo++;

    setTimeout(
      saltaProssimo,
      DURATA_SALTO_MS
    );
  }

  saltaProssimo();
}

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

  if (!listaPannello) {
    return;
  }

  listaPannello.innerHTML =
    "";

  ultimoStatoGiocatori.forEach(
    (giocatore, indice) => {
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
          giocatore.posizione
        );
      }

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
// TURNO / COUNTDOWN
// =========================================================

function aggiornaTurno(
  turnoDiId
) {
  turnoAttualeId =
    turnoDiId || null;

  mioTurno =
    turnoDiId === mioUid;

  const riga =
    document.getElementById(
      "riga-turno"
    );

  if (riga) {
    riga.textContent =
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
      !mioTurno
    );
  }
}

function aggiornaCountdownTurno(
  scadenzaTurno
) {
  scadenzaTurnoServer =
    scadenzaTurno
      ? Number(scadenzaTurno)
      : null;

  const riga =
    document.getElementById(
      "riga-turno"
    );

  if (!riga) {
    return;
  }

  clearInterval(
    timerTurno
  );

  if (
    !scadenzaTurnoServer ||
    !mioTurno
  ) {
    return;
  }

  timerTurno =
    setInterval(() => {
      const rimanente =
        Math.max(
          0,
          scadenzaTurnoServer -
            Date.now()
        );

      const secondi =
        Math.ceil(
          rimanente /
          1000
        );

      if (mioTurno) {
        riga.textContent =
          secondi > 0
            ? `🎲 È il tuo turno! (${secondi}s)`
            : "🎲 È il tuo turno! (0s)";
      }

      if (secondi <= 0) {
        clearInterval(
          timerTurno
        );
      }
    }, 200);
}

// =========================================================
// AVVIO
// =========================================================

async function avvia() {
  try {
    if (!partitaId) {
      console.error(
        "Partita non specificata nell'URL."
      );

      return;
    }

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

    mioUid =
      dati.uid;

    connetti();

  } catch (e) {
    console.error(
      "Errore avvio:",
      e
    );

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
          timerRiconnessione =
            null;

          connetti();
        }, 3000);
    }
  };

  socket.onerror = errore => {
    console.error(
      "WebSocket:",
      errore
    );
  };

  socket.onmessage = msg => {
    let dati;

    try {
      dati =
        JSON.parse(msg.data);
    } catch (e) {
      return;
    }

    // =====================================================
    // SESSIONE
    // =====================================================

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
    // MEDIA
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
    // CHI INIZIA
    // =====================================================

    if (
      dati.tipo ===
      "statoDeterminazione"
    ) {
      const giocatori =
        Array.isArray(
          dati.giocatori
        )
          ? dati.giocatori.map(g => ({
              id: g.uid,
              nome: g.nome,
              avatar: g.avatar || null,
              posizione: 0
            }))
          : [];

      ultimoStatoGiocatori =
        giocatori;

      risultatiDeterminazione =
        {};

      giocatori.forEach(g => {
        if (
          dati.risultato != null
        ) {
          risultatiDeterminazione[g.id] =
            dati.risultato;
        }
      });

      ordineDeterminazione =
        giocatori.map(
          g => g.id
        );

      determinazioneAttiva =
        true;

      determinazioneTurnoUid =
        dati.turnoInCorsoUid ||
        null;

      gruppoSpareggioAttuale =
        Array.isArray(
          dati.gruppoSpareggioAttuale
        )
          ? dati.gruppoSpareggioAttuale
          : [];

      apriDeterminazione(
        giocatori,
        determinazioneTurnoUid,
        risultatiDeterminazione,
        gruppoSpareggioAttuale
      );

      avviaTimerDeterminazioneLocale(
        dati.tempoInizioTurno,
        dati.durataMossaMs
      );

      disegnaGiocatori();

      return;
    }

    if (
      dati.tipo ===
      "risultatoDeterminazione"
    ) {
      risultatiDeterminazione[
        dati.uid
      ] =
        dati.valoreDado;

      const giocatore =
        ultimoStatoGiocatori.find(
          g =>
            g.id ===
            dati.uid
        );

      if (giocatore) {
        giocatore.posizione =
          0;
      }

      aggiornaOverlayDeterminazione();

      if (
        dati.uid === mioUid
      ) {
        const btn =
          document.getElementById(
            "btn-tira-determinazione"
          );

        if (btn) {
          btn.disabled =
            true;

          btn.style.opacity =
            ".5";

          btn.textContent =
            "🎲 Risultato registrato";
        }
      }

      const messaggi =
        document.getElementById(
          "messaggi-gioco"
        );

      if (messaggi) {
        messaggi.textContent =
          `${dati.nome}: 🎲 ${dati.valoreDado}`;
      }

      return;
    }

    if (
      dati.tipo ===
      "ordineFinaleCalcolato"
    ) {
      const sottotitolo =
        document.getElementById(
          "determinazione-sottotitolo"
        );

      if (sottotitolo) {
        sottotitolo.textContent =
          "Ordine deciso! La partita sta per iniziare...";
      }

      const lista =
        document.getElementById(
          "lista-determinazione"
        );

      if (lista) {
        lista.innerHTML = "";

        const ordine =
          Array.isArray(
            dati.ordineGiocatori
          )
            ? dati.ordineGiocatori
            : [];

        ordine.forEach(
          (nome, indice) => {
            const riga =
              document.createElement(
                "div"
              );

            riga.style.display =
              "flex";

            riga.style.alignItems =
              "center";

            riga.style.gap =
              "10px";

            riga.style.padding =
              "10px 12px";

            riga.style.marginBottom =
              "8px";

            riga.style.borderRadius =
              "10px";

            riga.style.background =
              "rgba(255,215,0,.08)";

            riga.innerHTML = `
              <strong
                style="
                  color:#ffd700;
                  width:24px;">
                ${indice + 1}
              </strong>

              <span
                style="
                  flex:1;
                  color:#eee;
                  font-weight:bold;">
                ${nome}
              </span>

              <span
                style="
                  color:#ffd700;
                  font-weight:bold;">
                ${dati.punteggi &&
                dati.punteggi[nome] != null
                  ? "🎲 " +
                    dati.punteggi[nome]
                  : ""}
              </span>
            `;

            lista.appendChild(
              riga
            );
          }
        );
      }

      return;
    }

    if (
      dati.tipo ===
      "determinazioneCompletata"
    ) {
      chiudiDeterminazione();

      partitaTerminata =
        false;

      ultimoStatoGiocatori =
        Array.isArray(
          dati.giocatori
        )
          ? dati.giocatori
          : ultimoStatoGiocatori;

      turnoAttualeId =
        dati.turnoDiId ||
        null;

      mioTurno =
        turnoAttualeId ===
        mioUid;

      aggiornaTurno(
        dati.turnoDiId
      );

      aggiornaCountdownTurno(
        dati.scadenzaTurno
      );

      disegnaGiocatori();

      if (
        dati.punteggiOrdineIniziale
      ) {
        const msg =
          document.getElementById(
            "messaggi-gioco"
          );

        if (msg) {
          msg.textContent =
            dati.primoMovimento &&
            dati.primoMovimento.messaggi
              ? dati.primoMovimento.messaggi.join(" ")
              : "🎲 Ordine deciso!";
        }
      }

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
        Array.isArray(
          dati.giocatori
        )
          ? dati.giocatori
          : [];

      partitaTerminata =
        !!dati.vittoria;

      if (
        dati.vittoria
      ) {
        turnoAttualeId =
          null;

        mioTurno =
          false;

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
          dati.turnoDiId
        );

        aggiornaCountdownTurno(
          dati.scadenzaTurno
        );

        disegnaGiocatori();
      }

      if (
        dati.messaggi &&
        dati.messaggi.length
      ) {
        const msg =
          document.getElementById(
            "messaggi-gioco"
          );

        if (msg) {
          msg.textContent =
            dati.messaggi.join(" ");
        }
      }

      return;
    }

    // =====================================================
    // AGGIORNAMENTO PARTITA / TIRO
    // =====================================================

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
              dati.idGiocatoreCheHaTirato,
              dati.percorso,
              () => {
                ultimoStatoGiocatori =
                  Array.isArray(
                    dati.giocatori
                  )
                    ? dati.giocatori
                    : [];

                const msg =
                  document.getElementById(
                    "messaggi-gioco"
                  );

                if (msg) {
                  msg.textContent =
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
                          dati.messaggi.join(" ")
                        : ""
                    );
                }

                if (
                  dati.vittoria
                ) {
                  turnoAttualeId =
                    null;

                  mioTurno =
                    false;

                  const areaDadi =
                    document.getElementById(
                      "area-dadi"
                    );

                  if (areaDadi) {
                    areaDadi.classList.add(
                      "disabilitato"
                    );
                  }

                  partitaTerminata =
                    true;

                  disegnaGiocatori();

                  mostraVittoria(
                    dati.vincitore
                  );
                } else {
                  aggiornaTurno(
                    null
                  );

                  disegnaGiocatori();
                }
              }
            );
          } else {
            ultimoStatoGiocatori =
              Array.isArray(
                dati.giocatori
              )
                ? dati.giocatori
                : [];

            const msg =
              document.getElementById(
                "messaggi-gioco"
              );

            if (msg) {
              msg.textContent =
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
                      dati.messaggi.join(" ")
                    : ""
                );
            }

            if (
              dati.vittoria
            ) {
              turnoAttualeId =
                null;

              mioTurno =
                false;

              const areaDadi =
                document.getElementById(
                  "area-dadi"
                );

              if (areaDadi) {
                areaDadi.classList.add(
                  "disabilitato"
                );
              }

              partitaTerminata =
                true;

              disegnaGiocatori();

              mostraVittoria(
                dati.vincitore
              );
            } else {
              aggiornaTurno(
                null
              );

              disegnaGiocatori();
            }
          }
        }
      );

      return;
    }

    // =====================================================
    // CHAT
    // =====================================================

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

    // =====================================================
    // ERRORI
    // =====================================================

    if (
      dati.tipo ===
      "errore"
    ) {
      console.error(
        "Errore server:",
        dati.messaggio
      );

      alert(
        dati.messaggio ||
        "Si è verificato un errore."
      );

      if (
        mioTurno
      ) {
        const areaDadi =
          document.getElementById(
            "area-dadi"
          );

        if (areaDadi) {
          areaDadi.classList.remove(
            "disabilitato"
          );
        }
      }

      return;
    }
  };
}

// =========================================================
// VITTORIA / USCITA
// =========================================================

function mostraVittoria(
  nomeVincitore
) {
  const testo =
    document.getElementById(
      "testo-vincitore"
    );

  if (testo) {
    testo.textContent =
      "🎉 Ha vinto " +
      (nomeVincitore || "un giocatore") +
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

function tornaAllaLobby() {
  chiudiTutteConnessioniMedia();

  if (socket) {
    try {
      socket.close();
    } catch (_) {}
  }

  window.location.href =
    `lobby.html?stanza=${encodeURIComponent(
      stanza || ""
    )}`;
}

function abbandonaPartita() {
  if (
    partitaTerminata
  ) {
    tornaAllaLobby();
    return;
  }

  if (
    !confirm(
      "Sei sicuro di voler abbandonare la partita?"
    )
  ) {
    return;
  }

  if (
    socket &&
    socket.readyState === WebSocket.OPEN
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

  setTimeout(() => {
    window.location.href =
      `lobby.html?stanza=${encodeURIComponent(
        stanza || ""
      )}`;
  }, 150);
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
  btnMenu.onclick = e => {
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
    (nome || "Giocatore") +
    ": ";

  const testoEl =
    document.createElement(
      "span"
    );

  testoEl.textContent =
    testo || "";

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
    socket.readyState === WebSocket.OPEN
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

  input.value =
    "";
}

const chatInput =
  document.getElementById(
    "chat-input"
  );

if (chatInput) {
  chatInput.addEventListener(
    "keypress",
    e => {
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
    e => {
      e.stopPropagation();

      const pannello =
        document.getElementById(
          "pannello-chat"
        );

      if (pannello) {
        pannello.classList.toggle(
          "nascosto"
        );
      }
    };
}

// =========================================================
// DADO
// =========================================================

const areaDadi =
  document.getElementById(
    "area-dadi"
  );

if (areaDadi) {
  areaDadi.onclick =
    () => {
      if (
        !mioTurno ||
        determinazioneAttiva ||
        partitaTerminata
      ) {
        return;
      }

      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      areaDadi.classList.add(
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
}

// =========================================================
// MICROFONO / WEBCAM
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
  () => {
    chiudiTutteConnessioniMedia();
  }
);

// =========================================================
// RESIZE TABELLONE
// =========================================================

window.addEventListener(
  "resize",
  () => {
    disegnaGiocatori();
  }
);

// =========================================================
// AVVIO INIZIALE
// =========================================================

creaOverlayDeterminazione();

mostraDadi(
  1,
  1
);

avvia();
