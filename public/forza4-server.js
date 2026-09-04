// forza4-server.js
// Modulo server per Forza 4 (Connect Four), completamente separato dagli
// altri giochi del sito (es. Gioco dell'Oca): usa un path WebSocket dedicato
// e non condivide stato, stanze o eventi con nessun altro modulo.
//
// Richiede il pacchetto "ws" (lo stesso già in uso per gli altri giochi).

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const RIGHE = 6;
const COLONNE = 7;
const HEARTBEAT_INTERVAL_MS = 30000;

function creaGrigliaVuota() {
  return Array.from({ length: RIGHE }, () => Array(COLONNE).fill(null));
}

function generaCodiceStanza() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // esclusi caratteri ambigui (I, O, 0, 1)
  let codice = "";
  for (let i = 0; i < 5; i++) {
    codice += alfabeto[crypto.randomInt(alfabeto.length)];
  }
  return codice;
}

function trovaRigaLibera(griglia, colonna) {
  for (let riga = RIGHE - 1; riga >= 0; riga--) {
    if (griglia[riga][colonna] === null) return riga;
  }
  return -1;
}

function controllaVittoria(griglia, riga, colonna, colore) {
  const direzioniOpposte = [
    [
      [0, 1],
      [0, -1],
    ], // orizzontale
    [
      [1, 0],
      [-1, 0],
    ], // verticale
    [
      [1, 1],
      [-1, -1],
    ], // diagonale \
    [
      [1, -1],
      [-1, 1],
    ], // diagonale /
  ];

  for (const coppia of direzioniOpposte) {
    const cellule = [[riga, colonna]];
    for (const [dr, dc] of coppia) {
      let r = riga + dr;
      let c = colonna + dc;
      while (r >= 0 && r < RIGHE && c >= 0 && c < COLONNE && griglia[r][c] === colore) {
        cellule.push([r, c]);
        r += dr;
        c += dc;
      }
    }
    if (cellule.length >= 4) return cellule;
  }
  return null;
}

function grigliaPiena(griglia) {
  return griglia.every((riga) => riga.every((cella) => cella !== null));
}

class GestoreForza4 {
  constructor() {
    this.stanze = new Map(); // codice -> stato stanza
    this.giocatoreStanza = new Map(); // giocatoreId -> codice stanza
  }

  creaStanza(ws, giocatoreId) {
    if (!giocatoreId) return;
    this._rimuoviDaStanzaPrecedente(giocatoreId);

    let codice;
    do {
      codice = generaCodiceStanza();
    } while (this.stanze.has(codice));

    const stanza = {
      codice,
      griglia: creaGrigliaVuota(),
      turno: "rosso",
      stato: "in_attesa", // in_attesa | in_corso | vittoria | pareggio
      giocatori: {
        rosso: { ws, giocatoreId, connesso: true },
        giallo: null,
      },
    };

    this.stanze.set(codice, stanza);
    this.giocatoreStanza.set(giocatoreId, codice);
    ws.forza4 = { codice, colore: "rosso", giocatoreId };

    this._invia(ws, { type: "stanza_creata", codice, giocatore: "rosso" });
  }

  entraStanza(ws, giocatoreId, codiceGrezzo) {
    if (!giocatoreId) return;
    const codice = (codiceGrezzo || "").toUpperCase().trim();
    const stanza = this.stanze.get(codice);

    if (!stanza) {
      this._invia(ws, { type: "errore", messaggio: "Stanza non trovata." });
      return;
    }

    // riconnessione: lo stesso giocatoreId è già seduto in questa stanza
    for (const colore of ["rosso", "giallo"]) {
      const giocatore = stanza.giocatori[colore];
      if (giocatore && giocatore.giocatoreId === giocatoreId) {
        giocatore.ws = ws;
        giocatore.connesso = true;
        ws.forza4 = { codice, colore, giocatoreId };
        this._invia(ws, { type: "stanza_unita", codice, giocatore: colore });
        this._invia(ws, this._statoPartitaMsg(stanza));
        this._trasmettiAAltro(stanza, colore, { type: "avversario_riconnesso" });
        return;
      }
    }

    if (stanza.giocatori.rosso && stanza.giocatori.giallo) {
      this._invia(ws, { type: "errore", messaggio: "La stanza è già piena." });
      return;
    }

    this._rimuoviDaStanzaPrecedente(giocatoreId);

    stanza.giocatori.giallo = { ws, giocatoreId, connesso: true };
    stanza.stato = "in_corso";
    this.giocatoreStanza.set(giocatoreId, codice);
    ws.forza4 = { codice, colore: "giallo", giocatoreId };

    this._invia(ws, { type: "stanza_unita", codice, giocatore: "giallo" });
    this._trasmetti(stanza, { type: "avversario_connesso" });
    this._trasmetti(stanza, this._statoPartitaMsg(stanza));
  }

  inserisciGettone(ws, colonna) {
    const info = ws.forza4;
    if (!info) return;
    const stanza = this.stanze.get(info.codice);
    if (!stanza || stanza.stato !== "in_corso") return;
    if (stanza.turno !== info.colore) return;
    if (typeof colonna !== "number" || colonna < 0 || colonna >= COLONNE) return;

    const riga = trovaRigaLibera(stanza.griglia, colonna);
    if (riga === -1) return; // colonna piena

    stanza.griglia[riga][colonna] = info.colore;

    const celleVincenti = controllaVittoria(stanza.griglia, riga, colonna, info.colore);

    if (celleVincenti) {
      stanza.stato = "vittoria";
      this._trasmetti(stanza, {
        type: "partita_finita",
        vincitore: info.colore,
        celleVincenti,
        griglia: stanza.griglia,
        ultimaMossa: { riga, colonna },
      });
      return;
    }

    if (grigliaPiena(stanza.griglia)) {
      stanza.stato = "pareggio";
      this._trasmetti(stanza, {
        type: "partita_finita",
        vincitore: null,
        celleVincenti: null,
        griglia: stanza.griglia,
        ultimaMossa: { riga, colonna },
      });
      return;
    }

    stanza.turno = stanza.turno === "rosso" ? "giallo" : "rosso";
    this._trasmetti(stanza, {
      ...this._statoPartitaMsg(stanza),
      ultimaMossa: { riga, colonna },
    });
  }

  nuovaPartita(ws) {
    const info = ws.forza4;
    if (!info) return;
    const stanza = this.stanze.get(info.codice);
    if (!stanza || !stanza.giocatori.rosso || !stanza.giocatori.giallo) return;

    stanza.griglia = creaGrigliaVuota();
    stanza.turno = "rosso";
    stanza.stato = "in_corso";
    this._trasmetti(stanza, this._statoPartitaMsg(stanza));
  }

  gestisciDisconnessione(ws) {
    const info = ws.forza4;
    if (!info) return;
    const stanza = this.stanze.get(info.codice);
    if (!stanza) return;

    const giocatore = stanza.giocatori[info.colore];
    if (giocatore && giocatore.ws === ws) {
      giocatore.connesso = false;
      this._trasmettiAAltro(stanza, info.colore, { type: "avversario_disconnesso" });
    }

    const rossoOff = !stanza.giocatori.rosso || !stanza.giocatori.rosso.connesso;
    const gialloOff = !stanza.giocatori.giallo || !stanza.giocatori.giallo.connesso;
    if (rossoOff && gialloOff) {
      this.stanze.delete(info.codice);
    }
  }

  _rimuoviDaStanzaPrecedente(giocatoreId) {
    const codicePrecedente = this.giocatoreStanza.get(giocatoreId);
    if (!codicePrecedente) return;
    const stanzaPrecedente = this.stanze.get(codicePrecedente);
    if (!stanzaPrecedente) return;
    for (const colore of ["rosso", "giallo"]) {
      if (stanzaPrecedente.giocatori[colore]?.giocatoreId === giocatoreId) {
        stanzaPrecedente.giocatori[colore] = null;
      }
    }
    if (!stanzaPrecedente.giocatori.rosso && !stanzaPrecedente.giocatori.giallo) {
      this.stanze.delete(codicePrecedente);
    }
  }

  _statoPartitaMsg(stanza) {
    return {
      type: "stato_partita",
      griglia: stanza.griglia,
      turno: stanza.turno,
      stato: stanza.stato,
    };
  }

  _invia(ws, messaggio) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(messaggio));
    }
  }

  _trasmetti(stanza, messaggio) {
    for (const colore of ["rosso", "giallo"]) {
      const giocatore = stanza.giocatori[colore];
      if (giocatore && giocatore.connesso) this._invia(giocatore.ws, messaggio);
    }
  }

  _trasmettiAAltro(stanza, colore, messaggio) {
    const altroColore = colore === "rosso" ? "giallo" : "rosso";
    const giocatore = stanza.giocatori[altroColore];
    if (giocatore && giocatore.connesso) this._invia(giocatore.ws, messaggio);
  }
}

/**
 * Aggancia il modulo Forza 4 a un server HTTP già esistente (quello creato
 * da Express). Ascolta SOLO le richieste di upgrade sul path dedicato:
 * qualunque altro path (incluso quello usato da altri giochi) viene ignorato
 * e lasciato libero per gli altri "listener" di upgrade eventualmente già
 * presenti nel tuo server.js.
 *
 * @param {import('http').Server} server - il server HTTP in uso da Express
 * @param {string} [path] - path dedicato per il WebSocket di Forza 4
 * @returns {import('ws').WebSocketServer}
 */
function attaccaForza4(server, path = "/forza4-ws") {
  const wss = new WebSocketServer({ noServer: true });
  const gestore = new GestoreForza4();

  server.on("upgrade", (richiesta, socket, head) => {
    let pathname;
    try {
      pathname = new URL(richiesta.url, `http://${richiesta.headers.host}`).pathname;
    } catch {
      return;
    }
    if (pathname !== path) return; // non è per noi: lascialo ad altri moduli

    wss.handleUpgrade(richiesta, socket, head, (ws) => {
      wss.emit("connection", ws, richiesta);
    });
  });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case "crea_stanza":
          gestore.creaStanza(ws, msg.giocatoreId);
          break;
        case "entra_stanza":
          gestore.entraStanza(ws, msg.giocatoreId, msg.codice);
          break;
        case "inserisci_gettone":
          gestore.inserisciGettone(ws, msg.colonna);
          break;
        case "nuova_partita":
          gestore.nuovaPartita(ws);
          break;
        default:
          break;
      }
    });

    ws.on("close", () => gestore.gestisciDisconnessione(ws));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

module.exports = { attaccaForza4 };
