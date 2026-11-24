"use strict";

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
  if (!invia({ tipo: "rientroLobby" })) raggiungiLobby();
};
