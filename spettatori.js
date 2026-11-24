"use strict";

const MAX_SPETTATORI = 10;

module.exports = function creaSpettatori({ WebSocket, partitaContieneUtenteBloccato, leggiPreferenza }) {
  const giochi = new Map();
  const gruppi = new WeakMap();
  const connessioni = new WeakMap();
  const ingressiInCorso = new WeakSet();
  const preferenzePartita = new WeakMap();
  const schedeInAttesa = new WeakSet();

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

  function regoleDellaPartita(partita) {
    if (!preferenzePartita.has(partita)) {
      preferenzePartita.set(partita, { regole: new Map(), inLettura: new Map() });
    }
    return preferenzePartita.get(partita);
  }

  function caricaPreferenze(partita) {
    const { regole, inLettura } = regoleDellaPartita(partita);
    const richieste = [];
    for (const uid of Object.keys(partita.giocatori)) {
      if (regole.has(uid)) continue;
      if (!inLettura.has(uid)) {
        const richiesta = leggiPreferenza(uid).then(preferenza => {
          if (inLettura.get(uid) === richiesta) regole.set(uid, preferenza);
        }).finally(() => {
          if (inLettura.get(uid) === richiesta) inLettura.delete(uid);
        });
        inLettura.set(uid, richiesta);
      }
      richieste.push(inLettura.get(uid));
    }
    return richieste.length ? Promise.all(richieste) : null;
  }

  function puoGuardare(partita, uid) {
    if (!uid || !visibile(partita) || partita.giocatori?.[uid]) return false;
    const regole = preferenzePartita.get(partita)?.regole;
    return Object.keys(partita.giocatori).every(giocatore => {
      const preferenza = regole?.get(giocatore);
      return preferenza?.modalita === "si" ||
        (preferenza?.modalita === "eccetto" && preferenza.eccezioni.has(uid));
    });
  }

  function scheda(partita, uid) {
    return {
      spettatoriDisponibili: puoGuardare(partita, uid),
      numSpettatori: gruppi.get(partita)?.size || 0,
      maxSpettatori: MAX_SPETTATORI
    };
  }

  function inviaLista(partite, presenze, serializza, invia, aggiornaLobby) {
    const destinatari = Object.entries(presenze || {});
    if (!destinatari.length) return;
    const schede = partite.map(partita => {
      if (visibile(partita) && !schedeInAttesa.has(partita)) {
        const lettura = caricaPreferenze(partita);
        if (lettura) {
          schedeInAttesa.add(partita);
          lettura.then(() => {
            schedeInAttesa.delete(partita);
            if (visibile(partita)) aggiornaLobby();
          }).catch(e => {
            schedeInAttesa.delete(partita);
            console.error("Preferenze spettatori non disponibili:", e.message);
          });
        }
      }
      return serializza(partita);
    });
    for (const [socketId, presenza] of destinatari) {
      invia(socketId, {
        tipo: "listaPartite",
        partite: schede.map((dati, indice) => ({ ...dati, ...scheda(partite[indice], presenza.uid) }))
      });
    }
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
      const [bloccato] = await Promise.all([partitaContieneUtenteBloccato(partita, uid), caricaPreferenze(partita)]);
      if (bloccato) {
        errore(socket, "Non puoi guardare questa partita.");
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!visibile(partita) || adattatore.trova(partitaId)?.partita !== partita) {
        errore(socket, "La partita è terminata.");
        return;
      }
      if (!puoGuardare(partita, uid)) {
        errore(socket, "Questa partita non è disponibile per gli spettatori.");
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

  function esci(socket, notificaLobby = true) {
    const iscrizione = connessioni.get(socket);
    if (!iscrizione) return;
    connessioni.delete(socket);
    const { partita, uid, stanza, adattatore } = iscrizione;
    const gruppo = gruppi.get(partita);
    if (gruppo?.get(uid) !== iscrizione) return;
    gruppo.delete(uid);
    if (!gruppo.size) gruppi.delete(partita);
    if (notificaLobby) adattatore.aggiornaLobby(stanza);
  }

  function aggiornaPreferenza(uid, preferenza) {
    for (const adattatore of giochi.values()) {
      const stanze = new Set();
      for (const { partita, stanza } of adattatore.partiteDelGiocatore(uid)) {
        if (!visibile(partita)) continue;
        const { regole, inLettura } = regoleDellaPartita(partita);
        regole.set(uid, preferenza);
        inLettura.delete(uid);
        for (const iscrizione of gruppi.get(partita)?.values() || []) {
          if (puoGuardare(partita, iscrizione.uid)) continue;
          esci(iscrizione.socket, false);
          errore(iscrizione.socket, "Le preferenze dei giocatori non ti consentono più di guardare questa partita.");
        }
        stanze.add(stanza);
      }
      for (const stanza of stanze) adattatore.aggiornaLobby(stanza);
    }
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

  return { registra: (gioco, adattatore) => giochi.set(gioco, adattatore), inviaLista, aggiornaPreferenza, entra, esci, pubblica, termina };
};
