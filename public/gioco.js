const posizioniCaselle = {
  1: { x: 2246, y: 817 },
  2: { x: 2227, y: 1064 },
  3: { x: 2102, y: 1329 },
  4: { x: 1801, y: 1545 },
  5: { x: 1421, y: 1599 },
  6: { x: 1126, y: 1591 },
  7: { x: 873, y: 1591 },
  8: { x: 567, y: 1518 },
  9: { x: 321, y: 1286 },
  10: { x: 249, y: 1017 },
  11: { x: 244, y: 759 },
  12: { x: 334, y: 492 },
  13: { x: 591, y: 298 },
  14: { x: 897, y: 258 },
  15: { x: 1139, y: 257 },
  16: { x: 1366, y: 246 },
  17: { x: 1674, y: 286 },
  18: { x: 1933, y: 490 },
  19: { x: 2008, y: 720 },
  20: { x: 2016, y: 974 },
  21: { x: 1930, y: 1232 },
  22: { x: 1694, y: 1395 },
  23: { x: 1325, y: 1423 },
  24: { x: 993, y: 1428 },
  25: { x: 673, y: 1386 },
  26: { x: 465, y: 1205 },
  27: { x: 435, y: 992 },
  28: { x: 425, y: 802 },
  29: { x: 480, y: 590 },
  30: { x: 685, y: 427 },
  31: { x: 999, y: 403 },
  32: { x: 1287, y: 398 },
  33: { x: 1578, y: 425 },
  34: { x: 1779, y: 579 },
  35: { x: 1811, y: 766 },
  36: { x: 1816, y: 943 },
  37: { x: 1765, y: 1134 },
  38: { x: 1566, y: 1264 },
  39: { x: 1269, y: 1275 },
  40: { x: 1022, y: 1267 },
  41: { x: 776, y: 1248 },
  42: { x: 622, y: 1106 },
  43: { x: 606, y: 967 },
  44: { x: 592, y: 829 },
  45: { x: 629, y: 676 },
  46: { x: 767, y: 554 },
  47: { x: 1044, y: 546 },
  48: { x: 1260, y: 527 },
  49: { x: 1505, y: 546 },
  50: { x: 1635, y: 722 },
  51: { x: 1639, y: 979 },
  52: { x: 1484, y: 1135 },
  53: { x: 1243, y: 1146 },
  54: { x: 1049, y: 1143 },
  55: { x: 857, y: 1129 },
  56: { x: 739, y: 986 },
  57: { x: 733, y: 798 },
  58: { x: 866, y: 679 },
  59: { x: 1040, y: 670 },
  60: { x: 1236, y: 668 },
  61: { x: 1400, y: 665 },
  62: { x: 1506, y: 738 },
  63: { x: 1486, y: 926 }
};

const coloriGiocatori = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa", "#fb8c00", "#00acc1", "#6d4c41"];

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita");
const stanza = params.get("stanza");
const mioNome = localStorage.getItem("nickname") || "Giocatore";

let socket;
let ultimoStatoGiocatori = [];
let mioTurno = false;

function connetti() {
  socket = new WebSocket("wss://gioco-oca-server.onrender.com");

  socket.onopen = () => {
    socket.send(JSON.stringify({
      tipo: "riprendiPartita",
      partitaId: partitaId,
      nome: mioNome
    }));
  };

  socket.onclose = () => {
    document.getElementById("turno-banner").textContent = "🔴 Disconnesso, riconnessione...";
    setTimeout(connetti, 3000);
  };

  socket.onmessage = (msg) => {
    const dati = JSON.parse(msg.data);

    if (dati.tipo === "statoPartita") {
      ultimoStatoGiocatori = dati.giocatori;
      disegnaGiocatori();
      aggiornaTurno(dati.turnoDiNome);
    }

    if (dati.tipo === "aggiornamentoPartita") {
      ultimoStatoGiocatori = dati.giocatori;
      disegnaGiocatori();
      document.getElementById("messaggi-gioco").textContent =
        "🎲 " + dati.valoreDado + (dati.messaggi.length ? " — " + dati.messaggi.join(" ") : "");

      if (dati.vittoria) {
        mostraVittoria(dati.vincitore);
      } else {
        aggiornaTurno(dati.turnoDiNome);
      }
    }

    if (dati.tipo === "errore") {
      alert(dati.messaggio);
    }
  };
}

function aggiornaTurno(nomeDiTurno) {
  mioTurno = (nomeDiTurno === mioNome);
  document.getElementById("turno-banner").textContent = mioTurno
    ? "🎲 È il tuo turno!"
    : "⏳ Turno di: " + nomeDiTurno;

  const dadi = document.getElementById("dadi");
  if (mioTurno) {
    dadi.classList.remove("disabilitato");
  } else {
    dadi.classList.add("disabilitato");
  }
}

function disegnaGiocatori() {
  const container = document.getElementById("contenitore-pedine");
  const immagine = document.getElementById("immagine-tabellone");
  container.innerHTML = "";

  const scaleX = immagine.clientWidth / immagine.naturalWidth;
  const scaleY = immagine.clientHeight / immagine.naturalHeight;

  const listaLista = document.getElementById("lista-giocatori");
  listaLista.innerHTML = "";

  ultimoStatoGiocatori.forEach((giocatore, indice) => {
    const colore = coloriGiocatori[indice % coloriGiocatori.length];
    const casella = giocatore.posizione === 0 ? { x: 100, y: 1900 } : posizioniCaselle[giocatore.posizione];
    if (!casella) return;

    const pedina = document.createElement("div");
    pedina.className = "pedina";
    pedina.style.left = (casella.x * scaleX) + "px";
    pedina.style.top = (casella.y * scaleY) + "px";
    pedina.innerHTML = `
      <svg width="22" height="30" viewBox="0 0 30 40">
        <ellipse cx="15" cy="32" rx="10" ry="4" fill="rgba(0,0,0,0.25)"/>
        <path d="M15 2 C22 2 27 9 27 16 C27 24 15 38 15 38 C15 38 3 24 3 16 C3 9 8 2 15 2 Z"
              fill="${colore}" stroke="#000" stroke-opacity="0.3" stroke-width="1.5"/>
      </svg>
    `;
    container.appendChild(pedina);

    const riga = document.createElement("div");
    riga.className = "giocatore-riga";
    riga.innerHTML = `<span style="color:${colore}">●</span> ${giocatore.nome} (casella ${giocatore.posizione})`;
    listaLista.appendChild(riga);
  });
}

function mostraVittoria(nomeVincitore) {
  document.getElementById("testo-vincitore").textContent = "🎉 Ha vinto " + nomeVincitore + "!";
  document.getElementById("overlay-vittoria").classList.add("aperto");
}

function tornaAllaLobby() {
  window.location.href = `lobby.html?stanza=${stanza}`;
}

document.getElementById("dadi").onclick = () => {
  if (!mioTurno) return;
  socket.send(JSON.stringify({ tipo: "tiraDadi", partitaId: partitaId }));
};

connetti();
