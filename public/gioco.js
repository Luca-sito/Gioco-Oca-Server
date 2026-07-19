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

const coloriGiocatori = ["#6a2c70", "#dddddd", "#1e40af", "#43a047", "#f57c00", "#c0ca33", "#e53935", "#2b2b2b"];
const DURATA_SALTO_MS = 380;

const params = new URLSearchParams(window.location.search);
const partitaId = params.get("partita");
const stanza = params.get("stanza");

const authToken = localStorage.getItem("authToken");
if (!authToken) {
  window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
}

function decodificaPayloadToken(token) {
  try {
    const payloadBase64 = token.split(".")[1];
    const json = atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch (e) { return null; }
}
const payloadToken = decodificaPayloadToken(authToken);
const mioUid = payloadToken ? payloadToken.uid : null;

let socket;
let ultimoStatoGiocatori = [];
let mioTurno = false;
let turnoAttualeId = null;
let timerRiconnessione = null; // fix: dichiarata FUORI da connetti(), altrimenti si azzera ad ogni chiamata

function creaFacciaDado(valore) {
  const posizioniPip = {
    1: [[50, 50]], 2: [[25, 25], [75, 75]], 3: [[25, 25], [50, 50], [75, 75]],
    4: [[25, 25], [75, 25], [25, 75], [75, 75]],
    5: [[25, 25], [75, 25], [50, 50], [25, 75], [75, 75]],
    6: [[25, 25], [75, 25], [25, 50], [75, 50], [25, 75], [75, 75]]
  };
  const colorePip = (valore === 1 || valore === 4) ? "#e53935" : "#222";
  const pips = posizioniPip[valore].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8" fill="${colorePip}"/>`).join("");
  return `<svg width="55" height="55" viewBox="0 0 100 100"><rect x="4" y="4" width="92" height="92" rx="14" fill="#fff" stroke="#ccc" stroke-width="3"/>${pips}</svg>`;
}

function mostraDadi(v1, v2) {
  document.getElementById("dado1").innerHTML = creaFacciaDado(v1);
  document.getElementById("dado2").innerHTML = creaFacciaDado(v2);
}

function animaLancioDadi(vf1, vf2, callback) {
  const dado1El = document.getElementById("dado1");
  const dado2El = document.getElementById("dado2");
  dado1El.classList.add("dado-rotola");
  dado2El.classList.add("dado-rotola");
  let cicli = 0;
  const intervallo = setInterval(() => {
    dado1El.innerHTML = creaFacciaDado(Math.floor(Math.random() * 6) + 1);
    dado2El.innerHTML = creaFacciaDado(Math.floor(Math.random() * 6) + 1);
    cicli++;
    if (cicli >= 8) {
      clearInterval(intervallo);
      dado1El.classList.remove("dado-rotola");
      dado2El.classList.remove("dado-rotola");
      mostraDadi(vf1, vf2);
      if (callback) callback();
    }
  }, 80);
}

function schiarisciColore(hex, p) { return mescolaColore(hex, 255, p); }
function scuriscColore(hex, p) { return mescolaColore(hex, 0, p); }
function mescolaColore(hex, target, p) {
  const num = parseInt(hex.replace("#", ""), 16);
  let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  r = Math.round(r + (target - r) * (p / 100));
  g = Math.round(g + (target - g) * (p / 100));
  b = Math.round(b + (target - b) * (p / 100));
  return `rgb(${r},${g},${b})`;
}
function iniziale(nome) { return (nome || "?").trim().charAt(0).toUpperCase(); }

function coordinatePerCasella(casellaNumero) {
  const immagine = document.getElementById("immagine-tabellone");
  const scaleX = immagine.clientWidth / immagine.naturalWidth;
  const scaleY = immagine.clientHeight / immagine.naturalHeight;
  const casella = casellaNumero === 0 ? { x: 100, y: 1900 } : posizioniCaselle[casellaNumero];
  if (!casella) return null;
  return { left: casella.x * scaleX, top: casella.y * scaleY };
}

function posizionaPedina(pedina, casellaNumero) {
  const coord = coordinatePerCasella(casellaNumero);
  if (!coord) return;
  pedina.style.left = coord.left + "px";
  pedina.style.top = coord.top + "px";
}

function ottieniOCreaPedina(idGiocatore, colore, indice) {
  let pedina = document.getElementById("pedina-" + idGiocatore);
  if (!pedina) {
    pedina = document.createElement("div");
    pedina.id = "pedina-" + idGiocatore;
    pedina.className = "pedina";
    const idGradiente = "gradPedina" + indice;
    pedina.innerHTML = `
      <svg width="26" height="38" viewBox="0 0 34 48">
        <defs><radialGradient id="${idGradiente}" cx="35%" cy="25%" r="75%">
          <stop offset="0%" stop-color="${schiarisciColore(colore, 55)}"/>
          <stop offset="55%" stop-color="${colore}"/>
          <stop offset="100%" stop-color="${scuriscColore(colore, 35)}"/>
        </radialGradient></defs>
        <ellipse cx="17" cy="44" rx="12" ry="3.5" fill="rgba(0,0,0,0.3)"/>
        <ellipse cx="17" cy="42" rx="11" ry="4" fill="${scuriscColore(colore, 25)}"/>
        <path d="M17 42 C10 42 4 40 4 37 L10 15 C10 15 12 12 17 12 C22 12 24 15 24 15 L30 37 C30 40 24 42 17 42 Z" fill="url(#${idGradiente})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
        <circle cx="17" cy="9" r="7.5" fill="url(#${idGradiente})" stroke="${scuriscColore(colore, 45)}" stroke-width="0.8"/>
        <ellipse cx="14" cy="6" rx="2.5" ry="1.8" fill="rgba(255,255,255,0.55)"/>
      </svg>`;
    document.getElementById("contenitore-pedine").appendChild(pedina);
  }
  return pedina;
}

function animaSaltoPedina(idGiocatore, percorso, callback) {
  if (!percorso || percorso.length === 0) { if (callback) callback(); return; }

  const indice = ultimoStatoGiocatori.findIndex(g => g.id === idGiocatore);
  const colore = coloriGiocatori[(indice >= 0 ? indice : 0) % coloriGiocatori.length];
  const pedina = ottieniOCreaPedina(idGiocatore, colore, indice >= 0 ? indice : 0);

  let passo = 0;
  function saltaProssimo() {
    if (passo >= percorso.length) { if (callback) callback(); return; }
    const casella = percorso[passo];

    pedina.classList.add("pedina-salta");
    posizionaPedina(pedina, casella);

    const etichettaCasella = document.getElementById("casella-" + idGiocatore);
    if (etichettaCasella) etichettaCasella.textContent = casella;

    setTimeout(() => pedina.classList.remove("pedina-salta"), DURATA_SALTO_MS * 0.6);

    passo++;
    setTimeout(saltaProssimo, DURATA_SALTO_MS);
  }
  saltaProssimo();
}

function connetti() {
  socket = new WebSocket("wss://gioco-oca-server.onrender.com");

  socket.onopen = () => {
  if (timerRiconnessione) {
    clearTimeout(timerRiconnessione);
    timerRiconnessione = null;
}
    socket.send(JSON.stringify({ tipo: "riprendiPartita", partitaId, token: authToken }));
  };

  socket.onclose = () => {
    document.getElementById("riga-turno").textContent = "🔴 Disconnesso, riconnessione...";
    if (!timerRiconnessione) {
      timerRiconnessione = setTimeout(() => {
        timerRiconnessione = null;
        connetti();
      }, 3000);
    }
  };

  socket.onmessage = (msg) => {
    const dati = JSON.parse(msg.data);

    if (dati.tipo === "sessioneScaduta") {
      localStorage.removeItem("authToken");
      window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.href);
      return;
    }

    if (dati.tipo === "statoPartita") {
      ultimoStatoGiocatori = dati.giocatori;
      if (dati.vittoria) {
        turnoAttualeId = null;
        document.getElementById("area-dadi").classList.add("disabilitato");
        disegnaGiocatori();
        mostraVittoria(dati.vincitore);
      } else {
        aggiornaTurno(dati.turnoDiId);
        disegnaGiocatori();
      }
      if (dati.messaggi && dati.messaggi.length) document.getElementById("messaggi-gioco").textContent = dati.messaggi.join(" ");
      mostraDadi(1, 1);
    }

    if (dati.tipo === "aggiornamentoPartita") {

    animaLancioDadi(dati.dado1, dati.dado2, () => {

        if (dati.percorso && dati.idGiocatoreCheHaTirato) {

            animaSaltoPedina(
                dati.idGiocatoreCheHaTirato,
                dati.percorso,
                () => {

                    ultimoStatoGiocatori = dati.giocatori;

document.getElementById("messaggi-gioco").textContent =
"🎲 " + dati.dado1 + " + " + dati.dado2 +
" = " + dati.valoreDado +
(dati.messaggi && dati.messaggi.length
    ? " — " + dati.messaggi.join(" ")
    : "");

if (dati.vittoria) {
    turnoAttualeId = null;
    document.getElementById("area-dadi").classList.add("disabilitato");
    disegnaGiocatori();
    mostraVittoria(dati.vincitore);
} else {
    aggiornaTurno(dati.turnoDiId);
    disegnaGiocatori();
}

                }
            );

        } else {

            // stesso codice che hai nella callback
            ultimoStatoGiocatori = dati.giocatori;

            document.getElementById("messaggi-gioco").textContent =
                "🎲 " + dati.dado1 + " + " + dati.dado2 +
                " = " + dati.valoreDado +
                (dati.messaggi && dati.messaggi.length
                    ? " — " + dati.messaggi.join(" ")
                    : "");


            if (dati.vittoria) {
                turnoAttualeId = null;
                document.getElementById("area-dadi").classList.add("disabilitato");
                disegnaGiocatori();
                mostraVittoria(dati.vincitore);
            } else {
                aggiornaTurno(dati.turnoDiId);
                disegnaGiocatori();
            }
        }

    });

}

    if (dati.tipo === "chatPartita") aggiungiMessaggioChatPartita(dati.nome, dati.testo);
    if (dati.tipo === "errore") {
      alert(dati.messaggio);
      // Se l'errore riguarda il turno, riabilito i dadi (altrimenti restano bloccati)
      if (mioTurno) document.getElementById("area-dadi").classList.remove("disabilitato");
    }
  };
}

function aggiornaTurno(turnoDiId) {
  turnoAttualeId = turnoDiId;
  mioTurno = (turnoDiId === mioUid);
  document.getElementById("riga-turno").textContent = mioTurno ? "🎲 È il tuo turno!" : "⏳ In attesa...";
  document.getElementById("area-dadi").classList.toggle("disabilitato", !mioTurno);
}

function disegnaGiocatori() {
const contenitore = document.getElementById("contenitore-pedine");

Array.from(contenitore.children).forEach(p => {
  if (!ultimoStatoGiocatori.some(g => "pedina-" + g.id === p.id)) {
    p.remove();
  }
});
  const listaPannello = document.getElementById("lista-giocatori");
  listaPannello.innerHTML = "";

  ultimoStatoGiocatori.forEach((giocatore, indice) => {
    const colore = coloriGiocatori[indice % coloriGiocatori.length];
    const pedina = ottieniOCreaPedina(giocatore.id, colore, indice);
    posizionaPedina(pedina, giocatore.posizione);

    const card = document.createElement("div");
    card.className = "giocatore-card" + (giocatore.id === turnoAttualeId ? " attivo" : "");
    card.innerHTML = `<div class="avatar-mini" style="background:${colore};">${iniziale(giocatore.nome)}</div><span>${giocatore.nome}</span><span class="casella-mini" id="casella-${giocatore.id}">${giocatore.posizione}</span>`;
    listaPannello.appendChild(card);
  });
}

function mostraVittoria(nomeVincitore) {
  document.getElementById("testo-vincitore").textContent = "🎉 Ha vinto " + nomeVincitore + "!";
  document.getElementById("overlay-vittoria").classList.add("aperto");
}

function tornaAllaLobby() { window.location.href = `lobby.html?stanza=${stanza}`; }

function abbandonaPartita() {
  if (!confirm("Sei sicuro di voler abbandonare la partita?")) return;

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      tipo: "abbandonaPartita",
      partitaId
    }));
  }

  tornaAllaLobby();
}

function apriProfilo() { chiudiMenu(); alert("Sezione Profilo in arrivo prossimamente!"); }
function apriImpostazioni() { chiudiMenu(); alert("Sezione Impostazioni in arrivo prossimamente!"); }
function chiudiMenu() { document.getElementById("pannello-menu").classList.add("nascosto"); }

document.getElementById("btn-menu").onclick = (e) => { e.stopPropagation(); document.getElementById("pannello-menu").classList.toggle("nascosto"); };
document.addEventListener("click", () => chiudiMenu());

function aggiungiMessaggioChatPartita(nome, testo) {
  const box = document.getElementById("chat-messaggi");
  const riga = document.createElement("div");
  riga.className = "chat-msg";
  riga.innerHTML = `<b>${nome}:</b> ${testo}`;
  box.appendChild(riga);
  box.scrollTop = box.scrollHeight;
}

function inviaChatPartita() {
  const input = document.getElementById("chat-input");
  const testo = input.value.trim();
  if (!testo) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
        tipo:"chatPartita",
        partitaId,
        testo
    }));
}
  input.value = "";
}
document.getElementById("chat-input").addEventListener("keypress", (e) => { if (e.key === "Enter") inviaChatPartita(); });
document.getElementById("btn-chat").onclick = (e) => { e.stopPropagation(); document.getElementById("pannello-chat").classList.toggle("nascosto"); };

document.getElementById("area-dadi").onclick = () => {
  if (!mioTurno) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  document.getElementById("area-dadi").classList.add("disabilitato");

  socket.send(JSON.stringify({
    tipo: "tiraDadi",
    partitaId
  }));
};

mostraDadi(1, 1);
connetti();
