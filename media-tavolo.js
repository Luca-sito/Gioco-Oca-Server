"use strict";

const messaggiMedia = new Set(["mediaPronto", "webrtc-offer", "webrtc-answer", "webrtc-ice-candidate"]);

module.exports = function creaMediaTavolo(invia, configuraIce) {
  const connessioni = new WeakMap();

  function stato(presenti) {
    const partecipantiMedia = Array.from(presenti.values(), voce => voce.info).filter(Boolean);
    const messaggio = {
      tipo: "statoMedia",
      mediaAttiva: true,
      partecipanti: partecipantiMedia.map(info => info.uid),
      partecipantiMedia
    };
    for (const voce of presenti.values()) invia(voce.socket, messaggio);
  }

  function collega(partita, uid, socket, tipoDispositivo) {
    if (partita.mediaAttiva !== true || partita.fase !== "in_corso") {
      invia(socket, { tipo: "statoMedia", mediaAttiva: false });
      return;
    }
    let presenti = connessioni.get(partita);
    if (!presenti) {
      presenti = new Map();
      connessioni.set(partita, presenti);
    }
    const precedente = presenti.get(uid);
    if (precedente?.socket !== socket) {
      if (precedente) invia(precedente.socket, { tipo: "statoMedia", mediaAttiva: false });
      presenti.set(uid, { socket, tipoDispositivo, info: null });
    }
    invia(socket, { tipo: "configMedia", configurazioneIce: configuraIce() });
    stato(presenti);
  }

  function scollega(partita, uid, socket) {
    const presenti = connessioni.get(partita);
    if (!presenti || presenti.get(uid)?.socket !== socket) return;
    presenti.delete(uid);
    stato(presenti);
  }

  function chiudi(partita) {
    const presenti = connessioni.get(partita);
    if (!presenti) return;
    connessioni.delete(partita);
    for (const voce of presenti.values()) invia(voce.socket, { tipo: "statoMedia", mediaAttiva: false });
  }

  function gestisci(partita, uid, socket, dati) {
    if (partita?.mediaAttiva !== true || partita.fase !== "in_corso" || partita.giocatori?.[uid]?.socket !== socket) return;
    const presenti = connessioni.get(partita);
    const mittente = presenti?.get(uid);
    if (mittente?.socket !== socket) return;

    if (dati.tipo === "mediaPronto") {
      if (typeof dati.attivo !== "boolean") return;
      const tipoDispositivo = mittente.tipoDispositivo === "cellulare" || dati.tipoDispositivo === "cellulare"
        ? "cellulare" : mittente.tipoDispositivo === "tablet" || dati.tipoDispositivo === "tablet" ? "tablet" : "computer";
      mittente.info = dati.attivo ? {
        uid,
        tipoDispositivo,
        videoDisponibile: tipoDispositivo !== "cellulare" && dati.videoDisponibile !== false
      } : null;
      stato(presenti);
      return;
    }

    const destinatarioUid = dati.destinatarioUid;
    if (typeof destinatarioUid !== "string" || destinatarioUid === uid || !mittente.info) return;
    const destinatario = presenti.get(destinatarioUid);
    if (!destinatario?.info || partita.giocatori?.[destinatarioUid]?.socket !== destinatario.socket) return;

    if (dati.tipo === "webrtc-ice-candidate") {
      const candidato = dati.candidate;
      if (!candidato || typeof candidato.candidate !== "string" || JSON.stringify(candidato).length > 16 * 1024) return;
      invia(destinatario.socket, {
        tipo: dati.tipo,
        mittenteUid: uid,
        candidate: {
          candidate: candidato.candidate,
          sdpMid: typeof candidato.sdpMid === "string" ? candidato.sdpMid : null,
          sdpMLineIndex: Number.isInteger(candidato.sdpMLineIndex) ? candidato.sdpMLineIndex : null,
          usernameFragment: typeof candidato.usernameFragment === "string" ? candidato.usernameFragment : null
        }
      });
      return;
    }

    const tipoSdp = dati.tipo === "webrtc-offer" ? "offer" : "answer";
    if (dati.sdp?.type !== tipoSdp || typeof dati.sdp.sdp !== "string" || !dati.sdp.sdp || dati.sdp.sdp.length > 128 * 1024) return;
    invia(destinatario.socket, { tipo: dati.tipo, mittenteUid: uid, sdp: { type: tipoSdp, sdp: dati.sdp.sdp } });
  }

  return { accetta: tipo => messaggiMedia.has(tipo), collega, scollega, chiudi, gestisci };
};
