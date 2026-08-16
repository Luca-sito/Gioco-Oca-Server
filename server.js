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

/* =========================================================
   UTILITÀ
========================================================= */

function pulisciTesto(testo, massimo = 500) {
  if (typeof testo !== "string") return "";
  return testo.trim().replace(/[<>]/g, "").substring(0, massimo);
}

app.set("trust proxy", 1);

/* =========================================================
   CORS
========================================================= */

const ORIGINI_CONSENTITE = [
  "https://solfriniluca1.wixstudio.com",
  "https://solfriniluca1-wixstudio-com.filesusr.com",
  "https://gioco-oca-server.onrender.com"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (ORIGINI_CONSENTITE.includes(origin)) {
      return callback(null, true);
    }

    console.log("CORS bloccato:", origin);
    callback(null, false);
  },
  credentials: true
}));

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
    frameguard: false
  })
);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));
app.use(passport.initialize());

/* =========================================================
   SERVER / WEBSOCKET
========================================================= */

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET mancante: impostala nelle variabili d'ambiente su Render prima di avviare il server."
  );
}

/* =========================================================
   COOKIE
========================================================= */

const OPZIONI_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite:
    process.env.NODE_ENV === "production"
      ? "none"
      : "lax",
  maxAge: 30 * 24 * 60 * 60 * 1000
};

/* =========================================================
   UPLOAD AVATAR
========================================================= */

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(
        new Error("Il file deve essere un'immagine.")
      );
    }

    cb(null, true);
  }
});

/* =========================================================
   RATE LIMIT
========================================================= */

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    errore:
      "Troppi tentativi, riprova tra qualche minuto."
  },
  standardHeaders: true,
  legacyHeaders: false
});

const limiteContatti = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    errore:
      "Hai inviato troppe richieste, riprova più tardi."
  }
});

const limiteMessaggiPrivati = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    errore:
      "Stai inviando messaggi troppo velocemente, rallenta un po'."
  }
});

const limiteAmici = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: {
    errore:
      "Troppe richieste di amicizia in poco tempo, rallenta un po'."
  }
});

/* =========================================================
   FIREBASE ADMIN
========================================================= */

let db = null;

try {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential:
      admin.credential.cert(serviceAccount),
    databaseURL:
      "https://giochi-societa-e8add-default-rtdb.europe-west1.firebasedatabase.app"
  });

  db = admin.database();

  console.log(
    "Firebase Admin inizializzato correttamente."
  );
} catch (e) {
  console.error(
    "ATTENZIONE: Firebase Admin NON inizializzato:",
    e.message
  );
}

/* =========================================================
   FIREBASE PARTITE
========================================================= */

function preparaGiocatoriPerFirebase(giocatori) {
  const risultato = {};

  for (const uid in giocatori) {
    risultato[uid] = {
      nome: giocatori[uid].nome,
      posizione: giocatori[uid].posizione,
      turniSaltati:
        giocatori[uid].turniSaltati || 0
    };
  }

  return risultato;
}

async function salvaPartita(partita) {
  if (!db) return;

  await db
    .ref("partite/" + partita.id)
    .set({
      id: partita.id,
      stanza: partita.stanza,
      creatore: partita.creatore,
      creatoDa: partita.creatoDa,
      tempo: partita.tempo,
      punti: partita.punti,
      modalita: partita.modalita,
      maxGiocatori: partita.maxGiocatori,
      chatAttiva:
        partita.chatAttiva !== false,
      fase: partita.fase || "in_corso",
      giocatori:
        preparaGiocatoriPerFirebase(
          partita.giocatori
        ),
      ordineGiocatori:
        partita.ordineGiocatori || [],
      turnoAttuale:
        partita.turnoAttuale || 0,
      iniziata: partita.iniziata === true,
      iniziataIl:
        partita.iniziataIl || null,
      punteggiOrdineIniziale:
        partita.punteggiOrdineIniziale || null,
      aggiornataIl: Date.now()
    });
}

async function caricaPartite() {
  if (!db) return {};

  const snap =
    await db.ref("partite").once("value");

  return snap.val() || {};
}

async function aggiornaStatoPartita(
  partitaId,
  dati
) {
  if (!db) return;

  await db
    .ref("partite/" + partitaId)
    .update({
      ...dati,
      aggiornataIl: Date.now()
    });
}

async function rimuoviPartita(
  nomeStanza,
  partitaId
) {
  if (stanze[nomeStanza]) {
    const partita =
      stanze[nomeStanza].partite[
        partitaId
      ];

    if (partita) {
      fermaTimerTurno(partita);
    }

    delete stanze[nomeStanza].partite[
      partitaId
    ];
  }

  if (db) {
    try {
      await db
        .ref("partite/" + partitaId)
        .remove();
    } catch (e) {
      console.error(
        "Errore rimozione partita da Firebase:",
        e.message
      );
    }
  }
}

/* =========================================================
   LIVELLI / XP / BADGE
========================================================= */

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

function calcolaLivello(xp) {
  let livello = 1;

  for (
    let i = 0;
    i < SOGLIE_LIVELLO.length;
    i++
  ) {
    if (xp >= SOGLIE_LIVELLO[i]) {
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
      SOGLIE_LIVELLO[livello] !== undefined
        ? SOGLIE_LIVELLO[livello]
        : null
  };
}

function calcolaBadge(utente) {
  const badge = [];

  const vinte =
    utente.partiteVinte || 0;

  const giocate =
    utente.partiteGiocate || 0;

  const xp =
    utente.xp || 0;

  const streakMax =
    utente.streakVittorieMassima || 0;

  const vittoriaVeloce =
    utente.vittoriaPiuVeloceSecondi;

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
    vittoriaVeloce < SOGLIA_VELOCISTA_SECONDI
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

function idConversazione(
  uidA,
  uidB
) {
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
  if (!db) return;

  try {
    const partecipanti =
      elencoPartecipanti ||
      partita.ordineGiocatori.map(id => ({
        uid: id,
        nome:
          partita.giocatori[id]
            ? partita.giocatori[id].nome
            : "?"
      }));

    const esclusi =
      escludiXpPer || new Set();

    const durataSecondi =
      partita.iniziataIl
        ? Math.round(
            (Date.now() -
              partita.iniziataIl) /
              1000
          )
        : null;

    const xpVinti = xpVincita();

    const nomeVincitore =
      (
        partecipanti.find(
          p => p.uid === vincitoreUid
        ) || {}
      ).nome || null;

    for (const p of partecipanti) {
      if (esclusi.has(p.uid)) {
        continue;
      }

      const u =
        (
          await db
            .ref("utenti/" + p.uid)
            .once("value")
        ).val();

      if (!u) continue;

      if (p.uid === vincitoreUid) {
        const nuovoStreak =
          (u.streakVittorieAttuale || 0) +
          1;

        const aggiornamenti = {
          partiteGiocate:
            admin.database.ServerValue.increment(
              1
            ),
          partiteVinte:
            admin.database.ServerValue.increment(
              1
            ),
          streakVittorieAttuale:
            nuovoStreak,
          streakVittorieMassima:
            Math.max(
              u.streakVittorieMassima || 0,
              nuovoStreak
            ),
          xp:
            (u.xp || 0) +
            xpVinti
        };

        if (
          durataSecondi !== null &&
          (
            u.vittoriaPiuVeloceSecondi ==
              null ||
            durataSecondi <
              u.vittoriaPiuVeloceSecondi
          )
        ) {
          aggiornamenti.vittoriaPiuVeloceSecondi =
            durataSecondi;
        }

        await db
          .ref("utenti/" + p.uid)
          .update(aggiornamenti);
      } else {
        await db
          .ref("utenti/" + p.uid)
          .update({
            partiteGiocate:
              admin.database.ServerValue.increment(
                1
              ),
            streakVittorieAttuale: 0,
            xp: Math.max(
              0,
              (u.xp || 0) -
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
        vincitoreNome: nomeVincitore,
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

/* =========================================================
   TOKEN
========================================================= */

function creaToken(
  uid,
  nickname,
  ruolo
) {
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
    return jwt.verify(
      token,
      JWT_SECRET
    );
  } catch (e) {
    return null;
  }
}

function estraiTokenHeader(req) {
  if (
    req.cookies &&
    req.cookies.token
  ) {
    return req.cookies.token;
  }

  const header =
    req.headers.authorization || "";

  const parti =
    header.split(" ");

  return parti.length === 2
    ? parti[1]
    : null;
}

function estraiTokenDaCookieHeader(
  cookieHeaderGrezzo
) {
  if (!cookieHeaderGrezzo) {
    return null;
  }

  const parti =
    cookieHeaderGrezzo
      .split(";")
      .map(p => p.trim());

  for (const parte of parti) {
    const idx =
      parte.indexOf("=");

    if (idx === -1) continue;

    if (
      parte.substring(0, idx) ===
      "token"
    ) {
      return decodeURIComponent(
        parte.substring(idx + 1)
      );
    }
  }

  return null;
}

async function richiediAuth(
  req,
  res,
  next
) {
  const dati =
    verificaToken(
      estraiTokenHeader(req)
    );

  if (!dati) {
    return res
      .status(401)
      .json({
        errore:
          "Devi effettuare il login."
      });
  }

  req.utente = dati;

  next();
}

async function richiediAdmin(
  req,
  res,
  next
) {
  const dati =
    verificaToken(
      estraiTokenHeader(req)
    );

  if (!dati) {
    return res
      .status(401)
      .json({
        errore:
          "Devi effettuare il login."
      });
  }

  if (
    dati.ruolo !== "admin"
  ) {
    return res
      .status(403)
      .json({
        errore:
          "Accesso riservato agli amministratori."
      });
  }

  req.utenteAdmin = dati;

  next();
}

/* =========================================================
   FUNZIONI UTENTE
========================================================= */

async function trovaUtentePerEmail(
  emailLower
) {
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

  const uid =
    Object.keys(val)[0];

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

  const uid =
    Object.keys(val)[0];

  return {
    uid,
    ...val[uid]
  };
}

async function trovaUtentePerNickname(
  nicknameLower
) {
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

  const uid =
    Object.keys(val)[0];

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

/* =========================================================
   GOOGLE
========================================================= */

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

    base = (
      base +
      parteEmail
    ).substring(0, 15);
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
  let base =
    preparaNicknameGoogle(
      nome,
      email
    );

  if (
    !(await trovaUtentePerNickname(
      base.toLowerCase()
    ))
  ) {
    return base;
  }

  for (
    let i = 1;
    i <= 99;
    i++
  ) {
    const suffisso =
      String(i);

    const massimoBase =
      15 -
      suffisso.length;

    const candidato =
      base.substring(
        0,
        massimoBase
      ) + suffisso;

    if (
      !(
        await trovaUtentePerNickname(
          candidato.toLowerCase()
        )
      )
    ) {
      return candidato;
    }
  }

  return (
    "Google" +
    Date.now()
      .toString()
      .slice(-8)
  );
}

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET;

const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL;

if (!GOOGLE_CLIENT_ID) {
  console.warn(
    "GOOGLE_CLIENT_ID non configurato su Render."
  );
}

if (!GOOGLE_CLIENT_SECRET) {
  console.warn(
    "GOOGLE_CLIENT_SECRET non configurato su Render."
  );
}

if (!GOOGLE_CALLBACK_URL) {
  console.warn(
    "GOOGLE_CALLBACK_URL non configurato su Render."
  );
}

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
            profile.emails?.[0]
              ?.verified;

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
            emailVerificata ===
            false
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
              utente.sospesoFino >
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
            streakVittorieAttuale:
              0,
            streakVittorieMassima:
              0,
            vittoriaPiuVeloceSecondi:
              null,
            email,
            emailLower:
              email,
            nickname,
            nicknameLower:
              nickname.toLowerCase(),
            passwordHash:
              null,
            googleId,
            providerGoogle:
              true,
            avatar:
              profile
                .photos?.[0]
                ?.value ||
              null,
            ruolo:
              "utente",
            stato:
              "attivo",
            sospesoFino:
              null,
            avvisi: [],
            creatoIl:
              Date.now(),
            ultimoAccesso:
              Date.now()
          });

          return done(
            null,
            {
              uid,
              nickname,
              ruolo:
                "utente"
            }
          );
        } catch (errore) {
          console.error(
            "Errore verifica account Google:",
            errore
          );

          return done(
            errore
          );
        }
      }
    )
  );
}

app.get(
  "/auth/google",
  (req, res, next) => {
    const redirect =
      typeof req.query.redirect ===
      "string"
        ? req.query.redirect
        : "";

    if (redirect) {
      res.cookie(
        "google_redirect",
        redirect,
        {
          ...OPZIONI_COOKIE,
          maxAge:
            10 * 60 * 1000
        }
      );
    }

    passport.authenticate(
      "google",
      {
        scope: [
          "profile",
          "email"
        ]
      }
    )(req, res, next);
  }
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

      const redirectGoogle =
        req.cookies
          .google_redirect ||
        "";

      res.clearCookie(
        "google_redirect",
        OPZIONI_COOKIE
      );

      res.redirect(
        redirectGoogle ||
          "https://solfriniluca1.wixstudio.com/giochisocieta"
      );
    } catch (errore) {
      console.error(
        "Errore callback Google:",
        errore
      );

      res.redirect(
        "/accedi.html?errore=google"
      );
    }
  }
);

/* =========================================================
   API REGISTRAZIONE / LOGIN
========================================================= */

app.post(
  "/api/registrati",
  limiteLogin,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio account non disponibile al momento."
        });
    }

    try {
      const {
        email,
        nickname,
        password
      } = req.body;

      if (
        !email ||
        !nickname ||
        !password
      ) {
        return res
          .status(400)
          .json({
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
        nicknamePulito.length <
          5 ||
        nicknamePulito.length >
          15
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Il nickname deve contenere da 5 a 15 caratteri."
          });
      }

      if (
        !/^[a-zA-Z0-9_ ]+$/.test(
          nicknamePulito
        )
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Il nickname contiene caratteri non consentiti."
          });
      }

      if (
        password.length < 6 ||
        password.length > 100
      ) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
            errore:
              "Questa email è già registrata."
          });
      }

      if (
        await trovaUtentePerNickname(
          nicknameLower
        )
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Questo nickname è già in uso."
          });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          10
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
        streakVittorieAttuale:
          0,
        streakVittorieMassima:
          0,
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
        avatar: null,
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

      res.json({
        nickname:
          nicknamePulito,
        ruolo:
          "utente"
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
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
      return res
        .status(500)
        .json({
          errore:
            "Servizio account non disponibile al momento."
        });
    }

    try {
      const {
        email,
        password
      } = req.body;

      if (!email || !password) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
            errore:
              "Email o password errati."
          });
      }

      if (!utente.passwordHash) {
        return res
          .status(400)
          .json({
            errore:
              "Questo account è stato creato con Google. Usa 'Accedi con Google'."
          });
      }

      if (
        !(
          await bcrypt.compare(
            password,
            utente.passwordHash
          )
        )
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Email o password errati."
          });
      }

      if (
        utente.stato ===
        "bannato"
      ) {
        return res
          .status(403)
          .json({
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
          utente.sospesoFino >
            Date.now()
        ) {
          return res
            .status(403)
            .json({
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
            stato: "attivo",
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

      res.json({
        nickname:
          utente.nickname,
        ruolo:
          utente.ruolo ||
          "utente"
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
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
      return res
        .status(500)
        .json({
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
        return res
          .status(404)
          .json({
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

      res.json({
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
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
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
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const {
        nickname
      } = req.body;

      if (
        !nickname ||
        !nickname.trim()
      ) {
        return res
          .status(400)
          .json({
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
        nuovoNickname.length <
          5 ||
        nuovoNickname.length >
          15
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Il nickname deve contenere da 5 a 15 caratteri."
          });
      }

      if (
        !/^[a-zA-Z0-9_ ]+$/.test(
          nuovoNickname
        )
      ) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
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
          req.utente.ruolo
        ),
        OPZIONI_COOKIE
      );

      res.json({
        nickname:
          nuovoNickname
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server, riprova."
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
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
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
          avatar: dataUri
        });

      res.json({
        avatar:
          dataUri
      });
    } catch (err) {
      console.error(err);

      res
        .status(400)
        .json({
          errore:
            err.message ||
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
              u.partiteVinte ||
              0,
            giocate:
              u.partiteGiocate ||
              0
          }))
          .sort(
            (a, b) =>
              b.vinte !== a.vinte
                ? b.vinte - a.vinte
                : b.giocate -
                  a.giocate
          )
          .slice(0, 10);

      res.json({
        giocatori: top
      });
    } catch (e) {
      console.error(
        "Errore classifica:",
        e
      );

      res
        .status(500)
        .json({
          giocatori: []
        });
    }
  }
);

/* =========================================================
   CONTATTI
========================================================= */

app.post(
  "/api/contatti",
  limiteContatti,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile al momento."
        });
    }

    try {
      const {
        categoria,
        messaggio
      } = req.body;

      let {
        nickname,
        email
      } = req.body;

      if (
        !messaggio ||
        !messaggio.trim()
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Scrivi un messaggio prima di inviare."
          });
      }

      const messaggioPulito =
        pulisciTesto(
          messaggio,
          1000
        );

      const datiToken =
        verificaToken(
          estraiTokenHeader(req)
        );

      let uidMittente =
        null;

      if (datiToken) {
        uidMittente =
          datiToken.uid;

        const utenteDb =
          (
            await db
              .ref(
                "utenti/" +
                  datiToken.uid
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
        !nickname ||
        !nickname.trim() ||
        !email ||
        !email.trim()
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Nickname ed email sono obbligatori."
          });
      }

      await db
        .ref("contatti")
        .push()
        .set({
          nickname:
            nickname.trim(),
          email:
            email.trim(),
          categoria:
            categoria ||
            "Altro",
          messaggio:
            messaggioPulito,
          uidMittente,
          letto: false,
          data: Date.now()
        });

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore durante l'invio, riprova."
        });
    }
  }
);

/* =========================================================
   PROFILO PUBBLICO / STORICO
========================================================= */

app.get(
  "/api/profilo-pubblico/:nickname",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
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
        return res
          .status(404)
          .json({
            errore:
              "Utente non trovato."
          });
      }

      const giocate =
        utente.partiteGiocate ||
        0;

      const vinte =
        utente.partiteVinte ||
        0;

      const {
        livello,
        sogliaAttuale,
        sogliaProssima
      } =
        calcolaLivello(
          utente.xp || 0
        );

      res.json({
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
          utente.xp || 0,
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
          ),
        statoAmicizia:
          await statoAmicizia(
            req.utente.uid,
            utente.uid
          )
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
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
      return res
        .status(500)
        .json({
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
          return res
            .status(404)
            .json({
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
            .once("value")
        ).val() || {};

      const partite =
        Object.values(
          tutte
        )
          .filter(
            m =>
              m.partecipanti &&
              m.partecipanti.some(
                p =>
                  p.uid ===
                  uidFiltro
              )
          )
          .sort(
            (a, b) =>
              b.data - a.data
          )
          .slice(0, 50);

      res.json({
        uid:
          uidFiltro,
        nickname:
          nicknameFiltro,
        partite
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server."
        });
    }
  }
);

/* =========================================================
   MESSAGGI PRIVATI
========================================================= */

app.get(
  "/api/messaggi-privati/:altroUid",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const idConv =
        idConversazione(
          req.utente.uid,
          req.params.altroUid
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
              a.data - b.data
          );

      const aggiornamenti =
        {};

      Object.entries(
        messaggi
      ).forEach(
        ([id, m]) => {
          if (
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

      res.json({
        messaggi: lista
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
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
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const {
        destinatarioUid,
        testo
      } = req.body;

      if (
        !destinatarioUid ||
        !testo ||
        !testo.trim()
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Dati mancanti."
          });
      }

      if (
        destinatarioUid ===
        req.utente.uid
      ) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
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
        return res
          .status(404)
          .json({
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
        letto: false
      };

      await nuovoRef.set(
        messaggio
      );

      res.json({
        ok: true,
        messaggio: {
          id:
            nuovoRef.key,
          ...messaggio
        }
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore durante l'invio, riprova."
        });
    }
  }
);

app.get(
  "/api/conversazioni",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
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
            .once("value")
        ).val() || {};

      const mieUid =
        req.utente.uid;

      const conversazioni =
        {};

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
              messaggi
            );

          if (!lista.length) {
            return;
          }

          const ultimo =
            lista.sort(
              (a, b) =>
                b.data - a.data
            )[0];

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

      res.json({
        conversazioni:
          Object.values(
            conversazioni
          ).sort(
            (a, b) =>
              b.ultimaData -
              a.ultimaData
          )
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server."
        });
    }
  }
);

/* =========================================================
   AMICI
========================================================= */

app.post(
  "/api/amici/richiedi",
  limiteAmici,
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const {
        destinatarioUid
      } = req.body;

      if (!destinatarioUid) {
        return res
          .status(400)
          .json({
            errore:
              "Dati mancanti."
          });
      }

      if (
        destinatarioUid ===
        req.utente.uid
      ) {
        return res
          .status(400)
          .json({
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
        return res
          .status(404)
          .json({
            errore:
              "Utente non trovato."
          });
      }

      const stato =
        await statoAmicizia(
          req.utente.uid,
          destinatarioUid
        );

      if (
        stato ===
        "amici"
      ) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
            errore:
              "Questo utente ti ha già inviato una richiesta: accettala dal suo profilo."
          });
      }

      const mioNickname =
        req.utente.nickname;

      const ora =
        Date.now();

      await db
        .ref()
        .update({
          [`utenti/${req.utente.uid}/richiesteInviate/${destinatarioUid}`]:
            {
              aNome:
                destinatario.nickname,
              data:
                ora
            },

          [`utenti/${destinatarioUid}/richiesteRicevute/${req.utente.uid}`]:
            {
              daNome:
                mioNickname,
              data:
                ora
            }
        });

      await db
        .ref(
          "utenti/" +
            destinatarioUid +
            "/notifiche"
        )
        .push({
          tipo:
            "richiestaAmicizia",
          testo:
            `${mioNickname} ti ha inviato una richiesta di amicizia`,
          data:
            ora,
          letta: false,
          daUid:
            req.utente.uid,
          daNome:
            mioNickname
        });

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server, riprova."
        });
    }
  }
);

app.post(
  "/api/amici/accetta",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const {
        daUid
      } = req.body;

      if (!daUid) {
        return res
          .status(400)
          .json({
            errore:
              "Dati mancanti."
          });
      }

      const richiesta =
        await db
          .ref(
            "utenti/" +
              req.utente.uid +
              "/richiesteRicevute/" +
              daUid
          )
          .once("value");

      if (
        !richiesta.exists()
      ) {
        return res
          .status(400)
          .json({
            errore:
              "Nessuna richiesta da questo utente."
          });
      }

      const mioNickname =
        req.utente.nickname;

      await db
        .ref()
        .update({
          [`utenti/${req.utente.uid}/richiesteRicevute/${daUid}`]:
            null,

          [`utenti/${daUid}/richiesteInviate/${req.utente.uid}`]:
            null,

          [`utenti/${req.utente.uid}/amici/${daUid}`]:
            true,

          [`utenti/${daUid}/amici/${req.utente.uid}`]:
            true
        });

      await db
        .ref(
          "utenti/" +
            daUid +
            "/notifiche"
        )
        .push({
          tipo:
            "amiciziaAccettata",
          testo:
            `${mioNickname} ha accettato la tua richiesta di amicizia`,
          data:
            Date.now(),
          letta: false
        });

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server, riprova."
        });
    }
  }
);

app.post(
  "/api/amici/rifiuta",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const {
        daUid
      } = req.body;

      if (!daUid) {
        return res
          .status(400)
          .json({
            errore:
              "Dati mancanti."
          });
      }

      await db
        .ref()
        .update({
          [`utenti/${req.utente.uid}/richiesteRicevute/${daUid}`]:
            null,

          [`utenti/${daUid}/richiesteInviate/${req.utente.uid}`]:
            null
        });

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server, riprova."
        });
    }
  }
);

app.post(
  "/api/amici/rimuovi",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const {
        altroUid
      } = req.body;

      if (!altroUid) {
        return res
          .status(400)
          .json({
            errore:
              "Dati mancanti."
          });
      }

      await db
        .ref()
        .update({
          [`utenti/${req.utente.uid}/amici/${altroUid}`]:
            null,

          [`utenti/${altroUid}/amici/${req.utente.uid}`]:
            null
        });

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server, riprova."
        });
    }
  }
);

app.get(
  "/api/amici",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
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
                "utenti/" +
                  req.utente.uid +
                  "/amici"
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
                    .once(
                      "value"
                    )
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

      res.json({
        amici:
          amici.filter(
            Boolean
          )
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server."
        });
    }
  }
);

/* =========================================================
   NOTIFICHE
========================================================= */

app.get(
  "/api/notifiche",
  richiediAuth,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
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
                "utenti/" +
                  req.utente.uid +
                  "/notifiche"
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
              b.data - a.data
          )
          .slice(0, 30);

      res.json({
        notifiche:
          lista,
        nonLette:
          lista.filter(
            n => !n.letta
          ).length
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
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
      return res
        .status(500)
        .json({
          errore:
            "Servizio non disponibile."
        });
    }

    try {
      const tutte =
        (
          await db
            .ref(
              "utenti/" +
                req.utente.uid +
                "/notifiche"
            )
            .once("value")
        ).val() || {};

      const aggiornamenti =
        {};

      Object.keys(
        tutte
      ).forEach(id => {
        if (!tutte[id].letta) {
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
            "utenti/" +
              req.utente.uid +
              "/notifiche"
          )
          .update(
            aggiornamenti
          );
      }

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(err);

      res
        .status(500)
        .json({
          errore:
            "Errore del server."
        });
    }
  }
);

/* =========================================================
   ADMIN
========================================================= */

app.get(
  "/api/admin/utenti",
  richiediAdmin,
  async (req, res) => {
    if (!db) {
      return res
        .status(500)
        .json({
          errore:
            "Database non disponibile."
        });
    }

    const val =
      (
        await db
          .ref("utenti")
          .once("value")
      ).val() || {};

    res.json({
      utenti:
        Object.keys(
          val
        ).map(uid => ({
          uid,
          email:
            val[uid].email,
          nickname:
            val[uid].nickname,
          stato:
            val[uid].stato,
          sospesoFino:
            val[uid]
              .sospesoFino,
          avvisi:
            val[uid].avvisi ||
            [],
          ruolo:
            val[uid].ruolo ||
            "utente"
        }))
    });
  }
);

app.post(
  "/api/admin/avviso",
  richiediAdmin,
  async (req, res) => {
    const {
      uid,
      motivo
    } = req.body;

    if (!uid || !motivo) {
      return res
        .status(400)
        .json({
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

    avvisiAttuali.push({
      data:
        Date.now(),
      motivo
    });

    await ref.set(
      avvisiAttuali
    );

    await db
      .ref(
        "utenti/" +
          uid +
          "/notifiche"
      )
      .push({
        tipo:
          "avviso",
        testo:
          "Hai ricevuto un avviso dallo staff",
        data:
          Date.now(),
        letta: false
      });

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/admin/sospendi",
  richiediAdmin,
  async (req, res) => {
    const {
      uid,
      giorni,
      motivo
    } = req.body;

    if (!uid || !giorni) {
      return res
        .status(400)
        .json({
          errore:
            "Dati mancanti."
        });
    }

    if (
      uid ===
      req.utenteAdmin.uid
    ) {
      return res
        .status(400)
        .json({
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
          parseInt(
            giorni,
            10
          ) *
            24 *
            60 *
            60 *
            1000,
        motivoSospensione:
          motivo || ""
      });

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/admin/rimuovi-sospensione",
  richiediAdmin,
  async (req, res) => {
    const {
      uid
    } = req.body;

    if (!uid) {
      return res
        .status(400)
        .json({
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

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/admin/banna",
  richiediAdmin,
  async (req, res) => {
    const {
      uid,
      motivo
    } = req.body;

    if (!uid) {
      return res
        .status(400)
        .json({
          errore:
            "Dati mancanti."
        });
    }

    if (
      uid ===
      req.utenteAdmin.uid
    ) {
      return res
        .status(400)
        .json({
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
          motivo || ""
      });

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/admin/riattiva",
  richiediAdmin,
  async (req, res) => {
    const {
      uid
    } = req.body;

    if (!uid) {
      return res
        .status(400)
        .json({
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

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   DADI
========================================================= */

function tiraDadoRandomOrg() {
  return new Promise(
    resolve => {
      const url =
        "https://www.random.org/integers/?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";

      const richiesta =
        https.get(
          url,
          {
            timeout: 1500
          },
          res => {
            let dati =
              "";

            res.on(
              "data",
              chunk => {
                dati += chunk;
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
                          parseInt(
                            n.trim(),
                            10
                          )
                      )
                      .filter(
                        n =>
                          !isNaN(n) &&
                          n >= 1 &&
                          n <= 6
                      );

                  resolve(
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
                } catch (e) {
                  resolve(
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
          resolve(null);
        }
      );

      richiesta.on(
        "error",
        () => {
          resolve(null);
        }
      );
    }
  );
}

async function lanciaDueDadiSicuri() {
  const risultato =
    await tiraDadoRandomOrg();

  if (risultato) {
    return risultato;
  }

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

/* =========================================================
   LOGICA DI GIOCO
========================================================= */

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

/* =========================================================
   STANZE
========================================================= */

let stanze = {
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

/* =========================================================
   RIPRISTINO PARTITE
========================================================= */

async function ripristinaPartiteDaFirebase() {
  const partiteFirebase =
    await caricaPartite();

  for (
    const id in partiteFirebase
  ) {
    const p =
      partiteFirebase[id];

    if (
      !stanze[p.stanza]
    ) {
      continue;
    }

    const giocatori =
      p.giocatori ||
      {};

    const ordineGiocatori =
      p.ordineGiocatori ||
      Object.keys(
        giocatori
      );

    const fase =
      p.fase ||
      (
        p.iniziata === true
          ? "in_corso"
          : "attesa_giocatori"
      );

    stanze[p.stanza].partite[id] = {
      ...p,

      maxGiocatori:
        p.maxGiocatori ||
        (
          Object.keys(
            giocatori
          ).length || 2
        ),

      chatAttiva:
        p.chatAttiva !== false,

      giocatori,

      ordineGiocatori,

      turnoAttuale:
        p.turnoAttuale || 0,

      iniziata:
        p.iniziata === true,

      iniziataIl:
        p.iniziataIl ||
        null,

      elaborandoTiro:
        false,

      invitati:
        {},

      timerTurno:
        null,

      tempoInizioTurno:
        null,

      tokenTimerTurno:
        0,

      punteggiOrdineIniziale:
        p.punteggiOrdineIniziale ||
        null,

      coppieAudioApprovate:
        new Set(),

      fase,

      ordineDeterminazione:
        p.ordineDeterminazione ||
        (
          fase ===
          "determinazione_ordine"
            ? [...ordineGiocatori]
            : []
        ),

      risultatiDeterminazione:
        p.risultatiDeterminazione ||
        {},

      codaDeterminazione:
        p.codaDeterminazione ||
        [],

      turnoInCorsoDeterminazione:
        p.turnoInCorsoDeterminazione ||
        null,

      gruppoSpareggioAttuale:
        p.gruppoSpareggioAttuale ||
        null
    };

    const partitaRipristinata =
      stanze[p.stanza].partite[id];

    /*
     * Le partite già iniziate rimangono attive.
     * Il socket verrà ricreato quando il giocatore
     * rientrerà con "riprendiPartita".
     */
    if (
      partitaRipristinata.iniziata
    ) {
      partitaRipristinata.fase =
        "in_corso";

      avviaTimerTurno(
        partitaRipristinata,
        p.stanza
      );

      continue;
    }

    /*
     * Se il server si riavvia durante
     * la determinazione dell'ordine,
     * ricostruiamo la fase.
     */
    if (
      partitaRipristinata.fase ===
      "determinazione_ordine"
    ) {
      if (
        !partitaRipristinata
          .ordineDeterminazione
          ?.length
      ) {
        partitaRipristinata
          .ordineDeterminazione =
          Object.keys(
            partitaRipristinata
              .giocatori
          );
      }

      if (
        !partitaRipristinata
          .codaDeterminazione
          ?.length
      ) {
        partitaRipristinata
          .codaDeterminazione =
          partitaRipristinata
            .ordineDeterminazione
            .filter(
              uid =>
                partitaRipristinata
                  .risultatiDeterminazione[
                    uid
                  ] ==
                null
            );
      }

      avanzaDeterminazione(
        partitaRipristinata,
        p.stanza
      );

      continue;
    }

    /*
     * Partita di attesa completa:
     * la avviamo.
     */
    if (
      Object.keys(
        partitaRipristinata
          .giocatori
      ).length ===
      partitaRipristinata
        .maxGiocatori
    ) {
      iniziaFaseDeterminazione(
        partitaRipristinata,
        p.stanza
      );
    }
  }

  console.log(
    "Partite ripristinate da Firebase:",
    Object.keys(
      partiteFirebase
    ).length
  );
}

/* =========================================================
   SOCKET REGISTRY
========================================================= */

let contatoreId = 0;

const socketsPerId = {};

/* =========================================================
   MOVIMENTO
========================================================= */

function calcolaMovimento(
  posizioneAttuale,
  valoreDado
) {
  let percorso = [];

  let nuovaPosizione =
    posizioneAttuale +
    valoreDado;

  let messaggi = [];

  let turniDaSaltare = 0;

  let vittoria = false;

  let tiraAncora = false;

  if (
    nuovaPosizione >
    CASELLA_VITTORIA
  ) {
    for (
      let p =
        posizioneAttuale + 1;
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
        posizioneAttuale + 1;
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
    const cf =
      CASELLE_TORNA_A[
        nuovaPosizione
      ];

    messaggi.push(
      `Torni alla casella ${cf}!`
    );

    percorso.push(cf);

    nuovaPosizione =
      cf;
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

function passaAlProssimoTurno(
  partita
) {
  const numeroGiocatori =
    partita
      .ordineGiocatori
      .length;

  if (
    numeroGiocatori <= 1
  ) {
    return;
  }

  const indiceDiPartenza =
    partita.turnoAttuale;

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

    const idGiocatore =
      partita
        .ordineGiocatori[
          indice
        ];

    const giocatore =
      partita.giocatori[
        idGiocatore
      ];

    if (!giocatore) {
      continue;
    }

    if (
      (giocatore.turniSaltati || 0) >
      0
    ) {
      giocatore.turniSaltati--;

      continue;
    }

    partita.turnoAttuale =
      indice;

    return;
  }

  partita.turnoAttuale =
    indiceDiPartenza;
}

/* =========================================================
   RICERCA PARTITE
========================================================= */

function trovaPartita(
  partitaId
) {
  for (
    const nomeStanza in
    stanze
  ) {
    if (
      stanze[nomeStanza]
        .partite[
          partitaId
        ]
    ) {
      return {
        partita:
          stanze[nomeStanza]
            .partite[
              partitaId
            ],
        nomeStanza
      };
    }
  }

  return null;
}

/*
 * IMPORTANTISSIMO:
 * vengono considerate solamente le partite
 * realmente iniziate.
 *
 * Una partita in semplice attesa NON deve
 * apparire come "Riprendi".
 */
function trovaPartitaAttivaPerUid(
  uid
) {
  for (
    const nomeStanza in
    stanze
  ) {
    for (
      const pid in
      stanze[nomeStanza]
        .partite
    ) {
      const p =
        stanze[nomeStanza]
          .partite[pid];

      if (
        !p ||
        !p.giocatori
      ) {
        continue;
      }

      if (
        !p.iniziata
      ) {
        continue;
      }

      if (
        p.giocatori[
          uid
        ]
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

/*
 * "In partita" significa:
 * - determinazione ordine
 * - partita vera iniziata
 */
function calcolaUidInPartita(
  nomeStanza
) {
  const uidInPartita =
    new Set();

  if (
    !stanze[nomeStanza]
  ) {
    return uidInPartita;
  }

  Object.values(
    stanze[
      nomeStanza
    ].partite
  ).forEach(p => {
    if (
      p.iniziata ||
      p.fase ===
        "determinazione_ordine"
    ) {
      Object.keys(
        p.giocatori ||
          {}
      ).forEach(uid => {
        uidInPartita.add(
          uid
        );
      });
    }
  });

  return uidInPartita;
}

function costruisciStatoGiocatori(
  partita
) {
  return partita
    .ordineGiocatori
    .map(id => {
      const g =
        partita.giocatori[
          id
        ];

      if (!g) {
        return null;
      }

      return {
        id,
        nome:
          g.nome,
        avatar:
          g.avatar ||
          null,
        posizione:
          g.posizione || 0
      };
    })
    .filter(Boolean);
}

function inviaAllaStanza(
  nomeStanza,
  messaggio
) {
  if (
    !stanze[nomeStanza]
  ) {
    return;
  }

  Object.keys(
    stanze[
      nomeStanza
    ].giocatoriOnline
  ).forEach(id => {
    const s =
      socketsPerId[id];

    if (
      s &&
      s.readyState ===
        WebSocket.OPEN
    ) {
      s.send(
        JSON.stringify(
          messaggio
        )
      );
    }
  });
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
      stanze[
        nomeStanza
      ].partite
    ).map(p => ({
      id:
        p.id,

      creatore:
        p.creatore,

      creatoDa:
        p.creatoDa,

      tempo:
        p.tempo,

      punti:
        p.punti,

      modalita:
        p.modalita,

      maxGiocatori:
        p.maxGiocatori,

      iniziata:
        p.iniziata === true,

      fase:
        p.fase ||
        (
          p.iniziata
            ? "in_corso"
            : "attesa_giocatori"
        ),

      numGiocatoriAttuali:
        Object.keys(
          p.giocatori ||
            {}
        ).length,

      chatAttiva:
        p.chatAttiva !== false,

      giocatori:
        Object.entries(
          p.giocatori ||
            {}
        ).map(
          ([uid, g]) => ({
            uid,
            nome:
              g.nome,
            avatar:
              g.avatar ||
              null
          })
        )
    }));

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

  for (
    const nome in stanze
  ) {
    const valori =
      Object.values(
        stanze[nome]
          .giocatoriOnline
      );

    const uidInPartita =
      calcolaUidInPartita(
        nome
      );

    const vistiUid =
      new Map();

    /*
     * Se lo stesso utente ha più socket
     * nella stessa stanza, lo mostriamo una volta.
     */
    valori.forEach(g => {
      vistiUid.set(
        g.uid,
        g
      );
    });

    const valoriUnici =
      Array.from(
        vistiUid.values()
      );

    conteggi[nome] =
      valoriUnici.length;

    giocatoriPerStanza[
      nome
    ] =
      valoriUnici.map(
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

  const messaggio =
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
        client.send(
          messaggio
        );
      }
    }
  );
}

/* =========================================================
   HEARTBEAT
========================================================= */

const HEARTBEAT_MS =
  15000;

const heartbeatInterval =
  setInterval(() => {
    wss.clients.forEach(
      socket => {
        if (
          socket.isAlive ===
          false
        ) {
          return socket.terminate();
        }

        socket.isAlive =
          false;

        socket.ping();
      }
    );
  }, HEARTBEAT_MS);

wss.on(
  "close",
  () => {
    clearInterval(
      heartbeatInterval
    );
  }
);

/* =========================================================
   DISPOSITIVO
========================================================= */

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

/* =========================================================
   TIMER TURNO
========================================================= */

function millisecondiMossa(
  partita
) {
  const secondi =
    parseInt(
      partita.tempo,
      10
    );

  return (
    Number.isFinite(
      secondi
    ) && secondi > 0
      ? secondi
      : 30
  ) * 1000;
}

function fermaTimerTurno(
  partita
) {
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
    (
      partita.tokenTimerTurno ||
      0
    ) + 1;
}

function avviaTimerTurno(
  partita,
  nomeStanza,
  ritardoMs = 0
) {
  fermaTimerTurno(
    partita
  );

  if (
    !partita.iniziata
  ) {
    return;
  }

  const token =
    partita.tokenTimerTurno;

  partita.tempoInizioTurno =
    Date.now() +
    ritardoMs;

  partita.timerTurno =
    setTimeout(
      () => {
        if (
          token !==
          partita.tokenTimerTurno
        ) {
          return;
        }

        partita.timerTurno =
          null;

        gestisciScadenzaTurno(
          partita,
          nomeStanza
        );
      },
      millisecondiMossa(
        partita
      ) + ritardoMs
    );
}

/* =========================================================
   SCADENZA TURNO
========================================================= */

async function gestisciScadenzaTurno(
  partita,
  nomeStanza
) {
  if (
    !partita.iniziata
  ) {
    return;
  }

  const idGiocatoreDiTurno =
    partita
      .ordineGiocatori[
        partita.turnoAttuale
      ];

  const giocatore =
    partita.giocatori[
      idGiocatoreDiTurno
    ];

  if (!giocatore) {
    return;
  }

  giocatore
    .tentativiAutomaticiConsecutivi =
    (
      giocatore
        .tentativiAutomaticiConsecutivi ||
      0
    ) + 1;

  if (
    giocatore
      .tentativiAutomaticiConsecutivi >
    3
  ) {
    await forzaAbbandonoPerInattivita(
      partita,
      nomeStanza,
      idGiocatoreDiTurno
    );

    return;
  }

  await eseguiTiroDadiPerGiocatore(
    partita,
    nomeStanza,
    idGiocatoreDiTurno,
    true
  );
}

/* =========================================================
   TIRO DADI
========================================================= */

async function eseguiTiroDadiPerGiocatore(
  partita,
  nomeStanza,
  idGiocatore,
  automatico
) {
  if (
    partita.elaborandoTiro
  ) {
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

    const giocatore =
      partita.giocatori[
        idGiocatore
      ];

    if (!giocatore) {
      return;
    }

    const risultato =
      calcolaMovimento(
        giocatore.posizione,
        valoreDado
      );

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

    const statoGiocatori =
      costruisciStatoGiocatori(
        partita
      );

    const idProssimo =
      partita
        .ordineGiocatori[
          partita.turnoAttuale
        ];

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
      Object.values(
        partita.giocatori
      ).forEach(g => {
        if (
          g.socket &&
          g.socket.readyState ===
            WebSocket.OPEN
        ) {
          g.socket.send(
            JSON.stringify({
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

              durataMossaMs:
                0,

              vittoria:
                true,

              vincitore:
                giocatore.nome
            })
          );
        }
      });

      await concludiPartita(
        partita,
        idGiocatore,
        nomeStanza,
        null
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

    const ritardoNuovoTurno =
      1200;

    avviaTimerTurno(
      partita,
      nomeStanza,
      ritardoNuovoTurno
    );

    const tempoInizioNuovoTurno =
      partita.tempoInizioTurno;

    Object.values(
      partita.giocatori
    ).forEach(g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        g.socket.send(
          JSON.stringify({
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
              idProssimo,

            tempoInizioTurno:
              tempoInizioNuovoTurno,

            durataMossaMs:
              millisecondiMossa(
                partita
              ),

            vittoria:
              false,

            vincitore:
              null
          })
        );
      }
    });

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

        fase:
          partita.fase
      }
    );
  } finally {
    partita.elaborandoTiro =
      false;
  }
}

/* =========================================================
   ABBANDONO PER INATTIVITÀ
========================================================= */

async function forzaAbbandonoPerInattivita(
  partita,
  nomeStanza,
  idGiocatore
) {
  fermaTimerTurno(
    partita
  );

  if (
    !partita.giocatori[
      idGiocatore
    ]
  ) {
    return;
  }

  const nomeUscente =
    partita.giocatori[
      idGiocatore
    ].nome;

  if (db) {
    try {
      const u =
        (
          await db
            .ref(
              "utenti/" +
                idGiocatore
            )
            .once("value")
        ).val();

      if (u) {
        await db
          .ref(
            "utenti/" +
              idGiocatore
          )
          .update({
            xp: Math.max(
              0,
              (u.xp || 0) -
                xpPenalitaAbbandonoAutomatico()
            ),

            streakVittorieAttuale:
              0
          });
      }
    } catch (e) {
      console.error(
        "Errore penalità abbandono automatico:",
        e.message
      );
    }
  }

  delete partita.giocatori[
    idGiocatore
  ];

  partita.ordineGiocatori =
    partita.ordineGiocatori.filter(
      id =>
        id !==
        idGiocatore
    );

  const restanti =
    Object.keys(
      partita.giocatori
    );

  if (
    partita.turnoAttuale >=
    partita.ordineGiocatori.length
  ) {
    partita.turnoAttuale = 0;
  }

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

    const vincitoreNome =
      partita.giocatori[
        vincitoreId
      ].nome;

    const statoGiocatori =
      costruisciStatoGiocatori(
        partita
      );

    Object.values(
      partita.giocatori
    ).forEach(g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        g.socket.send(
          JSON.stringify({
            tipo:
              "statoPartita",

            giocatori:
              statoGiocatori,

            turnoDiId:
              vincitoreId,

            vittoria:
              true,

            vincitore:
              vincitoreNome,

            messaggi: [
              nomeUscente +
                " è stato rimosso per inattività prolungata."
            ]
          })
        );
      }
    });

    const elencoCompleto =
      partita.ordineGiocatori
        .concat([
          idGiocatore
        ])
        .map(id =>
          id ===
          idGiocatore
            ? {
                uid:
                  idGiocatore,
                nome:
                  nomeUscente
              }
            : {
                uid: id,
                nome:
                  partita
                    .giocatori[id]
                    .nome
              }
        );

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
    const idAttuale =
      partita.ordineGiocatori[
        partita.turnoAttuale
      ];

    avviaTimerTurno(
      partita,
      nomeStanza
    );

    const statoGiocatori =
      costruisciStatoGiocatori(
        partita
      );

    Object.values(
      partita.giocatori
    ).forEach(g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        g.socket.send(
          JSON.stringify({
            tipo:
              "statoPartita",

            giocatori:
              statoGiocatori,

            turnoDiId:
              idAttuale,

            messaggi: [
              nomeUscente +
                " è stato rimosso per inattività prolungata."
            ],

            tempoInizioTurno:
              partita.tempoInizioTurno,

            durataMossaMs:
              millisecondiMossa(
                partita
              )
          })
        );
      }
    });

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
          partita.turnoAttuale
      }
    );
  }

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();
}

/* =========================================================
   DETERMINAZIONE ORDINE
========================================================= */

function calcolaOrdineDaiRisultati(
  risultati,
  tuttiGliUid
) {
  const coppie =
    tuttiGliUid.map(
      uid => ({
        uid,
        punteggio:
          risultati[
            uid
          ]
      })
    );

  coppie.sort(
    (a, b) =>
      b.punteggio -
      a.punteggio
  );

  for (
    let i = 0;
    i < coppie.length;
    i++
  ) {
    let j = i + 1;

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
      j - i > 1
    ) {
      return {
        ordineFinale:
          null,

        prossimoGruppoParitario:
          coppie
            .slice(i, j)
            .map(
              c =>
                c.uid
            )
      };
    }

    i = j - 1;
  }

  return {
    ordineFinale:
      coppie.map(
        c => c.uid
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
      u2 =>
        u2 !== uid
    );

  partita.codaDeterminazione =
    (
      partita.codaDeterminazione ||
      []
    ).filter(
      u2 =>
        u2 !== uid
    );

  if (
    partita
      .risultatiDeterminazione
  ) {
    delete partita
      .risultatiDeterminazione[
        uid
      ];
  }

  if (
    partita.gruppoSpareggioAttuale
  ) {
    partita.gruppoSpareggioAttuale =
      partita
        .gruppoSpareggioAttuale
        .filter(
          u2 =>
            u2 !== uid
        );
  }
}

function inviaStatoDeterminazione(
  partita,
  nomeStanza
) {
  const elenco =
    (
      partita.ordineDeterminazione ||
      []
    ).map(uid => ({
      uid,

      nome:
        partita.giocatori[
          uid
        ]
          ? partita.giocatori[
              uid
            ].nome
          : "?",

      avatar:
        partita.giocatori[
          uid
        ]
          ? (
              partita.giocatori[
                uid
              ].avatar ||
              null
            )
          : null,

      risultato:
        partita
          .risultatiDeterminazione &&
        partita
          .risultatiDeterminazione[
            uid
          ] !=
          null
          ? partita
              .risultatiDeterminazione[
                uid
              ]
          : null
    }));

  const messaggio =
    JSON.stringify({
      tipo:
        "statoDeterminazione",

      giocatori:
        elenco,

      turnoInCorsoUid:
        partita
          .turnoInCorsoDeterminazione ||
        null,

      gruppoSpareggioAttuale:
        partita
          .gruppoSpareggioAttuale ||
        null,

      tempoInizioTurno:
        partita
          .tempoInizioTurno ||
        null,

      durataMossaMs:
        millisecondiMossa(
          partita
        )
    });

  Object.values(
    partita.giocatori
  ).forEach(g => {
    if (
      g.socket &&
      g.socket.readyState ===
        WebSocket.OPEN
    ) {
      g.socket.send(
        messaggio
      );
    }
  });
}

function avviaTimerDeterminazione(
  partita,
  nomeStanza
) {
  fermaTimerTurno(
    partita
  );

  partita.tempoInizioTurno =
    Date.now();

  const token =
    partita.tokenTimerTurno;

  partita.timerTurno =
    setTimeout(
      () => {
        if (
          token !==
          partita.tokenTimerTurno
        ) {
          return;
        }

        gestisciScadenzaDeterminazione(
          partita,
          nomeStanza
        );
      },
      millisecondiMossa(
        partita
      )
    );
}

async function gestisciScadenzaDeterminazione(
  partita,
  nomeStanza
) {
  if (
    partita.fase !==
    "determinazione_ordine"
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

  giocatore
    .tentativiAutomaticiConsecutivi =
    (
      giocatore
        .tentativiAutomaticiConsecutivi ||
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
    partita.elaborandoTiro
  ) {
    return;
  }

  partita.elaborandoTiro =
    true;

  try {
    fermaTimerTurno(
      partita
    );

    const {
      dado1,
      dado2
    } =
      await lanciaDueDadiSicuri();

    const valoreDado =
      dado1 + dado2;

    if (
      !partita
        .risultatiDeterminazione
    ) {
      partita.risultatiDeterminazione =
        {};
    }

    partita
      .risultatiDeterminazione[
        uid
      ] =
      valoreDado;

    partita.turnoInCorsoDeterminazione =
      null;

    const giocatore =
      partita.giocatori[
        uid
      ];

    const messaggio =
      JSON.stringify({
        tipo:
          "risultatoDeterminazione",

        uid,

        nome:
          giocatore
            ? giocatore.nome
            : "?",

        dado1,
        dado2,
        valoreDado,

        automatico:
          !!automatico
      });

    Object.values(
      partita.giocatori
    ).forEach(g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        g.socket.send(
          messaggio
        );
      }
    });

    setTimeout(
      () => {
        avanzaDeterminazione(
          partita,
          nomeStanza
        );
      },
      1600
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
      ...partita
        .ordineDeterminazione
    ];

  partita.turnoInCorsoDeterminazione =
    null;

  partita.gruppoSpareggioAttuale =
    null;

  avanzaDeterminazione(
    partita,
    nomeStanza
  );
}

async function avanzaDeterminazione(
  partita,
  nomeStanza
) {
  if (
    partita.codaDeterminazione
      .length === 0
  ) {
    const esito =
      calcolaOrdineDaiRisultati(
        partita
          .risultatiDeterminazione,
        partita
          .ordineDeterminazione
      );

    if (
      esito.prossimoGruppoParitario
    ) {
      partita.gruppoSpareggioAttuale =
        esito
          .prossimoGruppoParitario;

      partita.codaDeterminazione =
        [
          ...esito
            .prossimoGruppoParitario
        ];

      await avanzaDeterminazione(
        partita,
        nomeStanza
      );

      return;
    }

    partita.gruppoSpareggioAttuale =
      null;

    const nomiOrdineFinale =
      esito.ordineFinale.map(
        uid =>
          partita
            .giocatori[
              uid
            ].nome
      );

    const punteggiOrdineFinale =
      {};

    esito.ordineFinale.forEach(
      uid => {
        punteggiOrdineFinale[
          partita
            .giocatori[
              uid
            ].nome
        ] =
          partita
            .risultatiDeterminazione[
              uid
            ];
      }
    );

    const messaggioOrdine =
      JSON.stringify({
        tipo:
          "ordineFinaleCalcolato",

        ordineGiocatori:
          nomiOrdineFinale,

        punteggi:
          punteggiOrdineFinale
      });

    Object.values(
      partita.giocatori
    ).forEach(g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        g.socket.send(
          messaggioOrdine
        );
      }
    });

    setTimeout(
      () => {
        completaDeterminazione(
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
    partita
      .codaDeterminazione
      .shift();

  avviaTimerDeterminazione(
    partita,
    nomeStanza
  );

  inviaStatoDeterminazione(
    partita,
    nomeStanza
  );
}

async function espelliPerInattivitaDuranteDeterminazione(
  partita,
  nomeStanza,
  uid
) {
  fermaTimerTurno(
    partita
  );

  const nomeUscente =
    partita.giocatori[
      uid
    ]
      ? partita.giocatori[
          uid
        ].nome
      : "?";

  if (db) {
    try {
      const u =
        (
          await db
            .ref(
              "utenti/" +
                uid
            )
            .once("value")
        ).val();

      if (u) {
        await db
          .ref(
            "utenti/" +
              uid
          )
          .update({
            xp: Math.max(
              0,
              (u.xp || 0) -
                xpPenalitaAbbandonoAutomatico()
            ),

            streakVittorieAttuale:
              0
          });
      }
    } catch (e) {
      console.error(
        "Errore penalità inattività in determinazione:",
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
    restanti.length <= 1
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

  partita.turnoInCorsoDeterminazione =
    null;

  await avanzaDeterminazione(
    partita,
    nomeStanza
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

      iniziata:
        false,

      fase:
        "determinazione_ordine"
    }
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
  /*
   * Se nel frattempo qualcuno è uscito,
   * non procediamo con un ordine che contiene
   * giocatori non più presenti.
   */
  const ordineValido =
    ordineFinale.filter(
      uid =>
        partita.giocatori[
          uid
        ]
    );

  if (
    ordineValido.length <
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

  partita.ordineGiocatori =
    ordineValido;

  partita.turnoAttuale =
    0;

  partita.fase =
    "in_corso";

  partita.iniziata =
    true;

  partita.iniziataIl =
    Date.now();

  partita.elaborandoTiro =
    false;

  const punteggiPerNome =
    {};

  ordineValido.forEach(
    uid => {
      punteggiPerNome[
        partita
          .giocatori[
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

  const primoUid =
    ordineValido[0];

  const primoGiocatore =
    partita.giocatori[
      primoUid
    ];

  const statoGiocatori =
    costruisciStatoGiocatori(
      partita
    );

  const idPrimoTurno =
    partita
      .ordineGiocatori[
        partita.turnoAttuale
      ];

  avviaTimerTurno(
    partita,
    nomeStanza
  );

  Object.values(
    partita.giocatori
  ).forEach(g => {
    if (
      g.socket &&
      g.socket.readyState ===
        WebSocket.OPEN
    ) {
      g.socket.send(
        JSON.stringify({
          tipo:
            "determinazioneCompletata",

          ordineGiocatori:
            ordineValido.map(
              id =>
                partita
                  .giocatori[
                    id
                  ].nome
            ),

          punteggiOrdineIniziale:
            punteggiPerNome,

          primoMovimento: {
            idGiocatore:
              primoUid,

            nomeGiocatore:
              primoGiocatore
                .nome,

            valoreDado:
              0,

            percorso: [],

            messaggi: [
              "Ordine deciso!",
              primoGiocatore
                .nome +
                " inizia la partita: tira i dadi!"
            ]
          },

          giocatori:
            statoGiocatori,

          turnoDiId:
            idPrimoTurno,

          tempoInizioTurno:
            partita
              .tempoInizioTurno,

          durataMossaMs:
            millisecondiMossa(
              partita
            ),

          vittoria:
            false,

          vincitore:
            null
        })
      );
    }
  });

  await salvaPartita({
    ...partita,
    stanza:
      nomeStanza
  });

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();
}

async function avviaPartitaAutomaticamente(
  partita
) {
  const trovato =
    trovaPartita(
      partita.id
    );

  const nomeStanza =
    trovato
      ? trovato.nomeStanza
      : partita.stanza;

  iniziaFaseDeterminazione(
    partita,
    nomeStanza
  );

  await salvaPartita({
    ...partita,
    stanza:
      nomeStanza,
    fase:
      partita.fase,
    iniziata:
      partita.iniziata
  });

  Object.values(
    partita.giocatori
  ).forEach(g => {
    if (
      g.socket &&
      g.socket.readyState ===
        WebSocket.OPEN
    ) {
      g.socket.send(
        JSON.stringify({
          tipo:
            "partitaAvviata",

          partitaId:
            partita.id
        })
      );
    }
  });

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();
}

/* =========================================================
   USCITA DALLA PARTITA IN ATTESA
========================================================= */

async function esciDaPartitaInAttesa(
  partita,
  nomeStanza,
  uid
) {
  if (
    !partita ||
    !uid
  ) {
    return false;
  }

  if (
    partita.fase !==
    "attesa_giocatori"
  ) {
    return false;
  }

  const giocatoreUscente =
    partita.giocatori[
      uid
    ];

  if (!giocatoreUscente) {
    return false;
  }

  const eraCreatore =
    partita.creatoDa ===
    uid;

  const nomeUscente =
    giocatoreUscente.nome ||
    "Giocatore";

  delete partita.giocatori[
    uid
  ];

  partita.ordineGiocatori =
    (
      partita.ordineGiocatori ||
      []
    ).filter(
      id =>
        id !== uid
    );

  partita.turnoAttuale =
    0;

  const restanti =
    Object.keys(
      partita.giocatori
    );

  /*
   * Nessuno è rimasto:
   * la partita viene realmente eliminata.
   */
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

  /*
   * Se era il creatore,
   * passa la proprietà al primo
   * giocatore rimasto nell'ordine.
   */
  if (
    eraCreatore
  ) {
    const nuovoCreatoreUid =
      partita
        .ordineGiocatori[0];

    const nuovoCreatore =
      partita.giocatori[
        nuovoCreatoreUid
      ];

    if (
      nuovoCreatore
    ) {
      partita.creatoDa =
        nuovoCreatoreUid;

      partita.creatore =
        nuovoCreatore.nome;
    }
  }

  await aggiornaStatoPartita(
    partita.id,
    {
      creatore:
        partita.creatore,

      creatoDa:
        partita.creatoDa,

      giocatori:
        preparaGiocatoriPerFirebase(
          partita.giocatori
        ),

      ordineGiocatori:
        partita.ordineGiocatori,

      turnoAttuale:
        partita.turnoAttuale,

      iniziata:
        false,

      fase:
        "attesa_giocatori"
    }
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
        partidaSafeUid(
          partita.creatoDa
        )
    }
  );

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();

  return true;
}

/*
 * Piccola utilità per evitare valori undefined
 * nei messaggi.
 */
function partidaSafeUid(uid) {
  return uid || null;
}

/* =========================================================
   WEBSOCKET
========================================================= */

wss.on(
  "connection",
  (socket, request) => {
    socket.isAlive =
      true;

    socket.on(
      "pong",
      () => {
        socket.isAlive =
          true;
      }
    );

    const tipoDispositivo =
      rilevaTipoDispositivo(
        request.headers[
          "user-agent"
        ]
      );

    const socketId =
      "s" +
      contatoreId++;

    socketsPerId[
      socketId
    ] =
      socket;

    let stanzaAttuale =
      null;

    let nickname =
      null;

    let mioAvatar =
      null;

    const tokenDalCookie =
      estraiTokenDaCookieHeader(
        request.headers.cookie
      );

    const datiTokenIniziali =
      verificaToken(
        tokenDalCookie
      );

    let uid =
      datiTokenIniziali
        ? datiTokenIniziali.uid
        : null;

    /* =====================================================
       FUNZIONE INTERNA DI REGISTRAZIONE ONLINE
    ===================================================== */

    function registraSocketNellaStanza(
      nomeStanza
    ) {
      if (!nomeStanza) {
        return;
      }

      if (
        !stanze[
          nomeStanza
        ]
      ) {
        stanze[
          nomeStanza
        ] = {
          giocatoriOnline:
            {},
          partite: {}
        };
      }

      /*
       * Lo stesso socket viene registrato
       * solamente una volta.
       */
      stanze[
        nomeStanza
      ].giocatoriOnline[
        socketId
      ] = {
        uid,
        nickname,
        avatar:
          mioAvatar,
        tipoDispositivo
      };

      stanzaAttuale =
        nomeStanza;
    }

    /* =====================================================
       GESTIONE MESSAGE
    ===================================================== */

    socket.on(
      "message",
      async message => {
        try {
          let dati;

          try {
            dati =
              JSON.parse(
                message
              );
          } catch (e) {
            return;
          }

          /* ===============================================
             RICHIEDI CONTEGGIO
          =============================================== */

          if (
            dati.tipo ===
            "richiediConteggio"
          ) {
            inviaConteggioStanze();
            return;
          }

          /* ===============================================
             WEBRTC / AUDIO
          =============================================== */

          if (
            dati.tipo ===
              "richiestaAudio" ||
            dati.tipo ===
              "rispostaAudio" ||
            dati.tipo ===
              "webrtc-offer" ||
            dati.tipo ===
              "webrtc-answer" ||
            dati.tipo ===
              "webrtc-ice-candidate"
          ) {
            if (!uid) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

            const {
              partita
            } = trovato;

            if (
              !partita.giocatori[
                uid
              ]
            ) {
              return;
            }

            const destinatarioUid =
              dati.destinatarioUid;

            if (
              !destinatarioUid
            ) {
              return;
            }

            const destinatario =
              partita.giocatori[
                destinatarioUid
              ];

            if (
              !destinatario ||
              !destinatario.socket ||
              destinatario.socket.readyState !==
                WebSocket.OPEN
            ) {
              return;
            }

            if (
              dati.tipo ===
              "richiestaAudio"
            ) {
              destinatario.socket.send(
                JSON.stringify({
                  tipo:
                    "richiestaAudioRicevuta",
                  mittenteUid:
                    uid,
                  mittenteNome:
                    nickname
                })
              );

              return;
            }

            if (
              dati.tipo ===
              "rispostaAudio"
            ) {
              if (
                dati.accettato
              ) {
                if (
                  !partita.coppieAudioApprovate
                ) {
                  partita.coppieAudioApprovate =
                    new Set();
                }

                partita.coppieAudioApprovate.add(
                  idConversazione(
                    uid,
                    destinatarioUid
                  )
                );
              }

              destinatario.socket.send(
                JSON.stringify({
                  tipo:
                    "rispostaAudioRicevuta",
                  mittenteUid:
                    uid,
                  mittenteNome:
                    nickname,
                  accettato:
                    !!dati.accettato
                })
              );

              return;
            }

            const coppiaApprovata =
              partita
                .coppieAudioApprovate &&
              partita
                .coppieAudioApprovate
                .has(
                  idConversazione(
                    uid,
                    destinatarioUid
                  )
                );

            if (
              !coppiaApprovata
            ) {
              return;
            }

            destinatario.socket.send(
              JSON.stringify({
                tipo:
                  dati.tipo,
                mittenteUid:
                  uid,
                sdp:
                  dati.sdp ||
                  null,
                candidate:
                  dati.candidate ||
                  null
              })
            );

            return;
          }

          /* ===============================================
             ENTRA LOBBY
          =============================================== */

          if (
            dati.tipo ===
            "entraLobby"
          ) {
            if (!db) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Servizio account non disponibile."
                })
              );

              return;
            }

            if (!uid) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "sessioneScaduta"
                })
              );

              return;
            }

            if (!dati.stanza) {
              return;
            }

            const utenteDb =
              (
                await db
                  .ref(
                    "utenti/" +
                      uid
                  )
                  .once("value")
              ).val();

            if (!utenteDb) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "sessioneScaduta"
                })
              );

              return;
            }

            if (
              utenteDb.stato ===
              "bannato"
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Il tuo account è stato bannato."
                })
              );

              return;
            }

            if (
              utenteDb.stato ===
                "sospeso" &&
              utenteDb.sospesoFino &&
              utenteDb.sospesoFino >
                Date.now()
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",

                  messaggio:
                    "Account sospeso fino al " +
                    new Date(
                      utenteDb.sospesoFino
                    ).toLocaleString(
                      "it-IT"
                    ) +
                    "."
                })
              );

              return;
            }

            nickname =
              utenteDb.nickname;

            mioAvatar =
              utenteDb.avatar ||
              null;

            registraSocketNellaStanza(
              dati.stanza
            );

            /*
             * Se esiste una partita già iniziata
             * con questo utente, la sua presenza
             * rimane valida e potrà essere ripresa.
             */
            const partitaAttiva =
              trovaPartitaAttivaPerUid(
                uid
              );

            inviaConteggioStanze();

            inviaAllaStanza(
              stanzaAttuale,
              {
                tipo:
                  "online",

                numero:
                  Object.keys(
                    stanze[
                      stanzaAttuale
                    ]
                      .giocatoriOnline
                  ).length
              }
            );

            inviaListaPartite(
              stanzaAttuale
            );

            socket.send(
              JSON.stringify({
                tipo:
                  "statoPartitaPersonale",

                partitaAttiva
              })
            );

            /*
             * Se l'utente appartiene a una partita
             * già iniziata ma il suo socket precedente
             * non esiste più, non lo facciamo entrare
             * automaticamente nel gioco: resta nel
             * server come partecipante e userà Riprendi.
             */
            return;
          }

          /* ===============================================
             RIPRENDI PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "riprendiPartita"
          ) {
            if (!uid) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "sessioneScaduta"
                })
              );

              return;
            }

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

            const {
              partita,
              nomeStanza
            } = trovato;

            if (
              !partita.iniziata
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Questa partita non è ancora iniziata."
                })
              );

              return;
            }

            const mioGiocatore =
              partita.giocatori[
                uid
              ];

            if (!mioGiocatore) {
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

            if (db) {
              try {
                const u =
                  (
                    await db
                      .ref(
                        "utenti/" +
                          uid
                      )
                      .once(
                        "value"
                      )
                  ).val();

                if (u) {
                  mioGiocatore.avatar =
                    u.avatar ||
                    null;
                }
              } catch (e) {}
            }

            /*
             * IMPORTANTE:
             * sostituiamo il vecchio socket
             * con quello attuale.
             */
            mioGiocatore.socket =
              socket;

            nickname =
              mioGiocatore.nome;

            mioAvatar =
              mioGiocatore.avatar ||
              null;

            registraSocketNellaStanza(
              nomeStanza
            );

            inviaConteggioStanze();

            if (
              partita.fase ===
              "determinazione_ordine"
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "statoDeterminazione",

                  giocatori:
                    (
                      partita
                        .ordineDeterminazione ||
                      []
                    )
                      .map(
                        u2 => ({
                          uid:
                            u2,

                          nome:
                            partita
                              .giocatori[
                                u2
                              ]
                              ? partita
                                  .giocatori[
                                    u2
                                  ].nome
                              : "?",

                          avatar:
                            partita
                              .giocatori[
                                u2
                              ]
                              ? (
                                  partita
                                    .giocatori[
                                      u2
                                    ].avatar ||
                                  null
                                )
                              : null,

                          risultato:
                            partita
                              .risultatiDeterminazione &&
                            partita
                              .risultatiDeterminazione[
                                u2
                              ] !=
                              null
                              ? partita
                                  .risultatiDeterminazione[
                                    u2
                                  ]
                              : null
                        })
                      ),

                  turnoInCorsoUid:
                    partita
                      .turnoInCorsoDeterminazione ||
                    null,

                  gruppoSpareggioAttuale:
                    partita
                      .gruppoSpareggioAttuale ||
                    null,

                  tempoInizioTurno:
                    partita
                      .tempoInizioTurno ||
                    Date.now(),

                  durataMossaMs:
                    millisecondiMossa(
                      partita
                    ),

                  chatAttiva:
                    partita.chatAttiva !==
                    false
                })
              );
            } else {
              /*
               * Se il timer non esiste più per un motivo
               * eccezionale, lo riavviamo.
               */
              if (
                !partita.timerTurno
              ) {
                avviaTimerTurno(
                  partita,
                  nomeStanza
                );
              }

              socket.send(
                JSON.stringify({
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
                    partita
                      .punteggiOrdineIniziale ||
                    null,

                  tempoInizioTurno:
                    partita
                      .tempoInizioTurno ||
                    Date.now(),

                  durataMossaMs:
                    millisecondiMossa(
                      partita
                    ),

                  chatAttiva:
                    partita.chatAttiva !==
                    false
                })
              );
            }

            return;
          }

          /* ===============================================
             CREA PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "creaPartita"
          ) {
            if (
              !stanzaAttuale ||
              !uid
            ) {
              return;
            }

            const esistente =
              Object.values(
                stanze[
                  stanzaAttuale
                ].partite
              ).some(
                p =>
                  p.creatoDa ===
                  uid
              );

            if (
              esistente
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

            const partitaId =
              "p" +
              Date.now() +
              Math.floor(
                Math.random() *
                  1000
              );

            const max =
              parseInt(
                dati.maxGiocatori,
                10
              );

            stanze[
              stanzaAttuale
            ].partite[
              partitaId
            ] = {
              id:
                partitaId,

              stanza:
                stanzaAttuale,

              creatore:
                nickname,

              creatoDa:
                uid,

              tempo:
                dati.tempo,

              punti:
                dati.punti,

              modalita:
                dati.modalita,

              maxGiocatori:
                !max ||
                max < 2 ||
                max > 8
                  ? 2
                  : max,

              chatAttiva:
                dati.chatAttiva !==
                false,

              fase:
                "attesa_giocatori",

              giocatori: {
                [uid]: {
                  nome:
                    nickname,

                  avatar:
                    mioAvatar,

                  posizione:
                    0,

                  socket,

                  turniSaltati:
                    0,

                  tentativiAutomaticiConsecutivi:
                    0
                }
              },

              ordineGiocatori: [
                uid
              ],

              turnoAttuale:
                0,

              iniziata:
                false,

              elaborandoTiro:
                false,

              invitati:
                dati.modalita ===
                "privata"
                  ? {
                      [uid]:
                        true
                    }
                  : {},

              timerTurno:
                null,

              tempoInizioTurno:
                null,

              tokenTimerTurno:
                0,

              coppieAudioApprovate:
                new Set()
            };

            await salvaPartita({
              ...stanze[
                stanzaAttuale
              ].partite[
                partitaId
              ],

              stanza:
                stanzaAttuale
            });

            inviaListaPartite(
              stanzaAttuale
            );

            inviaConteggioStanze();

            return;
          }

          /* ===============================================
             ENTRA PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "entraPartita"
          ) {
            if (
              !stanzaAttuale ||
              !uid
            ) {
              return;
            }

            const partita =
              stanze[
                stanzaAttuale
              ].partite[
                dati.id
              ];

            if (!partita) {
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

            /*
             * Se è già dentro:
             * non facciamo una seconda aggiunta.
             * Aggiorniamo invece il socket nel caso
             * sia una riconnessione legittima.
             */
            if (
              partita.giocatori[
                uid
              ]
            ) {
              partita.giocatori[
                uid
              ].socket =
                socket;

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
                    "La partita è già piena."
                })
              );

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
                    "Questa è una partita privata: puoi entrare solo se il creatore ti invita direttamente."
                })
              );

              return;
            }

            partita.giocatori[
              uid
            ] = {
              nome:
                nickname,

              avatar:
                mioAvatar,

              posizione:
                0,

              socket,

              turniSaltati:
                0,

              tentativiAutomaticiConsecutivi:
                0
            };

            partita.ordineGiocatori.push(
              uid
            );

            await aggiornaStatoPartita(
              partita.id,
              {
                giocatori:
                  preparaGiocatoriPerFirebase(
                    partita.giocatori
                  ),

                ordineGiocatori:
                  partita
                    .ordineGiocatori
              }
            );

            inviaListaPartite(
              stanzaAttuale
            );

            inviaConteggioStanze();

            if (
              Object.keys(
                partita.giocatori
              ).length ===
              partita.maxGiocatori
            ) {
              await avviaPartitaAutomaticamente(
                partita
              );
            }

            return;
          }

          /* ===============================================
             INVITO PARTITA PRIVATA
          =============================================== */

          if (
            dati.tipo ===
            "invitaPartita"
          ) {
            if (!uid) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

            const {
              partita,
              nomeStanza
            } = trovato;

            if (
              partita.creatoDa !==
              uid
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Solo il creatore della partita può invitare altri giocatori."
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
                    "La partita è già al completo."
                })
              );

              return;
            }

            const destinatarioUid =
              dati.destinatarioUid;

            if (
              !destinatarioUid ||
              destinatarioUid ===
                uid ||
              partita.giocatori[
                destinatarioUid
              ]
            ) {
              return;
            }

            const stanzaOggetto =
              stanze[
                nomeStanza
              ];

            if (
              !stanzaOggetto
            ) {
              return;
            }

            const socketIdDestinatario =
              Object.keys(
                stanzaOggetto
                  .giocatoriOnline
              ).find(
                sid =>
                  stanzaOggetto
                    .giocatoriOnline[
                      sid
                    ].uid ===
                  destinatarioUid
              );

            if (
              !socketIdDestinatario
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Questo giocatore non è più online in questa stanza."
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
            ] = true;

            const socketDestinatario =
              socketsPerId[
                socketIdDestinatario
              ];

            const nomeDestinatario =
              stanzaOggetto
                .giocatoriOnline[
                  socketIdDestinatario
                ].nickname;

            if (
              socketDestinatario &&
              socketDestinatario.readyState ===
                WebSocket.OPEN
            ) {
              socketDestinatario.send(
                JSON.stringify({
                  tipo:
                    "invitoRicevuto",

                  partitaId:
                    partita.id,

                  stanza:
                    nomeStanza,

                  daUid:
                    uid,

                  daNome:
                    nickname
                })
              );
            }

            if (db) {
              db
                .ref(
                  "utenti/" +
                    destinatarioUid +
                    "/notifiche"
                )
                .push({
                  tipo:
                    "invitoPartita",

                  testo:
                    `${nickname} ti ha invitato a giocare nella stanza ${nomeStanza}`,

                  data:
                    Date.now(),

                  letta: false,

                  daUid:
                    uid,

                  daNome:
                    nickname,

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

                destinatarioUid,

                destinatarioNome:
                  nomeDestinatario
              })
            );

            return;
          }

          /* ===============================================
             RISPOSTA INVITO
          =============================================== */

          if (
            dati.tipo ===
            "rispostaInvito"
          ) {
            if (!uid) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

            const {
              partita,
              nomeStanza
            } = trovato;

            if (
              !partita.invitati ||
              !partita.invitati[
                uid
              ]
            ) {
              return;
            }

            if (
              !dati.accettato
            ) {
              delete partita.invitati[
                uid
              ];

              const hostGiocatore =
                partita.giocatori[
                  partita.creatoDa
                ];

              if (
                hostGiocatore &&
                hostGiocatore.socket &&
                hostGiocatore.socket.readyState ===
                  WebSocket.OPEN
              ) {
                hostGiocatore.socket.send(
                  JSON.stringify({
                    tipo:
                      "invitoRifiutato",

                    destinatarioNome:
                      nickname
                  })
                );
              }

              return;
            }

            if (
              partita.giocatori[
                uid
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
                    "La partita si è già riempita."
                })
              );

              return;
            }

            stanzaAttuale =
              nomeStanza;

            partita.giocatori[
              uid
            ] = {
              nome:
                nickname,

              avatar:
                mioAvatar,

              posizione:
                0,

              socket,

              turniSaltati:
                0,

              tentativiAutomaticiConsecutivi:
                0
            };

            partita.ordineGiocatori.push(
              uid
            );

            delete partita.invitati[
              uid
            ];

            await aggiornaStatoPartita(
              partita.id,
              {
                giocatori:
                  preparaGiocatoriPerFirebase(
                    partita.giocatori
                  ),

                ordineGiocatori:
                  partita
                    .ordineGiocatori
              }
            );

            inviaListaPartite(
              nomeStanza
            );

            inviaConteggioStanze();

            if (
              Object.keys(
                partita.giocatori
              ).length ===
              partita.maxGiocatori
            ) {
              await avviaPartitaAutomaticamente(
                partita
              );
            }

            return;
          }

          /* ===============================================
             ELIMINA PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "eliminaPartita"
          ) {
            if (
              !stanzaAttuale ||
              !uid
            ) {
              return;
            }

            const idDaEliminare =
              Object.keys(
                stanze[
                  stanzaAttuale
                ].partite
              ).find(
                pid =>
                  stanze[
                    stanzaAttuale
                  ].partite[
                    pid
                  ].creatoDa ===
                  uid &&
                  !stanze[
                    stanzaAttuale
                  ].partite[
                    pid
                  ].iniziata
              );

            if (
              !idDaEliminare
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Non hai nessuna partita eliminabile."
                })
              );

              return;
            }

            await rimuoviPartita(
              stanzaAttuale,
              idDaEliminare
            );

            inviaListaPartite(
              stanzaAttuale
            );

            inviaConteggioStanze();

            return;
          }

          /* ===============================================
             CHAT LOBBY
          =============================================== */

          if (
            dati.tipo ===
            "chat"
          ) {
            if (
              !stanzaAttuale
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

            if (
              testo.length ===
              0
            ) {
              return;
            }

            inviaAllaStanza(
              stanzaAttuale,
              {
                tipo:
                  "chat",

                uid,

                nome:
                  nickname,

                testo
              }
            );

            return;
          }

          /* ===============================================
             CHAT PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "chatPartita"
          ) {
            if (!uid) {
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

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

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
                    "La chat è disattivata in questa partita."
                })
              );

              return;
            }

            const mittente =
              partita.giocatori[
                uid
              ];

            if (!mittente) {
              return;
            }

            Object.values(
              partita.giocatori
            ).forEach(g => {
              if (
                g.socket &&
                g.socket.readyState ===
                  WebSocket.OPEN
              ) {
                g.socket.send(
                  JSON.stringify({
                    tipo:
                      "chatPartita",

                    nome:
                      mittente.nome,

                    testo
                  })
                );
              }
            });

            return;
          }

          /* ===============================================
             TIRO DETERMINAZIONE
          =============================================== */

          if (
            dati.tipo ===
            "tiraDeterminazione"
          ) {
            if (!uid) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

            const {
              partita,
              nomeStanza
            } = trovato;

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
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",
                  messaggio:
                    "Non è il tuo turno per tirare."
                })
              );

              return;
            }

            if (
              partita.giocatori[
                uid
              ]
            ) {
              partita
                .giocatori[
                  uid
                ]
                .tentativiAutomaticiConsecutivi =
                0;
            }

            await eseguiTiroDeterminazionePerGiocatore(
              partita,
              nomeStanza,
              uid,
              false
            );

            return;
          }

          /* ===============================================
             TIRO DADI PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "tiraDadi"
          ) {
            if (!uid) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

            const {
              partita,
              nomeStanza
            } = trovato;

            if (
              partita.fase !==
              "in_corso"
            ) {
              return;
            }

            if (
              partita
                .ordineGiocatori[
                  partita.turnoAttuale
                ] !== uid
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
              partita.giocatori[
                uid
              ]
            ) {
              partita
                .giocatori[
                  uid
                ]
                .tentativiAutomaticiConsecutivi =
                0;
            }

            await eseguiTiroDadiPerGiocatore(
              partita,
              nomeStanza,
              uid,
              false
            );

            return;
          }

          /* ===============================================
             ABBANDONA PARTITA
          =============================================== */

          if (
            dati.tipo ===
            "abbandonaPartita"
          ) {
            if (!uid) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (!trovato) {
              return;
            }

            const {
              partita,
              nomeStanza
            } = trovato;

            if (
              !partita.giocatori[
                uid
              ]
            ) {
              return;
            }

            /*
             * 1) PARTITA ANCORA IN ATTESA
             */
            if (
              partita.fase ===
              "attesa_giocatori"
            ) {
              await esciDaPartitaInAttesa(
                partita,
                nomeStanza,
                uid
              );

              return;
            }

            /*
             * 2) DETERMINAZIONE ORDINE
             */
            if (
              partita.fase ===
              "determinazione_ordine"
            ) {
              const eraIlSuoTurnoDiTirare =
                (
                  partita
                    .turnoInCorsoDeterminazione ===
                  uid
                );

              fermaTimerTurno(
                partita
              );

              rimuoviGiocatoreDaDeterminazione(
                partita,
                uid
              );

              const restanti =
                Object.keys(
                  partita.giocatori
                );

              if (
                restanti.length <=
                1
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
                eraIlSuoTurnoDiTirare
              ) {
                partita.turnoInCorsoDeterminazione =
                  null;
              }

              await aggiornaStatoPartita(
                partita.id,
                {
                  giocatori:
                    preparaGiocatoriPerFirebase(
                      partita.giocatori
                    ),

                  ordineGiocatori:
                    partita.ordineGiocatori,

                  iniziata:
                    false,

                  fase:
                    "determinazione_ordine"
                }
              );

              await avanzaDeterminazione(
                partita,
                nomeStanza
              );

              inviaListaPartite(
                nomeStanza
              );

              inviaConteggioStanze();

              return;
            }

            /*
             * 3) PARTITA IN CORSO
             */
            const eraLuiIlGiocatoreAttivo =
              (
                partita
                  .ordineGiocatori[
                    partita.turnoAttuale
                  ] === uid
              );

            const idGiocatoreAttivoPrimaDiRimuovere =
              eraLuiIlGiocatoreAttivo
                ? null
                : partita
                    .ordineGiocatori[
                      partita.turnoAttuale
                    ];

            const elencoPartecipantiOriginali =
              partita
                .ordineGiocatori
                .map(
                  id => ({
                    uid:
                      id,

                    nome:
                      partita
                        .giocatori[
                          id
                        ]
                        ? partita
                            .giocatori[
                              id
                            ].nome
                        : "?"
                  })
                );

            const nomeUscente =
              partita
                .giocatori[
                  uid
                ].nome;

            /*
             * Rimuoviamo il giocatore
             * dalla partita vera.
             */
            delete partita.giocatori[
              uid
            ];

            partita.ordineGiocatori =
              partita
                .ordineGiocatori
                .filter(
                  id =>
                    id !== uid
                );

            const restanti =
              Object.keys(
                partita.giocatori
              );

            /*
             * Nessuno rimasto:
             * elimina completamente.
             */
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

            /*
             * Manteniamo lo stesso turno
             * quando possibile.
             */
            if (
              !eraLuiIlGiocatoreAttivo
            ) {
              const nuovoIndice =
                partita
                  .ordineGiocatori
                  .indexOf(
                    idGiocatoreAttivoPrimaDiRimuovere
                  );

              partita.turnoAttuale =
                nuovoIndice >=
                0
                  ? nuovoIndice
                  : 0;
            } else if (
              partita.turnoAttuale >=
              partita
                .ordineGiocatori
                .length
            ) {
              partita.turnoAttuale =
                0;
            }

            /*
             * Se resta un solo giocatore,
             * chiudiamo la partita.
             */
            if (
              restanti.length ===
                1 &&
              partita.iniziata
            ) {
              const vincitoreId =
                restanti[0];

              const vincitoreNome =
                partita
                  .giocatori[
                    vincitoreId
                  ].nome;

              const statoGiocatori =
                costruisciStatoGiocatori(
                  partita
                );

              Object.values(
                partita.giocatori
              ).forEach(g => {
                if (
                  g.socket &&
                  g.socket.readyState ===
                    WebSocket.OPEN
                ) {
                  g.socket.send(
                    JSON.stringify({
                      tipo:
                        "statoPartita",

                      giocatori:
                        statoGiocatori,

                      turnoDiId:
                        vincitoreId,

                      vittoria:
                        true,

                      vincitore:
                        vincitoreNome,

                      messaggi: [
                        nomeUscente +
                          " ha abbandonato la partita."
                      ]
                    })
                  );
                }
              });

              await concludiPartita(
                partita,
                vincitoreId,
                nomeStanza,
                elencoPartecipantiOriginali
              );

              await rimuoviPartita(
                nomeStanza,
                partita.id
              );
            } else {
              if (
                eraLuiIlGiocatoreAttivo
              ) {
                avviaTimerTurno(
                  partita,
                  nomeStanza
                );
              }

              const idAttuale =
                partita
                  .ordineGiocatori[
                    partita.turnoAttuale
                  ];

              const statoGiocatori =
                costruisciStatoGiocatori(
                  partita
                );

              Object.values(
                partita.giocatori
              ).forEach(g => {
                if (
                  g.socket &&
                  g.socket.readyState ===
                    WebSocket.OPEN
                ) {
                  g.socket.send(
                    JSON.stringify({
                      tipo:
                        "statoPartita",

                      giocatori:
                        statoGiocatori,

                      turnoDiId:
                        idAttuale,

                      messaggi: [
                        nomeUscente +
                          " ha abbandonato la partita."
                      ],

                      tempoInizioTurno:
                        partita.tempoInizioTurno ||
                        Date.now(),

                      durataMossaMs:
                        millisecondiMossa(
                          partita
                        )
                    })
                  );
                }
              });

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
                    true,

                  fase:
                    "in_corso"
                }
              );
            }

            inviaListaPartite(
              nomeStanza
            );

            inviaConteggioStanze();

            return;
          }
        } catch (erroreInterno) {
          console.error(
            "Errore nella gestione di un messaggio:",
            erroreInterno
          );
        }
      }
    );

    /* =====================================================
       CHIUSURA WEBSOCKET
    ===================================================== */

    socket.on(
      "close",
      async () => {
        try {
          delete socketsPerId[
            socketId
          ];

          /*
           * Rimuoviamo SEMPRE il socket
           * dalla lista online.
           */
          if (
            stanzaAttuale &&
            stanze[
              stanzaAttuale
            ]
          ) {
            delete stanze[
              stanzaAttuale
            ].giocatoriOnline[
              socketId
            ];

            inviaAllaStanza(
              stanzaAttuale,
              {
                tipo:
                  "online",

                numero:
                  Object.keys(
                    stanze[
                      stanzaAttuale
                    ]
                      .giocatoriOnline
                  ).length
              }
            );
          }

          /*
           * Nessuna stanza o utente:
           * non c'è altro da fare.
           */
          if (
            !stanzaAttuale ||
            !stanze[
              stanzaAttuale
            ] ||
            !uid
          ) {
            inviaConteggioStanze();
            return;
          }

          const partite =
            stanze[
              stanzaAttuale
            ].partite;

          /*
           * =================================================
           * PARTITE IN ATTESA
           * =================================================
           *
           * Se l'utente chiude browser / scheda mentre
           * la partita NON è iniziata:
           *
           * -> viene tolto dalla partita
           * -> se era creatore, la proprietà passa
           * -> se non rimane nessuno, la partita sparisce
           */
          for (
            const pid in partite
          ) {
            const partita =
              partite[pid];

            if (
              partita.fase !==
              "attesa_giocatori"
            ) {
              continue;
            }

            const giocatore =
              partita.giocatori[
                uid
              ];

            if (!giocatore) {
              continue;
            }

            /*
             * Se esiste già un altro socket
             * ancora associato allo stesso giocatore,
             * non espellerlo.
             */
            if (
              giocatore.socket &&
              giocatore.socket !==
                socket
            ) {
              continue;
            }

            await esciDaPartitaInAttesa(
              partita,
              stanzaAttuale,
              uid
            );
          }

          /*
           * =================================================
           * PARTITE GIÀ INIZIATE
           * =================================================
           *
           * NON vengono cancellate.
           *
           * NON vengono tolte.
           *
           * NON vengono concluse.
           *
           * Rimangono in Firebase / memoria.
           *
           * Il giocatore potrà rientrare con
           * "Riprendi".
           */
          for (
            const pid in partite
          ) {
            const partita =
              partite[pid];

            if (
              !partita.iniziata
            ) {
              continue;
            }

            const giocatore =
              partita.giocatori[
                uid
              ];

            if (!giocatore) {
              continue;
            }

            /*
             * Cancelliamo il riferimento al vecchio
             * socket SOLO se quel socket era proprio
             * quello chiuso.
             */
            if (
              giocatore.socket ===
              socket
            ) {
              giocatore.socket =
                null;
            }
          }

          inviaListaPartite(
            stanzaAttuale
          );

          inviaConteggioStanze();
        } catch (erroreInterno) {
          console.error(
            "Errore nella chiusura di una connessione:",
            erroreInterno
          );
        }
      }
    );
  }
);

/* =========================================================
   AVVIO SERVER
========================================================= */

server.listen(
  PORT,
  async () => {
    console.log(
      "Server avviato sulla porta " +
        PORT
    );

    await ripristinaPartiteDaFirebase();
  }
);
