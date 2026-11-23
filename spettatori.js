"use strict";

const MAX_SPETTATORI = 10;

module.exports = function creaSpettatori({ WebSocket, partitaContieneUtenteBloccato }) {
  const giochi = new Map();
  const gruppi = new WeakMap();
  const connessioni = new WeakMap();
  const ingressiInCorso = new WeakSet();

  function visibile(partita) {
    return partita?.modalita === "pubblica" &&
      (partita.fase === "in_corso" || partita.fase === "determinazione_ordine");
  }

  function manda(socket, pacchetto) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, "Connessione lenta");
      return;
    }
    socket.send(pacchetto);
  }

  function errore(socket, messaggio) {
    manda(socket, JSON.stringify({ tipo: "spettatore_errore", messaggio }));
  }

  function scheda(partita) {
    return {
      spettatoriDisponibili: visibile(partita),
      numSpettatori: gruppi.get(partita)?.size || 0,
      maxSpettatori: MAX_SPETTATORI
    };
  }

  async function entra(gioco, socket, uid, partitaId) {
    if (ingressiInCorso.has(socket) || connessioni.has(socket)) return;
    const adattatore = giochi.get(gioco);
    if (!adattatore || typeof partitaId !== "string" || !/^[a-zA-Z0-9_]{1,80}$/.test(partitaId)) {
      errore(socket, "Partita non disponibile.");
      return;
    }

    const trovato = adattatore.trova(partitaId);
    const partita = trovato?.partita;
    if (partita?.id !== partitaId || !visibile(partita)) {
      errore(socket, "Questa partita non è disponibile per gli spettatori.");
      return;
    }
    if (partita.giocatori?.[uid]) {
      errore(socket, "Fai già parte di questa partita. Usa Riprendi dalla lobby.");
      return;
    }

    ingressiInCorso.add(socket);
    try {
      if (await partitaContieneUtenteBloccato(partita, uid)) {
        errore(socket, "Non puoi guardare questa partita.");
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!visibile(partita) || adattatore.trova(partitaId)?.partita !== partita) {
        errore(socket, "La partita è terminata.");
        return;
      }
      if (partita.giocatori?.[uid]) {
        errore(socket, "Fai già parte di questa partita. Usa Riprendi dalla lobby.");
        return;
      }
      const gruppo = gruppi.get(partita) || new Map();
      const precedente = gruppo.get(uid);
      if (!precedente && gruppo.size >= MAX_SPETTATORI) {
        errore(socket, "Ci sono già 10 spettatori. Riprova quando si libera un posto.");
        return;
      }

      const stato = JSON.stringify(adattatore.stato(partita));
      const iscrizione = { socket, partita, uid, stanza: trovato.stanza, adattatore };
      connessioni.set(socket, iscrizione);
      gruppo.set(uid, iscrizione);
      gruppi.set(partita, gruppo);
      if (precedente) {
        connessioni.delete(precedente.socket);
        errore(precedente.socket, "Hai aperto questa partita in un'altra scheda.");
      }
      manda(socket, stato);
      if (!precedente) adattatore.aggiornaLobby(trovato.stanza);
    } catch (e) {
      console.error("Ingresso spettatore non riuscito:", e.message);
      errore(socket, "Impossibile guardare la partita. Riprova.");
    } finally {
      ingressiInCorso.delete(socket);
    }
  }

  function esci(socket) {
    const iscrizione = connessioni.get(socket);
    if (!iscrizione) return;
    connessioni.delete(socket);
    const { partita, uid, stanza, adattatore } = iscrizione;
    const gruppo = gruppi.get(partita);
    if (gruppo?.get(uid) !== iscrizione) return;
    gruppo.delete(uid);
    if (!gruppo.size) gruppi.delete(partita);
    adattatore.aggiornaLobby(stanza);
  }

  function pubblica(partita, evento) {
    const gruppo = gruppi.get(partita);
    if (!gruppo) return;
    const pacchetto = JSON.stringify(evento);
    for (const { socket } of gruppo.values()) manda(socket, pacchetto);
  }

  function termina(partita) {
    if (!gruppi.has(partita)) return;
    pubblica(partita, { tipo: "spettatore_fine" });
    for (const { socket } of gruppi.get(partita).values()) connessioni.delete(socket);
    gruppi.delete(partita);
  }

  // Ogni gioco espone solo lo stato pubblico della partita e il callback della lobby.
  return { registra: (gioco, adattatore) => giochi.set(gioco, adattatore), scheda, entra, esci, pubblica, termina };
};
