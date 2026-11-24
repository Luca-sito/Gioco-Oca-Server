"use strict";

(() => {
  const chiave = "giochiSocietaCookieYouTubeV1";
  const durata = 180 * 24 * 60 * 60 * 1000;
  let sceltaTemporanea = null;

  function leggi() {
    if (sceltaTemporanea !== null) return sceltaTemporanea;
    try {
      const scelta = JSON.parse(localStorage.getItem(chiave));
      if (scelta && scelta.scade > Date.now()) return scelta.consenso === true;
      return null;
    } catch {
      return null;
    }
  }

  function salva(consenso) {
    try {
      localStorage.setItem(chiave, JSON.stringify({ consenso, scade: Date.now() + durata }));
      sceltaTemporanea = null;
    } catch {
      // Nei browser che bloccano la memoria in questo iframe vale per la pagina corrente.
      sceltaTemporanea = consenso;
    }
    window.dispatchEvent(new Event("cookie-youtube"));
  }

  window.addEventListener("storage", evento => {
    if (evento.key === chiave || evento.key === null) window.dispatchEvent(new Event("cookie-youtube"));
  });
  window.CookieYouTube = { leggi, salva };

  const gestione = document.getElementById("gestione-cookie-youtube");
  if (gestione) {
    const stato = gestione.querySelector("[role='status']");
    const aggiorna = () => {
      stato.textContent = leggi() === true ? "YouTube è autorizzato in questo browser." : "YouTube è disattivato in questo browser.";
    };
    for (const bottone of gestione.querySelectorAll("button[data-consenso]")) {
      bottone.addEventListener("click", () => salva(bottone.dataset.consenso === "si"));
    }
    window.addEventListener("cookie-youtube", aggiorna);
    aggiorna();
  }
})();
