"use strict";

(() => {
  const blocco = document.getElementById("musica-youtube");
  if (!blocco) return;

  const agente = navigator.userAgent;
  const smartphone = /iPhone|iPod|Windows Phone|Android.*Mobile/i.test(agente) ||
    navigator.userAgentData?.mobile === true;
  if (smartphone && !/iPad|Tablet/i.test(agente)) return;

  blocco.innerHTML = `
    <button type="button" id="btn-musica-youtube" aria-label="Apri il player YouTube"
      aria-controls="pannello-musica-youtube" aria-expanded="false">♫</button>
    <section id="pannello-musica-youtube" aria-labelledby="titolo-musica-youtube" data-vista="elenco" hidden>
      <div class="intestazione-musica-youtube">
        <strong id="titolo-musica-youtube">Musica YouTube</strong>
        <div class="comandi-finestra-youtube" role="group" aria-label="Comandi del player">
          <button type="button" id="riduci-musica-youtube" aria-label="Riduci il player" title="Riduci il player">−</button>
          <button type="button" id="vista-musica-youtube" aria-label="Mostra solo il video" title="Mostra solo il video" disabled>□</button>
          <button type="button" id="chiudi-musica-youtube" aria-label="Chiudi e interrompi la musica" title="Chiudi e interrompi la musica">×</button>
        </div>
      </div>
      <form id="modulo-musica-youtube" role="search" aria-label="YouTube">
        <label class="solo-lettori-schermo" for="cerca-musica-youtube">Cerca su YouTube</label>
        <div class="riga-musica-youtube">
          <input id="cerca-musica-youtube" type="search" maxlength="120" autocomplete="off" placeholder="Cerca su YouTube" required>
          <button type="submit">Cerca</button>
        </div>
      </form>
      <div id="player-musica-youtube"></div>
      <p id="messaggio-musica-youtube" role="status"></p>
      <a id="apri-video-youtube" target="_blank" rel="noopener" hidden>Apri il video su YouTube ↗</a>
      <ul id="risultati-musica-youtube" aria-label="Risultati di ricerca"></ul>
      <button type="button" id="altri-risultati-youtube" hidden>Altri risultati</button>
    </section>`;

  const nodo = id => document.getElementById(id);
  const pulsante = nodo("btn-musica-youtube");
  const pannello = nodo("pannello-musica-youtube");
  const riduci = nodo("riduci-musica-youtube");
  const vista = nodo("vista-musica-youtube");
  const chiudi = nodo("chiudi-musica-youtube");
  const modulo = nodo("modulo-musica-youtube");
  const ingresso = nodo("cerca-musica-youtube");
  const messaggio = nodo("messaggio-musica-youtube");
  const contenitore = nodo("player-musica-youtube");
  const apriVideo = nodo("apri-video-youtube");
  const risultati = nodo("risultati-musica-youtube");
  const altri = nodo("altri-risultati-youtube");
  const voci = new Map();
  const sogliaVoce = 0.012;
  const durataCodaVoce = 600;
  let abbassaMusica = false;
  let musicaAttiva = false;
  let audioContext = null;
  let timerVoci = null;
  let ultimaVoce = -Infinity;
  let volumePrimaDelleVoci = null;
  let volumeRidotto = null;
  let vistaPrimaDiRidurre = "elenco";
  let server = window.location.origin;
  let leggiToken = null;
  let queryAttiva = "";
  let paginaSuccessiva = null;
  let chiamata = null;
  let caricamentoApi = null;
  let player = null;

  function disconnettiAnalizzatore(audio) {
    voci.get(audio)?.sorgente.disconnect();
    voci.set(audio, null);
  }

  function livelloVoce(audio, analisi) {
    const stream = audio.srcObject;
    if (audio.muted || audio.paused || audio.volume === 0 || !stream?.getAudioTracks().some(traccia => traccia.readyState === "live" && traccia.enabled)) return 0;
    if (analisi?.stream !== stream) {
      disconnettiAnalizzatore(audio);
      try {
        const sorgente = audioContext.createMediaStreamSource(stream);
        const analizzatore = audioContext.createAnalyser();
        analizzatore.fftSize = 2048;
        sorgente.connect(analizzatore);
        analisi = { stream, sorgente, analizzatore, campioni: new Float32Array(analizzatore.fftSize) };
        voci.set(audio, analisi);
      } catch {
        return 0;
      }
    }
    analisi.analizzatore.getFloatTimeDomainData(analisi.campioni);
    let energia = 0;
    for (const campione of analisi.campioni) energia += campione * campione;
    return Math.sqrt(energia / analisi.campioni.length);
  }

  function ripristinaVolumeMusica() {
    if (volumePrimaDelleVoci === null) return;
    const attuale = player?.getVolume?.();
    if (attuale === volumeRidotto || attuale === volumePrimaDelleVoci || !Number.isFinite(attuale)) {
      player?.setVolume?.(volumePrimaDelleVoci);
    }
    volumePrimaDelleVoci = null;
    volumeRidotto = null;
  }

  function rilevaVoci() {
    const adesso = performance.now();
    for (const [audio, analisi] of voci) {
      if (livelloVoce(audio, analisi) > sogliaVoce) {
        ultimaVoce = adesso;
        break;
      }
    }
    if (adesso - ultimaVoce >= durataCodaVoce) {
      ripristinaVolumeMusica();
      return;
    }
    if (volumePrimaDelleVoci !== null || player?.isMuted?.()) return;
    const attuale = player?.getVolume?.();
    if (!Number.isFinite(attuale) || attuale <= 0) return;
    volumePrimaDelleVoci = attuale;
    volumeRidotto = Math.round(attuale * 0.35);
    player.setVolume(volumeRidotto);
  }

  function aggiornaRilevamentoVoci() {
    if (abbassaMusica && musicaAttiva && voci.size && audioContext?.state === "running") {
      if (timerVoci === null) timerVoci = setInterval(rilevaVoci, 75);
      return;
    }
    clearInterval(timerVoci);
    timerVoci = null;
    ultimaVoce = -Infinity;
    for (const audio of voci.keys()) disconnettiAnalizzatore(audio);
    ripristinaVolumeMusica();
  }

  function preparaAudio() {
    const Contesto = window.AudioContext || window.webkitAudioContext;
    if (!abbassaMusica || !Contesto) return;
    try {
      audioContext ||= new Contesto();
      audioContext.resume().then(aggiornaRilevamentoVoci).catch(() => {});
    } catch {}
  }

  function impostaMusicaAttiva(attiva) {
    musicaAttiva = attiva;
    aggiornaRilevamentoVoci();
  }

  function cambiaVista(modo) {
    pannello.dataset.vista = modo;
    const elenco = modo === "elenco";
    modulo.hidden = !elenco;
    risultati.hidden = !elenco;
    altri.hidden = !elenco || !paginaSuccessiva;
    vista.disabled = !contenitore.hasChildNodes();
    const azioneVista = elenco ? "Mostra solo il video" : "Mostra lista e ricerca";
    vista.setAttribute("aria-label", azioneVista);
    vista.title = azioneVista;
    const azioneRiduci = modo === "compatto" ? "Ripristina la dimensione del player" : "Riduci il player";
    riduci.setAttribute("aria-label", azioneRiduci);
    riduci.title = azioneRiduci;
    pannello.scrollTop = 0;
  }

  function nascondiPannello(ripristinaFocus) {
    pannello.hidden = true;
    pulsante.hidden = false;
    pulsante.setAttribute("aria-expanded", "false");
    if (ripristinaFocus && !blocco.hidden) pulsante.focus();
  }

  function riduciPlayer(ripristinaFocus = false) {
    if (!contenitore.hasChildNodes()) {
      nascondiPannello(ripristinaFocus);
    } else if (pannello.dataset.vista === "compatto") {
      cambiaVista(vistaPrimaDiRidurre);
    } else {
      vistaPrimaDiRidurre = pannello.dataset.vista;
      cambiaVista("compatto");
      if (ripristinaFocus) riduci.focus();
    }
  }

  function rimuoviVideo() {
    impostaMusicaAttiva(false);
    player?.stopVideo?.();
    player?.destroy?.();
    player = null;
    contenitore.replaceChildren();
  }

  function chiudiPlayer(ripristinaFocus = false) {
    chiamata?.abort();
    chiamata = null;
    rimuoviVideo();
    ingresso.value = "";
    queryAttiva = "";
    paginaSuccessiva = null;
    risultati.replaceChildren();
    messaggio.textContent = "";
    apriVideo.hidden = true;
    apriVideo.removeAttribute("href");
    vistaPrimaDiRidurre = "elenco";
    cambiaVista("elenco");
    nascondiPannello(ripristinaFocus);
  }

  function caricaApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (caricamentoApi) return caricamentoApi;

    caricamentoApi = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const precedente = window.onYouTubeIframeAPIReady;
      let timer;
      function fallita() {
        clearTimeout(timer);
        script.remove();
        window.onYouTubeIframeAPIReady = precedente;
        reject(new Error("Player non disponibile. Riprova."));
      }
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        window.onYouTubeIframeAPIReady = precedente;
        resolve(window.YT);
        if (typeof precedente === "function") precedente();
      };
      script.src = "https://www.youtube.com/iframe_api";
      script.referrerPolicy = "strict-origin-when-cross-origin";
      script.onerror = fallita;
      timer = setTimeout(fallita, 10000);
      document.head.appendChild(script);
    }).catch(errore => {
      caricamentoApi = null;
      throw errore;
    });
    return caricamentoApi;
  }

  async function riproduci(video) {
    preparaAudio();
    rimuoviVideo();
    messaggio.textContent = "";
    apriVideo.hidden = true;
    apriVideo.href = "https://www.youtube.com/watch?v=" + video.id;

    const iframe = document.createElement("iframe");
    const url = new URL("https://www.youtube.com/embed/" + video.id);
    url.search = new URLSearchParams({ enablejsapi: "1", origin: location.origin, playsinline: "1" });
    iframe.src = url.href;
    iframe.title = "Player YouTube";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    iframe.allowFullscreen = true;
    contenitore.replaceChildren(iframe);
    cambiaVista("elenco");

    const attuale = () => contenitore.contains(iframe);
    const errorePlayer = () => {
      if (!attuale()) return;
      impostaMusicaAttiva(false);
      messaggio.textContent = "Questo video non è riproducibile nel player.";
      apriVideo.hidden = false;
    };

    try {
      const YT = await caricaApi();
      if (!attuale()) return;
      player = new YT.Player(iframe, { events: {
        onReady(evento) {
          if (!attuale() || pannello.hidden || document.hidden) return;
          evento.target.playVideo();
        },
        onStateChange(evento) {
          if (!attuale()) return;
          const attiva = evento.data === YT.PlayerState.PLAYING && !pannello.hidden && !document.hidden;
          if (attiva) messaggio.textContent = "";
          if (evento.data === YT.PlayerState.PLAYING && !attiva) evento.target.pauseVideo();
          impostaMusicaAttiva(attiva);
        },
        onAutoplayBlocked() {
          if (attuale() && !pannello.hidden) messaggio.textContent = "Premi Play nel lettore per iniziare.";
        },
        onError: errorePlayer
      } });
    } catch {
      if (attuale()) {
        messaggio.textContent = "Player YouTube non disponibile. Riprova.";
        apriVideo.hidden = false;
      }
    }
  }

  function testoYouTube(sorgente) {
    const entita = document.createElement("textarea");
    entita.innerHTML = String(sorgente || "").replace(/</g, "&lt;");
    return entita.value;
  }

  function aggiungiRisultato(video) {
    if (!/^[\w-]{11}$/.test(video.id)) return;
    const voce = document.createElement("li");
    const bottone = document.createElement("button");
    bottone.type = "button";
    bottone.className = "risultato-youtube";
    const miniatura = document.createElement("img");
    miniatura.width = 120;
    miniatura.height = 90;
    miniatura.loading = "lazy";
    miniatura.alt = "";
    miniatura.src = "https://i.ytimg.com/vi/" + video.id + "/default.jpg";
    const descrizione = document.createElement("span");
    const titolo = document.createElement("strong");
    titolo.textContent = testoYouTube(video.titolo);
    const canale = document.createElement("small");
    canale.textContent = testoYouTube(video.canale);
    descrizione.append(titolo, canale);
    bottone.append(miniatura, descrizione);
    bottone.addEventListener("click", () => riproduci(video));
    voce.append(bottone);
    risultati.append(voce);
  }

  async function cerca(query, pagina = null) {
    chiamata?.abort();
    const richiesta = new AbortController();
    chiamata = richiesta;
    if (!pagina) {
      risultati.replaceChildren();
      queryAttiva = query;
      paginaSuccessiva = null;
    }
    altri.hidden = true;
    messaggio.textContent = "Ricerca in corso…";
    const url = new URL("/api/youtube/cerca", server);
    url.searchParams.set("q", query);
    if (pagina) url.searchParams.set("pagina", pagina);
    const token = leggiToken?.();
    try {
      const risposta = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: "Bearer " + token } : {},
        signal: richiesta.signal
      });
      const esito = await risposta.json();
      if (chiamata !== richiesta) return;
      if (!risposta.ok) throw new Error(esito.errore || "Ricerca non disponibile.");
      for (const video of esito.video) aggiungiRisultato(video);
      paginaSuccessiva = esito.paginaSuccessiva;
      messaggio.textContent = risultati.children.length ? "" : "Nessun video trovato.";
    } catch (errore) {
      if (chiamata === richiesta) messaggio.textContent = errore.message || "Ricerca non disponibile.";
    } finally {
      if (chiamata === richiesta) altri.hidden = pannello.dataset.vista !== "elenco" || !paginaSuccessiva;
    }
  }

  pulsante.addEventListener("click", () => {
    preparaAudio();
    pannello.hidden = false;
    pulsante.hidden = true;
    pulsante.setAttribute("aria-expanded", "true");
    ingresso.focus();
  });
  riduci.addEventListener("click", () => riduciPlayer(true));
  vista.addEventListener("click", () => cambiaVista(pannello.dataset.vista === "elenco" ? "video" : "elenco"));
  chiudi.addEventListener("click", () => chiudiPlayer(true));
  blocco.addEventListener("keydown", evento => {
    if (evento.key !== "Escape" || pannello.hidden) return;
    evento.stopPropagation();
    riduciPlayer(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      player?.pauseVideo?.();
      impostaMusicaAttiva(false);
    }
  });
  window.addEventListener("pagehide", () => chiudiPlayer());
  modulo.addEventListener("submit", evento => {
    evento.preventDefault();
    const query = ingresso.value.trim();
    if (query) cerca(query);
  });
  altri.addEventListener("click", () => {
    if (paginaSuccessiva) cerca(queryAttiva, paginaSuccessiva);
  });

  window.MusicaYouTube = {
    avvia(preferenze, origine, token) {
      server = origine;
      leggiToken = token;
      abbassaMusica = (preferenze?.abbassaMusicaConVoci ?? preferenze?.abbassaVociConMusica) === true;
      blocco.hidden = preferenze?.playerYouTube === false;
      if (blocco.hidden) chiudiPlayer();
      aggiornaRilevamentoVoci();
    },
    registraVoce(audio) {
      if (!voci.has(audio)) voci.set(audio, null);
      aggiornaRilevamentoVoci();
    },
    rimuoviVoce(audio) {
      if (!voci.has(audio)) return;
      disconnettiAnalizzatore(audio);
      voci.delete(audio);
      aggiornaRilevamentoVoci();
    }
  };
})();
