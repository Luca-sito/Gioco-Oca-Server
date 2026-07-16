const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

const CASELLE_AVANZA_ANCORA = [9, 18, 27, 36, 45, 54];
const CASELLE_SALTA_TRE_TURNI = [19, 31];
const CASELLE_SALTA_UN_TURNO = [52];
const CASELLE_TORNA_A = { 42: 38, 50: 1, 58: 1 };
const CASELLA_TIRA_ANCORA = 6;
const CASELLA_VITTORIA = 63;

let stanze = {
  BAR: { giocatoriOnline: {}, partite: {} },
  PUB: { giocatoriOnline: {}, partite: {} },
  DISCOPUB: { giocatoriOnline: {}, partite: {} },
  SERATE: { giocatoriOnline: {}, partite: {} }
};

let contatoreId = 0;
const socketsPerId = {};

function calcolaMovimento(posizioneAttuale, valoreDado) {
  let nuovaPosizione = posizioneAttuale + valoreDado;
  let messaggi = [];
  let turniDaSaltare = 0;
  let vittoria = false;
  let tiraAncora = false;

  if (nuovaPosizione > CASELLA_VITTORIA) {
    const eccesso = nuovaPosizione - CASELLA_VITTORIA;
    nuovaPosizione = CASELLA_VITTORIA - eccesso;
    messaggi.push("Hai superato il traguardo, rimbalzi indietro!");
  }

  if (nuovaPosizione === CASELLA_VITTORIA) {
    vittoria = true;
    messaggi.push("🎉 Hai vinto!");
    return { nuovaPosizione, messaggi, turniDaSaltare, vittoria, tiraAncora };
  }

  if (nuovaPosizione === CASELLA_TIRA_ANCORA) {
    tiraAncora = true;
    messaggi.push("Sali sul ponte! Tira ancora i dadi.");
  }

  if (CASELLE_AVANZA_ANCORA.includes(nuovaPosizione)) {
    messaggi.push("Avanzi dello stesso numero di caselle!");
    const r = calcolaMovimento(nuovaPosizione, valoreDado);
    return { nuovaPosizione: r.nuovaPosizione, messaggi: messaggi.concat(r.messaggi), turniDaSaltare: r.turniDaSaltare, vittoria: r.vittoria, tiraAncora: r.tiraAncora };
  }

  if (CASELLE_SALTA_TRE_TURNI.includes(nuovaPosizione)) {
    turniDaSaltare = 3;
    messaggi.push("Rimani fermo per 3 turni!");
  }

  if (CASELLE_SALTA_UN_TURNO.includes(nuovaPosizione)) {
    turniDaSaltare = 1;
    messaggi.push("Salti un turno!");
  }

  if (CASELLE_TORNA_A[nuovaPosizione] !== undefined) {
    const casellaFinale = CASELLE_TORNA_A[nuovaPosizione];
    messaggi.push(`Torni alla casella ${casellaFinale}!`);
    nuovaPosizione = casellaFinale;
  }

  return { nuovaPosizione, messaggi, turniDaSaltare, vittoria, tiraAncora };
}

function lanciaDueDadi() {
  return (Math.floor(Math.random() * 6) + 1) + (Math.floor(Math.random() * 6) + 1);
}

function determinaOrdineIniziale(idsGiocatori) {
  let risultati = idsGiocatori.map(id => ({ id, punteggio: lanciaDueDadi() }));
  risultati.sort((a, b) => b.punteggio - a.punteggio);

  let ordineFinale = [];
  let i = 0;
  while (i < risultati.length) {
    let gruppoPari = [risultati[i]];
    let j = i + 1;
    while (j < risultati.length && risultati[j].punteggio === risultati[i].punteggio) {
      gruppoPari.push(risultati[j]);
      j++;
    }
    if (gruppoPari.length > 1) {
      ordineFinale = ordineFinale.concat(determinaOrdineIniziale(gruppoPari.map(g => g.id)));
    } else {
      ordineFinale.push(gruppoPari[0].id);
    }
    i = j;
  }
  return ordineFinale;
}

function avviaPartitaAutomaticamente(partita) {
  const idsGiocatori = Object.keys(partita.giocatori);
  const ordineDeterminato = determinaOrdineIniziale(idsGiocatori);

  partita.ordineGiocatori = ordineDeterminato;
  partita.turnoAttuale = 0;
  partita.iniziata = true;

  const nomiInOrdine = ordineDeterminato.map(id => partita.giocatori[id].nome);

  Object.values(partita.giocatori).forEach(g => {
    if (g.socket && g.socket.readyState === WebSocket.OPEN) {
      g.socket.send(JSON.stringify({
        tipo: "partitaAvviata",
        partitaId: partita.id,
        ordineGiocatori: nomiInOrdine,
        turnoDiId: partita.ordineGiocatori[0]
      }));
    }
  });
}

function passaAlProssimoTurno(partita) {
  let tentativi = 0;
  do {
    partita.turnoAttuale = (partita.turnoAttuale + 1) % partita.ordineGiocatori.length;
    const idProssimo = partita.ordineGiocatori[partita.turnoAttuale];
    const giocatoreProssimo = partita.giocatori[idProssimo];
    if (giocatoreProssimo.turniSaltati > 0) {
      giocatoreProssimo.turniSaltati--;
      tentativi++;
    } else break;
  } while (tentativi < partita.ordineGiocatori.length);
}

function trovaPartita(partitaId) {
  for (const nomeStanza in stanze) {
    if (stanze[nomeStanza].partite[partitaId]) {
      return { partita: stanze[nomeStanza].partite[partitaId], nomeStanza };
    }
  }
  return null;
}

function inviaAllaStanza(nomeStanza, messaggio) {
  if (!stanze[nomeStanza]) return;
  Object.keys(stanze[nomeStanza].giocatoriOnline).forEach(id => {
    const s = socketsPerId[id];
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(messaggio));
  });
}

function inviaListaPartite(nomeStanza) {
  if (!stanze[nomeStanza]) return;
  const lista = Object.values(stanze[nomeStanza].partite).map(p => ({
    id: p.id, creatore: p.creatore, tempo: p.tempo, punti: p.punti,
    modalita: p.modalita, maxGiocatori: p.maxGiocatori,
    numGiocatoriAttuali: Object.keys(p.giocatori).length
  }));
  inviaAllaStanza(nomeStanza, { tipo: "listaPartite", partite: lista });
}

// Manda a TUTTI (anche a chi guarda la Home senza essere entrato in nessuna stanza)
// sia il conteggio che l'elenco nomi per ogni stanza.
function inviaConteggioStanze() {
  const conteggi = {};
  const giocatoriPerStanza = {};
  for (const nome in stanze) {
    const nomiGiocatori = Object.values(stanze[nome].giocatoriOnline);
    conteggi[nome] = nomiGiocatori.length;
    giocatoriPerStanza[nome] = nomiGiocatori;
  }
  const messaggio = JSON.stringify({
    tipo: "conteggioStanze",
    stanze: conteggi,
    giocatori: giocatoriPerStanza
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(messaggio);
  });
}

// ===== HEARTBEAT: rileva in fretta chi si disconnette senza chiudere "pulito" =====
const HEARTBEAT_MS = 15000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(socket => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeatInterval));

// ===== CONNESSIONI =====
wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });

  const socketId = "s" + (contatoreId++);
  socketsPerId[socketId] = socket;

  let stanzaAttuale = null;
  let nickname = null;
  let giocatoreIdAttuale = null;

  socket.on("message", (message) => {
    try {
      let dati;
      try { dati = JSON.parse(message); } catch (e) { return; }

      if (dati.tipo === "richiediConteggio") {
        inviaConteggioStanze();
        return;
      }

      if (dati.tipo === "entraLobby") {
        if (!dati.stanza) return;
        stanzaAttuale = dati.stanza;
        nickname = dati.nome || "Giocatore";
        giocatoreIdAttuale = dati.giocatoreId || null;

        if (!stanze[stanzaAttuale]) stanze[stanzaAttuale] = { giocatoriOnline: {}, partite: {} };
        stanze[stanzaAttuale].giocatoriOnline[socketId] = nickname;

        inviaConteggioStanze();
        inviaAllaStanza(stanzaAttuale, { tipo: "online", numero: Object.keys(stanze[stanzaAttuale].giocatoriOnline).length });
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "riprendiPartita") {
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Partita non trovata." })); return; }
        const { partita, nomeStanza } = trovato;
        stanzaAttuale = nomeStanza;
        nickname = dati.nome;
        giocatoreIdAttuale = dati.giocatoreId;

        const mioGiocatore = partita.giocatori[giocatoreIdAttuale];
        if (!mioGiocatore) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non fai parte di questa partita." }));
          return;
        }
        mioGiocatore.socket = socket;
        mioGiocatore.nome = nickname;

        const statoGiocatori = partita.ordineGiocatori.map(id => ({
          id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione
        }));

        socket.send(JSON.stringify({
          tipo: "statoPartita",
          giocatori: statoGiocatori,
          turnoDiId: partita.ordineGiocatori[partita.turnoAttuale]
        }));
        return;
      }

      if (dati.tipo === "creaPartita") {
        if (!stanzaAttuale) return;
        giocatoreIdAttuale = dati.giocatoreId;
        if (!giocatoreIdAttuale) return;

        const haGiaCreato = Object.values(stanze[stanzaAttuale].partite).some(p => p.creatoDa === giocatoreIdAttuale);
        if (haGiaCreato) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Hai già una partita attiva." }));
          return;
        }

        const partitaId = "p" + Date.now() + Math.floor(Math.random() * 1000);
        stanze[stanzaAttuale].partite[partitaId] = {
          id: partitaId,
          creatore: nickname,
          creatoDa: giocatoreIdAttuale,
          tempo: dati.tempo,
          punti: dati.punti,
          modalita: dati.modalita,
          codicePrivato: dati.modalita === "privata" ? dati.codicePrivato : null,
          maxGiocatori: parseInt(dati.maxGiocatori) || 2,
          giocatori: { [giocatoreIdAttuale]: { nome: nickname, posizione: 0, socket, turniSaltati: 0 } },
          ordineGiocatori: [giocatoreIdAttuale],
          turnoAttuale: 0,
          iniziata: false
        };
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "entraPartita") {
        if (!stanzaAttuale) return;
        giocatoreIdAttuale = dati.giocatoreId;
        if (!giocatoreIdAttuale) return;

        const partita = stanze[stanzaAttuale].partite[dati.id];
        if (!partita) return;
        if (partita.giocatori[giocatoreIdAttuale]) return;
        if (Object.keys(partita.giocatori).length >= partita.maxGiocatori) return;

        if (partita.modalita === "privata" && dati.codicePrivato !== partita.codicePrivato) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Codice partita non corretto." }));
          return;
        }

        partita.giocatori[giocatoreIdAttuale] = { nome: nickname, posizione: 0, socket, turniSaltati: 0 };
        partita.ordineGiocatori.push(giocatoreIdAttuale);
        inviaListaPartite(stanzaAttuale);

        if (Object.keys(partita.giocatori).length === partita.maxGiocatori) {
          avviaPartitaAutomaticamente(partita);
        }
        return;
      }

      if (dati.tipo === "eliminaPartita") {
        if (!stanzaAttuale) return;
        const idGiocatore = dati.giocatoreId || giocatoreIdAttuale;
        const partite = stanze[stanzaAttuale].partite;
        const idDaEliminare = Object.keys(partite).find(pid => partite[pid].creatoDa === idGiocatore);
        if (!idDaEliminare) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non hai nessuna partita da eliminare." }));
          return;
        }
        delete partite[idDaEliminare];
        inviaListaPartite(stanzaAttuale);
        return;
      }

      if (dati.tipo === "chat") {
        if (!stanzaAttuale) return;
        inviaAllaStanza(stanzaAttuale, { tipo: "chat", nome: nickname, testo: dati.testo });
        return;
      }

      if (dati.tipo === "chatPartita") {
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const partita = trovato.partita;
        const mittente = partita.giocatori[dati.giocatoreId];
        if (!mittente) return;
        Object.values(partita.giocatori).forEach(g => {
          if (g.socket && g.socket.readyState === WebSocket.OPEN) {
            g.socket.send(JSON.stringify({ tipo: "chatPartita", nome: mittente.nome, testo: dati.testo }));
          }
        });
        return;
      }

      if (dati.tipo === "tiraDadi") {
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const partita = trovato.partita;

        const idDiTurno = partita.ordineGiocatori[partita.turnoAttuale];
        if (idDiTurno !== dati.giocatoreId) {
          socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è il tuo turno!" }));
          return;
        }

        const dado1 = Math.floor(Math.random() * 6) + 1;
        const dado2 = Math.floor(Math.random() * 6) + 1;
        const valoreDado = dado1 + dado2;

        const giocatore = partita.giocatori[dati.giocatoreId];
        const risultato = calcolaMovimento(giocatore.posizione, valoreDado);
        giocatore.posizione = risultato.nuovaPosizione;
        if (risultato.turniDaSaltare > 0) giocatore.turniSaltati = risultato.turniDaSaltare;
        if (!risultato.tiraAncora && !risultato.vittoria) passaAlProssimoTurno(partita);

        const statoGiocatori = partita.ordineGiocatori.map(id => ({
          id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione
        }));
        const idProssimo = partita.ordineGiocatori[partita.turnoAttuale];

        Object.values(partita.giocatori).forEach(g => {
          if (g.socket && g.socket.readyState === WebSocket.OPEN) {
            g.socket.send(JSON.stringify({
              tipo: "aggiornamentoPartita", giocatori: statoGiocatori, dado1, dado2, valoreDado,
              messaggi: risultato.messaggi, turnoDiId: idProssimo,
              vittoria: risultato.vittoria, vincitore: risultato.vittoria ? giocatore.nome : null
            }));
          }
        });
        return;
      }

      if (dati.tipo === "abbandonaPartita") {
        const trovato = trovaPartita(dati.partitaId);
        if (!trovato) return;
        const { partita, nomeStanza } = trovato;
        const idUscente = dati.giocatoreId;
        if (!partita.giocatori[idUscente]) return;

        const nomeUscente = partita.giocatori[idUscente].nome;
        delete partita.giocatori[idUscente];
        partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== idUscente);

        const restanti = Object.keys(partita.giocatori);

        if (restanti.length === 0) {
          delete stanze[nomeStanza].partite[partita.id];
          inviaListaPartite(nomeStanza);
          return;
        }

        if (partita.turnoAttuale >= partita.ordineGiocatori.length) {
          partita.turnoAttuale = 0;
        }

        if (restanti.length === 1 && partita.iniziata) {
          const vincitoreId = restanti[0];
          const vincitoreNome = partita.giocatori[vincitoreId].nome;
          const statoGiocatori = partita.ordineGiocatori.map(id => ({
            id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione
          }));
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({
                tipo: "statoPartita", giocatori: statoGiocatori,
                turnoDiId: vincitoreId, vittoria: true, vincitore: vincitoreNome,
                messaggi: [nomeUscente + " ha abbandonato la partita."]
              }));
            }
          });
          delete stanze[nomeStanza].partite[partita.id];
        } else {
          const idAttuale = partita.ordineGiocatori[partita.turnoAttuale];
          const statoGiocatori = partita.ordineGiocatori.map(id => ({
            id, nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione
          }));
          Object.values(partita.giocatori).forEach(g => {
            if (g.socket && g.socket.readyState === WebSocket.OPEN) {
              g.socket.send(JSON.stringify({
                tipo: "statoPartita", giocatori: statoGiocatori, turnoDiId: idAttuale,
                messaggi: [nomeUscente + " ha abbandonato la partita."]
              }));
            }
          });
        }

        inviaListaPartite(nomeStanza);
        return;
      }

    } catch (erroreInterno) {
      console.error("Errore nella gestione di un messaggio:", erroreInterno);
    }
  });

  socket.on("close", () => {
    try {
      delete socketsPerId[socketId];
      if (!stanzaAttuale || !stanze[stanzaAttuale]) return;

      delete stanze[stanzaAttuale].giocatoriOnline[socketId];
      inviaConteggioStanze();
      inviaAllaStanza(stanzaAttuale, { tipo: "online", numero: Object.keys(stanze[stanzaAttuale].giocatoriOnline).length });

      const partite = stanze[stanzaAttuale].partite;
      for (const pid in partite) {
        const partita = partite[pid];
        if (giocatoreIdAttuale && partita.giocatori[giocatoreIdAttuale] && !partita.iniziata) {
          delete partita.giocatori[giocatoreIdAttuale];
          partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== giocatoreIdAttuale);
          if (Object.keys(partita.giocatori).length === 0) delete partite[pid];
        }
      }
      inviaListaPartite(stanzaAttuale);
    } catch (erroreInterno) {
      console.error("Errore nella chiusura di una connessione:", erroreInterno);
    }
  });
});

server.listen(PORT, () => console.log("Server avviato sulla porta " + PORT));
