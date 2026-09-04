// game.js — logica client del gioco Forza 4
// Modulo indipendente: usa la propria chiave WebSocket dedicata (/forza4-ws)
// e non condivide stato con altri giochi presenti sul sito.

(function () {
  "use strict";

  const RIGHE = 6;
  const COLONNE = 7;

  // ---------- Identità persistente del giocatore ----------
  // Riusa la stessa chiave "giocatoreId" già usata dagli altri giochi del sito,
  // così l'identità del giocatore resta coerente su tutta la piattaforma.
  function ottieniGiocatoreId() {
    let id = localStorage.getItem("giocatoreId");
    if (!id) {
      id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        "g-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      localStorage.setItem("giocatoreId", id);
    }
    return id;
  }

  const giocatoreId = ottieniGiocatoreId();

  // ---------- Riferimenti agli elementi ----------
  const schermate = {
    lobby: document.getElementById("schermata-lobby"),
    attesa: document.getElementById("schermata-attesa"),
    gioco: document.getElementById("schermata-gioco"),
  };

  const btnCreaStanza = document.getElementById("btn-crea-stanza");
  const formEntraStanza = document.getElementById("form-entra-stanza");
  const inputCodice = document.getElementById("input-codice");
  const messaggioErrore = document.getElementById("messaggio-errore");

  const codiceStanzaMostrato = document.getElementById("codice-stanza-mostrato");
  const btnAnnullaAttesa = document.getElementById("btn-annulla-attesa");

  const tabellone = document.getElementById("tabellone");
  const filaAnteprima = document.getElementById("fila-anteprima");
  const pallinoTurno = document.getElementById("pallino-turno");
  const testoTurno = document.getElementById("testo-turno");
  const badgeConnessione = document.getElementById("badge-connessione");

  const overlayFine = document.getElementById("overlay-fine-partita");
  const testoFinePartita = document.getElementById("testo-fine-partita");
  const btnNuovaPartita = document.getElementById("btn-nuova-partita");

  // ---------- Stato locale ----------
  let socket = null;
  let miaCodiceStanza = null;
  let mioColore = null; // 'rosso' | 'giallo'
  let turnoCorrente = null;
  let griglaAttuale = creaGrigliaVuota();
  let celleBucaEl = []; // matrice RIGHE x COLONNE di elementi .buca
  let celleAnteprimaEl = [];
  let partitaTerminata = false;

  function creaGrigliaVuota() {
    return Array.from({ length: RIGHE }, () => Array(COLONNE).fill(null));
  }

  // ---------- Navigazione tra schermate ----------
  function mostraSchermata(nome) {
    Object.entries(schermate).forEach(([chiave, el]) => {
      el.classList.toggle("schermata--attiva", chiave === nome);
    });
  }

  // ---------- Costruzione tabellone (una sola volta) ----------
  function costruisciTabellone() {
    tabellone.innerHTML = "";
    filaAnteprima.innerHTML = "";
    celleBucaEl = [];
    celleAnteprimaEl = [];

    for (let colonna = 0; colonna < COLONNE; colonna++) {
      const cellaAnteprima = document.createElement("div");
      cellaAnteprima.className = "cella-anteprima";
      cellaAnteprima.dataset.colonna = String(colonna);

      const gettoneAnteprima = document.createElement("div");
      gettoneAnteprima.className = "gettone-anteprima";
      cellaAnteprima.appendChild(gettoneAnteprima);

      cellaAnteprima.addEventListener("click", () => provaInserisci(colonna));
      filaAnteprima.appendChild(cellaAnteprima);
      celleAnteprimaEl[colonna] = gettoneAnteprima;
    }

    for (let riga = 0; riga < RIGHE; riga++) {
      celleBucaEl[riga] = [];
      for (let colonna = 0; colonna < COLONNE; colonna++) {
        const buca = document.createElement("div");
        buca.className = "buca";
        buca.dataset.riga = String(riga);
        buca.dataset.colonna = String(colonna);
        buca.addEventListener("click", () => provaInserisci(colonna));
        tabellone.appendChild(buca);
        celleBucaEl[riga][colonna] = buca;
      }
    }
  }

  function provaInserisci(colonna) {
    if (partitaTerminata) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (turnoCorrente !== mioColore) return;
    socket.send(JSON.stringify({ type: "inserisci_gettone", colonna }));
  }

  // ---------- Rendering stato partita ----------
  function aggiornaAnteprima() {
    const attivo = !partitaTerminata && turnoCorrente === mioColore;
    celleAnteprimaEl.forEach((el) => {
      el.classList.toggle("gettone-anteprima--attiva", attivo);
      el.classList.remove("gettone-anteprima--rosso", "gettone-anteprima--giallo");
      if (attivo && mioColore) {
        el.classList.add(
          mioColore === "rosso" ? "gettone-anteprima--rosso" : "gettone-anteprima--giallo"
        );
      }
    });
  }

  function aggiornaIndicatoreTurno() {
    pallinoTurno.classList.remove("pallino-turno--rosso", "pallino-turno--giallo");
    if (turnoCorrente) {
      pallinoTurno.classList.add(
        turnoCorrente === "rosso" ? "pallino-turno--rosso" : "pallino-turno--giallo"
      );
    }
    if (partitaTerminata) {
      // il testo viene gestito dall'overlay di fine partita
    } else if (turnoCorrente === mioColore) {
      testoTurno.textContent = "Tocca a te";
    } else {
      testoTurno.textContent =
        turnoCorrente === "rosso" ? "Turno del rosso" : "Turno del giallo";
    }
  }

  function renderizzaGriglia(nuovaGriglia, ultimaMossa) {
    for (let riga = 0; riga < RIGHE; riga++) {
      for (let colonna = 0; colonna < COLONNE; colonna++) {
        const valore = nuovaGriglia[riga][colonna];
        const valorePrecedente = griglaAttuale[riga][colonna];
        const buca = celleBucaEl[riga][colonna];

        if (valore && !valorePrecedente) {
          // nuovo gettone: crealo e anima la caduta
          const gettone = document.createElement("div");
          gettone.className = "gettone gettone--" + valore;

          const èUltimaMossa =
            ultimaMossa && ultimaMossa.riga === riga && ultimaMossa.colonna === colonna;

          buca.appendChild(gettone);

          // forza il reflow prima di aggiungere la classe di animazione
          // in modo che la transizione parta sempre dall'alto
          void gettone.offsetWidth;
          gettone.classList.add("gettone--cade");

          if (!èUltimaMossa) {
            // per gettoni già presenti in uno stato ricevuto in blocco
            // (es. dopo una riconnessione) evitiamo l'animazione ripetuta
            gettone.style.animation = "none";
            gettone.style.transform = "translateY(0)";
          }
        } else if (!valore && valorePrecedente) {
          buca.innerHTML = "";
        }
      }
    }
    griglaAttuale = nuovaGriglia.map((riga) => riga.slice());
  }

  function evidenziaCelleVincenti(celle) {
    if (!celle) return;
    celle.forEach(([riga, colonna]) => {
      const buca = celleBucaEl[riga][colonna];
      const gettone = buca.querySelector(".gettone");
      if (gettone) gettone.classList.add("gettone--vincente");
    });
  }

  function mostraFinePartita(vincitore) {
    partitaTerminata = true;
    aggiornaAnteprima();
    aggiornaIndicatoreTurno();

    if (vincitore === null) {
      testoFinePartita.textContent = "Pareggio!";
    } else if (vincitore === mioColore) {
      testoFinePartita.textContent = "Hai vinto! 🎉";
    } else {
      testoFinePartita.textContent =
        vincitore === "rosso" ? "Ha vinto il rosso" : "Ha vinto il giallo";
    }

    overlayFine.classList.add("overlay-fine-partita--visibile");
  }

  function nascondiFinePartita() {
    overlayFine.classList.remove("overlay-fine-partita--visibile");
  }

  // ---------- Connessione WebSocket ----------
  function urlWebSocket() {
    const protocollo = location.protocol === "https:" ? "wss:" : "ws:";
    return protocollo + "//" + location.host + "/forza4-ws";
  }

  function connetti() {
    socket = new WebSocket(urlWebSocket());

    socket.addEventListener("open", () => {
      messaggioErrore.textContent = "";
    });

    socket.addEventListener("message", (evento) => {
      let msg;
      try {
        msg = JSON.parse(evento.data);
      } catch {
        return;
      }
      gestisciMessaggio(msg);
    });

    socket.addEventListener("close", () => {
      if (schermate.gioco.classList.contains("schermata--attiva") && !partitaTerminata) {
        badgeConnessione.textContent = "Connessione persa, riprovo...";
        badgeConnessione.classList.remove("badge-connessione--nascosto");
      }
      // tentativo di riconnessione
      setTimeout(connetti, 2000);
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  function gestisciMessaggio(msg) {
    switch (msg.type) {
      case "stanza_creata":
        miaCodiceStanza = msg.codice;
        mioColore = msg.giocatore;
        codiceStanzaMostrato.textContent = msg.codice;
        mostraSchermata("attesa");
        break;

      case "stanza_unita":
        miaCodiceStanza = msg.codice;
        mioColore = msg.giocatore;
        break;

      case "avversario_connesso":
        avviaPartitaLocale();
        break;

      case "avversario_disconnesso":
        badgeConnessione.textContent = "L'avversario si è disconnesso";
        badgeConnessione.classList.remove("badge-connessione--nascosto");
        break;

      case "avversario_riconnesso":
        badgeConnessione.classList.add("badge-connessione--nascosto");
        break;

      case "stato_partita":
        if (!schermate.gioco.classList.contains("schermata--attiva")) {
          avviaPartitaLocale();
        }
        partitaTerminata = false;
        nascondiFinePartita();
        turnoCorrente = msg.turno;
        renderizzaGriglia(msg.griglia, msg.ultimaMossa);
        aggiornaIndicatoreTurno();
        aggiornaAnteprima();
        break;

      case "partita_finita":
        turnoCorrente = null;
        renderizzaGriglia(msg.griglia, msg.ultimaMossa);
        evidenziaCelleVincenti(msg.celleVincenti);
        mostraFinePartita(msg.vincitore);
        break;

      case "errore":
        messaggioErrore.textContent = msg.messaggio || "Si è verificato un errore.";
        break;

      default:
        break;
    }
  }

  function avviaPartitaLocale() {
    if (!celleBucaEl.length) costruisciTabellone();
    griglaAttuale = creaGrigliaVuota();
    partitaTerminata = false;
    badgeConnessione.classList.add("badge-connessione--nascosto");
    nascondiFinePartita();
    mostraSchermata("gioco");
  }

  // ---------- Eventi UI ----------
  btnCreaStanza.addEventListener("click", () => {
    messaggioErrore.textContent = "";
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "crea_stanza", giocatoreId }));
  });

  formEntraStanza.addEventListener("submit", (evento) => {
    evento.preventDefault();
    messaggioErrore.textContent = "";
    const codice = inputCodice.value.trim().toUpperCase();
    if (!codice) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      messaggioErrore.textContent = "Connessione non pronta, riprova tra un istante.";
      return;
    }
    socket.send(JSON.stringify({ type: "entra_stanza", giocatoreId, codice }));
  });

  btnAnnullaAttesa.addEventListener("click", () => {
    miaCodiceStanza = null;
    mioColore = null;
    mostraSchermata("lobby");
  });

  btnNuovaPartita.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "nuova_partita" }));
  });

  // ---------- Avvio ----------
  costruisciTabellone();
  connetti();
})();
