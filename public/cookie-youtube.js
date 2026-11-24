"use strict";

(() => {
  const chiave = "giochiSocietaCookieYouTubeV1";
  const durata = 180 * 24 * 60 * 60 * 1000;
  const mostraBannerSito = document.currentScript?.hasAttribute("data-banner-sito");
  let sceltaTemporanea = null;

  function leggiImpostazioni() {
    if (sceltaTemporanea !== null) return sceltaTemporanea;
    try {
      return JSON.parse(localStorage.getItem(chiave)) || {};
    } catch {
      return {};
    }
  }

  function leggi() {
    const scelta = leggiImpostazioni();
    return scelta.scade > Date.now() ? scelta.consenso === true : null;
  }

  function sceltaSitoRegistrata() {
    return leggiImpostazioni().sceltaSitoScade > Date.now();
  }

  function salva(consenso, sceltaDelSito = false) {
    const scade = Date.now() + durata;
    const scelta = { consenso: consenso === true, scade };
    const scadenzaSito = sceltaDelSito ? scade : leggiImpostazioni().sceltaSitoScade;
    if (scadenzaSito > Date.now()) scelta.sceltaSitoScade = scadenzaSito;
    try {
      localStorage.setItem(chiave, JSON.stringify(scelta));
      sceltaTemporanea = null;
    } catch {
      // Nei browser che bloccano la memoria in questo iframe vale per la pagina corrente.
      sceltaTemporanea = scelta;
    }
    window.dispatchEvent(new Event("cookie-youtube"));
  }

  window.addEventListener("storage", evento => {
    if (evento.key === chiave || evento.key === null) window.dispatchEvent(new Event("cookie-youtube"));
  });
  window.CookieYouTube = { leggi, salva };

  if (mostraBannerSito) {
    const banner = document.createElement("aside");
    banner.id = "banner-cookie-sito";
    banner.setAttribute("aria-labelledby", "titolo-cookie-sito");
    banner.innerHTML = `
      <div>
        <strong id="titolo-cookie-sito">Cookie di Giochi Società</strong>
        <p>Usiamo cookie e tecnologie necessari per l’accesso e il gioco. Con «Accetta tutto» autorizzi anche i contenuti facoltativi di YouTube. <a href="/cookie-policy.html#youtube">Cookie Policy</a></p>
      </div>
      <div class="scelte-cookie-sito">
        <button type="button" data-consenso-sito="no">Solo necessari</button>
        <button type="button" data-consenso-sito="si">Accetta tutto</button>
      </div>`;
    const aggiorna = () => { banner.hidden = sceltaSitoRegistrata(); };
    aggiorna();
    document.body.append(banner);
    window.addEventListener("cookie-youtube", aggiorna);
  }

  for (const bottone of document.querySelectorAll("[data-consenso-sito]")) {
    bottone.addEventListener("click", () => salva(bottone.dataset.consensoSito === "si", true));
  }

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
