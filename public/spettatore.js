"use strict";

(() => {
  if (new URLSearchParams(location.search).get("spettatore") !== "1") return;
  document.body.classList.add("vista-spettatore");
  const barra = document.createElement("header");
  barra.className = "barra-spettatore";
  const esci = document.createElement("button");
  esci.type = "button";
  esci.textContent = "Esci da questa partita";
  esci.addEventListener("click", () => window.tornaAllaLobby());
  const stato = document.createElement("p");
  stato.setAttribute("role", "status");
  stato.textContent = "Modalità spettatore";
  barra.append(esci, stato);
  document.body.prepend(barra);

  const dadi = document.getElementById("area-dadi");
  if (dadi) dadi.tabIndex = -1;
  for (const tabellone of document.querySelectorAll("#area-tabellone [role='grid']")) {
    tabellone.setAttribute("aria-readonly", "true");
  }

  window.SpettatoreGioco = {
    gestisci(dati) {
      if (dati.tipo === "spettatore_errore") {
        stato.textContent = dati.messaggio || "Partita non disponibile.";
        document.body.classList.add("spettatore-non-disponibile");
        return true;
      }
      if (dati.tipo === "spettatore_fine") {
        if (stato.textContent === "Modalità spettatore") stato.textContent = "Partita terminata";
        return true;
      }
      return false;
    },
    esito(vincitore) {
      stato.textContent = vincitore ? "Ha vinto " + vincitore : "Partita terminata in parità";
    }
  };
})();
