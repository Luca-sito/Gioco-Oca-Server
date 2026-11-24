"use strict";

window.PresenzaLobby = {
  chiave(percorso) {
    return "giochiSocietaRientro:" + percorso;
  },
  rientro(percorso) {
    try {
      const dati = JSON.parse(sessionStorage.getItem(this.chiave(percorso)));
      if (dati?.scadenza > Date.now()) return { stanza: dati.stanza, id: dati.id };
    } catch {}
  },
  completa(percorso) {
    try { sessionStorage.removeItem(this.chiave(percorso)); } catch {}
  },
  richiediConteggio(socket, percorso) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const rientro = this.rientro(percorso);
    let token;
    if (rientro) {
      try { token = sessionStorage.getItem("giochiSocietaAuthToken") || undefined; } catch {}
    }
    socket.send(JSON.stringify({ tipo: "richiediConteggio", rientro, token }));
  }
};

window.rientraInLobby = (url, socket, invia) => {
  if (socket?.readyState !== WebSocket.OPEN) {
    window.location.replace(url);
    return;
  }

  function raggiungiLobby() {
    clearTimeout(timer);
    socket.removeEventListener("message", riceviConferma);
    socket.removeEventListener("close", raggiungiLobby);
    window.location.replace(url);
  }

  function riceviConferma(evento) {
    const dati = JSON.parse(evento.data);
    if (dati.tipo === "rientroLobbyPronto") raggiungiLobby();
  }

  const timer = setTimeout(raggiungiLobby, 1500);
  socket.addEventListener("message", riceviConferma);
  socket.addEventListener("close", raggiungiLobby);
  const destinazione = new URL(url, window.location.href);
  const idRientro = window.crypto.randomUUID?.();
  if (idRientro) {
    try {
      sessionStorage.setItem(window.PresenzaLobby.chiave(destinazione.pathname), JSON.stringify({
        stanza: destinazione.searchParams.get("stanza") || "BAR",
        id: idRientro,
        scadenza: Date.now() + 15000
      }));
    } catch {}
  }
  if (!invia({ tipo: "rientroLobby", idRientro })) {
    window.PresenzaLobby.completa(destinazione.pathname);
    raggiungiLobby();
  }
};
