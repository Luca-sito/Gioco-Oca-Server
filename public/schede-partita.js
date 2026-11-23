"use strict";

window.SchedePartita = {
  azioneSpettatore(partita, partecipa, paginaGioco, stanza) {
    if (partecipa || partita.spettatoriDisponibili !== true) return "";
    const massimo = Number(partita.maxSpettatori);
    const spettatori = Number(partita.numSpettatori);
    if (spettatori >= massimo) {
      return '<button type="button" class="btn-spettatore" disabled>Spettatori al completo</button>';
    }
    const link = new URL(paginaGioco, location.href);
    link.search = new URLSearchParams({ partita: partita.id, stanza, spettatore: "1" });
    return '<a class="btn-spettatore" href="' + link.href.replaceAll("&", "&amp;") + '">Fai da spettatore</a>';
  },

  disegna({ dettagli, giocatori, azioni }) {
    return `
      <article class="scheda-partita">
        <div class="corpo-scheda-partita">
          <div class="giocatori-mini">${giocatori}</div>
          <div class="info-partita">${dettagli.map(testo => `<span>${testo}</span>`).join("")}</div>
        </div>
        <div class="azioni-scheda">${azioni}</div>
      </article>`;
  }
};
