let socket;
let tipoPartita = "pubblica";

const parametri = new URLSearchParams(window.location.search);
const stanza = parametri.get("stanza") || "BAR";
document.getElementById("nomeStanza").innerHTML = "🏠 " + stanza;

let nomeGiocatore = localStorage.getItem("nickname");
if (!nomeGiocatore) {
  nomeGiocatore = prompt("Come vuoi essere chiamato?", "Giocatore");
  localStorage.setItem("nickname", nomeGiocatore);
}

socket = new WebSocket(location.origin.replace("http", "ws"));

socket.onopen = () => {
  console.log("Connesso");
  socket.send(JSON.stringify({
    tipo: "entraLobby",
    stanza: stanza,
    nome: nomeGiocatore
  }));
};

socket.onmessage = (msg) => {
  let dati = JSON.parse(msg.data);

  if (dati.tipo === "online") {
    document.getElementById("online").innerHTML = dati.numero;
  }

  if (dati.tipo === "chat") {
    aggiungiMessaggio(dati.nome, dati.testo);
  }

  if (dati.tipo === "listaPartite") {
    mostraPartite(dati.partite);
  }

  if (dati.tipo === "errore") {
    alert(dati.messaggio);
  }

  if (dati.tipo === "partitaAvviata") {
    localStorage.setItem('partitaId', dati.partitaId);
    localStorage.setItem('stanzaCorrente', stanza);
    window.location.href = `gioco.html?partita=${dati.partitaId}&stanza=${stanza}`;
  }
};

function tipo(t) {
  tipoPartita = t;
}

function creaPartita() {
  socket.send(JSON.stringify({
    tipo: "creaPartita",
    tempo: document.getElementById("tempo").value,
    punti: document.getElementById("punti").value,
    modalita: tipoPartita,
    maxGiocatori: 4
  }));
}

function mostraPartite(lista) {
  let html = "";
  if (lista.length === 0) {
    html = "<p>Nessuna partita disponibile</p>";
  }
  lista.forEach(partita => {
    html += `
    <div class="partita">
      🎲 ${partita.creatore}
      <br>
      ${partita.modalita === "privata" ? "🔒 Privata" : "🔓 Pubblica"}
      <br>
      ⏱ ${partita.tempo} secondi
      <br>
      🏆 ${partita.punti} punti
      <br>
      👥 ${partita.numGiocatoriAttuali} su ${partita.maxGiocatori}
      <br><br>
      <button onclick="entraPartita('${partita.id}')">Entra</button>
    </div>
    `;
  });
  document.getElementById("partite").innerHTML = html;
}

function entraPartita(id) {
  socket.send(JSON.stringify({ tipo: "entraPartita", id: id }));
}

function inviaChat() {
  let testo = document.getElementById("messaggio").value;
  if (testo === "") return;
  socket.send(JSON.stringify({
    tipo: "chat",
    testo: testo
  }));
  document.getElementById("messaggio").value = "";
}

function aggiungiMessaggio(nome, testo) {
  let chat = document.getElementById("chat");
  chat.innerHTML += `<div><b>${nome}</b>: ${testo}</div>`;
  chat.scrollTop = chat.scrollHeight;
}
