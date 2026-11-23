"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rateLimit = require("express-rate-limit");

function chiaveYouTube() {
  if (process.env.YOUTUBE_DATA_API_KEY) return process.env.YOUTUBE_DATA_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), ".config", "giochi-societa", "youtube.key"), "utf8").trim();
  } catch {
    return "";
  }
}

module.exports = function registraRicercaYouTube(app, richiediAuth) {
  const chiave = chiaveYouTube();
  const ricerche = new Map();
  const limite = rateLimit({
    windowMs: 60 * 1000,
    max: 12,
    keyGenerator: req => req.utente.uid,
    standardHeaders: true,
    legacyHeaders: false,
    message: { errore: "Troppe ricerche. Riprova tra un minuto." }
  });

  async function cerca(query, pagina) {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "10",
      relevanceLanguage: "it",
      q: query,
      fields: "nextPageToken,items(id/videoId,snippet(title,channelTitle))"
    });
    if (pagina) url.searchParams.set("pageToken", pagina);
    const risposta = await fetch(url, {
      headers: { "x-goog-api-key": chiave },
      signal: AbortSignal.timeout(8000)
    });
    const dati = await risposta.json();
    if (!risposta.ok) {
      const motivo = dati.error?.errors?.[0]?.reason;
      const quota = risposta.status === 429 || ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"].includes(motivo);
      throw Object.assign(new Error("Ricerca YouTube non riuscita"), { quota, statoYouTube: risposta.status });
    }
    return {
      video: (dati.items || []).filter(item => /^[\w-]{11}$/.test(item.id?.videoId || "")).map(item => ({
        id: item.id.videoId,
        titolo: item.snippet?.title || "Video YouTube",
        canale: item.snippet?.channelTitle || ""
      })),
      paginaSuccessiva: dati.nextPageToken || null
    };
  }

  app.get("/api/youtube/cerca", richiediAuth, limite, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const pagina = req.query.pagina ?? "";
    if (!query || query.length > 120 || typeof pagina !== "string" || !/^[\w=-]{0,256}$/.test(pagina)) {
      return res.status(400).json({ errore: "Inserisci un termine di ricerca valido." });
    }
    if (!chiave) return res.status(503).json({ errore: "La ricerca YouTube è in attesa di attivazione." });

    const id = JSON.stringify([query, pagina]);
    let richiesta = ricerche.get(id);
    if (!richiesta || richiesta.scadenza <= Date.now()) {
      if (!ricerche.has(id) && ricerche.size >= 150) ricerche.delete(ricerche.keys().next().value);
      richiesta = { scadenza: Date.now() + 15 * 60 * 1000, risultato: cerca(query, pagina) };
      ricerche.set(id, richiesta);
    }
    try {
      return res.json(await richiesta.risultato);
    } catch (errore) {
      if (ricerche.get(id) === richiesta) ricerche.delete(id);
      if (errore.quota) return res.status(429).json({ errore: "YouTube ha raggiunto il limite di ricerca. Riprova più tardi." });
      console.warn("Ricerca YouTube non disponibile:", errore.statoYouTube || errore.name);
      return res.status(503).json({ errore: "La ricerca YouTube non è disponibile al momento. Riprova tra poco." });
    }
  });
};
