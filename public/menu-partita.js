(() => {
  "use strict";

  const pannello = document.getElementById("pannello-menu");
  const apertura = document.getElementById("btn-menu");
  const chiusura = document.getElementById("btn-chiudi-menu");
  const etichettaSchermo = document.getElementById("testo-menu-schermo");
  const frecciaSchermo = document.getElementById("freccia-menu-schermo");
  const rigaVideo = document.getElementById("btn-stato-media");
  const etichettaVideo = document.getElementById("titolo-menu-video");
  const statoVideo = document.getElementById("stato-menu-video");

  function mostra(aperto) {
    pannello.classList.toggle("nascosto", !aperto);
    apertura.setAttribute("aria-expanded", String(aperto));
    apertura.setAttribute("aria-label", aperto ? "Chiudi menu" : "Apri menu");
  }

  function chiudi(ripristinaFocus = false) {
    if (pannello.classList.contains("nascosto")) return;
    mostra(false);
    if (ripristinaFocus) apertura.focus();
  }

  function inizializza(primaDiAprire) {
    apertura.addEventListener("click", () => {
      if (!pannello.classList.contains("nascosto")) {
        chiudi();
        return;
      }
      primaDiAprire();
      mostra(true);
    });
    chiusura.addEventListener("click", () => chiudi(true));
    document.addEventListener("click", evento => {
      if (!apertura.contains(evento.target) && !pannello.contains(evento.target)) chiudi();
    });
  }

  function impostaInterruttore(id, attivo) {
    const bottone = document.getElementById(id);
    bottone.setAttribute("aria-checked", String(attivo));
    bottone.querySelector("[data-stato-interruttore]").textContent = attivo ? "On" : "Off";
  }

  function aggiornaSchermoIntero() {
    const attivo = !!(document.fullscreenElement || document.webkitFullscreenElement);
    etichettaSchermo.textContent = attivo ? "Esci da tutto schermo" : "Attiva tutto schermo";
    frecciaSchermo.textContent = attivo ? "↙" : "↗";
  }

  function impostaVideochiamata(attiva, soloAudio, errore) {
    const etichetta = attiva && soloAudio ? "Chiamata audio" : "Videochiamata";
    const stato = attiva ? (errore ? "Verifica necessaria" : "Attiva") : "Non attiva";
    if (etichettaVideo.textContent !== etichetta) etichettaVideo.textContent = etichetta;
    if (statoVideo.textContent !== stato) statoVideo.textContent = stato;
    rigaVideo.classList.toggle("media-attiva", attiva && !errore);
    rigaVideo.classList.toggle("media-errore", attiva && !!errore);
  }

  window.MenuPartita = { inizializza, chiudi, impostaInterruttore, aggiornaSchermoIntero, impostaVideochiamata };
})();
