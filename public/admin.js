(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AdminPanel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const STATI = new Set(["attivo", "sospeso", "bannato"]);

  function interoNonNegativo(valore) {
    const numero = Number.parseInt(valore, 10);
    return Number.isFinite(numero) && numero >= 0 ? numero : 0;
  }

  function normalizzaUtente(dato = {}) {
    const stato = STATI.has(dato.stato) ? dato.stato : "sconosciuto";
    const sospesoFino = Number(dato.sospesoFino);
    return {
      uid: String(dato.uid == null ? "" : dato.uid),
      nickname: String(dato.nickname || "Utente senza nickname"),
      email: String(dato.email || "Email non disponibile"),
      stato,
      sospesoFino: Number.isFinite(sospesoFino) && sospesoFino > 0 ? sospesoFino : null,
      partiteGiocate: interoNonNegativo(dato.partiteGiocate),
      partiteVinte: interoNonNegativo(dato.partiteVinte),
      avvisi: Array.isArray(dato.avvisi)
        ? dato.avvisi.map(avviso => ({
            motivo: String(avviso && avviso.motivo || "Avviso senza motivo"),
            data: interoNonNegativo(avviso && avviso.data)
          }))
        : []
    };
  }

  function percentualeVittorie(utente) {
    const giocate = interoNonNegativo(utente && utente.partiteGiocate);
    const vinte = interoNonNegativo(utente && utente.partiteVinte);
    if (giocate === 0) return 0;
    return Math.max(0, Math.min(100, Math.round((vinte / giocate) * 100)));
  }

  function calcolaStatistiche(utenti) {
    const lista = Array.isArray(utenti) ? utenti : [];
    return {
      registrati: lista.length,
      attivi: lista.filter(utente => utente.stato === "attivo").length,
      sospesi: lista.filter(utente => utente.stato === "sospeso").length,
      bannati: lista.filter(utente => utente.stato === "bannato").length
    };
  }

  function filtraUtenti(utenti, termine) {
    const query = String(termine || "").trim().toLocaleLowerCase("it-IT");
    const lista = Array.isArray(utenti) ? utenti : [];
    if (!query) return lista.slice();
    return lista.filter(utente =>
      utente.nickname.toLocaleLowerCase("it-IT").includes(query) ||
      utente.email.toLocaleLowerCase("it-IT").includes(query)
    );
  }

  function azioniPerStato(stato) {
    if (stato === "attivo") return ["warn", "suspend", "ban"];
    if (stato === "sospeso") return ["warn", "end-suspension", "ban"];
    if (stato === "bannato") return ["reactivate"];
    return [];
  }

  function validaSospensione(valore) {
    const numero = Number(valore);
    const valido = Number.isInteger(numero) && numero > 0;
    return {
      valido,
      giorni: valido ? numero : null,
      errore: valido ? "" : "Inserisci un numero intero di giorni maggiore di zero."
    };
  }

  const ENDPOINT_AZIONI = Object.freeze({
    warn: "/api/admin/avviso",
    suspend: "/api/admin/sospendi",
    "end-suspension": "/api/admin/rimuovi-sospensione",
    ban: "/api/admin/banna",
    reactivate: "/api/admin/riattiva"
  });

  class ErroreHttpAdmin extends Error {
    constructor(messaggio, status) {
      super(messaggio);
      this.name = "ErroreHttpAdmin";
      this.status = Number(status) || 0;
    }
  }

  function creaClientAdmin({ fetchImpl } = {}) {
    const eseguiFetch = fetchImpl || ((url, opzioni) => fetch(url, opzioni));

    async function leggiJson(risposta) {
      const contentType = risposta.headers && risposta.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new ErroreHttpAdmin("Risposta del server non valida.", risposta.status);
      }
      try {
        return await risposta.json();
      } catch (_errore) {
        throw new ErroreHttpAdmin("Risposta del server non valida.", risposta.status);
      }
    }

    async function richiesta(url, opzioni) {
      let risposta;
      try {
        risposta = await eseguiFetch(url, opzioni);
      } catch (_errore) {
        throw new ErroreHttpAdmin("Connessione al server non disponibile.", 0);
      }
      const json = await leggiJson(risposta);
      if (!risposta.ok) {
        throw new ErroreHttpAdmin(String(json.errore || "Operazione non riuscita."), risposta.status);
      }
      return json;
    }

    return {
      async caricaUtenti() {
        const json = await richiesta("/api/admin/utenti", {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (!Array.isArray(json.utenti)) {
          throw new ErroreHttpAdmin("Risposta del server non valida.", 200);
        }
        return json.utenti.map(normalizzaUtente);
      },
      async eseguiAzione(azione, dati) {
        const url = ENDPOINT_AZIONI[azione];
        if (!url) throw new Error("Azione amministrativa non supportata.");
        return richiesta(url, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(dati)
        });
      },
      logout() {
        return richiesta("/api/logout", {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" }
        });
      }
    };
  }

  function creaConfigurazioneAzione(azione, utente) {
    const nome = utente.nickname;
    const configurazioni = {
      warn: {
        azione: "warn",
        titolo: `Invia un avviso a ${nome}`,
        descrizione: "Il messaggio verrà registrato e notificato all’utente.",
        conferma: "Invia avviso",
        pericolo: false,
        campi: ["motivo"]
      },
      suspend: {
        azione: "suspend",
        titolo: `Sospendi ${nome}`,
        descrizione: "L’utente non potrà utilizzare il proprio account per il periodo indicato.",
        conferma: "Conferma sospensione",
        pericolo: false,
        campi: ["giorni", "motivo"]
      },
      "end-suspension": {
        azione: "end-suspension",
        titolo: `Termina la sospensione di ${nome}`,
        descrizione: "L’account tornerà immediatamente attivo.",
        conferma: "Termina sospensione",
        pericolo: false,
        campi: []
      },
      ban: {
        azione: "ban",
        titolo: `Banna ${nome}`,
        descrizione: "L’account verrà bloccato finché un amministratore non lo riattiverà.",
        conferma: "Conferma ban",
        pericolo: true,
        campi: ["motivo"]
      },
      reactivate: {
        azione: "reactivate",
        titolo: `Riattiva ${nome}`,
        descrizione: "L’account tornerà immediatamente attivo.",
        conferma: "Riattiva account",
        pericolo: false,
        campi: []
      }
    };
    return configurazioni[azione] || null;
  }

  function creaElemento(documento, tag, classe, testo) {
    const elemento = documento.createElement(tag);
    if (classe) elemento.className = classe;
    if (testo !== undefined) elemento.textContent = String(testo);
    return elemento;
  }

  function bootstrap() {
    if (typeof document === "undefined") return;

    if (document.documentElement.dataset.adminPanelReady === "true") return;
    document.documentElement.dataset.adminPanelReady = "true";

    const stato = {
      utenti: [],
      ricerca: "",
      caricamento: false,
      errore: null,
      aggiornatoIl: null,
      dialogo: null,
      invioInCorso: false
    };

    const dom = Object.fromEntries([
      "adminLoading", "adminDenied", "adminError", "adminApp", "adminErrorMessage",
      "lastUpdated", "refreshButton", "logoutButton", "registeredCount", "activeCount",
      "suspendedCount", "bannedCount", "searchInput", "clearSearchButton", "resultsCount",
      "usersTableBody", "usersCards", "emptyState", "emptyStateTitle", "emptyStateMessage",
      "adminDialogRoot", "adminToast"
    ].map(id => [id, document.getElementById(id)]));

    if (Object.values(dom).some(elemento => !elemento)) return;

    const client = creaClientAdmin();
    let focusPrecedente = null;
    let timerToast = null;

    const ETICHETTE_AZIONE = Object.freeze({
      warn: "Invia avviso",
      suspend: "Sospendi",
      "end-suspension": "Termina sospensione",
      ban: "Banna",
      reactivate: "Riattiva"
    });

    function mostraStatoPagina(nome) {
      dom.adminLoading.hidden = nome !== "loading";
      dom.adminDenied.hidden = nome !== "denied";
      dom.adminError.hidden = nome !== "error";
      dom.adminApp.hidden = nome !== "ready";
    }

    function renderStatistiche() {
      const numeri = calcolaStatistiche(stato.utenti);
      dom.registeredCount.textContent = String(numeri.registrati);
      dom.activeCount.textContent = String(numeri.attivi);
      dom.suspendedCount.textContent = String(numeri.sospesi);
      dom.bannedCount.textContent = String(numeri.bannati);
    }

    function testoRisultati(visibili) {
      return visibili === 1 ? "1 utente visualizzato" : `${visibili} utenti visualizzati`;
    }

    function formattaData(timestamp) {
      const data = new Date(timestamp);
      if (!Number.isFinite(data.getTime())) return "Data non disponibile";
      return new Intl.DateTimeFormat("it-IT", {
        dateStyle: "short",
        timeStyle: "short"
      }).format(data);
    }

    function etichettaStato(statoUtente) {
      if (statoUtente === "attivo") return "Attivo";
      if (statoUtente === "sospeso") return "Sospeso";
      if (statoUtente === "bannato") return "Bannato";
      return "Stato non disponibile";
    }

    function creaIdentita(utente) {
      const identita = creaElemento(document, "div", "user-identity");
      identita.append(
        creaElemento(document, "strong", "", utente.nickname),
        creaElemento(document, "span", "", utente.email)
      );
      return identita;
    }

    function creaStatisticheUtente(utente) {
      return creaElemento(
        document,
        "div",
        "user-stats",
        `${utente.partiteGiocate} giocate · ${utente.partiteVinte} vinte · ${percentualeVittorie(utente)}% win rate`
      );
    }

    function creaStatoUtente(utente) {
      const contenitore = creaElemento(document, "div", "user-status");
      contenitore.append(creaElemento(
        document,
        "span",
        `status-badge status-${utente.stato}`,
        etichettaStato(utente.stato)
      ));
      if (utente.stato === "sospeso" && utente.sospesoFino) {
        contenitore.append(creaElemento(
          document,
          "div",
          "suspension-date",
          `Fino al ${formattaData(utente.sospesoFino)}`
        ));
      }
      return contenitore;
    }

    function creaAvvisi(utente) {
      if (utente.avvisi.length === 0) {
        return creaElemento(document, "span", "warning-list", "Nessuno");
      }
      const lista = creaElemento(document, "ul", "warning-list");
      for (const avviso of utente.avvisi) {
        lista.append(creaElemento(document, "li", "", avviso.motivo));
      }
      return lista;
    }

    function creaAzioni(utente) {
      const lista = creaElemento(document, "div", "action-list");
      const azioni = azioniPerStato(utente.stato);
      if (azioni.length === 0) {
        lista.append(creaElemento(document, "span", "warning-list", "Nessuna azione disponibile"));
        return lista;
      }
      for (const azione of azioni) {
        const etichetta = ETICHETTE_AZIONE[azione];
        const pulsante = creaElemento(document, "button", "action-button", etichetta);
        pulsante.type = "button";
        pulsante.dataset.action = azione;
        pulsante.dataset.uid = utente.uid;
        pulsante.setAttribute("aria-label", `${etichetta} per ${utente.nickname}`);
        lista.append(pulsante);
      }
      return lista;
    }

    function creaRigaUtente(utente) {
      const riga = creaElemento(document, "tr", "user-row");
      for (const contenuto of [
        creaIdentita(utente),
        creaStatisticheUtente(utente),
        creaStatoUtente(utente),
        creaAvvisi(utente),
        creaAzioni(utente)
      ]) {
        const cella = creaElemento(document, "td");
        cella.append(contenuto);
        riga.append(cella);
      }
      return riga;
    }

    function aggiungiDettaglio(lista, etichetta, valore) {
      lista.append(
        creaElemento(document, "dt", "", etichetta),
        creaElemento(document, "dd", "", valore)
      );
    }

    function creaCardUtente(utente) {
      const card = creaElemento(document, "article", "user-card");
      const testa = creaElemento(document, "div", "user-card-head");
      testa.append(creaIdentita(utente), creaStatoUtente(utente));
      const dettagli = creaElemento(document, "dl");
      aggiungiDettaglio(dettagli, "Partite", String(utente.partiteGiocate));
      aggiungiDettaglio(dettagli, "Vittorie", String(utente.partiteVinte));
      aggiungiDettaglio(dettagli, "Win rate", `${percentualeVittorie(utente)}%`);
      aggiungiDettaglio(
        dettagli,
        "Avvisi",
        utente.avvisi.length ? utente.avvisi.map(avviso => avviso.motivo).join(" · ") : "Nessuno"
      );
      card.append(testa, dettagli, creaAzioni(utente));
      return card;
    }

    function renderUtenti() {
      const visibili = filtraUtenti(stato.utenti, stato.ricerca);
      dom.usersTableBody.replaceChildren(...visibili.map(creaRigaUtente));
      dom.usersCards.replaceChildren(...visibili.map(creaCardUtente));
      dom.resultsCount.textContent = testoRisultati(visibili.length);
      dom.clearSearchButton.hidden = stato.ricerca.trim() === "";
      dom.emptyState.hidden = visibili.length !== 0;
      const nessunRegistrato = stato.utenti.length === 0;
      dom.emptyStateTitle.textContent = nessunRegistrato
        ? "Nessun utente registrato"
        : "Nessun utente corrisponde alla ricerca";
      dom.emptyStateMessage.textContent = nessunRegistrato
        ? "Gli utenti compariranno qui dopo la registrazione."
        : "Modifica il testo oppure visualizza nuovamente tutti gli utenti.";
      const cancellaVuoto = dom.emptyState.querySelector('[data-action="clear-search"]');
      if (cancellaVuoto) cancellaVuoto.hidden = nessunRegistrato;
    }

    function mostraToast(testo, isErrore) {
      if (timerToast) window.clearTimeout(timerToast);
      dom.adminToast.textContent = String(testo);
      dom.adminToast.classList.toggle("is-error", Boolean(isErrore));
      dom.adminToast.classList.add("is-visible");
      timerToast = window.setTimeout(() => {
        dom.adminToast.classList.remove("is-visible");
        timerToast = null;
      }, 4000);
    }

    async function carica() {
      if (stato.caricamento) return;
      stato.caricamento = true;
      dom.refreshButton.disabled = true;
      mostraStatoPagina("loading");
      try {
        stato.utenti = await client.caricaUtenti();
        stato.aggiornatoIl = Date.now();
        stato.errore = null;
        renderStatistiche();
        renderUtenti();
        dom.lastUpdated.textContent = `Aggiornato: ${formattaData(stato.aggiornatoIl)}`;
        mostraStatoPagina("ready");
      } catch (errore) {
        stato.errore = errore;
        if (errore instanceof ErroreHttpAdmin && (errore.status === 401 || errore.status === 403)) {
          mostraStatoPagina("denied");
        } else {
          dom.adminErrorMessage.textContent = errore.message || "Controlla la connessione e riprova.";
          mostraStatoPagina("error");
        }
      } finally {
        stato.caricamento = false;
        dom.refreshButton.disabled = false;
      }
    }

    async function eseguiLogout() {
      dom.logoutButton.disabled = true;
      try {
        await client.logout();
      } catch (_errore) {
        // Il tentativo di cancellazione del cookie è già stato eseguito.
      }
      window.location.assign("/login.html");
    }

    function payloadAzione(configurazione, utente, modulo) {
      const motivo = modulo.elements.namedItem("motivo");
      const giorni = modulo.elements.namedItem("giorni");
      if (configurazione.azione === "warn") {
        return { uid: utente.uid, motivo: motivo.value.trim() };
      }
      if (configurazione.azione === "suspend") {
        const controllo = validaSospensione(giorni.value);
        if (!controllo.valido) throw new Error(controllo.errore);
        return {
          uid: utente.uid,
          giorni: controllo.giorni,
          motivo: motivo.value.trim()
        };
      }
      if (configurazione.azione === "ban") {
        return { uid: utente.uid, motivo: motivo.value.trim() };
      }
      return { uid: utente.uid };
    }

    function elementiFocusDialogo() {
      if (!stato.dialogo) return [];
      return Array.from(stato.dialogo.pannello.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ));
    }

    function gestisciTastieraDialogo(evento) {
      if (!stato.dialogo) return;
      if (evento.key === "Escape" && !stato.invioInCorso) {
        evento.preventDefault();
        chiudiDialogo();
        return;
      }
      if (evento.key !== "Tab") return;
      const elementi = elementiFocusDialogo();
      if (elementi.length === 0) return;
      const primo = elementi[0];
      const ultimo = elementi[elementi.length - 1];
      if (evento.shiftKey && document.activeElement === primo) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault();
        primo.focus();
      }
    }

    function chiudiDialogo() {
      if (!stato.dialogo || stato.invioInCorso) return;
      document.removeEventListener("keydown", gestisciTastieraDialogo);
      dom.adminDialogRoot.replaceChildren();
      document.body.classList.remove("modal-open");
      stato.dialogo = null;
      if (focusPrecedente && focusPrecedente.isConnected) focusPrecedente.focus();
      focusPrecedente = null;
    }

    function creaCampoDialogo(nome, richiesto) {
      const gruppo = creaElemento(document, "div", "field");
      const etichetta = creaElemento(
        document,
        "label",
        "",
        nome === "giorni" ? "Numero di giorni" : "Motivo"
      );
      const controllo = nome === "motivo"
        ? creaElemento(document, "textarea")
        : creaElemento(document, "input");
      controllo.id = `admin-dialog-${nome}`;
      controllo.name = nome;
      controllo.required = richiesto;
      etichetta.htmlFor = controllo.id;
      if (nome === "giorni") {
        controllo.type = "number";
        controllo.min = "1";
        controllo.step = "1";
        controllo.inputMode = "numeric";
        controllo.value = "3";
      } else {
        controllo.maxLength = 500;
      }
      gruppo.append(etichetta, controllo);
      return gruppo;
    }

    function apriDialogo(configurazione, utente, trigger) {
      focusPrecedente = trigger;
      const backdrop = creaElemento(document, "div", "dialog-backdrop");
      const pannello = creaElemento(document, "section", "dialog-panel");
      pannello.setAttribute("role", "dialog");
      pannello.setAttribute("aria-modal", "true");
      pannello.setAttribute("aria-labelledby", "adminDialogTitle");
      pannello.setAttribute("aria-describedby", "adminDialogDescription");
      pannello.tabIndex = -1;

      const titolo = creaElemento(document, "h2", "", configurazione.titolo);
      titolo.id = "adminDialogTitle";
      const descrizione = creaElemento(document, "p", "", configurazione.descrizione);
      descrizione.id = "adminDialogDescription";
      const modulo = creaElemento(document, "form", "dialog-form");
      modulo.noValidate = true;
      for (const campo of configurazione.campi) {
        modulo.append(creaCampoDialogo(campo, configurazione.azione === "warn" && campo === "motivo"));
      }
      const errore = creaElemento(document, "p", "field-error");
      errore.setAttribute("aria-live", "assertive");
      const azioni = creaElemento(document, "div", "dialog-actions");
      const annulla = creaElemento(document, "button", "button button-secondary", "Annulla");
      annulla.type = "button";
      annulla.dataset.action = "close-dialog";
      const conferma = creaElemento(
        document,
        "button",
        configurazione.pericolo ? "button button-danger" : "button button-primary",
        configurazione.conferma
      );
      conferma.type = "submit";
      azioni.append(annulla, conferma);
      modulo.append(errore, azioni);
      pannello.append(titolo, descrizione, modulo);
      backdrop.append(pannello);
      dom.adminDialogRoot.replaceChildren(backdrop);
      document.body.classList.add("modal-open");
      stato.dialogo = { configurazione, utente, pannello, modulo, errore, conferma };
      document.addEventListener("keydown", gestisciTastieraDialogo);
      backdrop.addEventListener("click", evento => {
        if (evento.target === backdrop && !stato.invioInCorso) chiudiDialogo();
      });
      modulo.addEventListener("submit", evento => {
        evento.preventDefault();
        inviaDialogo();
      });
      const primoCampo = modulo.querySelector("input, textarea");
      (primoCampo || conferma).focus();
    }

    async function inviaDialogo() {
      if (!stato.dialogo || stato.invioInCorso) return;
      const dialogo = stato.dialogo;
      dialogo.errore.textContent = "";
      let payload;
      try {
        payload = payloadAzione(dialogo.configurazione, dialogo.utente, dialogo.modulo);
        if (dialogo.configurazione.azione === "warn" && !payload.motivo) {
          throw new Error("Inserisci il motivo dell’avviso.");
        }
      } catch (errore) {
        dialogo.errore.textContent = errore.message;
        return;
      }

      stato.invioInCorso = true;
      dialogo.conferma.disabled = true;
      const testoConferma = dialogo.conferma.textContent;
      dialogo.conferma.textContent = "Operazione in corso";
      try {
        await client.eseguiAzione(dialogo.configurazione.azione, payload);
      } catch (errore) {
        if (errore instanceof ErroreHttpAdmin && (errore.status === 401 || errore.status === 403)) {
          stato.invioInCorso = false;
          chiudiDialogo();
          mostraStatoPagina("denied");
          return;
        }
        dialogo.errore.textContent = errore.message || "Operazione non riuscita.";
        dialogo.conferma.disabled = false;
        dialogo.conferma.textContent = testoConferma;
        stato.invioInCorso = false;
        return;
      }

      stato.invioInCorso = false;
      chiudiDialogo();
      mostraToast("Operazione completata", false);
      await carica();
    }

    dom.searchInput.addEventListener("input", evento => {
      stato.ricerca = evento.currentTarget.value;
      renderUtenti();
    });

    document.addEventListener("click", evento => {
      if (!(evento.target instanceof Element)) return;
      const controllo = evento.target.closest("[data-action]");
      if (!controllo) return;
      const azione = controllo.dataset.action;
      if (azione === "refresh") {
        carica();
        return;
      }
      if (azione === "logout") {
        eseguiLogout();
        return;
      }
      if (azione === "clear-search") {
        stato.ricerca = "";
        dom.searchInput.value = "";
        renderUtenti();
        dom.searchInput.focus();
        return;
      }
      if (azione === "close-dialog") {
        chiudiDialogo();
        return;
      }
      const utente = stato.utenti.find(elemento => elemento.uid === controllo.dataset.uid);
      if (!utente || !azioniPerStato(utente.stato).includes(azione)) return;
      const configurazione = creaConfigurazioneAzione(azione, utente);
      if (configurazione) apriDialogo(configurazione, utente, controllo);
    });

    carica();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  }

  return {
    normalizzaUtente,
    percentualeVittorie,
    calcolaStatistiche,
    filtraUtenti,
    azioniPerStato,
    validaSospensione,
    ErroreHttpAdmin,
    creaClientAdmin,
    creaConfigurazioneAzione,
    creaElemento,
    bootstrap
  };
});