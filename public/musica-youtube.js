"use strict";

(() => {
  const blocco = document.getElementById("musica-youtube");
  if (!blocco) return;

  const pulsante = document.getElementById("btn-musica-youtube");
  const pannello = document.getElementById("pannello-musica-youtube");
  const chiudi = document.getElementById("chiudi-musica-youtube");
  const modulo = document.getElementById("modulo-musica-youtube");
  const ingresso = document.getElementById("link-musica-youtube");
  const messaggio = document.getElementById("messaggio-musica-youtube");
  const contenitore = document.getElementById("player-musica-youtube");
  const pulsanteChat = document.getElementById("btn-chat");

  function chiudiPannello(ripristinaFocus = false) {
    contenitore.replaceChildren();
    pannello.hidden = true;
    pulsante.setAttribute("aria-expanded", "false");
    messaggio.textContent = "";
    if (ripristinaFocus) pulsante.focus();
  }

  function leggiLink(testo) {
    let link;
    try {
      link = new URL(testo.trim());
    } catch {
      return null;
    }
    if (link.protocol !== "https:" && link.protocol !== "http:") return null;

    const sito = link.hostname;
    const [, pagina, id] = link.pathname.split("/");
    let video = null;
    let playlist = null;
    if (sito === "youtu.be") {
      video = pagina;
    } else if (["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com"].includes(sito)) {
      if (pagina === "watch") video = link.searchParams.get("v");
      if (["shorts", "live", "embed"].includes(pagina)) video = id;
      if (["watch", "playlist", "embed"].includes(pagina)) playlist = link.searchParams.get("list");
    }

    if (/^[\w-]{11}$/.test(video || "")) {
      const embed = new URL("https://www.youtube.com/embed/" + video);
      if (/^[\w-]{10,100}$/.test(playlist || "")) embed.searchParams.set("list", playlist);
      return embed;
    }
    if (/^[\w-]{10,100}$/.test(playlist || "")) {
      return new URL("https://www.youtube.com/embed/videoseries?list=" + playlist);
    }
    return null;
  }

  pulsante.addEventListener("click", () => {
    if (!pannello.hidden) {
      chiudiPannello(true);
      return;
    }
    if (pulsanteChat?.getAttribute("aria-expanded") === "true") pulsanteChat.click();
    pannello.hidden = false;
    pulsante.setAttribute("aria-expanded", "true");
    chiudi.focus();
  });
  chiudi.addEventListener("click", () => chiudiPannello(true));
  blocco.addEventListener("keydown", evento => {
    if (evento.key !== "Escape" || pannello.hidden) return;
    evento.stopPropagation();
    chiudiPannello(true);
  });
  pulsanteChat?.addEventListener("click", () => chiudiPannello());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !pannello.hidden) chiudiPannello();
  });
  window.addEventListener("pagehide", () => chiudiPannello());

  modulo.addEventListener("submit", evento => {
    evento.preventDefault();
    const link = leggiLink(ingresso.value);
    if (!link) {
      messaggio.textContent = "Incolla un link a un video o a una playlist di YouTube.";
      ingresso.focus();
      return;
    }

    messaggio.textContent = "";
    link.searchParams.set("playsinline", "1");
    const iframe = document.createElement("iframe");
    iframe.title = "Riproduzione musicale su YouTube";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allow = "encrypted-media; fullscreen; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.src = link.href;
    contenitore.replaceChildren(iframe);
  });

  window.MusicaYouTube = {
    impostaDisponibilita(attiva) {
      blocco.hidden = attiva !== true;
      if (blocco.hidden) chiudiPannello();
    }
  };
})();
