const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

// WebSocket collegato allo STESSO server HTTP (stessa porta, obbligatorio per Render)
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server Giochi Societa attivo!");
});

// STRUTTURA: ogni stanza ha giocatori online + più partite
let stanze = {
  BAR: { giocatoriOnline: {}, partite: {} },
  PUB: { giocatoriOnline: {}, partite: {} },
  DISCOPUB: { giocatoriOnline: {}, partite: {} },
  SERATE: { giocatoriOnline: {}, partite: {} }
};

let contatoreId = 0;

wss.on("connection", (socket) => {
  const socketId = "s" + (contatoreId++);
  let stanzaAttuale = null;
  let nickname = null;

  socket.on("message", (message) => {
    let dati = JSON.parse(message);

    // ENTRA IN UNA STANZA
    if (dati.tipo === "entraStanza") {
      stanzaAttuale = dati.stanza;
      nickname = dati.nome;

      if (!stanze[stanzaAttuale]) return;

      stanze[stanzaAttuale].giocatoriOnline[socketId] = nickname;

      inviaAllaStanza(stanzaAttuale, {
        tipo: "aggiornaOnline",
        giocatori: Object.values(stanze[stanzaAttuale].giocatoriOnline)
      });

      socket.send(JSON.stringify({
        tipo: "listaPartite",
        partite: Object.values(stanze[stanzaAttuale].partite)
      }));
    }

    // CREA UNA NUOVA PARTITA
    if (dati.tipo === "creaPartita") {
      if (!stanzaAttuale) return;

      const partitaId = "p" + Date.now() + Math.floor(Math.random() * 1000);
      const nuovaPartita = {
        id: partitaId,
        nomePartita: dati.nomePartita,
        maxGiocatori: dati.maxGiocatori,
        privata: dati.privata,
        chatAttiva: dati.chatAttiva,
        giocatori: { [socketId]: { nome: nickname, posizione: 0, socket } },
        creatoDa: socketId
      };

      stanze[stanzaAttuale].partite[partitaId] = nuovaPartita;
      inviaListaPartite(stanzaAttuale);
    }

    // UNISCITI A UNA PARTITA ESISTENTE
    if (dati.tipo === "unisciti") {
      if (!stanzaAttuale) return;
      const partita = stanze[stanzaAttuale].partite[dati.partitaId];
      if (!partita) return;

      const numAttuali = Object.keys(partita.giocatori).length;
      if (numAttuali >= partita.maxGiocatori) return; // piena

      partita.giocatori[socketId] = { nome: nickname, posizione: 0, socket };
      inviaListaPartite(stanzaAttuale);
    }

    // TIRO DEL DADO (dentro una partita specifica)
    if (dati.tipo === "dado") {
      if (!stanzaAttuale) return;
      const partita = stanze[stanzaAttuale].partite[dati.partitaId];
      if (!partita || !partita.giocatori[socketId]) return;

      const tiro = Math.floor(Math.random() * 6) + 1;
      partita.giocatori[socketId].posizione += tiro;

      const listaGiocatori = Object.values(partita.giocatori).map(g => ({
        nome: g.nome,
        posizione: g.posizione
      }));

      Object.values(partita.giocatori).forEach(g => {
        g.socket.send(JSON.stringify({
          tipo: "aggiornamentoPartita",
          giocatori: listaGiocatori,
          ultimoTiro: tiro
        }));
      });
    }
  });

  socket.on("close", () => {
    if (!stanzaAttuale) return;

    delete stanze[stanzaAttuale].giocatoriOnline[socketId];
    inviaAllaStanza(stanzaAttuale, {
      tipo: "aggiornaOnline",
      giocatori: Object.values(stanze[stanzaAttuale].giocatoriOnline)
    });

    // Rimuovi da eventuali partite, elimina partite vuote
    const partite = stanze[stanzaAttuale].partite;
    for (const pid in partite) {
      if (partite[pid].giocatori[socketId]) {
        delete partite[pid].giocatori[socketId];
        if (Object.keys(partite[pid].giocatori).length === 0) {
          delete partite[pid];
        }
      }
    }
    inviaListaPartite(stanzaAttuale);
  });
});

function inviaAllaStanza(nomeStanza, messaggio) {
  Object.keys(stanze[nomeStanza].giocatoriOnline).forEach(() => {});
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(messaggio));
    }
  });
}

function inviaListaPartite(nomeStanza) {
  const partiteSemplificate = Object.values(stanze[nomeStanza].partite).map(p => ({
    id: p.id,
    nomePartita: p.nomePartita,
    maxGiocatori: p.maxGiocatori,
    privata: p.privata,
    chatAttiva: p.chatAttiva,
    giocatori: Object.values(p.giocatori).map(g => g.nome)
  }));

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ tipo: "listaPartite", partite: partiteSemplificate }));
    }
  });
}

server.listen(PORT, () => {
  console.log("Server avviato sulla porta " + PORT);
});