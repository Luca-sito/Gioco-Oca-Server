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
      return {
        partita: stanze[nomeStanza].partite[partitaId],
        nomeStanza
      };
    }
  }

  return null;
}


function inviaConteggioStanze() {

  const conteggi = {};

  for (const nome in stanze) {

    conteggi[nome] =
      Object.keys(stanze[nome].giocatoriOnline).length;

  }


  const messaggio = JSON.stringify({
    tipo: "conteggioStanze",
    stanze: conteggi
  });


  wss.clients.forEach(client => {

    if (client.readyState === WebSocket.OPEN) {

      client.send(messaggio);

    }

  });

}



wss.on("connection", (socket) => {

  socket.isAlive = true;

  socket.on("pong", () => {
    socket.isAlive = true;
  });


  const socketId = "s" + (contatoreId++);
  socketsPerId[socketId] = socket;

  let stanzaAttuale = null;
  let nickname = null;



  socket.on("message", (message) => {


    let dati;

    try {

      dati = JSON.parse(message);

    } catch(e) {

      return;

    }



    // INVIA IL CONTEGGIO QUANDO UNA PAGINA SI COLLEGA

    if (dati.tipo === "richiediConteggio") {

      inviaConteggioStanze();

      return;

    }




    // ENTRATA IN UNA STANZA

    if (dati.tipo === "entra") {


      if (!dati.stanza || !stanze[dati.stanza]) {


        socket.send(JSON.stringify({

          tipo:"errore",

          messaggio:"Stanza inesistente"

        }));

        return;

      }



      stanzaAttuale = dati.stanza;

      nickname = dati.nome;



      stanze[stanzaAttuale].giocatoriOnline[socketId] = nickname;



      // aggiorna tutti i giocatori online

      inviaConteggioStanze();



      inviaAllaStanza(

        stanzaAttuale,

        {

          tipo:"online",

          numero:Object.keys(
            stanze[stanzaAttuale].giocatoriOnline
          ).length

        }

      );


      return;

    }

    if (dati.tipo === "riprendiPartita") {
      const trovato = trovaPartita(dati.partitaId);
      if (!trovato) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Partita non trovata." })); return; }
      const { partita, nomeStanza } = trovato;
      stanzaAttuale = nomeStanza;
      nickname = dati.nome;

      const idEsistente = Object.keys(partita.giocatori).find(id => partita.giocatori[id].nome === dati.nome);
      if (idEsistente) partita.giocatori[idEsistente].socket = socket;

      const statoGiocatori = partita.ordineGiocatori.map(id => ({ nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione }));

      socket.send(JSON.stringify({
        tipo: "statoPartita",
        giocatori: statoGiocatori,
        turnoDiNome: partita.giocatori[partita.ordineGiocatori[partita.turnoAttuale]].nome,
        mioNome: dati.nome
      }));
    }

    if (dati.tipo === "creaPartita") {
      if (!stanzaAttuale) return;
      const haGiaCreato = Object.values(stanze[stanzaAttuale].partite).some(p => p.creatoDa === socketId);
      if (haGiaCreato) {
        socket.send(JSON.stringify({ tipo: "errore", messaggio: "Hai già una partita attiva." }));
        return;
      }

      const partitaId = "p" + Date.now() + Math.floor(Math.random() * 1000);
      stanze[stanzaAttuale].partite[partitaId] = {
        id: partitaId,
        creatore: nickname,
        creatoDa: socketId,
        tempo: dati.tempo,
        punti: dati.punti,
        modalita: dati.modalita,
        maxGiocatori: parseInt(dati.maxGiocatori) || 2,
        giocatori: { [socketId]: { nome: nickname, posizione: 0, socket, turniSaltati: 0 } },
        ordineGiocatori: [socketId],
        turnoAttuale: 0,
        iniziata: false
      };
      inviaListaPartite(stanzaAttuale);
    }


    if (dati.tipo === "entraPartita") {
      if (!stanzaAttuale) return;
      const partita = stanze[stanzaAttuale].partite[dati.id];
      if (!partita) return;
      if (Object.keys(partita.giocatori).length >= partita.maxGiocatori) return;

      partita.giocatori[socketId] = { nome: nickname, posizione: 0, socket, turniSaltati: 0 };
      partita.ordineGiocatori.push(socketId);
      inviaListaPartite(stanzaAttuale);

      if (Object.keys(partita.giocatori).length === partita.maxGiocatori) {
        avviaPartitaAutomaticamente(partita);
      }
    }

    if (dati.tipo === "chat") {
      if (!stanzaAttuale) return;
      inviaAllaStanza(stanzaAttuale, { tipo: "chat", nome: nickname, testo: dati.testo });
    }

    if (dati.tipo === "tiraDadi") {
      const trovato = trovaPartita(dati.partitaId);
      if (!trovato) return;
      const partita = trovato.partita;

      const idDiTurno = partita.ordineGiocatori[partita.turnoAttuale];
      const idMio = Object.keys(partita.giocatori).find(id => partita.giocatori[id].nome === nickname);
      if (idDiTurno !== idMio) { socket.send(JSON.stringify({ tipo: "errore", messaggio: "Non è il tuo turno!" })); return; }

      const dado1 = Math.floor(Math.random() * 6) + 1;
      const dado2 = Math.floor(Math.random() * 6) + 1;
      const valoreDado = dado1 + dado2;

      const giocatore = partita.giocatori[idMio];
      const risultato = calcolaMovimento(giocatore.posizione, valoreDado);
      giocatore.posizione = risultato.nuovaPosizione;
      if (risultato.turniDaSaltare > 0) giocatore.turniSaltati = risultato.turniDaSaltare;
      if (!risultato.tiraAncora && !risultato.vittoria) passaAlProssimoTurno(partita);

      const statoGiocatori = partita.ordineGiocatori.map(id => ({ nome: partita.giocatori[id].nome, posizione: partita.giocatori[id].posizione }));
      const prossimoNome = partita.giocatori[partita.ordineGiocatori[partita.turnoAttuale]].nome;

      Object.values(partita.giocatori).forEach(g => {
        if (g.socket && g.socket.readyState === WebSocket.OPEN) {
          g.socket.send(JSON.stringify({
            tipo: "aggiornamentoPartita", giocatori: statoGiocatori, dado1, dado2, valoreDado,
            messaggi: risultato.messaggi, turnoDiNome: prossimoNome,
            vittoria: risultato.vittoria, vincitore: risultato.vittoria ? giocatore.nome : null
          }));
        }
      });
    }
  });

  socket.on("close", () => {
    delete socketsPerId[socketId];
    if (!stanzaAttuale || !stanze[stanzaAttuale]) return;

    delete stanze[stanzaAttuale].giocatoriOnline[socketId];
    inviaConteggioStanze();
    inviaAllaStanza(stanzaAttuale, { tipo: "online", numero: Object.keys(stanze[stanzaAttuale].giocatoriOnline).length });

    const partite = stanze[stanzaAttuale].partite;
    for (const pid in partite) {
      const partita = partite[pid];
      if (!partita.giocatori[socketId]) continue;
      if (!partita.iniziata) {
        delete partita.giocatori[socketId];
        partita.ordineGiocatori = partita.ordineGiocatori.filter(id => id !== socketId);
        if (Object.keys(partita.giocatori).length === 0) delete partite[pid];
      }
    }
    inviaListaPartite(stanzaAttuale);
  });
});

function inviaAllaStanza(nomeStanza, messaggio) {
  Object.keys(stanze[nomeStanza].giocatoriOnline).forEach(id => {
    const s = socketsPerId[id];
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(messaggio));
  });
}

function inviaListaPartite(nomeStanza) {
  const lista = Object.values(stanze[nomeStanza].partite).map(p => ({
    id: p.id, creatore: p.creatore, tempo: p.tempo, punti: p.punti,
    modalita: p.modalita, maxGiocatori: p.maxGiocatori, numGiocatoriAttuali: Object.keys(p.giocatori).length
  }));
  inviaAllaStanza(nomeStanza, { tipo: "listaPartite", partite: lista });
}

server.listen(PORT, () => console.log("Server avviato sulla porta " + PORT));
