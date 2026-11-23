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
    <section id="pannello-musica-youtube" aria-labelledby="titolo-musica-youtube" hidden>
      <div class="intestazione-musica-youtube">
        <strong id="titolo-musica-youtube">Musica YouTube</strong>
        <button type="button" id="riduci-musica-youtube" aria-label="Riduci il player a icona" title="Riduci a icona">−</button>
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
  const modulo = nodo("modulo-musica-youtube");
  const ingresso = nodo("cerca-musica-youtube");
  const messaggio = nodo("messaggio-musica-youtube");
  const contenitore = nodo("player-musica-youtube");
  const apriVideo = nodo("apri-video-youtube");
  const risultati = nodo("risultati-musica-youtube");
  const altri = nodo("altri-risultati-youtube");
  const voci = new Map();
  let abbassaVoci = false;
  let musicaAttiva = false;
  let audioContext = null;
  let server = window.location.origin;
  let leggiToken = null;
  let queryAttiva = "";
  let paginaSuccessiva = null;
  let chiamata = null;
  let caricamentoApi = null;
  let player = null;

  function aggiornaVoce(audio, voce, attenua) {
    if (!attenua) {
      if (voce.gain) {
        voce.sorgente.disconnect();
        voce.gain.disconnect();
        audio.muted = voce.muted;
        voce.gain = null;
        voce.sorgente = null;
      }
      if (voce.volume !== null) audio.volume = voce.volume;
      voce.volume = null;
      return;
    }
    if (voce.volume === null) voce.volume = audio.volume;
    const volumeRidotto = voce.volume * 0.35;
    audio.volume = volumeRidotto;
    if (Math.abs(audio.volume - volumeRidotto) < 0.01 || voce.gain || audioContext?.state !== "running") return;

    try {
      // Su alcuni tablet il volume del tag audio dipende dai controlli di sistema.
      voce.sorgente = audioContext.createMediaStreamSource(audio.srcObject);
      voce.gain = audioContext.createGain();
      voce.gain.gain.value = volumeRidotto;
      voce.sorgente.connect(voce.gain).connect(audioContext.destination);
      voce.muted = audio.muted;
      audio.muted = true;
    } catch {
      voce.sorgente?.disconnect();
      voce.gain?.disconnect();
      voce.gain = null;
      voce.sorgente = null;
    }
  }

  function impostaMusicaAttiva(attiva) {
    musicaAttiva = attiva;
    for (const [audio, voce] of voci) aggiornaVoce(audio, voce, abbassaVoci && attiva);
  }

  function preparaAudio() {
    if (!abbassaVoci || (!/iPad/i.test(agente) && !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))) return;
    const Contesto = window.AudioContext || window.webkitAudioContext;
    if (!Contesto) return;
    try {
      audioContext ||= new Contesto();
      audioContext.resume().then(() => impostaMusicaAttiva(musicaAttiva)).catch(() => {});
    } catch {}
  }

  function nascondiPannello(ripristinaFocus = false) {
    if (pannello.hidden) return;
    player?.pauseVideo?.();
    pannello.hidden = true;
    pulsante.hidden = false;
    pulsante.setAttribute("aria-expanded", "false");
    impostaMusicaAttiva(false);
    if (ripristinaFocus) pulsante.focus();
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
    player?.destroy?.();
    player = null;
    impostaMusicaAttiva(false);
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
    pannello.scrollTop = 0;

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
      if (chiamata === richiesta) altri.hidden = !paginaSuccessiva;
    }
  }

  pulsante.addEventListener("click", () => {
    preparaAudio();
    pannello.hidden = false;
    pulsante.hidden = true;
    pulsante.setAttribute("aria-expanded", "true");
    ingresso.focus();
  });
  riduci.addEventListener("click", () => nascondiPannello(true));
  blocco.addEventListener("keydown", evento => {
    if (evento.key !== "Escape" || pannello.hidden) return;
    evento.stopPropagation();
    nascondiPannello(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) nascondiPannello();
  });
  window.addEventListener("pagehide", () => nascondiPannello());
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
      abbassaVoci = preferenze?.abbassaVociConMusica === true;
      blocco.hidden = preferenze?.playerYouTube === false;
      if (blocco.hidden) nascondiPannello();
      impostaMusicaAttiva(musicaAttiva);
    },
    registraVoce(audio) {
      if (!voci.has(audio)) voci.set(audio, { volume: null, gain: null });
      aggiornaVoce(audio, voci.get(audio), abbassaVoci && musicaAttiva);
    },
    rimuoviVoce(audio) {
      const voce = voci.get(audio);
      if (!voce) return;
      aggiornaVoce(audio, voce, false);
      voci.delete(audio);
    }
  };
})();
