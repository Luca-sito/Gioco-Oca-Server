const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const app = express();

/* ============================================================
   CONFIGURAZIONE
   ============================================================ */

const PORT = Number(process.env.PORT || 3000);

const URL_FIREBASE =
  "https://giochi-societa-e8add-default-rtdb.europe-west1.firebasedatabase.app";

const ORIGINI_CONSENTITE = new Set([
  "https://solfriniluca1.wixstudio.com",
  "https://solfriniluca1-wixstudio-com.filesusr.com",
  "https://gioco-oca-server.onrender.com"
]);

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET mancante o troppo corta. Imposta su Render una chiave casuale di almeno 32 caratteri."
  );
}

const DURATA_LANCIO_DADI_MS = 700;
const DURATA_SALTO_MS = 220;
const DURATA_ANIMAZIONE_MASSIMA_MS = 6000;

const TOLLERANZA_MOSSA_MS = 2000;

const HEARTBEAT_MS = 15000;

const MAX_WS_MESSAGE_BYTES = 64 * 1024;

const SOGLIE_LIVELLO = [
  0,
  300,
  700,
  1200,
  1800,
  2500,
  3300,
  4200,
  5200,
  6300
];

const SOGLIA_VELOCISTA_SECONDI = 300;

/* ============================================================
   UTILITÀ
   ============================================================ */

function pulisciTesto(testo, massimo = 500) {
  if (typeof testo !== "string") return "";

  return testo
    .trim()
    .replace(/[<>]/g, "")
    .substring(0, massimo);
}

function numeroPositivo(valore, fallback = 0) {
  const n = Number(valore);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function stringaSicura(valore, massimo = 200) {
  return pulisciTesto(String(valore ?? ""), massimo);
}

function tokenCasuale(lunghezza = 24) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  let out = "";

  for (let i = 0; i < lunghezza; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

/* ============================================================
   EXPRESS
   ============================================================ */

app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (ORIGINI_CONSENTITE.has(origin)) {
        return callback(null, true);
      }

      console.warn("CORS bloccato:", origin);
      return callback(new Error("Origine non autorizzata."));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With"
    ]
  })
);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
    frameguard: false
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use(passport.initialize());

const server = http.createServer(app);

/* ============================================================
   WEBSOCKET
   ============================================================ */

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_WS_MESSAGE_BYTES,
  perMessageDeflate: false
});

/* ============================================================
   COOKIE
   ============================================================ */

const OPZIONI_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite:
    process.env.NODE_ENV === "production"
      ? "none"
      : "lax",
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: "/"
};

/* ============================================================
   RATE LIMIT
   ============================================================ */

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore:
      "Troppi tentativi. Riprova tra qualche minuto."
  }
});

const limiteContatti = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore:
      "Hai inviato troppe richieste. Riprova più tardi."
  }
});

const limiteMessaggiPrivati = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore:
      "Stai inviando messaggi troppo velocemente."
  }
});

const limiteAmici = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    errore:
      "Troppe richieste di amicizia in poco tempo."
  }
});

/* ============================================================
   FIREBASE
   ============================================================ */

let db = null;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT mancante."
    );
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: URL_FIREBASE
  });

  db = admin.database();

  console.log(
    "Firebase Admin inizializzato correttamente."
  );
} catch (e) {
  console.error(
    "Firebase Admin NON inizializzato:",
    e.message
  );
}

/* ============================================================
   UPLOAD AVATAR
   ============================================================ */

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024
  },
  fileFilter(req, file, cb) {
    if (
      !file ||
      !file.mimetype ||
      !file.mimetype.startsWith("image/")
    ) {
      return cb(
        new Error(
          "Il file deve essere un'immagine."
        )
      );
    }

    return cb(null, true);
  }
});

/* ============================================================
   TOKEN / AUTH
   ============================================================ */

function creaToken(uid, nickname, ruolo) {
  return jwt.sign(
    {
      uid,
      nickname,
      ruolo
    },
    JWT_SECRET,
    {
      expiresIn: "30d"
    }
  );
}

function verificaToken(token) {
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function estraiTokenHeader(req) {
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  const header =
    req.headers.authorization || "";

  const parti = header.split(" ");

  if (
    parti.length === 2 &&
    /^Bearer$/i.test(parti[0])
  ) {
    return parti[1];
  }

  return null;
}

function estraiTokenDaCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;

  const parti = String(cookieHeader)
    .split(";")
    .map(x => x.trim());

  for (const parte of parti) {
    const indice = parte.indexOf("=");

    if (indice === -1) continue;

    const nome = parte.substring(0, indice);

    if (nome !== "token") continue;

    const valore =
      parte.substring(indice + 1);

    try {
      return decodeURIComponent(valore);
    } catch {
      return valore;
    }
  }

  return null;
}

async function richiediAuth(req, res, next) {
  const dati = verificaToken(
    estraiTokenHeader(req)
  );

  if (!dati) {
    return res.status(401).json({
      errore:
        "Devi effettuare il login."
    });
  }

  req.utente = dati;
  next();
}

async function richiediAdmin(req, res, next) {
  const dati = verificaToken(
    estraiTokenHeader(req)
  );

  if (!dati) {
    return res.status(401).json({
      errore:
        "Devi effettuare il login."
    });
  }

  if (dati.ruolo !== "admin") {
    return res.status(403).json({
      errore:
        "Accesso riservato agli amministratori."
    });
  }

  req.utenteAdmin = dati;
  next();
}

/* ============================================================
   FIREBASE HELPERS
   ============================================================ */

function preparaGiocatoriPerFirebase(giocatori) {
  const risultato = {};

  for (const uid in giocatori || {}) {
    const g = giocatori[uid];

    risultato[uid] = {
      nome: g.nome || "?",
      avatar: g.avatar || null,
      posizione: Number(g.posizione || 0),
      turniSaltati: Number(g.turniSaltati || 0)
    };
  }

  return risultato;
}

function preparaPartitaPerFirebase(partita) {
  return {
    id: partita.id,
    stanza: partita.stanza,
    creatore: partita.creatore,
    creatoDa: partita.creatoDa,
    tempo: partita.tempo,
    punti: partita.punti,
    modalita: partita.modalita,
    maxGiocatori: partita.maxGiocatori,
    chatAttiva: partita.chatAttiva !== false,

    fase:
      partita.fase ||
      "attesa_giocatori",

    giocatori:
      preparaGiocatoriPerFirebase(
        partita.giocatori
      ),

    ordineGiocatori:
      partita.ordineGiocatori || [],

    turnoAttuale:
      Number(partita.turnoAttuale || 0),

    iniziata:
      partita.iniziata === true,

    iniziataIl:
      partita.iniziataIl || null,

    punteggiOrdineIniziale:
      partita.punteggiOrdineIniziale ||
      null,

    tiriEffettuatiNelTurno:
      Number(
        partita.tiriEffettuatiNelTurno || 0
      ),

    tiriConsentitiNelTurno:
      Number(
        partita.tiriConsentitiNelTurno || 1
      ),

    tempoInizioTurno:
      partita.tempoInizioTurno || null,

    scadenzaTurno:
      partita.scadenzaTurno || null,

    invitati:
      partita.invitati || {},

    ordineDeterminazione:
      partita.ordineDeterminazione || [],

    risultatiDeterminazione:
      partita.risultatiDeterminazione || {},

    codaDeterminazione:
      partita.codaDeterminazione || [],

    turnoInCorsoDeterminazione:
      partita.turnoInCorsoDeterminazione ||
      null,

    gruppoSpareggioAttuale:
      partita.gruppoSpareggioAttuale ||
      null,

    ordineFinaleInAttesa:
      partita.ordineFinaleInAttesa === true,

    aggiornataIl:
      Date.now()
  };
}

async function salvaPartita(partita) {
  if (!db || !partita) return;

  await db
    .ref("partite/" + partita.id)
    .set(
      preparaPartitaPerFirebase(partita)
    );
}

async function aggiornaStatoPartita(
  partitaId,
  dati
) {
  if (!db || !partitaId) return;

  await db
    .ref("partite/" + partitaId)
    .update({
      ...dati,
      aggiornataIl: Date.now()
    });
}

async function caricaPartite() {
  if (!db) return {};

  const snap =
    await db
      .ref("partite")
      .once("value");

  return snap.val() || {};
}

/* ============================================================
   LIVELLI / XP / BADGE
   ============================================================ */

function calcolaLivello(xp) {
  const valore =
    Number.isFinite(Number(xp))
      ? Number(xp)
      : 0;

  let livello = 1;

  for (let i = 0; i < SOGLIE_LIVELLO.length; i++) {
    if (
      valore >= SOGLIE_LIVELLO[i]
    ) {
      livello = i + 1;
    } else {
      break;
    }
  }

  return {
    livello,
    sogliaAttuale:
      SOGLIE_LIVELLO[livello - 1],
    sogliaProssima:
      SOGLIE_LIVELLO[livello] ??
      null
  };
}

function calcolaBadge(utente) {
  const badge = [];

  const vinte =
    Number(utente?.partiteVinte || 0);

  const giocate =
    Number(utente?.partiteGiocate || 0);

  const xp =
    Number(utente?.xp || 0);

  const streakMax =
    Number(
      utente?.streakVittorieMassima || 0
    );

  const vittoriaVeloce =
    utente?.vittoriaPiuVeloceSecondi;

  if (vinte >= 10) {
    badge.push({
      icona: "🥉",
      nome: "Prime 10 vittorie"
    });
  }

  if (giocate >= 100) {
    badge.push({
      icona: "🥈",
      nome: "100 partite giocate"
    });
  }

  if (xp >= 500) {
    badge.push({
      icona: "🥇",
      nome: "500 punti XP"
    });
  }

  if (streakMax >= 20) {
    badge.push({
      icona: "👑",
      nome: "20 vittorie consecutive"
    });
  }

  if (
    vittoriaVeloce != null &&
    Number(vittoriaVeloce) <
      SOGLIA_VELOCISTA_SECONDI
  ) {
    badge.push({
      icona: "🏃",
      nome: "Velocista"
    });
  }

  return badge;
}

function xpVincita() {
  return (
    50 +
    Math.floor(Math.random() * 151)
  );
}

function xpSconfitta() {
  return (
    20 +
    Math.floor(Math.random() * 61)
  );
}

function xpPenalitaAbbandonoAutomatico() {
  return (
    200 +
    Math.floor(Math.random() * 101)
  );
}

function idConversazione(uidA, uidB) {
  return [uidA, uidB]
    .sort()
    .join("_");
}

async function concludiPartita(
  partita,
  vincitoreUid,
  nomeStanza,
  elencoPartecipanti,
  escludiXpPer
) {
  if (!db || !partita || partita.conclusa) {
    return;
  }

  partita.conclusa = true;

  try {
    const partecipanti =
      Array.isArray(elencoPartecipanti)
        ? elencoPartecipanti
        : (
            partita.ordineGiocatori || []
          ).map(uid => ({
            uid,
            nome:
              partita.giocatori[uid]
                ? partita.giocatori[uid].nome
                : "?"
          }));

    const esclusi =
      escludiXpPer || new Set();

    const durataSecondi =
      partita.iniziataIl
        ? Math.max(
            0,
            Math.round(
              (Date.now() -
                partita.iniziataIl) /
                1000
            )
          )
        : null;

    const xpVinti = xpVincita();

    const vincitore =
      partecipanti.find(
        p =>
          p.uid ===
          vincitoreUid
      );

    for (const p of participantesSafe(
      partecipanti
    )) {
      if (esclusi.has(p.uid)) {
        continue;
      }

      const ref =
        db.ref(
          "utenti/" +
            p.uid
        );

      const u =
        (
          await ref.once("value")
        ).val();

      if (!u) continue;

      if (
        p.uid === vincitoreUid
      ) {
        const nuovoStreak =
          Number(
            u.streakVittorieAttuale ||
              0
          ) + 1;

        const aggiornamenti = {
          partiteGiocate:
            admin.database
              .ServerValue
              .increment(1),

          partiteVinte:
            admin.database
              .ServerValue
              .increment(1),

          streakVittorieAttuale:
            nuovoStreak,

          streakVittorieMassima:
            Math.max(
              Number(
                u.streakVittorieMassima ||
                  0
              ),
              nuovoStreak
            ),

          xp:
            Number(u.xp || 0) +
            xpVinti
        };

        if (
          durataSecondi !== null &&
          (
            u.vittoriaPiuVeloceSecondi ==
              null ||
            durataSecondi <
              Number(
                u.vittoriaPiuVeloceSecondi
              )
          )
        ) {
          aggiornamenti.vittoriaPiuVeloceSecondi =
            durataSecondi;
        }

        await ref.update(
          aggiornamenti
        );
      } else {
        await ref.update({
          partiteGiocate:
            admin.database
              .ServerValue
              .increment(1),

          streakVittorieAttuale:
            0,

          xp:
            Math.max(
              0,
              Number(u.xp || 0) -
                xpSconfitta()
            )
        });
      }
    }

    await db
      .ref("storicoPartite")
      .push()
      .set({
        data: Date.now(),
        stanza: nomeStanza,
        vincitoreUid,
        vincitoreNome:
          vincitore?.nome || null,
        durataSecondi,
        xpVincitore: xpVinti,
        partecipanti
      });
  } catch (e) {
    console.error(
      "Errore conclusione partita:",
      e.message
    );
  }
}

function participantesSafe(
  partecipanti
) {
  return Array.isArray(
    partecipanti
  )
    ? partecipanti.filter(
        p =>
          p &&
          typeof p.uid === "string" &&
          p.uid.length > 0
      )
    : [];
}

/* ============================================================
   USER LOOKUP
   ============================================================ */

async function trovaUtentePerEmail(
  emailLower
) {
  if (!db) return null;

  const snap =
    await db
      .ref("utenti")
      .orderByChild("emailLower")
      .equalTo(emailLower)
      .once("value");

  if (!snap.exists()) {
    return null;
  }

  const val = snap.val();
  const uid = Object.keys(val)[0];

  return {
    uid,
    ...val[uid]
  };
}

async function trovaUtentePerGoogleId(
  googleId
) {
  if (!db || !googleId) {
    return null;
  }

  const snap =
    await db
      .ref("utenti")
      .orderByChild("googleId")
      .equalTo(googleId)
      .once("value");

  if (!snap.exists()) {
    return null;
  }

  const val = snap.val();
  const uid = Object.keys(val)[0];

  return {
    uid,
    ...val[uid]
  };
}

async function trovaUtentePerNickname(
  nicknameLower
) {
  if (!db) return null;

  const snap =
    await db
      .ref("utenti")
      .orderByChild("nicknameLower")
      .equalTo(nicknameLower)
      .once("value");

  if (!snap.exists()) {
    return null;
  }

  const val = snap.val();
  const uid = Object.keys(val)[0];

  return {
    uid,
    ...val[uid]
  };
}

async function statoAmicizia(
  mioUid,
  altroUid
) {
  if (mioUid === altroUid) {
    return "se_stesso";
  }

  const [
    snapAmici,
    snapInviata,
    snapRicevuta
  ] = await Promise.all([
    db
      .ref(
        `utenti/${mioUid}/amici/${altroUid}`
      )
      .once("value"),

    db
      .ref(
        `utenti/${mioUid}/richiesteInviate/${altroUid}`
      )
      .once("value"),

    db
      .ref(
        `utenti/${mioUid}/richiesteRicevute/${altroUid}`
      )
      .once("value")
  ]);

  if (snapAmici.exists()) {
    return "amici";
  }

  if (snapInviata.exists()) {
    return "richiesta_inviata";
  }

  if (snapRicevuta.exists()) {
    return "richiesta_ricevuta";
  }

  return "nessuno";
}

/* ============================================================
   GOOGLE OAUTH
   ============================================================ */

function preparaNicknameGoogle(
  nome,
  email
) {
  let base =
    pulisciTesto(
      nome || "",
      15
    )
      .replace(
        /[^a-zA-Z0-9_ ]/g,
        ""
      )
      .trim();

  if (!base) {
    base = "Google";
  }

  if (base.length < 5) {
    const parteEmail =
      String(email || "")
        .split("@")[0]
        .replace(
          /[^a-zA-Z0-9_]/g,
          ""
        );

    base =
      (
        base +
        parteEmail
      ).substring(
        0,
        15
      );
  }

  if (base.length < 5) {
    base = "GoogleUser";
  }

  return base.substring(0, 15);
}

async function generaNicknameGoogleUnico(
  nome,
  email
) {
  const base =
    preparaNicknameGoogle(
      nome,
      email
    );

  if (
    !await trovaUtentePerNickname(
      base.toLowerCase()
    )
  ) {
    return base;
  }

  for (let i = 1; i <= 99; i++) {
    const suffisso = String(i);

    const candidato =
      base.substring(
        0,
        15 -
          suffisso.length
      ) +
      suffisso;

    if (
      !await trovaUtentePerNickname(
        candidato.toLowerCase()
      )
    ) {
      return candidato;
    }
  }

  return (
    "Google" +
    Date.now().toString().slice(-8)
  );
}

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET;

const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL;

if (
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET &&
  GOOGLE_CALLBACK_URL
) {
  passport.use(
    new GoogleStrategy(
      {
        clientID:
          GOOGLE_CLIENT_ID,
        clientSecret:
          GOOGLE_CLIENT_SECRET,
        callbackURL:
          GOOGLE_CALLBACK_URL
      },
      async (
        accessToken,
        refreshToken,
        profile,
        done
      ) => {
        try {
          if (!db) {
            return done(
              new Error(
                "Database non disponibile."
              )
            );
          }

          const googleId =
            profile.id;

          const email =
            profile.emails?.[0]
              ?.value
              ?.trim()
              .toLowerCase();

          const emailVerificata =
            profile.emails?.[0]?.verified;

          if (!googleId) {
            return done(
              new Error(
                "Google non ha restituito un ID valido."
              )
            );
          }

          if (!email) {
            return done(
              new Error(
                "Google non ha restituito un indirizzo email."
              )
            );
          }

          if (
            emailVerificata === false
          ) {
            return done(
              new Error(
                "L'indirizzo email Google non è verificato."
              )
            );
          }

          let utente =
            await trovaUtentePerGoogleId(
              googleId
            );

          if (!utente) {
            utente =
              await trovaUtentePerEmail(
                email
              );
          }

          if (utente) {
            if (
              utente.stato ===
              "bannato"
            ) {
              return done(
                new Error(
                  "Il tuo account è stato bannato."
                )
              );
            }

            if (
              utente.stato ===
                "sospeso" &&
              utente.sospesoFino &&
              Number(
                utente.sospesoFino
              ) >
                Date.now()
            ) {
              return done(
                new Error(
                  "Account sospeso fino al " +
                    new Date(
                      utente.sospesoFino
                    ).toLocaleString(
                      "it-IT"
                    ) +
                    "."
                )
              );
            }

            await db
              .ref(
                "utenti/" +
                  utente.uid
              )
              .update({
                googleId,
                providerGoogle:
                  true,
                ultimoAccesso:
                  Date.now()
              });

            return done(
              null,
              {
                uid:
                  utente.uid,
                nickname:
                  utente.nickname,
                ruolo:
                  utente.ruolo ||
                  "utente"
              }
            );
          }

          const nickname =
            await generaNicknameGoogleUnico(
              profile.displayName,
              email
            );

          const nuovoRef =
            db
              .ref("utenti")
              .push();

          const uid =
            nuovoRef.key;

          await nuovoRef.set({
            partiteVinte: 0,
            partiteGiocate: 0,
            puntiTotali: 0,
            xp: 0,
            streakVittorieAttuale: 0,
            streakVittorieMassima: 0,
            vittoriaPiuVeloceSecondi:
              null,

            email,
            emailLower:
              email,

            nickname,
            nicknameLower:
              nickname.toLowerCase(),

            passwordHash: null,
            googleId,
            providerGoogle: true,

            avatar:
              profile.photos?.[0]?.value ||
              null,

            ruolo: "utente",
            stato: "attivo",
            sospesoFino: null,

            avvisi: [],
            creatoIl: Date.now(),
            ultimoAccesso:
              Date.now()
          });

          return done(
            null,
            {
              uid,
              nickname,
              ruolo: "utente"
            }
          );
        } catch (e) {
          console.error(
            "Errore verifica account Google:",
            e
          );

          return done(e);
        }
      }
    )
  );

  app.get(
    "/auth/google",
    passport.authenticate(
      "google",
      {
        scope: [
          "profile",
          "email"
        ]
      }
    )
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate(
      "google",
      {
        session: false,
        failureRedirect:
          "/accedi.html?errore=google"
      }
    ),
    async (req, res) => {
      try {
        const utente =
          req.user;

        if (
          !utente ||
          !utente.uid
        ) {
          return res.redirect(
            "/accedi.html?errore=google"
          );
        }

        const token =
          creaToken(
            utente.uid,
            utente.nickname,
            utente.ruolo ||
              "utente"
          );

        res.cookie(
          "token",
          token,
          OPZIONI_COOKIE
        );

        return res.redirect("/");
      } catch (e) {
        console.error(
          "Errore callback Google:",
          e
        );

        return res.redirect(
          "/accedi.html?errore=google"
        );
      }
    }
  );
}

/* ============================================================
   API ACCOUNT
   ============================================================ */

app.post(
  "/api/registrati",
  limiteLogin,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio account non disponibile."
      });
    }

    try {
      const {
        email,
        nickname,
        password
      } = req.body || {};

      if (
        !email ||
        !nickname ||
        !password
      ) {
        return res.status(400).json({
          errore:
            "Compila tutti i campi."
        });
      }

      const nicknamePulito =
        pulisciTesto(
          nickname,
          20
        );

      if (
        nicknamePulito.length < 5 ||
        nicknamePulito.length > 15
      ) {
        return res.status(400).json({
          errore:
            "Il nickname deve contenere da 5 a 15 caratteri."
        });
      }

      if (
        !/^[a-zA-Z0-9_ ]+$/.test(
          nicknamePulito
        )
      ) {
        return res.status(400).json({
          errore:
            "Il nickname contiene caratteri non consentiti."
        });
      }

      if (
        typeof password !== "string" ||
        password.length < 6 ||
        password.length > 100
      ) {
        return res.status(400).json({
          errore:
            "La password deve avere tra 6 e 100 caratteri."
        });
      }

      const emailPulita =
        pulisciTesto(
          email,
          100
        ).toLowerCase();

      if (
        !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(
          emailPulita
        )
      ) {
        return res.status(400).json({
          errore:
            "Inserisci un indirizzo email valido."
        });
      }

      const nicknameLower =
        nicknamePulito.toLowerCase();

      if (
        await trovaUtentePerEmail(
          emailPulita
        )
      ) {
        return res.status(400).json({
          errore:
            "Questa email è già registrata."
        });
      }

      if (
        await trovaUtentePerNickname(
          nicknameLower
        )
      ) {
        return res.status(400).json({
          errore:
            "Questo nickname è già in uso."
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const nuovoRef =
        db.ref("utenti").push();

      const uid =
        nuovoRef.key;

      await nuovoRef.set({
        partiteVinte: 0,
        partiteGiocate: 0,
        puntiTotali: 0,
        xp: 0,

        streakVittorieAttuale: 0,
        streakVittorieMassima: 0,
        vittoriaPiuVeloceSecondi:
          null,

        email:
          emailPulita,
        emailLower:
          emailPulita,

        nickname:
          nicknamePulito,
        nicknameLower,

        passwordHash,

        avatar:
          null,

        ruolo:
          "utente",
        stato:
          "attivo",
        sospesoFino:
          null,

        avvisi: [],
        notifiche: {},

        creatoIl:
          Date.now(),
        ultimoAccesso:
          Date.now()
      });

      const token =
        creaToken(
          uid,
          nicknamePulito,
          "utente"
        );

      res.cookie(
        "token",
        token,
        OPZIONI_COOKIE
      );

      return res.json({
        nickname:
          nicknamePulito,
        ruolo:
          "utente"
      });
    } catch (e) {
      console.error(
        "Errore registrazione:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

app.post(
  "/api/login",
  limiteLogin,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio account non disponibile."
      });
    }

    try {
      const {
        email,
        password
      } = req.body || {};

      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        !email ||
        !password
      ) {
        return res.status(400).json({
          errore:
            "Inserisci email e password."
        });
      }

      const utente =
        await trovaUtentePerEmail(
          pulisciTesto(
            email,
            100
          ).toLowerCase()
        );

      if (!utente) {
        return res.status(400).json({
          errore:
            "Email o password errati."
        });
      }

      if (!utente.passwordHash) {
        return res.status(400).json({
          errore:
            "Questo account è stato creato con Google. Usa 'Accedi con Google'."
        });
      }

      const passwordValida =
        await bcrypt.compare(
          password,
          utente.passwordHash
        );

      if (!passwordValida) {
        return res.status(400).json({
          errore:
            "Email o password errati."
        });
      }

      if (
        utente.stato ===
        "bannato"
      ) {
        return res.status(403).json({
          errore:
            "Il tuo account è stato bannato."
        });
      }

      if (
        utente.stato ===
        "sospeso"
      ) {
        if (
          utente.sospesoFino &&
          Number(
            utente.sospesoFino
          ) >
            Date.now()
        ) {
          return res.status(403).json({
            errore:
              "Account sospeso fino al " +
              new Date(
                utente.sospesoFino
              ).toLocaleString(
                "it-IT"
              ) +
              "."
          });
        }

        await db
          .ref(
            "utenti/" +
              utente.uid
          )
          .update({
            stato:
              "attivo",
            sospesoFino:
              null
          });
      }

      await db
        .ref(
          "utenti/" +
            utente.uid
        )
        .update({
          ultimoAccesso:
            Date.now()
        });

      const token =
        creaToken(
          utente.uid,
          utente.nickname,
          utente.ruolo ||
            "utente"
        );

      res.cookie(
        "token",
        token,
        OPZIONI_COOKIE
      );

      return res.json({
        nickname:
          utente.nickname,
        ruolo:
          utente.ruolo ||
          "utente"
      });
    } catch (e) {
      console.error(
        "Errore login:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

app.post(
  "/api/logout",
  (req, res) => {
    res.clearCookie(
      "token",
      OPZIONI_COOKIE
    );

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/me",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio account non disponibile."
      });
    }

    try {
      const utente =
        (
          await db
            .ref(
              "utenti/" +
                req.utente.uid
            )
            .once("value")
        ).val();

      if (!utente) {
        return res.status(404).json({
          errore:
            "Utente non trovato."
        });
      }

      const {
        livello,
        sogliaAttuale,
        sogliaProssima
      } =
        calcolaLivello(
          utente.xp || 0
        );

      return res.json({
        uid:
          req.utente.uid,

        nickname:
          utente.nickname,

        email:
          utente.email,

        avatar:
          utente.avatar ||
          null,

        ruolo:
          utente.ruolo ||
          "utente",

        stato:
          utente.stato ||
          "attivo",

        sospesoFino:
          utente.sospesoFino ||
          null,

        avvisi:
          utente.avvisi ||
          [],

        partiteVinte:
          utente.partiteVinte ||
          0,

        partiteGiocate:
          utente.partiteGiocate ||
          0,

        creatoIl:
          utente.creatoIl ||
          null,

        ultimoAccesso:
          utente.ultimoAccesso ||
          null,

        xp:
          utente.xp ||
          0,

        livello,
        sogliaAttuale,
        sogliaProssima,

        streakVittorieMassima:
          utente.streakVittorieMassima ||
          0,

        vittoriaPiuVeloceSecondi:
          utente.vittoriaPiuVeloceSecondi ??
          null,

        badge:
          calcolaBadge(
            utente
          )
      });
    } catch (e) {
      console.error(
        "Errore /api/me:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/modifica-nickname",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const nickname =
        req.body?.nickname;

      if (
        typeof nickname !== "string" ||
        !nickname.trim()
      ) {
        return res.status(400).json({
          errore:
            "Inserisci un nickname."
        });
      }

      const nuovoNickname =
        pulisciTesto(
          nickname,
          20
        );

      if (
        nuovoNickname.length < 5 ||
        nuovoNickname.length > 15
      ) {
        return res.status(400).json({
          errore:
            "Il nickname deve contenere da 5 a 15 caratteri."
        });
      }

      if (
        !/^[a-zA-Z0-9_ ]+$/.test(
          nuovoNickname
        )
      ) {
        return res.status(400).json({
          errore:
            "Nickname non valido."
        });
      }

      const nicknameLower =
        nuovoNickname.toLowerCase();

      const esistente =
        await trovaUtentePerNickname(
          nicknameLower
        );

      if (
        esistente &&
        esistente.uid !==
          req.utente.uid
      ) {
        return res.status(400).json({
          errore:
            "Questo nickname è già in uso."
        });
      }

      await db
        .ref(
          "utenti/" +
            req.utente.uid
        )
        .update({
          nickname:
            nuovoNickname,
          nicknameLower
        });

      res.cookie(
        "token",
        creaToken(
          req.utente.uid,
          nuovoNickname,
          req.utente.ruolo ||
            "utente"
        ),
        OPZIONI_COOKIE
      );

      return res.json({
        nickname:
          nuovoNickname
      });
    } catch (e) {
      console.error(
        "Errore modifica nickname:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/carica-avatar",
  richiediAuth,
  uploadAvatar.single("avatar"),
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          errore:
            "Nessuna immagine ricevuta."
        });
      }

      const dataUri =
        `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

      await db
        .ref(
          "utenti/" +
            req.utente.uid
        )
        .update({
          avatar:
            dataUri
        });

      forEachPartitaDiUid(
        req.utente.uid,
        partita => {
          if (
            partita.giocatori &&
            partita.giocatori[
              req.utente.uid
            ]
          ) {
            partita.giocatori[
              req.utente.uid
            ].avatar =
              dataUri;
          }
        }
      );

      return res.json({
        avatar:
          dataUri
      });
    } catch (e) {
      console.error(
        "Errore avatar:",
        e
      );

      return res.status(400).json({
        errore:
          e.message ||
          "Errore durante il caricamento."
      });
    }
  }
);

app.get(
  "/api/top-giocatori",
  async (req, res) => {
    try {
      if (!db) {
        return res.json({
          giocatori: []
        });
      }

      const utenti =
        (
          await db
            .ref("utenti")
            .once("value")
        ).val() || {};

      const top =
        Object.values(
          utenti
        )
          .map(u => ({
            nickname:
              u.nickname ||
              "Sconosciuto",
            vinte:
              Number(
                u.partiteVinte ||
                  0
              ),
            giocate:
              Number(
                u.partiteGiocate ||
                  0
              )
          }))
          .sort(
            (a, b) =>
              b.vinte !==
              a.vinte
                ? b.vinte -
                  a.vinte
                : b.giocate -
                  a.giocate
          )
          .slice(0, 10);

      return res.json({
        giocatori:
          top
      });
    } catch (e) {
      console.error(
        "Errore classifica:",
        e
      );

      return res.status(500).json({
        giocatori: []
      });
    }
  }
);

app.post(
  "/api/contatti",
  limiteContatti,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        categoria,
        messaggio
      } = req.body || {};

      let {
        nickname,
        email
      } = req.body || {};

      if (
        typeof messaggio !== "string" ||
        !messaggio.trim()
      ) {
        return res.status(400).json({
          errore:
            "Scrivi un messaggio prima di inviare."
        });
      }

      const messaggioPulito =
        pulisciTesto(
          messaggio,
          1000
        );

      const token =
        verificaToken(
          estraiTokenHeader(req)
        );

      let uidMittente = null;

      if (token) {
        uidMittente =
          token.uid;

        const utenteDb =
          (
            await db
              .ref(
                "utenti/" +
                  token.uid
              )
              .once("value")
          ).val();

        if (utenteDb) {
          nickname =
            utenteDb.nickname;
          email =
            utenteDb.email;
        }
      }

      if (
        typeof nickname !== "string" ||
        !nickname.trim() ||
        typeof email !== "string" ||
        !email.trim()
      ) {
        return res.status(400).json({
          errore:
            "Nickname ed email sono obbligatori."
        });
      }

      await db
        .ref("contatti")
        .push()
        .set({
          nickname:
            stringaSicura(
              nickname,
              50
            ),

          email:
            stringaSicura(
              email,
              100
            ),

          categoria:
            stringaSicura(
              categoria ||
                "Altro",
              50
            ),

          messaggio:
            messaggioPulito,

          uidMittente,

          letto:
            false,

          data:
            Date.now()
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore contatti:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore durante l'invio."
      });
    }
  }
);

/* ============================================================
   PROFILI / STORICO
   ============================================================ */

app.get(
  "/api/profilo-pubblico/:nickname",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const utente =
        await trovaUtentePerNickname(
          pulisciTesto(
            req.params.nickname,
            20
          ).toLowerCase()
        );

      if (!utente) {
        return res.status(404).json({
          errore:
            "Utente non trovato."
        });
      }

      const giocate =
        Number(
          utente.partiteGiocate ||
            0
        );

      const vinte =
        Number(
          utente.partiteVinte ||
            0
        );

      const {
        livello,
        sogliaAttuale,
        sogliaProssima
      } =
        calcolaLivello(
          utente.xp || 0
        );

      return res.json({
        uid:
          utente.uid,

        nickname:
          utente.nickname,

        avatar:
          utente.avatar ||
          null,

        creatoIl:
          utente.creatoIl ||
          null,

        ultimoAccesso:
          utente.ultimoAccesso ||
          null,

        partiteVinte:
          vinte,

        partiteGiocate:
          giocate,

        winRate:
          giocate > 0
            ? Math.round(
                (vinte /
                  giocate) *
                  100
              )
            : 0,

        xp:
          Number(
            utente.xp || 0
          ),

        livello,
        sogliaAttuale,
        sogliaProssima,

        streakVittorieMassima:
          Number(
            utente.streakVittorieMassima ||
              0
          ),

        vittoriaPiuVeloceSecondi:
          utente.vittoriaPiuVeloceSecondi ??
          null,

        badge:
          calcolaBadge(
            utente
          ),

        statoAmicizia:
          await statoAmicizia(
            req.utente.uid,
            utente.uid
          )
      });
    } catch (e) {
      console.error(
        "Errore profilo:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.get(
  "/api/storico",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      let uidFiltro =
        req.utente.uid;

      let nicknameFiltro =
        req.utente.nickname;

      if (req.query.nickname) {
        const u =
          await trovaUtentePerNickname(
            pulisciTesto(
              req.query.nickname,
              20
            ).toLowerCase()
          );

        if (!u) {
          return res.status(404).json({
            errore:
              "Utente non trovato."
          });
        }

        uidFiltro =
          u.uid;

        nicknameFiltro =
          u.nickname;
      }

      const tutte =
        (
          await db
            .ref(
              "storicoPartite"
            )
            .once(
              "value"
            )
        ).val() || {};

      const partite =
        Object.values(
          tutte
        )
          .filter(
            m =>
              Array.isArray(
                m.partecipanti
              ) &&
              m.partecipanti.some(
                p =>
                  p.uid ===
                  uidFiltro
              )
          )
          .sort(
            (a, b) =>
              Number(b.data || 0) -
              Number(a.data || 0)
          )
          .slice(0, 50);

      return res.json({
        uid:
          uidFiltro,
        nickname:
          nicknameFiltro,
        partite
      });
    } catch (e) {
      console.error(
        "Errore storico:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* ============================================================
   MESSAGGI PRIVATI
   ============================================================ */

app.get(
  "/api/messaggi-privati/:altroUid",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const altroUid =
        stringaSicura(
          req.params.altroUid,
          200
        );

      const idConv =
        idConversazione(
          req.utente.uid,
          altroUid
        );

      const messaggi =
        (
          await db
            .ref(
              "messaggiPrivati/" +
                idConv
            )
            .once("value")
        ).val() || {};

      const lista =
        Object.entries(
          messaggi
        )
          .map(
            ([id, m]) => ({
              id,
              ...m
            })
          )
          .sort(
            (a, b) =>
              Number(a.data || 0) -
              Number(b.data || 0)
          );

      const aggiornamenti = {};

      Object.entries(
        messaggi
      ).forEach(
        ([id, m]) => {
          if (
            m &&
            m.aUid ===
              req.utente.uid &&
            !m.letto
          ) {
            aggiornamenti[
              id + "/letto"
            ] = true;
          }
        }
      );

      if (
        Object.keys(
          aggiornamenti
        ).length
      ) {
        await db
          .ref(
            "messaggiPrivati/" +
              idConv
          )
          .update(
            aggiornamenti
          );
      }

      return res.json({
        messaggi:
          lista
      });
    } catch (e) {
      console.error(
        "Errore messaggi privati:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/messaggi-privati",
  limiteMessaggiPrivati,
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        destinatarioUid,
        testo
      } = req.body || {};

      if (
        typeof destinatarioUid !== "string" ||
        !destinatarioUid ||
        typeof testo !== "string" ||
        !testo.trim()
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        destinatarioUid ===
        req.utente.uid
      ) {
        return res.status(400).json({
          errore:
            "Non puoi scrivere a te stesso."
        });
      }

      const testoPulito =
        pulisciTesto(
          testo,
          500
        );

      if (!testoPulito) {
        return res.status(400).json({
          errore:
            "Messaggio vuoto."
        });
      }

      const mittente =
        (
          await db
            .ref(
              "utenti/" +
                req.utente.uid
            )
            .once("value")
        ).val();

      const destinatario =
        (
          await db
            .ref(
              "utenti/" +
                destinatarioUid
            )
            .once("value")
        ).val();

      if (
        !mittente ||
        !destinatario
      ) {
        return res.status(404).json({
          errore:
            "Utente non trovato."
        });
      }

      const idConv =
        idConversazione(
          req.utente.uid,
          destinatarioUid
        );

      const nuovoRef =
        db
          .ref(
            "messaggiPrivati/" +
              idConv
          )
          .push();

      const messaggio = {
        daUid:
          req.utente.uid,

        daNome:
          mittente.nickname,

        aUid:
          destinatarioUid,

        aNome:
          destinatario.nickname,

        testo:
          testoPulito,

        data:
          Date.now(),

        letto:
          false
      };

      await nuovoRef.set(
        messaggio
      );

      return res.json({
        ok: true,
        messaggio: {
          id:
            nuovoRef.key,
          ...messaggio
        }
      });
    } catch (e) {
      console.error(
        "Errore invio messaggio:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore durante l'invio."
      });
    }
  }
);

app.get(
  "/api/conversazioni",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const tutte =
        (
          await db
            .ref(
              "messaggiPrivati"
            )
            .once(
              "value"
            )
        ).val() || {};

      const mieUid =
        req.utente.uid;

      const conversazioni = {};

      Object.entries(
        tutte
      ).forEach(
        ([idConv, messaggi]) => {
          if (
            !idConv
              .split("_")
              .includes(mieUid)
          ) {
            return;
          }

          const lista =
            Object.values(
              messaggi || {}
            );

          if (!lista.length) {
            return;
          }

          lista.sort(
            (a, b) =>
              Number(b.data || 0) -
              Number(a.data || 0)
          );

          const ultimo =
            lista[0];

          const altroUid =
            ultimo.daUid ===
            mieUid
              ? ultimo.aUid
              : ultimo.daUid;

          const altroNome =
            ultimo.daUid ===
            mieUid
              ? ultimo.aNome
              : ultimo.daNome;

          conversazioni[
            altroUid
          ] = {
            altroUid,
            altroNome,
            ultimoTesto:
              ultimo.testo,
            ultimaData:
              ultimo.data,
            nonLetti:
              lista.filter(
                m =>
                  m.aUid ===
                    mieUid &&
                  !m.letto
              ).length
          };
        }
      );

      return res.json({
        conversazioni:
          Object.values(
            conversazioni
          ).sort(
            (a, b) =>
              Number(b.ultimaData || 0) -
              Number(a.ultimaData || 0)
          )
      });
    } catch (e) {
      console.error(
        "Errore conversazioni:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* ============================================================
   AMICI
   ============================================================ */

app.post(
  "/api/amici/richiedi",
  limiteAmici,
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const destinatarioUid =
        req.body?.destinatarioUid;

      if (
        typeof destinatarioUid !==
          "string" ||
        !destinatarioUid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        destinatarioUid ===
        req.utente.uid
      ) {
        return res.status(400).json({
          errore:
            "Non puoi inviare una richiesta a te stesso."
        });
      }

      const destinatario =
        (
          await db
            .ref(
              "utenti/" +
                destinatarioUid
            )
            .once("value")
        ).val();

      if (!destinatario) {
        return res.status(404).json({
          errore:
            "Utente non trovato."
        });
      }

      const stato =
        await statoAmicizia(
          req.utente.uid,
          destinatarioUid
        );

      if (stato === "amici") {
        return res.status(400).json({
          errore:
            "Siete già amici."
        });
      }

      if (
        stato ===
        "richiesta_inviata"
      ) {
        return res.json({
          ok: true
        });
      }

      if (
        stato ===
        "richiesta_ricevuta"
      ) {
        return res.status(400).json({
          errore:
            "Questo utente ti ha già inviato una richiesta."
        });
      }

      const ora =
        Date.now();

      const mioNickname =
        req.utente.nickname;

      await db
        .ref()
        .update({
          [
            `utenti/${req.utente.uid}/richiesteInviate/${destinatarioUid}`
          ]: {
            aNome:
              destinatario.nickname,
            data:
              ora
          },

          [
            `utenti/${destinatarioUid}/richiesteRicevute/${req.utente.uid}`
          ]: {
            daNome:
              mioNickname,
            data:
              ora
          }
        });

      await db
        .ref(
          `utenti/${destinatarioUid}/notifiche`
        )
        .push({
          tipo:
            "richiestaAmicizia",
          testo:
            `${mioNickname} ti ha inviato una richiesta di amicizia`,
          data:
            ora,
          letta:
            false,
          daUid:
            req.utente.uid,
          daNome:
            mioNickname
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore richiesta amicizia:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/amici/accetta",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const daUid =
        req.body?.daUid;

      if (
        typeof daUid !== "string" ||
        !daUid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      const richiesta =
        await db
          .ref(
            `utenti/${req.utente.uid}/richiesteRicevute/${daUid}`
          )
          .once("value");

      if (!richiesta.exists()) {
        return res.status(400).json({
          errore:
            "Nessuna richiesta da questo utente."
        });
      }

      const mioNickname =
        req.utente.nickname;

      await db.ref().update({
        [
          `utenti/${req.utente.uid}/richiesteRicevute/${daUid}`
        ]: null,

        [
          `utenti/${daUid}/richiesteInviate/${req.utente.uid}`
        ]: null,

        [
          `utenti/${req.utente.uid}/amici/${daUid}`
        ]: true,

        [
          `utenti/${daUid}/amici/${req.utente.uid}`
        ]: true
      });

      await db
        .ref(
          `utenti/${daUid}/notifiche`
        )
        .push({
          tipo:
            "amiciziaAccettata",
          testo:
            `${mioNickname} ha accettato la tua richiesta di amicizia`,
          data:
            Date.now(),
          letta:
            false
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore accettazione amicizia:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/amici/rifiuta",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const daUid =
        req.body?.daUid;

      if (
        typeof daUid !== "string" ||
        !daUid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      await db.ref().update({
        [
          `utenti/${req.utente.uid}/richiesteRicevute/${daUid}`
        ]: null,

        [
          `utenti/${daUid}/richiesteInviate/${req.utente.uid}`
        ]: null
      });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore rifiuto amicizia:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/amici/rimuovi",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const altroUid =
        req.body?.altroUid;

      if (
        typeof altroUid !== "string" ||
        !altroUid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      await db.ref().update({
        [
          `utenti/${req.utente.uid}/amici/${altroUid}`
        ]: null,

        [
          `utenti/${altroUid}/amici/${req.utente.uid}`
        ]: null
      });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore rimozione amico:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.get(
  "/api/amici",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const uids =
        Object.keys(
          (
            await db
              .ref(
                `utenti/${req.utente.uid}/amici`
              )
              .once("value")
          ).val() || {}
        );

      const amici =
        await Promise.all(
          uids.map(
            async uidAmico => {
              const u =
                (
                  await db
                    .ref(
                      "utenti/" +
                        uidAmico
                    )
                    .once("value")
                ).val();

              return u
                ? {
                    uid:
                      uidAmico,
                    nickname:
                      u.nickname,
                    avatar:
                      u.avatar ||
                      null
                  }
                : null;
            }
          )
        );

      return res.json({
        amici:
          amici.filter(Boolean)
      });
    } catch (e) {
      console.error(
        "Errore amici:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* ============================================================
   NOTIFICHE
   ============================================================ */

app.get(
  "/api/notifiche",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const lista =
        Object.entries(
          (
            await db
              .ref(
                `utenti/${req.utente.uid}/notifiche`
              )
              .once("value")
          ).val() || {}
        )
          .map(
            ([id, n]) => ({
              id,
              ...n
            })
          )
          .sort(
            (a, b) =>
              Number(b.data || 0) -
              Number(a.data || 0)
          )
          .slice(0, 30);

      return res.json({
        notifiche:
          lista,
        nonLette:
          lista.filter(
            n => !n.letta
          ).length
      });
    } catch (e) {
      console.error(
        "Errore notifiche:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/notifiche/segna-lette",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const tutte =
        (
          await db
            .ref(
              `utenti/${req.utente.uid}/notifiche`
            )
            .once("value")
        ).val() || {};

      const aggiornamenti = {};

      Object.keys(
        tutte
      ).forEach(id => {
        if (
          !tutte[id].letta
        ) {
          aggiornamenti[
            id + "/letta"
          ] = true;
        }
      });

      if (
        Object.keys(
          aggiornamenti
        ).length
      ) {
        await db
          .ref(
            `utenti/${req.utente.uid}/notifiche`
          )
          .update(
            aggiornamenti
          );
      }

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore segna notifiche:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* ============================================================
   ADMIN
   ============================================================ */

app.get(
  "/api/admin/utenti",
  richiediAdmin,
  async (req, res) => {
    if (!db) {
      return res.status(500).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const val =
        (
          await db
            .ref("utenti")
            .once("value")
        ).val() || {};

      return res.json({
        utenti:
          Object.keys(
            val
          ).map(
            uid => ({
              uid,
              email:
                val[uid].email,
              nickname:
                val[uid].nickname,
              stato:
                val[uid].stato,
              sospesoFino:
                val[uid].sospesoFino,
              avvisi:
                val[uid].avvisi ||
                [],
              ruolo:
                val[uid].ruolo ||
                "utente"
            })
          )
      });
    } catch (e) {
      console.error(
        "Errore admin utenti:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/avviso",
  richiediAdmin,
  async (req, res) => {
    try {
      const {
        uid,
        motivo
      } = req.body || {};

      if (
        typeof uid !== "string" ||
        !uid ||
        typeof motivo !== "string" ||
        !motivo.trim()
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      const ref =
        db.ref(
          "utenti/" +
            uid +
            "/avvisi"
        );

      const avvisiAttuali =
        (await ref.once(
          "value"
        )).val() || [];

      if (
        !Array.isArray(
          avvisiAttuali
        )
      ) {
        return res.status(500).json({
          errore:
            "Formato avvisi non valido."
        });
      }

      avvisiAttuali.push({
        data:
          Date.now(),
        motivo:
          pulisciTesto(
            motivo,
            500
          )
      });

      await ref.set(
        avvisiAttuali
      );

      await db
        .ref(
          `utenti/${uid}/notifiche`
        )
        .push({
          tipo:
            "avviso",
          testo:
            "Hai ricevuto un avviso dallo staff",
          data:
            Date.now(),
          letta:
            false
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore avviso admin:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/sospendi",
  richiediAdmin,
  async (req, res) => {
    try {
      const {
        uid,
        giorni,
        motivo
      } = req.body || {};

      const giorniNumero =
        Number(giorni);

      if (
        typeof uid !== "string" ||
        !uid ||
        !Number.isFinite(
          giorniNumero
        ) ||
        giorniNumero <= 0 ||
        giorniNumero > 3650
      ) {
        return res.status(400).json({
          errore:
            "Dati non validi."
        });
      }

      if (
        uid ===
        req.utenteAdmin.uid
      ) {
        return res.status(400).json({
          errore:
            "Non puoi sospendere il tuo stesso account."
        });
      }

      await db
        .ref(
          "utenti/" +
            uid
        )
        .update({
          stato:
            "sospeso",

          sospesoFino:
            Date.now() +
            giorniNumero *
              24 *
              60 *
              60 *
              1000,

          motivoSospensione:
            pulisciTesto(
              motivo || "",
              500
            )
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore sospensione admin:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/rimuovi-sospensione",
  richiediAdmin,
  async (req, res) => {
    try {
      const uid =
        req.body?.uid;

      if (
        typeof uid !== "string" ||
        !uid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      await db
        .ref(
          "utenti/" +
            uid
        )
        .update({
          stato:
            "attivo",
          sospesoFino:
            null
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore rimozione sospensione:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/banna",
  richiediAdmin,
  async (req, res) => {
    try {
      const {
        uid,
        motivo
      } = req.body || {};

      if (
        typeof uid !== "string" ||
        !uid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        uid ===
        req.utenteAdmin.uid
      ) {
        return res.status(400).json({
          errore:
            "Non puoi bannare il tuo stesso account."
        });
      }

      await db
        .ref(
          "utenti/" +
            uid
        )
        .update({
          stato:
            "bannato",

          motivoBan:
            pulisciTesto(
              motivo || "",
              500
            )
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore ban:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/riattiva",
  richiediAdmin,
  async (req, res) => {
    try {
      const uid =
        req.body?.uid;

      if (
        typeof uid !== "string" ||
        !uid
      ) {
        return res.status(400).json({
          errore:
            "Dati mancanti."
        });
      }

      await db
        .ref(
          "utenti/" +
            uid
        )
        .update({
          stato:
            "attivo",
          sospesoFino:
            null
        });

      return res.json({
        ok: true
      });
    } catch (e) {
      console.error(
        "Errore riattivazione:",
        e
      );

      return res.status(500).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* ============================================================
   DADI
   ============================================================ */

function tiraDadoRandomOrg() {
  return new Promise(resolve => {
    const url =
      "https://www.random.org/integers/?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";

    let risolto = false;

    const completa =
      valore => {
        if (risolto) return;

        risolto = true;
        resolve(valore);
      };

    const richiesta =
      https.get(
        url,
        {
          timeout: 1500
        },
        res => {
          let dati = "";

          res.on(
            "data",
            chunk => {
              dati +=
                chunk;
            }
          );

          res.on(
            "end",
            () => {
              try {
                const numeri =
                  dati
                    .trim()
                    .split("\n")
                    .map(
                      n =>
                        Number.parseInt(
                          n.trim(),
                          10
                        )
                    )
                    .filter(
                      n =>
                        Number.isInteger(
                          n
                        ) &&
                        n >= 1 &&
                        n <= 6
                    );

                completa(
                  numeri.length ===
                    2
                    ? {
                        dado1:
                          numeri[0],
                        dado2:
                          numeri[1]
                      }
                    : null
                );
              } catch {
                completa(
                  null
                );
              }
            }
          );
        }
      );

    richiesta.on(
      "timeout",
      () => {
        richiesta.destroy();
        completa(null);
      }
    );

    richiesta.on(
      "error",
      () => {
        completa(null);
      }
    );
  });
}

async function lanciaDueDadiSicuri() {
  const risultato =
    await tiraDadoRandomOrg();

  if (risultato) {
    return risultato;
  }

  console.warn(
    "Random.org non disponibile: fallback locale."
  );

  return {
    dado1:
      Math.floor(
        Math.random() * 6
      ) + 1,

    dado2:
      Math.floor(
        Math.random() * 6
      ) + 1
  };
}

/* ============================================================
   LOGICA PARTITA
   ============================================================ */

const CASELLE_AVANZA_ANCORA = [
  9,
  18,
  27,
  36,
  45,
  54
];

const CASELLE_SALTA_TRE_TURNI = [
  19,
  31
];

const CASELLE_SALTA_UN_TURNO = [
  52
];

const CASELLE_TORNA_A = {
  42: 38,
  50: 1,
  58: 1
};

const CASELLA_TIRA_ANCORA = 6;
const CASELLA_VITTORIA = 63;

/* ============================================================
   STANZE
   ============================================================ */

const stanze = {
  BAR: {
    giocatoriOnline: {},
    partite: {}
  },

  PUB: {
    giocatoriOnline: {},
    partite: {}
  },

  DISCOPUB: {
    giocatoriOnline: {},
    partite: {}
  },

  SERATE: {
    giocatoriOnline: {},
    partite: {}
  }
};

const socketsPerId = {};
let contatoreId = 0;

/* ============================================================
   HELPER PARTITE
   ============================================================ */

function trovaPartita(partitaId) {
  if (
    typeof partitaId !==
    "string"
  ) {
    return null;
  }

  for (const nomeStanza in stanze) {
    const partita =
      stanze[nomeStanza]
        .partite[
        partitaId
      ];

    if (partita) {
      return {
        partita,
        nomeStanza
      };
    }
  }

  return null;
}

function trovaPartitaAttivaPerUid(uid) {
  for (const nomeStanza in stanze) {
    for (
      const pid in
        stanze[nomeStanza].partite
    ) {
      const p =
        stanze[nomeStanza]
          .partite[pid];

      if (
        p.giocatori &&
        p.giocatori[uid]
      ) {
        return {
          partitaId:
            pid,
          stanza:
            nomeStanza
        };
      }
    }
  }

  return null;
}

function forEachPartitaDiUid(
  uid,
  callback
) {
  for (const nomeStanza in stanze) {
    for (
      const partita of Object.values(
        stanze[nomeStanza]
          .partite
      )
    ) {
      if (
        partita.giocatori &&
        partita.giocatori[uid]
      ) {
        callback(
          partita,
          nomeStanza
        );
      }
    }
  }
}

function calcolaUidInPartita(nomeStanza) {
  const result =
    new Set();

  if (!stanze[nomeStanza]) {
    return result;
  }

  Object.values(
    stanze[nomeStanza].partite
  ).forEach(
    partita => {
      if (
        partita.iniziata
      ) {
        Object.keys(
          partita.giocatori ||
            {}
        ).forEach(
          uid =>
            result.add(
              uid
            )
        );
      }
    }
  );

  return result;
}

function costruisciStatoGiocatori(partita) {
  return (
    partita.ordineGiocatori ||
    []
  )
    .map(uid => {
      const g =
        partita.giocatori[
          uid
        ];

      if (!g) return null;

      return {
        id:
          uid,

        nome:
          g.nome ||
          "?",

        avatar:
          g.avatar ||
          null,

        posizione:
          Number(
            g.posizione || 0
          )
      };
    })
    .filter(Boolean);
}

function inviaAgiocatore(
  giocatore,
  payload
) {
  if (
    !giocatore ||
    !giocatore.socket
  ) {
    return;
  }

  if (
    giocatore.socket.readyState !==
    WebSocket.OPEN
  ) {
    return;
  }

  try {
    giocatore.socket.send(
      JSON.stringify(
        payload
      )
    );
  } catch (e) {
    console.error(
      "Errore invio socket:",
      e.message
    );
  }
}

function inviaAllaPartita(
  partita,
  payload
) {
  if (!partita) return;

  const json =
    JSON.stringify(
      payload
    );

  Object.values(
    partita.giocatori || {}
  ).forEach(
    g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        try {
          g.socket.send(
            json
          );
        } catch {}
      }
    }
  );
}

function inviaAllaStanza(
  nomeStanza,
  payload
) {
  if (
    !stanze[nomeStanza]
  ) {
    return;
  }

  const json =
    JSON.stringify(
      payload
    );

  Object.values(
    stanze[nomeStanza]
      .giocatoriOnline
  ).forEach(
    online => {
      const socket =
        online?.socket;

      if (
        socket &&
        socket.readyState ===
          WebSocket.OPEN
      ) {
        try {
          socket.send(
            json
          );
        } catch {}
      }
    }
  );
}

function inviaListaPartite(
  nomeStanza
) {
  if (
    !stanze[nomeStanza]
  ) {
    return;
  }

  const lista =
    Object.values(
      stanze[nomeStanza]
        .partite
    ).map(
      partita => ({
        id:
          partita.id,

        creatore:
          partita.creatore,

        creatoDa:
          partita.creatoDa,

        tempo:
          partita.tempo,

        punti:
          partita.punti,

        modalita:
          partita.modalita,

        maxGiocatori:
          partita.maxGiocatori,

        numGiocatoriAttuali:
          Object.keys(
            partita.giocatori ||
              {}
          ).length,

        chatAttiva:
          partita.chatAttiva !==
          false,

        iniziata:
          partita.iniziata ===
          true,

        giocatori:
          Object.entries(
            partita.giocatori ||
              {}
          ).map(
            ([uid, g]) => ({
              uid,
              nome:
                g.nome ||
                "?",
              avatar:
                g.avatar ||
                null
            })
          )
      })
    );

  inviaAllaStanza(
    nomeStanza,
    {
      tipo:
        "listaPartite",
      partite:
        lista
    }
  );
}

function inviaConteggioStanze() {
  const conteggi = {};
  const giocatoriPerStanza =
    {};

  for (const nome in stanze) {
    const online =
      Object.values(
        stanze[nome]
          .giocatoriOnline
      );

    const uidInPartita =
      calcolaUidInPartita(
        nome
      );

    const unici =
      new Map();

    online.forEach(
      g => {
        if (
          g &&
          g.uid
        ) {
          unici.set(
            g.uid,
            g
          );
        }
      }
    );

    const valori =
      Array.from(
        unici.values()
      );

    conteggi[nome] =
      valori.length;

    giocatoriPerStanza[
      nome
    ] =
      valori.map(
        g => ({
          uid:
            g.uid,

          nickname:
            g.nickname,

          avatar:
            g.avatar ||
            null,

          tipoDispositivo:
            g.tipoDispositivo ||
            "computer",

          stato:
            uidInPartita.has(
              g.uid
            )
              ? "partita"
              : "lobby"
        })
      );
  }

  const payload =
    JSON.stringify({
      tipo:
        "conteggioStanze",
      stanze:
        conteggi,
      giocatori:
        giocatoriPerStanza
    });

  wss.clients.forEach(
    client => {
      if (
        client.readyState ===
        WebSocket.OPEN
      ) {
        try {
          client.send(
            payload
          );
        } catch {}
      }
    }
  );
}

/* ============================================================
   MOVIMENTO
   ============================================================ */

function calcolaMovimento(
  posizioneAttuale,
  valoreDado
) {
  let percorso = [];

  let nuovaPosizione =
    Number(
      posizioneAttuale || 0
    ) +
    Number(
      valoreDado || 0
    );

  const messaggi = [];
  let turniDaSaltare = 0;
  let vittoria = false;
  let tiraAncora = false;

  if (
    nuovaPosizione >
    CASELLA_VITTORIA
  ) {
    for (
      let p =
        Number(
          posizioneAttuale || 0
        ) + 1;
      p <=
      CASELLA_VITTORIA;
      p++
    ) {
      percorso.push(p);
    }

    const eccesso =
      nuovaPosizione -
      CASELLA_VITTORIA;

    nuovaPosizione =
      CASELLA_VITTORIA -
      eccesso;

    for (
      let p =
        CASELLA_VITTORIA - 1;
      p >=
      nuovaPosizione;
      p--
    ) {
      percorso.push(p);
    }

    messaggi.push(
      "Hai superato il traguardo, rimbalzi indietro!"
    );
  } else {
    for (
      let p =
        Number(
          posizioneAttuale || 0
        ) + 1;
      p <=
      nuovaPosizione;
      p++
    ) {
      percorso.push(p);
    }
  }

  if (
    nuovaPosizione ===
    CASELLA_VITTORIA
  ) {
    vittoria = true;

    messaggi.push(
      "🎉 Hai vinto!"
    );

    return {
      nuovaPosizione,
      percorso,
      messaggi,
      turniDaSaltare,
      vittoria,
      tiraAncora
    };
  }

  if (
    nuovaPosizione ===
    CASELLA_TIRA_ANCORA
  ) {
    tiraAncora = true;

    messaggi.push(
      "Sali sul ponte! Tira ancora i dadi."
    );
  }

  if (
    CASELLE_AVANZA_ANCORA.includes(
      nuovaPosizione
    )
  ) {
    messaggi.push(
      "Avanzi dello stesso numero di caselle!"
    );

    const r =
      calcolaMovimento(
        nuovaPosizione,
        valoreDado
      );

    return {
      nuovaPosizione:
        r.nuovaPosizione,

      percorso:
        percorso.concat(
          r.percorso
        ),

      messaggi:
        messaggi.concat(
          r.messaggi
        ),

      turniDaSaltare:
        r.turniDaSaltare,

      vittoria:
        r.vittoria,

      tiraAncora:
        r.tiraAncora
    };
  }

  if (
    CASELLE_SALTA_TRE_TURNI.includes(
      nuovaPosizione
    )
  ) {
    turniDaSaltare = 3;

    messaggi.push(
      "Rimani fermo per 3 turni!"
    );
  }

  if (
    CASELLE_SALTA_UN_TURNO.includes(
      nuovaPosizione
    )
  ) {
    turniDaSaltare = 1;

    messaggi.push(
      "Salti un turno!"
    );
  }

  if (
    CASELLE_TORNA_A[
      nuovaPosizione
    ] !== undefined
  ) {
    const nuovaCasella =
      CASELLE_TORNA_A[
        nuovaPosizione
      ];

    messaggi.push(
      `Torni alla casella ${nuovaCasella}!`
    );

    percorso.push(
      nuovaCasella
    );

    nuovaPosizione =
      nuovaCasella;
  }

  return {
    nuovaPosizione,
    percorso,
    messaggi,
    turniDaSaltare,
    vittoria,
    tiraAncora
  };
}

/* ============================================================
   TURNI
   ============================================================ */

function passaAlProssimoTurno(partita) {
  const numeroGiocatori =
    (
      partita.ordineGiocatori ||
      []
    ).length;

  if (
    numeroGiocatori <= 1
  ) {
    return;
  }

  const indiceDiPartenza =
    Number(
      partita.turnoAttuale || 0
    );

  for (
    let i = 1;
    i < numeroGiocatori;
    i++
  ) {
    const indice =
      (
        indiceDiPartenza +
        i
      ) %
      numeroGiocatori;

    const uid =
      partita
        .ordineGiocatori[
        indice
      ];

    const giocatore =
      partita.giocatori[
        uid
      ];

    if (!giocatore) {
      continue;
    }

    const salti =
      Number(
        giocatore.turniSaltati ||
          0
      );

    if (salti > 0) {
      giocatore.turniSaltati =
        salti - 1;

      continue;
    }

    partita.turnoAttuale =
      indice;

    partita.tiriEffettuatiNelTurno =
      0;

    partita.tiriConsentitiNelTurno =
      1;

    return;
  }

  partita.turnoAttuale =
    indiceDiPartenza;

  partita.tiriEffettuatiNelTurno =
    0;

  partita.tiriConsentitiNelTurno =
    1;
}

/* ============================================================
   TIMER
   ============================================================ */

function millisecondiMossa(partita) {
  const secondi =
    Number.parseInt(
      partita?.tempo,
      10
    );

  return (
    Number.isFinite(
      secondi
    ) &&
    secondi > 0
      ? secondi
      : 30
  ) * 1000;
}

function fermaTimerTurno(partita) {
  if (!partita) return;

  if (
    partita.timerTurno
  ) {
    clearTimeout(
      partita.timerTurno
    );

    partita.timerTurno =
      null;
  }

  partita.tokenTimerTurno =
    Number(
      partita.tokenTimerTurno ||
        0
    ) + 1;
}

function avviaTimerTurno(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    !partita.iniziata ||
    partita.conclusa
  ) {
    return;
  }

  fermaTimerTurno(
    partita
  );

  const durata =
    millisecondiMossa(
      partita
    );

  const adesso =
    Date.now();

  partita.tempoInizioTurno =
    adesso;

  partita.scadenzaTurno =
    adesso +
    durata;

  const token =
    partita.tokenTimerTurno;

  partita.timerTurno =
    setTimeout(
      async () => {
        if (
          partita.conclusa ||
          token !==
            partita.tokenTimerTurno
        ) {
          return;
        }

        partita.timerTurno =
          null;

        await gestisciScadenzaTurno(
          partita,
          nomeStanza
        );
      },
      durata +
        TOLLERANZA_MOSSA_MS
    );
}

function ripristinaTimerTurno(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    !partita.iniziata ||
    partita.conclusa
  ) {
    return;
  }

  partita.animazioneTiroInCorso =
    false;

  const scadenza =
    Number(
      partita.scadenzaTurno
    );

  if (
    !Number.isFinite(
      scadenza
    ) ||
    scadenza <= 0
  ) {
    avviaTimerTurno(
      partita,
      nomeStanza
    );

    return;
  }

  fermaTimerTurno(
    partita
  );

  const token =
    partita.tokenTimerTurno;

  const ritardo =
    Math.max(
      0,
      scadenza -
        Date.now() +
        TOLLERANZA_MOSSA_MS
    );

  partita.timerTurno =
    setTimeout(
      async () => {
        if (
          partita.conclusa ||
          token !==
            partita.tokenTimerTurno
        ) {
          return;
        }

        partita.timerTurno =
          null;

        await gestisciScadenzaTurno(
          partita,
          nomeStanza
        );
      },
      ritardo
    );
}

/* ============================================================
   TIRO DI GIOCO
   ============================================================ */

async function gestisciScadenzaTurno(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.conclusa ||
    !partita.iniziata
  ) {
    return;
  }

  if (
    partita.elaborandoTiro ||
    partita.animazioneTiroInCorso
  ) {
    return;
  }

  const uid =
    partita
      .ordineGiocatori[
      partita.turnoAttuale
    ];

  const giocatore =
    partita.giocatori[
      uid
    ];

  if (!giocatore) {
    return;
  }

  giocatore.tentativiAutomaticiConsecutivi =
    Number(
      giocatore.tentativiAutomaticiConsecutivi ||
        0
    ) + 1;

  if (
    giocatore.tentativiAutomaticiConsecutivi >
    3
  ) {
    await forzaAbbandonoPerInattivita(
      partita,
      nomeStanza,
      uid
    );

    return;
  }

  await eseguiTiroDadiPerGiocatore(
    partita,
    nomeStanza,
    uid,
    true
  );
}

function calcolaDurataAnimazione(
  numeroCaselle
) {
  const n =
    Number.isFinite(
      Number(numeroCaselle)
    )
      ? Math.max(
          0,
          Number(numeroCaselle)
        )
      : 0;

  return Math.min(
    DURATA_LANCIO_DADI_MS +
      n *
        DURATA_SALTO_MS,
    DURATA_ANIMAZIONE_MASSIMA_MS
  );
}

async function eseguiTiroDadiPerGiocatore(
  partita,
  nomeStanza,
  idGiocatore,
  automatico
) {
  if (
    !partita ||
    partita.conclusa ||
    partita.elaborandoTiro ||
    partita.animazioneTiroInCorso
  ) {
    return;
  }

  if (
    partita.ordineGiocatori[
      partita.turnoAttuale
    ] !==
    idGiocatore
  ) {
    return;
  }

  const tiriEffettuati =
    Number(
      partita.tiriEffettuatiNelTurno ||
        0
    );

  const tiriConsentiti =
    Number(
      partita.tiriConsentitiNelTurno ||
        1
    );

  if (
    tiriEffettuati >=
    tiriConsentiti
  ) {
    return;
  }

  const giocatore =
    partita.giocatori[
      idGiocatore
    ];

  if (!giocatore) return;

  partita.tiriEffettuatiNelTurno =
    tiriEffettuati + 1;

  partita.elaborandoTiro =
    true;

  partita.animazioneTiroInCorso =
    true;

  fermaTimerTurno(
    partita
  );

  try {
    const {
      dado1,
      dado2
    } =
      await lanciaDueDadiSicuri();

    const valoreDado =
      Number(dado1) +
      Number(dado2);

    const risultato =
      calcolaMovimento(
        giocatore.posizione,
        valoreDado
      );

    if (
      risultato.tiraAncora
    ) {
      partita.tiriConsentitiNelTurno =
        partita.tiriEffettuatiNelTurno +
        1;
    }

    giocatore.posizione =
      risultato.nuovaPosizione;

    if (
      risultato.turniDaSaltare >
      0
    ) {
      giocatore.turniSaltati =
        risultato.turniDaSaltare;
    }

    if (
      !risultato.tiraAncora &&
      !risultato.vittoria
    ) {
      passaAlProssimoTurno(
        partita
      );
    }

    giocatore.tentativiAutomaticiConsecutivi =
      automatico
        ? Number(
            giocatore.tentativiAutomaticiConsecutivi ||
              0
          )
        : 0;

    const statoGiocatori =
      costruisciStatoGiocatori(
        partita
      );

    const durataAnimazioneMs =
      calcolaDurataAnimazione(
        risultato.percorso.length
      );

    const messaggiFinali =
      automatico
        ? [
            "⏱️ Tempo scaduto: mossa automatica."
          ].concat(
            risultato.messaggi
          )
        : risultato.messaggi;

    if (
      risultato.vittoria
    ) {
      inviaAllaPartita(
        partita,
        {
          tipo:
            "aggiornamentoPartita",

          giocatori:
            statoGiocatori,

          dado1,
          dado2,
          valoreDado,

          percorso:
            risultato.percorso,

          idGiocatoreCheHaTirato:
            idGiocatore,

          automatico:
            !!automatico,

          messaggi:
            messaggiFinali,

          turnoDiId:
            null,

          tempoInizioTurno:
            null,

          scadenzaTurno:
            null,

          durataMossaMs:
            0,

          durataAnimazioneMs,

          vittoria:
            true,

          vincitore:
            giocatore.nome
        }
      );

      await concludiPartita(
        partita,
        idGiocatore,
        nomeStanza
      );

      fermaTimerTurno(
        partita
      );

      await rimuoviPartita(
        nomeStanza,
        partita.id
      );

      inviaListaPartite(
        nomeStanza
      );

      inviaConteggioStanze();

      return;
    }

    inviaAllaPartita(
      partita,
      {
        tipo:
          "aggiornamentoPartita",

        giocatori:
          statoGiocatori,

        dado1,
        dado2,
        valoreDado,

        percorso:
          risultato.percorso,

        idGiocatoreCheHaTirato:
          idGiocatore,

        automatico:
          !!automatico,

        messaggi:
          messaggiFinali,

        turnoDiId:
          null,

        tempoInizioTurno:
          null,

        scadenzaTurno:
          null,

        durataMossaMs:
          0,

        durataAnimazioneMs,

        vittoria:
          false,

        vincitore:
          null
      }
    );

    await aggiornaStatoPartita(
      partita.id,
      {
        giocatori:
          preparaGiocatoriPerFirebase(
            partita.giocatori
          ),

        ordineGiocatori:
          partita.ordineGiocatori,

        turnoAttuale:
          partita.turnoAttuale,

        iniziata:
          partita.iniziata,

        tiriEffettuatiNelTurno:
          partita.tiriEffettuatiNelTurno,

        tiriConsentitiNelTurno:
          partita.tiriConsentitiNelTurno,

        tempoInizioTurno:
          null,

        scadenzaTurno:
          null
      }
    );

    const tokenAnimazione =
      partita.tokenTimerTurno;

    setTimeout(
      async () => {
        const trovato =
          trovaPartita(
            partita.id
          );

        if (
          !trovato ||
          trovato.partita !==
            partita
        ) {
          return;
        }

        if (
          partita.conclusa ||
          !partita.iniziata
        ) {
          return;
        }

        if (
          tokenAnimazione !==
          partita.tokenTimerTurno
        ) {
          return;
        }

        partita.animazioneTiroInCorso =
          false;

        avviaTimerTurno(
          partita,
          nomeStanza
        );

        const statoDopoAnimazione =
          costruisciStatoGiocatori(
            partita
          );

        const idTurnoAttuale =
          partita
            .ordineGiocatori[
            partita.turnoAttuale
          ];

        const durataMossaMs =
          millisecondiMossa(
            partita
          );

        const statoPayload = {
          tipo:
            "statoPartita",

          giocatori:
            statoDopoAnimazione,

          turnoDiId:
            idTurnoAttuale,

          punteggiOrdineIniziale:
            partita.punteggiOrdineIniziale ||
            null,

          tempoInizioTurno:
            partita.tempoInizioTurno,

          durataMossaMs,

          scadenzaTurno:
            partita.scadenzaTurno,

          tiriEffettuatiNelTurno:
            partita.tiriEffettuatiNelTurno,

          tiriConsentitiNelTurno:
            partita.tiriConsentitiNelTurno,

          chatAttiva:
            partita.chatAttiva !==
            false
        };

        inviaAllaPartita(
          partita,
          statoPayload
        );

        await aggiornaStatoPartita(
          partita.id,
          {
            turnoAttuale:
              partita.turnoAttuale,

            iniziata:
              partita.iniziata,

            tiriEffettuatiNelTurno:
              partita.tiriEffettuatiNelTurno,

            tiriConsentitiNelTurno:
              partita.tiriConsentitiNelTurno,

            tempoInizioTurno:
              partita.tempoInizioTurno,

            scadenzaTurno:
              partita.scadenzaTurno
          }
        );
      },
      durataAnimazioneMs
    );
  } catch (e) {
    console.error(
      "Errore durante il tiro:",
      e
    );

    partita.tiriEffettuatiNelTurno =
      tiriEffettuati;

    partita.animazioneTiroInCorso =
      false;

    partita.elaborandoTiro =
      false;

    avviaTimerTurno(
      partita,
      nomeStanza
    );

    inviaAllaPartita(
      partita,
      {
        tipo:
          "statoPartita",

        giocatori:
          costruisciStatoGiocatori(
            partita
          ),

        turnoDiId:
          partita
            .ordineGiocatori[
            partita.turnoAttuale
          ],

        messaggi: [
          "Errore nel tiro dei dadi, riprova."
        ],

        tempoInizioTurno:
          partita.tempoInizioTurno,

        durataMossaMs:
          millisecondiMossa(
            partita
          ),

        scadenzaTurno:
          partita.scadenzaTurno,

        chatAttiva:
          partita.chatAttiva !==
          false
      }
    );
  } finally {
    partita.elaborandoTiro =
      false;
  }
}

/* ============================================================
   INATTIVITÀ
   ============================================================ */

async function forzaAbbandonoPerInattivita(
  partita,
  nomeStanza,
  idGiocatore
) {
  if (
    !partita ||
    partita.conclusa ||
    !partita.giocatori[idGiocatore]
  ) {
    return;
  }

  fermaTimerTurno(
    partita
  );

  const nomeUscente =
    partita.giocatori[
      idGiocatore
    ].nome;

  if (db) {
    try {
      const ref =
        db.ref(
          "utenti/" +
            idGiocatore
        );

      const u =
        (
          await ref.once(
            "value"
          )
        ).val();

      if (u) {
        await ref.update({
          xp:
            Math.max(
              0,
              Number(u.xp || 0) -
                xpPenalitaAbbandonoAutomatico()
            ),

          streakVittorieAttuale:
            0
        });
      }
    } catch (e) {
      console.error(
        "Errore penalità inattività:",
        e.message
      );
    }
  }

  const uidTurnoPrima =
    partita
      .ordineGiocatori[
      partita.turnoAttuale
    ];

  delete partita.giocatori[
    idGiocatore
  ];

  partita.ordineGiocatori =
    partita.ordineGiocatori.filter(
      uid =>
        uid !==
        idGiocatore
    );

  if (
    partita.ordineGiocatori.length ===
    0
  ) {
    await rimuoviPartita(
      nomeStanza,
      partita.id
    );

    inviaListaPartite(
      nomeStanza
    );

    inviaConteggioStanze();

    return;
  }

  if (
    partita.ordineGiocatori.length ===
    1
  ) {
    const vincitoreId =
      partita
        .ordineGiocatori[0];

    const vincitore =
      partita.giocatori[
        vincitoreId
      ];

    inviaAllaPartita(
      partita,
      {
        tipo:
          "statoPartita",

        giocatori:
          costruisciStatoGiocatori(
            partita
          ),

        turnoDiId:
          vincitoreId,

        vittoria:
          true,

        vincitore:
          vincitore.nome,

        messaggi: [
          nomeUscente +
            " è stato rimosso per inattività prolungata."
        ]
      }
    );

    const elencoCompleto =
      partita.ordineGiocatori.map(
        uid => ({
          uid,
          nome:
            partita.giocatori[
              uid
            ]?.nome ||
            "?"
        })
      );

    elencoCompleto.push({
      uid:
        idGiocatore,
      nome:
        nomeUscente
    });

    await concludiPartita(
      partita,
      vincitoreId,
      nomeStanza,
      elencoCompleto,
      new Set([
        idGiocatore
      ])
    );

    await rimuoviPartita(
      nomeStanza,
      partita.id
    );
  } else {
    const nuovoIndice =
      partita.ordineGiocatori.indexOf(
        uidTurnoPrima
      );

    partita.turnoAttuale =
      nuovoIndice >= 0
        ? nuovoIndice
        : 0;

    partita.tiriEffettuatiNelTurno =
      0;

    partita.tiriConsentitiNelTurno =
      1;

    avviaTimerTurno(
      partita,
      nomeStanza
    );

    inviaAllaPartita(
      partita,
      {
        tipo:
          "statoPartita",

        giocatori:
          costruisciStatoGiocatori(
            partita
          ),

        turnoDiId:
          partita
            .ordineGiocatori[
            partita.turnoAttuale
          ],

        messaggi: [
          nomeUscente +
            " è stato rimosso per inattività prolungata."
        ],

        tempoInizioTurno:
          partita.tempoInizioTurno,

        durataMossaMs:
          millisecondiMossa(
            partita
          ),

        scadenzaTurno:
          partita.scadenzaTurno,

        tiriEffettuatiNelTurno:
          partita.tiriEffettuatiNelTurno,

        tiriConsentitiNelTurno:
          partita.tiriConsentitiNelTurno,

        chatAttiva:
          partita.chatAttiva !==
          false
      }
    );

    await salvaPartita(
      partita
    );
  }

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();
}

/* ============================================================
   DETERMINAZIONE ORDINE
   ============================================================ */

function calcolaOrdineDaiRisultati(
  risultati,
  tuttiGliUid
) {
  const coppie =
    (
      tuttiGliUid || []
    )
      .filter(uid => risultati[uid] != null)
      .map(uid => ({
        uid,
        punteggio:
          Number(
            risultati[uid]
          )
      }))
      .sort(
        (a, b) =>
          b.punteggio -
          a.punteggio
      );

  for (
    let i = 0;
    i < coppie.length;
    i++
  ) {
    let j =
      i + 1;

    while (
      j <
        coppie.length &&
      coppie[j]
        .punteggio ===
        coppie[i]
          .punteggio
    ) {
      j++;
    }

    if (
      j - i >
      1
    ) {
      return {
        ordineFinale:
          null,

        prossimoGruppoParitario:
          coppie
            .slice(
              i,
              j
            )
            .map(
              x =>
                x.uid
            )
      };
    }

    i =
      j - 1;
  }

  return {
    ordineFinale:
      coppie.map(
        x =>
          x.uid
      ),

    prossimoGruppoParitario:
      null
  };
}

function rimuoviGiocatoreDaDeterminazione(
  partita,
  uid
) {
  delete partita.giocatori[
    uid
  ];

  partita.ordineDeterminazione =
    (
      partita.ordineDeterminazione ||
      []
    ).filter(
      x =>
        x !==
        uid
    );

  partita.codaDeterminazione =
    (
      partita.codaDeterminazione ||
      []
    ).filter(
      x =>
        x !==
        uid
    );

  if (
    partita.risultatiDeterminazione
  ) {
    delete partita
      .risultatiDeterminazione[
      uid
    ];
  }

  if (
    Array.isArray(
      partita.gruppoSpareggioAttuale
    )
  ) {
    partita.gruppoSpareggioAttuale =
      partita
        .gruppoSpareggioAttuale
        .filter(
          x =>
            x !==
            uid
        );
  }

  if (
    partita
      .turnoInCorsoDeterminazione ===
    uid
  ) {
    partita
      .turnoInCorsoDeterminazione =
      null;
  }
}

function inviaStatoDeterminazione(
  partita
) {
  const elenco =
    (
      partita.ordineDeterminazione ||
      []
    )
      .filter(
        uid =>
          partita.giocatori[
            uid
          ]
      )
      .map(
        uid => ({
          uid,

          nome:
            partita.giocatori[
              uid
            ].nome ||
            "?",

          avatar:
            partita.giocatori[
              uid
            ].avatar ||
            null,

          risultato:
            partita.risultatiDeterminazione &&
            partita.risultatiDeterminazione[
              uid
            ] != null
              ? partita
                  .risultatiDeterminazione[
                  uid
                ]
              : null
        })
      );

  inviaAllaPartita(
    partita,
    {
      tipo:
        "statoDeterminazione",

      giocatori:
        elenco,

      turnoInCorsoUid:
        partita.turnoInCorsoDeterminazione ||
        null,

      gruppoSpareggioAttuale:
        partita.gruppoSpareggioAttuale ||
        null,

      tempoInizioTurno:
        partita.tempoInizioTurno ||
        null,

      scadenzaTurno:
        partita.scadenzaTurno ||
        null,

      durataMossaMs:
        millisecondiMossa(
          partita
        ),

      chatAttiva:
        partita.chatAttiva !==
        false
    }
  );
}

function avviaTimerDeterminazione(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.conclusa
  ) {
    return;
  }

  fermaTimerTurno(
    partita
  );

  partita.tempoInizioTurno =
    Date.now();

  partita.scadenzaTurno =
    partita.tempoInizioTurno +
    millisecondiMossa(
      partita
    );

  const token =
    partita.tokenTimerTurno;

  partita.timerTurno =
    setTimeout(
      async () => {
        if (
          token !==
          partita.tokenTimerTurno
        ) {
          return;
        }

        partita.timerTurno =
          null;

        await gestisciScadenzaDeterminazione(
          partita,
          nomeStanza
        );
      },
      millisecondiMossa(
        partita
      ) +
        TOLLERANZA_MOSSA_MS
    );
}

async function gestisciScadenzaDeterminazione(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.conclusa ||
    partita.fase !==
      "determinazione_ordine"
  ) {
    return;
  }

  if (
    partita.elaborandoTiro
  ) {
    return;
  }

  const uid =
    partita
      .turnoInCorsoDeterminazione;

  if (!uid) {
    return;
  }

  const giocatore =
    partita.giocatori[
      uid
    ];

  if (!giocatore) {
    return;
  }

  giocatore.tentativiAutomaticiConsecutivi =
    Number(
      giocatore.tentativiAutomaticiConsecutivi ||
        0
    ) + 1;

  if (
    giocatore
      .tentativiAutomaticiConsecutivi >
    3
  ) {
    await espelliPerInattivitaDuranteDeterminazione(
      partita,
      nomeStanza,
      uid
    );

    return;
  }

  await eseguiTiroDeterminazionePerGiocatore(
    partita,
    nomeStanza,
    uid,
    true
  );
}

async function eseguiTiroDeterminazionePerGiocatore(
  partita,
  nomeStanza,
  uid,
  automatico
) {
  if (
    !partita ||
    partita.conclusa ||
    partita.elaborandoTiro
  ) {
    return;
  }

  if (
    partita.fase !==
    "determinazione_ordine"
  ) {
    return;
  }

  if (
    partita
      .turnoInCorsoDeterminazione !==
    uid
  ) {
    return;
  }

  const giocatore =
    partita.giocatori[
      uid
    ];

  if (!giocatore) {
    return;
  }

  partita.elaborandoTiro =
    true;

  fermaTimerTurno(
    partita
  );

  try {
    const {
      dado1,
      dado2
    } =
      await lanciaDueDadiSicuri();

    const valoreDado =
      dado1 + dado2;

    if (
      !partita.risultatiDeterminazione
    ) {
      partita.risultatiDeterminazione =
        {};
    }

    partita.risultatiDeterminazione[
      uid
    ] =
      valoreDado;

    partita.turnoInCorsoDeterminazione =
      null;

    partita.tempoInizioTurno =
      null;

    partita.scadenzaTurno =
      null;

    giocatore.tentativiAutomaticiConsecutivi =
      automatico
        ? Number(
            giocatore.tentativiAutomaticiConsecutivi ||
              0
          )
        : 0;

    inviaAllaPartita(
      partita,
      {
        tipo:
          "risultatoDeterminazione",

        uid,
        nome:
          giocatore.nome,

        dado1,
        dado2,
        valoreDado,

        automatico:
          !!automatico
      }
    );

    await salvaPartita(
      partita
    );

    setTimeout(
      async () => {
        const trovato =
          trovaPartita(
            partita.id
          );

        if (
          !trovato ||
          trovato.partita !==
            partita ||
          partita.conclusa
        ) {
          return;
        }

        await avanzaDeterminazione(
          partita,
          nomeStanza
        );
      },
      DURATA_LANCIO_DADI_MS +
        900
    );
  } catch (e) {
    console.error(
      "Errore determinazione:",
      e
    );

    partita.elaborandoTiro =
      false;

    avviaTimerDeterminazione(
      partita,
      nomeStanza
    );

    inviaStatoDeterminazione(
      partita
    );
  } finally {
    partita.elaborandoTiro =
      false;
  }
}

function iniziaFaseDeterminazione(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.conclusa
  ) {
    return;
  }

  partita.fase =
    "determinazione_ordine";

  partita.ordineDeterminazione =
    Object.keys(
      partita.giocatori
    );

  partita.risultatiDeterminazione =
    {};

  partita.codaDeterminazione =
    [
      ...partita.ordineDeterminazione
    ];

  partita.turnoInCorsoDeterminazione =
    null;

  partita.gruppoSpareggioAttuale =
    null;

  partita.ordineFinaleInAttesa =
    false;

  avanzaDeterminazione(
    partita,
    nomeStanza
  ).catch(
    console.error
  );
}

async function avanzaDeterminazione(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.conclusa ||
    partita.fase !==
      "determinazione_ordine"
  ) {
    return;
  }

  const giocatoriValidi =
    (
      partita.ordineDeterminazione ||
      []
    ).filter(
      uid =>
        partita.giocatori[
          uid
        ]
    );

  partita.ordineDeterminazione =
    giocatoriValidi;

  if (
    partita.codaDeterminazione
  ) {
    partita.codaDeterminazione =
      partita
        .codaDeterminazione
        .filter(
          uid =>
            partita.giocatori[
              uid
            ]
        );
  }

  if (
    partita.ordineFinaleInAttesa
  ) {
    return;
  }

  if (
    !Array.isArray(
      partita.codaDeterminazione
    )
  ) {
    partita.codaDeterminazione =
      [];
  }

  if (
    partita.codaDeterminazione.length ===
    0
  ) {
    const esito =
      calcolaOrdineDaiRisultati(
        partita.risultatiDeterminazione ||
          {},
        partita.ordineDeterminazione
      );

    if (
      esito.prossimoGruppoParitario
    ) {
      partita.gruppoSpareggioAttuale =
        esito.prossimoGruppoParitario;

      partita.codaDeterminazione =
        [
          ...esito.prossimoGruppoParitario
        ];

      await salvaPartita(
        partita
      );

      await avanzaDeterminazione(
        partita,
        nomeStanza
      );

      return;
    }

    if (
      !esito.ordineFinale ||
      esito.ordineFinale.length <
        2
    ) {
      await rimuoviPartita(
        nomeStanza,
        partita.id
      );

      return;
    }

    partita.gruppoSpareggioAttuale =
      null;

    partita.ordineFinaleInAttesa =
      true;

    const nomi =
      esito.ordineFinale.map(
        uid =>
          partita.giocatori[
            uid
          ]?.nome ||
          "?"
      );

    const punteggi = {};

    esito.ordineFinale.forEach(
      uid => {
        punteggi[
          partita.giocatori[
            uid
          ].nome
        ] =
          partita
            .risultatiDeterminazione[
            uid
          ];
      }
    );

    inviaAllaPartita(
      partita,
      {
        tipo:
          "ordineFinaleCalcolato",

        ordineGiocatori:
          nomi,

        punteggi
      }
    );

    await salvaPartita(
      partita
    );

    setTimeout(
      async () => {
        const trovato =
          trovaPartita(
            partita.id
          );

        if (
          !trovato ||
          trovato.partita !==
            partita ||
          partita.conclusa
        ) {
          return;
        }

        await completaDeterminazione(
          partita,
          nomeStanza,
          esito.ordineFinale
        );
      },
      2600
    );

    return;
  }

  partita.turnoInCorsoDeterminazione =
    partita.codaDeterminazione.shift();

  avviaTimerDeterminazione(
    partita,
    nomeStanza
  );

  await salvaPartita(
    partita
  );

  inviaStatoDeterminazione(
    partita
  );
}

async function espelliPerInattivitaDuranteDeterminazione(
  partita,
  nomeStanza,
  uid
) {
  if (
    !partita ||
    partita.conclusa ||
    partita.fase !==
      "determinazione_ordine"
  ) {
    return;
  }

  fermaTimerTurno(
    partita
  );

  const nomeUscente =
    partita.giocatori[
      uid
    ]?.nome ||
    "?";

  if (db) {
    try {
      const ref =
        db.ref(
          "utenti/" +
            uid
        );

      const u =
        (
          await ref.once(
            "value"
          )
        ).val();

      if (u) {
        await ref.update({
          xp:
            Math.max(
              0,
              Number(u.xp || 0) -
                xpPenalitaAbbandonoAutomatico()
            ),

          streakVittorieAttuale:
            0
        });
      }
    } catch (e) {
      console.error(
        "Errore penalità determinazione:",
        e.message
      );
    }
  }

  rimuoviGiocatoreDaDeterminazione(
    partita,
    uid
  );

  const restanti =
    Object.keys(
      partita.giocatori
    );

  if (
    restanti.length <
    2
  ) {
    await rimuoviPartita(
      nomeStanza,
      partita.id
    );

    inviaListaPartite(
      nomeStanza
    );

    inviaConteggioStanze();

    return;
  }

  partita.codaDeterminazione =
    partita.codaDeterminazione ||
    [];

  if (
    !partita.codaDeterminazione.includes(
      partita.turnoInCorsoDeterminazione
    ) &&
    partita.turnoInCorsoDeterminazione
  ) {
    partita.codaDeterminazione.push(
      partita.turnoInCorsoDeterminazione
    );
  }

  partita.turnoInCorsoDeterminazione =
    null;

  inviaAllaPartita(
    partita,
    {
      tipo:
        "statoDeterminazione",

      giocatori:
        (
          partita.ordineDeterminazione ||
          []
        )
          .filter(
            x =>
              partita.giocatori[
                x
              ]
          )
          .map(
            x => ({
              uid:
                x,
              nome:
                partita.giocatori[
                  x
                ].nome,
              avatar:
                partita.giocatori[
                  x
                ].avatar ||
                null,
              risultato:
                partita
                  .risultatiDeterminazione?.[
                  x
                ] ?? null
            })
          ),

      turnoInCorsoUid:
        null,

      gruppoSpareggioAttuale:
        partita.gruppoSpareggioAttuale ||
        null,

      messaggi: [
        nomeUscente +
          " è stato rimosso per inattività."
      ]
    }
  );

  await salvaPartita(
    partita
  );

  await avanzaDeterminazione(
    partita,
    nomeStanza
  );

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();
}

async function completaDeterminazione(
  partita,
  nomeStanza,
  ordineFinale
) {
  if (
    !partita ||
    partita.conclusa
  ) {
    return;
  }

  partita.ordineGiocatori =
    ordineFinale.filter(
      uid =>
        partita.giocatori[
          uid
        ]
    );

  if (
    partita.ordineGiocatori.length <
    2
  ) {
    await rimuoviPartita(
      nomeStanza,
      partita.id
    );

    return;
  }

  partita.turnoAttuale =
    0;

  partita.fase =
    "in_corso";

  partita.iniziata =
    true;

  partita.iniziataIl =
    partita.iniziataIl ||
    Date.now();

  partita.ordineFinaleInAttesa =
    false;

  partita.elaborandoTiro =
    false;

  partita.animazioneTiroInCorso =
    false;

  partita.tiriEffettuatiNelTurno =
    0;

  partita.tiriConsentitiNelTurno =
    1;

  const punteggiPerNome = {};

  partita.ordineGiocatori.forEach(
    uid => {
      punteggiPerNome[
        partita.giocatori[
          uid
        ].nome
      ] =
        partita
          .risultatiDeterminazione[
          uid
        ];
    }
  );

  partita.punteggiOrdineIniziale =
    punteggiPerNome;

  avviaTimerTurno(
    partita,
    nomeStanza
  );

  inviaAllaPartita(
    partita,
    {
      tipo:
        "determinazioneCompletata",

      ordineGiocatori:
        partita.ordineGiocatori,

      punteggiOrdineIniziale:
        punteggiPerNome,

      primoMovimento: {
        idGiocatore:
          partita
            .ordineGiocatori[0],

        nomeGiocatore:
          partita.giocatori[
            partita
              .ordineGiocatori[0]
          ].nome,

        valoreDado:
          0,

        percorso:
          [],

        messaggi: [
          "Ordine deciso!",
          partita.giocatori[
            partita
              .ordineGiocatori[0]
          ].nome +
            " inizia la partita: tira i dadi!"
        ]
      },

      giocatori:
        costruisciStatoGiocatori(
          partita
        ),

      turnoDiId:
        partita
          .ordineGiocatori[
          partita.turnoAttuale
        ],

      tempoInizioTurno:
        partita.tempoInizioTurno,

      scadenzaTurno:
        partita.scadenzaTurno,

      durataMossaMs:
        millisecondiMossa(
          partita
        ),

      vittoria:
        false,

      vincitore:
        null
    }
  );

  await salvaPartita(
    partita
  );

  inviaConteggioStanze();
}

/* ============================================================
   USCITA DA PARTITA IN ATTESA
   ============================================================ */

async function esciDaPartitaInAttesa(
  partita,
  nomeStanza,
  uid
) {
  if (
    !partita ||
    partita.conclusa ||
    partita.fase !==
      "attesa_giocatori"
  ) {
    return false;
  }

  if (
    !partita.giocatori[
      uid
    ]
  ) {
    return false;
  }

  const eraCreatore =
    partita.creatoDa ===
    uid;

  const nomeUscente =
    partita.giocatori[
      uid
    ].nome ||
    "Giocatore";

  delete partita.giocatori[
    uid
  ];

  partita.ordineGiocatori =
    (
      partita.ordineGiocatori ||
      []
    ).filter(
      x =>
        x !==
        uid
    );

  const restanti =
    Object.keys(
      partita.giocatori
    );

  if (
    restanti.length ===
    0
  ) {
    await rimuoviPartita(
      nomeStanza,
      partita.id
    );

    inviaListaPartite(
      nomeStanza
    );

    inviaConteggioStanze();

    return true;
  }

  if (eraCreatore) {
    const nuovoCreatoreUid =
      partita
        .ordineGiocatori[0];

    const nuovoCreatore =
      partita.giocatori[
        nuovoCreatoreUid
      ];

    if (nuovoCreatore) {
      partita.creatoDa =
        nuovoCreatoreUid;

      partita.creatore =
        nuovoCreatore.nome;
    }
  }

  await salvaPartita(
    partita
  );

  inviaAllaStanza(
    nomeStanza,
    {
      tipo:
        "giocatoreHaLasciatoPartita",

      partitaId:
        partita.id,

      uid,
      nome:
        nomeUscente,

      nuovoCreatoreUid:
        partita.creatoDa
    }
  );

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();

  return true;
}

/* ============================================================
   PARTITE
   ============================================================ */

async function rimuoviPartita(
  nomeStanza,
  partitaId
) {
  const stanza =
    stanze[
      nomeStanza
    ];

  const partita =
    stanza?.partite?.[
      partitaId
    ];

  if (partita) {
    partita.conclusa =
      true;

    fermaTimerTurno(
      partita
    );

    partita.elaborandoTiro =
      false;

    partita.animazioneTiroInCorso =
      false;

    delete stanza.partite[
      partitaId
    ];
  }

  if (
    db &&
    partitaId
  ) {
    try {
      await db
        .ref(
          "partite/" +
            partitaId
        )
        .remove();
    } catch (e) {
      console.error(
        "Errore rimozione Firebase:",
        e.message
      );
    }
  }
}

async function ripristinaDeterminazione(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.conclusa
  ) {
    return;
  }

  if (
    partita.ordineFinaleInAttesa
  ) {
    setTimeout(
      () => {
        const trovato =
          trovaPartita(
            partita.id
          );

        if (
          trovato &&
          trovato.partita ===
            partita &&
          !partita.conclusa
        ) {
          const esito =
            calcolaOrdineDaiRisultati(
              partita.risultatiDeterminazione ||
                {},
              partita.ordineDeterminazione ||
                []
            );

          if (
            esito.ordineFinale
          ) {
            completaDeterminazione(
              partita,
              nomeStanza,
              esito.ordineFinale
            ).catch(
              console.error
            );
          }
        }
      },
      500
    );

    return;
  }

  if (
    !Array.isArray(
      partita.codaDeterminazione
    ) ||
    partita.codaDeterminazione.length ===
      0
  ) {
    await avanzaDeterminazione(
      partita,
      nomeStanza
    );

    return;
  }

  if (
    partita.turnoInCorsoDeterminazione
  ) {
    const scadenza =
      Number(
        partita.scadenzaTurno
      );

    if (
      Number.isFinite(
        scadenza
      ) &&
      scadenza > 0
    ) {
      fermaTimerTurno(
        partita
      );

      const token =
        partita.tokenTimerTurno;

      const ritardo =
        Math.max(
          0,
          scadenza -
            Date.now() +
            TOLLERANZA_MOSSA_MS
        );

      partita.timerTurno =
        setTimeout(
          async () => {
            if (
              partita.conclusa ||
              token !==
                partita.tokenTimerTurno
            ) {
              return;
            }

            partita.timerTurno =
              null;

            await gestisciScadenzaDeterminazione(
              partita,
              nomeStanza
            );
          },
          ritardo
        );
    } else {
      avviaTimerDeterminazione(
        partita,
        nomeStanza
      );
    }

    inviaStatoDeterminazione(
      partita
    );

    return;
  }

  await avanzaDeterminazione(
    partita,
    nomeStanza
  );
}

async function ripristinaPartiteDaFirebase() {
  if (!db) {
    console.warn(
      "Firebase non disponibile: impossibile ripristinare partite."
    );

    return;
  }

  const partiteFirebase =
    await caricaPartite();

  for (
    const id in partiteFirebase
  ) {
    const dati =
      partiteFirebase[id];

    if (
      !dati ||
      !dati.stanza ||
      !stanze[dati.stanza]
    ) {
      continue;
    }

    const partita = {
      ...dati,

      maxGiocatori:
        Number(
          dati.maxGiocatori ||
            Object.keys(
              dati.giocatori ||
                {}
            ).length ||
            2
        ),

      chatAttiva:
        dati.chatAttiva !==
        false,

      giocatori:
        dadosJogadoresSafe(
          dati.giocatori
        ),

      ordemJogadoresSafe:
        Array.isArray(
          dati.ordineGiocatori
        )
          ? dati.ordineGiocatori
          : [],

      ordineGiocatori:
        Array.isArray(
          dati.ordineGiocatori
        )
          ? dati.ordineGiocatori
          : [],

      turnoAttuale:
        Number(
          dati.turnoAttuale || 0
        ),

      iniziata:
        dati.iniziata ===
        true,

      iniziataIl:
        dati.iniziataIl ||
        null,

      punteggiOrdineIniziale:
        dati.punteggiOrdineIniziale ||
        null,

      tiriEffettuatiNelTurno:
        Number(
          dati.tiriEffettuatiNelTurno ||
            0
        ),

      tiriConsentitiNelTurno:
        Number(
          dati.tiriConsentitiNelTurno ||
            1
        ),

      tempoInizioTurno:
        dati.tempoInizioTurno ||
        null,

      scadenzaTurno:
        dati.scadenzaTurno ||
        null,

      invitati:
        dadosInvitatiSafe(
          dati.invitati
        ),

      ordineDeterminazione:
        Array.isArray(
          dati.ordineDeterminazione
        )
          ? dati.ordineDeterminazione
          : [],

      risultatiDeterminazione:
        dadosRisultatiSafe(
          dati.risultatiDeterminazione
        ),

      codaDeterminazione:
        Array.isArray(
          dati.codaDeterminazione
        )
          ? dati.codaDeterminazione
          : [],

      turnoInCorsoDeterminazione:
        dati.turnoInCorsoDeterminazione ||
        null,

      gruppoSpareggioAttuale:
        Array.isArray(
          dati.gruppoSpareggioAttuale
        )
          ? dati.gruppoSpareggioAttuale
          : null,

      ordineFinaleInAttesa:
        dati.ordineFinaleInAttesa ===
        true,

      elaborandoTiro:
        false,

      animazioneTiroInCorso:
        false,

      timerTurno:
        null,

      tokenTimerTurno:
        0,

      conclusa:
        false,

      coppieAudioApprovate:
        new Set(),

      richiesteAudioPendenti:
        new Set(),

      fase:
        dati.fase ||
        (
          dati.iniziata ===
          true
            ? "in_corso"
            : "attesa_giocatori"
        )
    };

    for (
      const uid in
        partita.giocatori
    ) {
      partita.giocatori[
        uid
      ].socket =
        null;

      partita.giocatori[
        uid
      ].tentativiAutomaticiConsecutivi =
        0;
    }

    stanze[
      dati.stanza
    ].partite[
      id
    ] =
      partita;

    if (
      partita.iniziata
    ) {
      partita.fase =
        "in_corso";

      ripristinaTimerTurno(
        partita,
        dati.stanza
      );
    } else if (
      partita.fase ===
      "determinazione_ordine"
    ) {
      await ripristinaDeterminazione(
        partita,
        dati.stanza
      );
    } else if (
      Object.keys(
        partita.giocatori
      ).length >=
      partita.maxGiocatori
    ) {
      iniziaFaseDeterminazione(
        partita,
        dati.stanza
      );
    }
  }

  console.log(
    "Partite ripristinate:",
    Object.keys(
      partiteFirebase
    ).length
  );
}

function dadosJogadoresSafe(
  giocatori
) {
  const out = {};

  for (
    const uid in
      giocatori || {}
  ) {
    const g =
      giocatori[uid];

    out[uid] = {
      nome:
        g?.nome ||
        "?",

      avatar:
        g?.avatar ||
        null,

      posizione:
        Number(
          g?.posizione || 0
        ),

      turniSaltati:
        Number(
          g?.turniSaltati || 0
        )
    };
  }

  return out;
}

function dadosInvitatiSafe(
  invitati
) {
  const out = {};

  for (
    const uid in
      invitati || {}
  ) {
    out[uid] =
      true;
  }

  return out;
}

function dadosRisultatiSafe(
  risultati
) {
  const out = {};

  for (
    const uid in
      risultati || {}
  ) {
    const n =
      Number(
        risultati[uid]
      );

    if (
      Number.isFinite(
        n
      )
    ) {
      out[uid] =
        n;
    }
  }

  return out;
}

/* ============================================================
   WEBSOCKET SECURITY / LIMITI
   ============================================================ */

function verificaOrigineWebSocket(
  origin
) {
  if (!origin) {
    return true;
  }

  return ORIGINI_CONSENTITE.has(
    origin
  );
}

function controllaLimiteSocket(
  socket,
  chiave,
  massimo,
  finestraMs
) {
  const adesso =
    Date.now();

  if (
    !socket.rateLimits
  ) {
    socket.rateLimits =
      {};
  }

  const entry =
    socket.rateLimits[
      chiave
    ];

  if (
    !entry ||
    adesso -
      entry.inizio >=
      finestraMs
  ) {
    socket.rateLimits[
      chiave
    ] = {
      inizio:
        adesso,
      conteggio:
        1
    };

    return true;
  }

  entry.conteggio++;

  if (
    entry.conteggio >
    massimo
  ) {
    return false;
  }

  return true;
}

function socketAutorizzato(
  socket,
  uid
) {
  return (
    socket &&
    uid &&
    socket.uid ===
      uid &&
    socket.authenticated ===
      true
  );
}

async function aggiornaUtenteSocket(
  socket
) {
  if (
    !db ||
    !socket.uid
  ) {
    return null;
  }

  try {
    const u =
      (
        await db
          .ref(
            "utenti/" +
              socket.uid
          )
          .once(
            "value"
          )
      ).val();

    if (!u) {
      return null;
    }

    if (
      u.stato ===
      "bannato"
    ) {
      return {
        bloccato:
          true,
        motivo:
          "Il tuo account è stato bannato."
      };
    }

    if (
      u.stato ===
        "sospeso" &&
      u.sospesoFino &&
      Number(
        u.sospesoFino
      ) >
        Date.now()
    ) {
      return {
        bloccato:
          true,

        motivo:
          "Account sospeso fino al " +
          new Date(
            u.sospesoFino
          ).toLocaleString(
            "it-IT"
          ) +
          "."
      };
    }

    socket.nickname =
      u.nickname ||
      socket.nickname;

    socket.avatar =
      u.avatar ||
      null;

    socket.ruolo =
      u.ruolo ||
      "utente";

    return {
      bloccato:
        false,
      utente:
        u
    };
  } catch {
    return null;
  }
}

/* ============================================================
   WEBSOCKET MESSAGE HANDLER
   ============================================================ */

async function gestisciMessaggioSocket(
  socket,
  message
) {
  if (
    !socketAutorizzato(
      socket,
      socket.uid
    )
  ) {
    return;
  }

  if (
    !Buffer.isBuffer(
      message
    )
  ) {
    message =
      Buffer.from(
        String(message)
      );
  }

  if (
    message.length >
    MAX_WS_MESSAGE_BYTES
  ) {
    socket.close(
      1009,
      "Messaggio troppo grande"
    );
    return;
  }

  let dati;

  try {
    dati =
      JSON.parse(
        message.toString("utf8")
      );
  } catch {
    return;
  }

  if (
    !dati ||
    typeof dati.tipo !==
      "string"
  ) {
    return;
  }

  if (
    !controllaLimiteSocket(
      socket,
      "generale",
      100,
      10_000
    )
  ) {
    socket.send(
      JSON.stringify({
        tipo:
          "errore",
        messaggio:
          "Stai inviando troppi messaggi."
      })
    );

    return;
  }

  /* ==========================================================
     CONTEGGIO
     ========================================================== */

  if (
    dati.tipo ===
    "richiediConteggio"
  ) {
    inviaConteggioStanze();
    return;
  }

  /* ==========================================================
     AUDIO / WEBRTC
     ========================================================== */

  const tipiAudio = new Set([
    "richiestaAudio",
    "rispostaAudio",
    "webrtc-offer",
    "webrtc-answer",
    "webrtc-ice-candidate"
  ]);

  if (
    tipiAudio.has(
      dati.tipo
    )
  ) {
    if (
      !controllaLimiteSocket(
        socket,
        "audio",
        30,
        10_000
      )
    ) {
      return;
    }

    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    const uid =
      socket.uid;

    if (
      !partita.giocatori[uid]
    ) {
      return;
    }

    const destinatarioUid =
      typeof dati.destinatarioUid ===
      "string"
        ? dati.destinatarioUid
        : null;

    if (
      !destinatarioUid ||
      destinatarioUid ===
        uid
    ) {
      return;
    }

    const destinatario =
      partita.giocatori[
        destinatarioUid
      ];

    if (
      !destinatario
    ) {
      return;
    }

    if (
      dati.tipo ===
      "richiestaAudio"
    ) {
      if (
        !partita.richiesteAudioPendenti
      ) {
        partita.richiesteAudioPendenti =
          new Set();
      }

      partita.richiesteAudioPendenti.add(
        idConversazione(
          uid,
          destinatarioUid
        )
      );

      inviaAgiocatore(
        destinatario,
        {
          tipo:
            "richiestaAudioRicevuta",

          mittenteUid:
            uid,

          mittenteNome:
            socket.nickname
        }
      );

      return;
    }

    const coppia =
      idConversazione(
        uid,
        destinatarioUid
      );

    if (
      dati.tipo ===
      "rispostaAudio"
    ) {
      if (
        dati.accettato
      ) {
        const pendenti =
          partita.richiesteAudioPendenti ||
          new Set();

        if (
          !pendenti.has(
            coppia
          )
        ) {
          return;
        }

        if (
          !partita.coppieAudioApprovate
        ) {
          partita.coppieAudioApprovate =
            new Set();
        }

        partita.coppieAudioApprovate.add(
          coppia
        );

        pendenti.delete(
          coppia
        );
      } else if (
        partita.richiesteAudioPendenti
      ) {
        partita.richiesteAudioPendenti.delete(
          coppia
        );
      }

      inviaAgiocatore(
        destinatario,
        {
          tipo:
            "rispostaAudioRicevuta",

          mittenteUid:
            uid,

          mittenteNome:
            socket.nickname,

          accettato:
            !!dati.accettato
        }
      );

      return;
    }

    const approvata =
      partita
        .coppieAudioApprovate &&
      partita
        .coppieAudioApprovate
        .has(
          coppia
        );

    if (
      !approvata
    ) {
      return;
    }

    if (
      dati.tipo ===
      "webrtc-offer" ||
      dati.tipo ===
      "webrtc-answer"
    ) {
      if (
        !dati.sdp
      ) {
        return;
      }

      inviaAgiocatore(
        destinatario,
        {
          tipo:
            dati.tipo,

          mittenteUid:
            uid,

          sdp:
            dati.sdp
        }
      );

      return;
    }

    if (
      dati.tipo ===
      "webrtc-ice-candidate"
    ) {
      if (
        !dati.candidate
      ) {
        return;
      }

      inviaAgiocatore(
        destinatario,
        {
          tipo:
            dati.tipo,

          mittenteUid:
            uid,

          candidate:
            dati.candidate
        }
      );
    }

    return;
  }

  /* ==========================================================
     SESSIONE / UTENTE
     ========================================================== */

  const controlloUtente =
    await aggiornaUtenteSocket(
      socket
    );

  if (!controlloUtente) {
    socket.send(
      JSON.stringify({
        tipo:
          "errore",
        messaggio:
          "Sessione non disponibile."
      })
    );

    return;
  }

  if (
    controlloUtente.bloccato
  ) {
    socket.send(
      JSON.stringify({
        tipo:
          "errore",
        messaggio:
          controlloUtente.motivo
      })
    );

    socket.close(
      1008,
      "Account bloccato"
    );

    return;
  }

  /* ==========================================================
     ENTRA LOBBY
     ========================================================== */

  if (
    dati.tipo ===
    "entraLobby"
  ) {
    if (
      !controllaLimiteSocket(
        socket,
        "lobby",
        10,
        10_000
      )
    ) {
      return;
    }

    const nomeStanza =
      stringaSicura(
        dati.stanza,
        30
      );

    if (
      !stanze[nomeStanza]
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Stanza non valida."
        })
      );

      return;
    }

    socket.stanzaAttuale =
      nomeStanza;

    rimuoviVecchieConnessioniOnline(
      nomeStanza,
      socket.uid,
      socket.id
    );

    stanze[nomeStanza]
      .giocatoriOnline[
        socket.id
      ] = {
        uid:
          socket.uid,

        nickname:
          socket.nickname,

        avatar:
          socket.avatar,

        tipoDispositivo:
          socket.tipoDispositivo,

        socket
      };

    for (
      const partita of Object.values(
        stanze[nomeStanza]
          .partite
      )
    ) {
      if (
        partita.giocatori &&
        partita.giocatori[
          socket.uid
        ] &&
        partita.fase ===
          "attesa_giocatori"
      ) {
        partita.giocatori[
          socket.uid
        ].socket =
          socket;
      }
    }

    inviaConteggioStanze();

    inviaAllaStanza(
      nomeStanza,
      {
        tipo:
          "online",

        numero:
          Object.keys(
            stanze[nomeStanza]
              .giocatoriOnline
          ).length
      }
    );

    inviaListaPartite(
      nomeStanza
    );

    socket.send(
      JSON.stringify({
        tipo:
          "statoPartitaPersonale",

        partitaAttiva:
          trovaPartitaAttivaPerUid(
            socket.uid
          )
      })
    );

    return;
  }

  /* ==========================================================
     RIPRENDI PARTITA
     ========================================================== */

  if (
    dati.tipo ===
    "riprendiPartita"
  ) {
    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Partita non trovata."
        })
      );

      return;
    }

    const partita =
      trovato.partita;

    const nomeStanza =
      trovato.nomeStanza;

    const giocatore =
      partita.giocatori[
        socket.uid
      ];

    if (!giocatore) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Non fai parte di questa partita."
        })
      );

      return;
    }

    socket.stanzaAttuale =
      nomeStanza;

    giocatore.socket =
      socket;

    giocatore.avatar =
      socket.avatar;

    giocatore.nome =
      giocatore.nome ||
      socket.nickname;

    rimuoviVecchieConnessioniOnline(
      nomeStanza,
      socket.uid,
      socket.id
    );

    stanze[nomeStanza]
      .giocatoriOnline[
        socket.id
      ] = {
        uid:
          socket.uid,

        nickname:
          socket.nickname,

        avatar:
          socket.avatar,

        tipoDispositivo:
          socket.tipoDispositivo,

        socket
      };

    inviaConteggioStanze();

    if (
      partita.fase ===
      "determinazione_ordine"
    ) {
      inviaStatoDeterminazione(
        partita
      );
    } else {
      inviaAgiocatore(
        giocatore,
        {
          tipo:
            "statoPartita",

          giocatori:
            costruisciStatoGiocatori(
              partita
            ),

          turnoDiId:
            partita
              .ordineGiocatori[
              partita.turnoAttuale
            ],

          punteggiOrdineIniziale:
            partita.punteggiOrdineIniziale ||
            null,

          tempoInizioTurno:
            partita.tempoInizioTurno ||
            null,

          durataMossaMs:
            millisecondiMossa(
              partita
            ),

          scadenzaTurno:
            partita.scadenzaTurno ||
            null,

          tiriEffettuatiNelTurno:
            partita.tiriEffettuatiNelTurno,

          tiriConsentitiNelTurno:
            partita.tiriConsentitiNelTurno,

          chatAttiva:
            partita.chatAttiva !==
            false
        }
      );
    }

    return;
  }

  /* ==========================================================
     CREA PARTITA
     ========================================================== */

  if (
    dati.tipo ===
    "creaPartita"
  ) {
    if (
      !socket.stanzaAttuale
    ) {
      return;
    }

    if (
      trovaPartitaAttivaPerUid(
        socket.uid
      )
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Hai già una partita attiva."
        })
      );

      return;
    }

    const stanza =
      stanze[
        socket.stanzaAttuale
      ];

    const partitaId =
      "p" +
      Date.now() +
      "_" +
      tokenCasuale(6);

    const max =
      Number.parseInt(
        dati.maxGiocatori,
        10
      );

    const maxGiocatori =
      Number.isFinite(max) &&
      max >= 2 &&
      max <= 8
        ? max
        : 2;

    const partita = {
      id:
        partitaId,

      stanza:
        socket.stanzaAttuale,

      creatore:
        socket.nickname,

      creatoDa:
        socket.uid,

      tempo:
        Number.parseInt(
          dati.tempo,
          10
        ) > 0
          ? Number.parseInt(
              dati.tempo,
              10
            )
          : 30,

      punti:
        stringaSicura(
          dati.punti ||
            "",
          50
        ),

      modalita:
        dati.modalita ===
        "privata"
          ? "privata"
          : "pubblica",

      maxGiocatori,

      chatAttiva:
        dati.chatAttiva !==
        false,

      fase:
        "attesa_giocatori",

      giocatori: {
        [socket.uid]: {
          nome:
            socket.nickname,

          avatar:
            socket.avatar,

          posizione:
            0,

          turniSaltati:
            0,

          tentativiAutomaticiConsecutivi:
            0,

          socket
        }
      },

      ordineGiocatori:
        [socket.uid],

      turnoAttuale:
        0,

      iniziata:
        false,

      iniziataIl:
        null,

      punteggiOrdineIniziale:
        null,

      tiriEffettuatiNelTurno:
        0,

      tiriConsentitiNelTurno:
        1,

      tempoInizioTurno:
        null,

      scadenzaTurno:
        null,

      timerTurno:
        null,

      tokenTimerTurno:
        0,

      elaborandoTiro:
        false,

      animazioneTiroInCorso:
        false,

      invitati:
        socket.stanzaAttuale
          ? (
              dati.modalita ===
              "privata"
                ? {
                    [socket.uid]:
                      true
                  }
                : {}
            )
          : {},

      coppieAudioApprovate:
        new Set(),

      richiesteAudioPendenti:
        new Set(),

      conclusa:
        false
    };

    stanza.partite[
      partitaId
    ] =
      partita;

    await salvaPartita(
      partita
    );

    inviaListaPartite(
      socket.stanzaAttuale
    );

    inviaConteggioStanze();

    return;
  }

  /* ==========================================================
     ENTRA PARTITA PUBBLICA
     ========================================================== */

  if (
    dati.tipo ===
    "entraPartita"
  ) {
    if (
      !socket.stanzaAttuale ||
      !dati.id
    ) {
      return;
    }

    if (
      trovaPartitaAttivaPerUid(
        socket.uid
      )
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Sei già dentro una partita."
        })
      );

      return;
    }

    const partita =
      stanze[
        socket.stanzaAttuale
      ].partite[
        dati.id
      ];

    if (!partita) {
      return;
    }

    if (
      partita.fase !==
      "attesa_giocatori"
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "La partita è già iniziata."
        })
      );

      return;
    }

    if (
      partita.giocatori[
        socket.uid
      ]
    ) {
      return;
    }

    if (
      Object.keys(
        partita.giocatori
      ).length >=
      partita.maxGiocatori
    ) {
      return;
    }

    if (
      partita.modalita ===
      "privata"
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Questa partita è privata."
        })
      );

      return;
    }

    partita.giocatori[
      socket.uid
    ] = {
      nome:
        socket.nickname,

      avatar:
        socket.avatar,

      posizione:
        0,

      turniSaltati:
        0,

      tentativiAutomaticiConsecutivi:
        0,

      socket
    };

    partita.ordineGiocatori.push(
      socket.uid
    );

    await salvaPartita(
      partita
    );

    inviaListaPartite(
      socket.stanzaAttuale
    );

    if (
      Object.keys(
        partita.giocatori
      ).length >=
      partita.maxGiocatori
    ) {
      iniziaFaseDeterminazione(
        partita,
        socket.stanzaAttuale
      );

      await salvaPartita(
        partita
      );

      inviaAllaPartita(
        partita,
        {
          tipo:
            "partitaAvviata",

          partitaId:
            partita.id
        }
      );
    }

    inviaConteggioStanze();

    return;
  }

  /* ==========================================================
     INVITA PARTITA PRIVATA
     ========================================================== */

  if (
    dati.tipo ===
    "invitaPartita"
  ) {
    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    const nomeStanza =
      trovato.nomeStanza;

    if (
      partita.creatoDa !==
      socket.uid
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Solo il creatore può invitare giocatori."
        })
      );

      return;
    }

    if (
      partita.modalita !==
      "privata"
    ) {
      return;
    }

    if (
      partita.fase !==
      "attesa_giocatori"
    ) {
      return;
    }

    const destinatarioUid =
      dati.destinatarioUid;

    if (
      typeof destinatarioUid !==
        "string" ||
      !destinatarioUid ||
      destinatarioUid ===
        socket.uid
    ) {
      return;
    }

    if (
      partita.giocatori[
        destinatarioUid
      ]
    ) {
      return;
    }

    if (
      Object.keys(
        partita.giocatori
      ).length >=
      partita.maxGiocatori
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "La partita è piena."
        })
      );

      return;
    }

    const online =
      Object.values(
        stanze[nomeStanza]
          .giocatoriOnline
      ).find(
        g =>
          g.uid ===
          destinatarioUid
      );

    if (!online?.socket) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Questo giocatore non è più online nella stanza."
        })
      );

      return;
    }

    if (
      !partita.invitati
    ) {
      partita.invitati =
        {};
    }

    partita.invitati[
      destinatarioUid
    ] =
      true;

    await salvaPartita(
      partita
    );

    inviaAgiocatore(
      online,
      {
        tipo:
          "invitoRicevuto",

        partitaId:
          partita.id,

        stanza:
          nomeStanza,

        daUid:
          socket.uid,

        daNome:
          socket.nickname
      }
    );

    if (db) {
      db.ref(
        `utenti/${destinatarioUid}/notifiche`
      )
        .push({
          tipo:
            "invitoPartita",

          testo:
            `${socket.nickname} ti ha invitato a giocare nella stanza ${nomeStanza}`,

          data:
            Date.now(),

          letta:
            false,

          daUid:
            socket.uid,

          daNome:
            socket.nickname,

          stanza:
            nomeStanza,

          partitaId:
            partita.id
        })
        .catch(
          () => {}
        );
    }

    socket.send(
      JSON.stringify({
        tipo:
          "invitoInviato",

        destinatarioUid
      })
    );

    return;
  }

  /* ==========================================================
     RISPOSTA INVITO
     ========================================================== */

  if (
    dati.tipo ===
    "rispostaInvito"
  ) {
    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    const nomeStanza =
      trovato.nomeStanza;

    if (
      !partita.invitati?.[
        socket.uid
      ]
    ) {
      return;
    }

    if (
      !dati.accettato
    ) {
      delete partita.invitati[
        socket.uid
      ];

      await salvaPartita(
        partita
      );

      const creatore =
        partita.giocatori[
          partita.creatoDa
        ];

      inviaAgiocatore(
        creatore,
        {
          tipo:
            "invitoRifiutato",

          destinatarioNome:
            socket.nickname
        }
      );

      return;
    }

    if (
      trovaPartitaAttivaPerUid(
        socket.uid
      )
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Sei già in un'altra partita."
        })
      );

      return;
    }

    if (
      partita.fase !==
      "attesa_giocatori"
    ) {
      return;
    }

    if (
      Object.keys(
        partita.giocatori
      ).length >=
      partita.maxGiocatori
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "La partita si è già riempita."
        })
      );

      return;
    }

    partita.giocatori[
      socket.uid
    ] = {
      nome:
        socket.nickname,

      avatar:
        socket.avatar,

      posizione:
        0,

      turniSaltati:
        0,

      tentativiAutomaticiConsecutivi:
        0,

      socket
    };

    partita.ordineGiocatori.push(
      socket.uid
    );

    delete partita.invitati[
      socket.uid
    ];

    socket.stanzaAttuale =
      nomeStanza;

    await salvaPartita(
      partita
    );

    inviaListaPartite(
      nomeStanza
    );

    if (
      Object.keys(
        partita.giocatori
      ).length >=
      partita.maxGiocatori
    ) {
      iniziaFaseDeterminazione(
        partita,
        nomeStanza
      );

      await salvaPartita(
        partita
      );

      inviaAllaPartita(
        partita,
        {
          tipo:
            "partitaAvviata",

          partitaId:
            partita.id
        }
      );
    }

    inviaConteggioStanze();

    return;
  }

  /* ==========================================================
     ELIMINA PARTITA
     ========================================================== */

  if (
    dati.tipo ===
    "eliminaPartita"
  ) {
    if (
      !socket.stanzaAttuale
    ) {
      return;
    }

    const partita =
      Object.values(
        stanze[
          socket.stanzaAttuale
        ].partite
      ).find(
        p =>
          p.creatoDa ===
          socket.uid
      );

    if (!partita) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Non hai nessuna partita da eliminare."
        })
      );

      return;
    }

    if (
      partita.fase !==
      "attesa_giocatori"
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Non puoi eliminare una partita già iniziata."
        })
      );

      return;
    }

    await rimuoviPartita(
      socket.stanzaAttuale,
      partita.id
    );

    inviaListaPartite(
      socket.stanzaAttuale
    );

    inviaConteggioStanze();

    return;
  }

  /* ==========================================================
     CHAT LOBBY
     ========================================================== */

  if (
    dati.tipo ===
    "chat"
  ) {
    if (
      !socket.stanzaAttuale
    ) {
      return;
    }

    if (
      !controllaLimiteSocket(
        socket,
        "chat",
        20,
        10_000
      )
    ) {
      return;
    }

    if (
      typeof dati.testo !==
      "string"
    ) {
      return;
    }

    const testo =
      pulisciTesto(
        dati.testo,
        300
      );

    if (!testo) {
      return;
    }

    inviaAllaStanza(
      socket.stanzaAttuale,
      {
        tipo:
          "chat",

        uid:
          socket.uid,

        nome:
          socket.nickname,

        testo
      }
    );

    return;
  }

  /* ==========================================================
     CHAT PARTITA
     ========================================================== */

  if (
    dati.tipo ===
    "chatPartita"
  ) {
    if (
      !controllaLimiteSocket(
        socket,
        "chatPartita",
        20,
        10_000
      )
    ) {
      return;
    }

    if (
      typeof dati.testo !==
      "string"
    ) {
      return;
    }

    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    if (
      partita.chatAttiva ===
      false
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "La chat è disattivata."
        })
      );

      return;
    }

    if (
      !partita.giocatori[
        socket.uid
      ]
    ) {
      return;
    }

    const testo =
      pulisciTesto(
        dati.testo,
        300
      );

    if (!testo) return;

    inviaAllaPartita(
      partita,
      {
        tipo:
          "chatPartita",

        nome:
          socket.nickname,

        testo
      }
    );

    return;
  }

  /* ==========================================================
     DETERMINAZIONE ORDINE
     ========================================================== */

  if (
    dati.tipo ===
    "tiraDeterminazione"
  ) {
    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    if (
      partita.fase !==
      "determinazione_ordine"
    ) {
      return;
    }

    if (
      partita
        .turnoInCorsoDeterminazione !==
      socket.uid
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Non è il tuo turno per la determinazione."
        })
      );

      return;
    }

    if (
      partita.elaborandoTiro
    ) {
      return;
    }

    if (
      partita.giocatori[
        socket.uid
      ]
    ) {
      partita.giocatori[
        socket.uid
      ].tentativiAutomaticiConsecutivi =
        0;
    }

    await eseguiTiroDeterminazionePerGiocatore(
      partita,
      trovato.nomeStanza,
      socket.uid,
      false
    );

    return;
  }

  /* ==========================================================
     TIRO DI PARTITA
     ========================================================== */

  if (
    dati.tipo ===
    "tiraDadi"
  ) {
    if (
      !controllaLimiteSocket(
        socket,
        "tiraDadi",
        15,
        10_000
      )
    ) {
      return;
    }

    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    const nomeStanza =
      trovato.nomeStanza;

    if (
      partita.fase !==
      "in_corso" ||
      !partita.iniziata ||
      partita.conclusa
    ) {
      return;
    }

    if (
      !partita.giocatori[
        socket.uid
      ]
    ) {
      return;
    }

    const uidTurno =
      partita
        .ordineGiocatori[
        partita.turnoAttuale
      ];

    if (
      uidTurno !==
      socket.uid
    ) {
      socket.send(
        JSON.stringify({
          tipo:
            "errore",
          messaggio:
            "Non è il tuo turno!"
        })
      );

      return;
    }

    if (
      partita.elaborandoTiro ||
      partita.animazioneTiroInCorso
    ) {
      return;
    }

    const tiriEffettuati =
      Number(
        partita.tiriEffettuatiNelTurno ||
          0
      );

    const tiriConsentiti =
      Number(
        partita.tiriConsentitiNelTurno ||
          1
      );

    if (
      tiriEffettuati >=
      tiriConsentiti
    ) {
      return;
    }

    const scadenza =
      Number(
        partita.scadenzaTurno
      );

    if (
      Number.isFinite(
        scadenza
      ) &&
      Date.now() >
        scadenza +
          TOLLERANZA_MOSSA_MS
    ) {
      await gestisciScadenzaTurno(
        partita,
        nomeStanza
      );

      return;
    }

    partita.giocatori[
      socket.uid
    ].tentativiAutomaticiConsecutivi =
      0;

    await eseguiTiroDadiPerGiocatore(
      partita,
      nomeStanza,
      socket.uid,
      false
    );

    return;
  }

  /* ==========================================================
     ABBANDONA PARTITA
     ========================================================== */

  if (
    dati.tipo ===
    "abbandonaPartita"
  ) {
    const trovato =
      trovaPartita(
        dati.partitaId
      );

    if (!trovato) return;

    const partita =
      trovato.partita;

    const nomeStanza =
      trovato.nomeStanza;

    if (
      !partita.giocatori[
        socket.uid
      ]
    ) {
      return;
    }

    if (
      partita.fase ===
      "attesa_giocatori"
    ) {
      await esciDaPartitaInAttesa(
        partita,
        nomeStanza,
        socket.uid
      );

      return;
    }

    if (
      partita.fase ===
      "determinazione_ordine"
    ) {
      const eraTurno =
        partita
          .turnoInCorsoDeterminazione ===
        socket.uid;

      fermaTimerTurno(
        partita
      );

      rimuoviGiocatoreDaDeterminazione(
        partita,
        socket.uid
      );

      const restanti =
        Object.keys(
          partita.giocatori
        );

      if (
        restanti.length <
        2
      ) {
        await rimuoviPartita(
          nomeStanza,
          partita.id
        );
      } else {
        if (eraTurno) {
          partita
            .turnoInCorsoDeterminazione =
            null;
        }

        await salvaPartita(
          partita
        );

        await avanzaDeterminazione(
          partita,
          nomeStanza
        );
      }

      inviaListaPartite(
        nomeStanza
      );

      inviaConteggioStanze();

      return;
    }

    /* --------------------------------------------------------
       PARTITA IN CORSO
       -------------------------------------------------------- */

    const uidAttivoPrima =
      partita
        .ordineGiocatori[
        partita.turnoAttuale
      ];

    const eraTurno =
      uidAttivoPrima ===
      socket.uid;

    const nomeUscente =
      partita.giocatori[
        socket.uid
      ].nome;

    const partecipantiOriginali =
      partita.ordineGiocatori.map(
        uid => ({
          uid,
          nome:
            partita.giocatori[
              uid
            ]?.nome ||
            "?"
        })
      );

    fermaTimerTurno(
      partita
    );

    delete partita.giocatori[
      socket.uid
    ];

    partita.ordineGiocatori =
      partita.ordineGiocatori.filter(
        uid =>
          uid !==
          socket.uid
      );

    const restanti =
      partita.ordineGiocatori;

    if (
      restanti.length ===
      0
    ) {
      await rimuoviPartita(
        nomeStanza,
        partita.id
      );

      inviaListaPartite(
        nomeStanza
      );

      inviaConteggioStanze();

      return;
    }

    if (
      restanti.length ===
      1
    ) {
      const vincitoreId =
        restanti[0];

      const vincitore =
        partita.giocatori[
          vincitoreId
        ];

      inviaAllaPartita(
        partita,
        {
          tipo:
            "statoPartita",

          giocatori:
            costruisciStatoGiocatori(
              partita
            ),

          turnoDiId:
            vincitoreId,

          vittoria:
            true,

          vincitore:
            vincitore.nome,

          messaggi: [
            nomeUscente +
              " ha abbandonato la partita."
          ]
        }
      );

      await concludiPartita(
        partita,
        vincitoreId,
        nomeStanza,
        partecipantiOriginali,
        new Set([
          socket.uid
        ])
      );

      await rimuoviPartita(
        nomeStanza,
        partita.id
      );
    } else {
      const nuovoIndice =
        partita.ordineGiocatori.indexOf(
          uidAttivoPrima
        );

      partita.turnoAttuale =
        nuovoIndice >= 0
          ? nuovoIndice
          : 0;

      partita.tiriEffettuatiNelTurno =
        0;

      partita.tiriConsentitiNelTurno =
        1;

      partita.animazioneTiroInCorso =
        false;

      if (
        eraTurno ||
        nuovoIndice >= 0
      ) {
        avviaTimerTurno(
          partita,
          nomeStanza
        );
      }

      await salvaPartita(
        partita
      );

      inviaAllaPartita(
        partita,
        {
          tipo:
            "statoPartita",

          giocatori:
            costruisciStatoGiocatori(
              partita
            ),

          turnoDiId:
            partita
              .ordineGiocatori[
              partita.turnoAttuale
            ],

          messaggi: [
            nomeUscente +
              " ha abbandonato la partita."
          ],

          tempoInizioTurno:
            partita.tempoInizioTurno,

          durataMossaMs:
            millisecondiMossa(
              partita
            ),

          scadenzaTurno:
            partita.scadenzaTurno,

          tiriEffettuatiNelTurno:
            partita.tiriEffettuatiNelTurno,

          tiriConsentitiNelTurno:
            partita.tiriConsentitiNelTurno,

          chatAttiva:
            partita.chatAttiva !==
            false
        }
      );
    }

    inviaListaPartite(
      nomeStanza
    );

    inviaConteggioStanze();

    return;
  }
}

/* ============================================================
   WEBSOCKET CONNECTION
   ============================================================ */

wss.on(
  "connection",
  (socket, request) => {
    const origin =
      request.headers.origin ||
      "";

    if (
      !verificaOrigineWebSocket(
        origin
      )
    ) {
      socket.close(
        1008,
        "Origine non autorizzata"
      );

      return;
    }

    const token =
      verificaToken(
        estraiTokenDaCookieHeader(
          request.headers.cookie
        )
      );

    if (!token?.uid) {
      socket.close(
        1008,
        "Autenticazione richiesta"
      );

      return;
    }

    socket.id =
      "s" +
      contatoreId++;

    socket.uid =
      token.uid;

    socket.nickname =
      token.nickname ||
      "";

    socket.ruolo =
      token.ruolo ||
      "utente";

    socket.avatar =
      null;

    socket.authenticated =
      true;

    socket.stanzaAttuale =
      null;

    socket.tipoDispositivo =
      rilevaTipoDispositivo(
        request.headers[
          "user-agent"
        ]
      );

    socket.isAlive =
      true;

    socket.rateLimits =
      {};

    socket.messageQueue =
      Promise.resolve();

    socketsPerId[
      socket.id
    ] =
      socket;

    socket.on(
      "pong",
      () => {
        socket.isAlive =
          true;
      }
    );

    socket.on(
      "error",
      error => {
        console.error(
          "WebSocket error:",
          error.message
        );
      }
    );

    socket.on(
      "message",
      message => {
        socket.messageQueue =
          socket.messageQueue
            .then(
              () =>
                gestisciMessaggioSocket(
                  socket,
                  message
                )
            )
            .catch(
              error => {
                console.error(
                  "Errore gestione WebSocket:",
                  error
                );
              }
            );
      }
    );

    socket.on(
      "close",
      async () => {
        try {
          delete socketsPerId[
            socket.id
          ];

          const stanza =
            socket.stanzaAttuale;

          if (
            stanza &&
            stanze[stanza]
          ) {
            const online =
              stanze[stanza]
                .giocatoriOnline[
                socket.id
              ];

            if (
              online
            ) {
              delete stanze[
                stanza
              ].giocatoriOnline[
                socket.id
              ];

              inviaAllaStanza(
                stanza,
                {
                  tipo:
                    "online",

                  numero:
                    Object.keys(
                      stanze[stanza]
                        .giocatoriOnline
                    ).length
                }
              );
            }
          }

          /*
           * IMPORTANTISSIMO:
           *
           * Se la partita è iniziata NON rimuoviamo il giocatore.
           * Rimane salvato per "Riprendi partita".
           *
           * Se la partita è ancora in attesa, invece,
           * una chiusura reale della connessione libera
           * il posto nella lobby.
           */

          if (
            stanza &&
            stanze[stanza] &&
            socket.uid
          ) {
            const partite =
              stanze[stanza]
                .partite;

            for (
              const partita of Object.values(
                partite
              )
            ) {
              if (
                partita.fase !==
                "attesa_giocatori"
              ) {
                if (
                  partita.giocatori[
                    socket.uid
                  ]?.socket ===
                  socket
                ) {
                  partita.giocatori[
                    socket.uid
                  ].socket =
                    null;
                }

                continue;
              }

              const giocatore =
                partita.giocatori[
                  socket.uid
                ];

              if (!giocatore) {
                continue;
              }

              if (
                giocatore.socket &&
                giocatore.socket !==
                  socket
              ) {
                continue;
              }

              await esciDaPartitaInAttesa(
                partita,
                stanza,
                socket.uid
              );
            }

            inviaListaPartite(
              stanza
            );

            inviaConteggioStanze();
          }
        } catch (e) {
          console.error(
            "Errore chiusura WebSocket:",
            e
          );
        }
      }
    );
  }
);

/* ============================================================
   DISPOSITIVO
   ============================================================ */

function rilevaTipoDispositivo(
  userAgent
) {
  const ua =
    userAgent || "";

  if (
    /iPad/i.test(ua) ||
    (
      /Android/i.test(ua) &&
      !/Mobile/i.test(ua)
    )
  ) {
    return "tablet";
  }

  if (
    /iPhone|iPod/i.test(
      ua
    ) ||
    (
      /Android/i.test(ua) &&
      /Mobile/i.test(ua)
    )
  ) {
    return "cellulare";
  }

  return "computer";
}

function rimuoviVecchieConnessioniOnline(
  nomeStanza,
  uid,
  socketIdDaConservare
) {
  if (
    !stanze[nomeStanza] ||
    !uid
  ) {
    return;
  }

  for (
    const [
      sid,
      giocatoreOnline
    ] of Object.entries(
      stanze[nomeStanza]
        .giocatoriOnline
    )
  ) {
    if (
      giocatoreOnline &&
      giocatoreOnline.uid ===
        uid &&
      sid !==
        socketIdDaConservare
    ) {
      delete stanze[
        nomeStanza
      ].giocatoriOnline[
        sid
      ];
    }
  }
}

/* ============================================================
   HEARTBEAT
   ============================================================ */

const heartbeatInterval =
  setInterval(
    () => {
      wss.clients.forEach(
        socket => {
          if (
            socket.isAlive ===
            false
          ) {
            try {
              socket.terminate();
            } catch {}
            return;
          }

          socket.isAlive =
            false;

          try {
            socket.ping();
          } catch {}
        }
      );
    },
    HEARTBEAT_MS
  );

wss.on(
  "close",
  () =>
    clearInterval(
      heartbeatInterval
    )
);

/* ============================================================
   ERROR HANDLER EXPRESS
   ============================================================ */

app.use(
  (err, req, res, next) => {
    console.error(
      "Errore Express:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    if (
      err instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        errore:
          err.message ||
          "Errore upload."
      });
    }

    return res.status(500).json({
      errore:
        "Errore interno del server."
    });
  }
);

/* ============================================================
   AVVIO SERVER
   ============================================================ */

server.listen(
  PORT,
  async () => {
    console.log(
      "Server avviato sulla porta " +
        PORT
    );

    try {
      await ripristinaPartiteDaFirebase();
    } catch (e) {
      console.error(
        "Errore ripristino partite:",
        e
      );
    }
  }
);
