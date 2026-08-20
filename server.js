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

app.disable("x-powered-by");
app.set("trust proxy", 1);

/* =========================================================
   UTILITÀ
   ========================================================= */

function pulisciTesto(testo, massimo = 500) {
  if (typeof testo !== "string") return "";

  return testo
    .trim()
    .replace(/[<>]/g, "")
    .substring(0, massimo);
}

function idConversazione(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

/* =========================================================
   ELO
   ========================================================= */

const ELO_INIZIALE = 1500;

const ELO_K_NUOVO = 40;
const ELO_K_INTERMEDIO = 32;
const ELO_K_ESPERTO = 24;

const PARTITE_PROVVISORIE_ELO = 10;

function ratingEloValido(valore) {
  const numero = Number(valore);

  if (!Number.isFinite(numero)) {
    return ELO_INIZIALE;
  }

  return Math.round(numero);
}

function limitaElo(valore) {
  const numero = Math.round(
    Number(valore)
  );

  if (!Number.isFinite(numero)) {
    return ELO_INIZIALE;
  }

  return Math.max(100, numero);
}

function calcolaKFactor(partiteClassificate) {
  const partite = Number(
    partiteClassificate || 0
  );

  if (
    partite <
    PARTITE_PROVVISORIE_ELO
  ) {
    return ELO_K_NUOVO;
  }

  if (partite < 30) {
    return ELO_K_INTERMEDIO;
  }

  return ELO_K_ESPERTO;
}

function aspettativaElo(
  ratingGiocatore,
  ratingAvversario
) {
  return (
    1 /
    (
      1 +
      Math.pow(
        10,
        (
          ratingAvversario -
          ratingGiocatore
        ) / 400
      )
    )
  );
}

function risultatoEloDaPosizioni(
  posizioneA,
  posizioneB
) {
  if (
    posizioneA <
    posizioneB
  ) {
    return 1;
  }

  if (
    posizioneA >
    posizioneB
  ) {
    return 0;
  }

  return 0.5;
}

function calcolaVariazioniElo(
  giocatori
) {
  if (
    !Array.isArray(giocatori) ||
    giocatori.length < 2
  ) {
    return giocatori || [];
  }

  const risultati =
    giocatori.map(
      (g) => ({
        ...g,
        ratingPrima:
          ratingEloValido(
            g.ratingPrima
          ),
        deltaNonArrotondato: 0
      })
    );

  for (
    let i = 0;
    i < risultati.length;
    i++
  ) {
    const giocatore =
      risultati[i];

    const k =
      calcolaKFactor(
        giocatore.partiteClassificatePrima
      );

    for (
      let j = 0;
      j < risultati.length;
      j++
    ) {
      if (i === j) continue;

      const avversario =
        risultati[j];

      const risultato =
        risultatoEloDaPosizioni(
          giocatore.posizioneFinale,
          avversario.posizioneFinale
        );

      const atteso =
        aspettativaElo(
          giocatore.ratingPrima,
          avversario.ratingPrima
        );

      giocatore.deltaNonArrotondato +=
        k *
        (
          risultato -
          atteso
        );
    }
  }

  const numeroAvversari =
    risultati.length - 1;

  return risultati.map(
    (g) => {
      const variazione =
        Math.round(
          g.deltaNonArrotondato /
          numeroAvversari
        );

      const ratingDopo =
        limitaElo(
          g.ratingPrima +
          variazione
        );

      return {
        ...g,
        variazioneElo:
          variazione,
        ratingDopo
      };
    }
  );
}

async function migraUtenteElo(
  uid,
  utente
) {
  if (!db || !uid || !utente) {
    return utente;
  }

  const aggiornamenti = {};

  let modificato = false;

  if (
    utente.ratingElo === undefined ||
    utente.ratingElo === null ||
    !Number.isFinite(
      Number(utente.ratingElo)
    )
  ) {
    aggiornamenti.ratingElo =
      ELO_INIZIALE;

    utente.ratingElo =
      ELO_INIZIALE;

    modificato = true;
  } else {
    utente.ratingElo =
      ratingEloValido(
        utente.ratingElo
      );
  }

  if (
    utente.eloMassimo === undefined ||
    utente.eloMassimo === null ||
    !Number.isFinite(
      Number(utente.eloMassimo)
    )
  ) {
    aggiornamenti.eloMassimo =
      Number(
        utente.ratingElo ||
        ELO_INIZIALE
      );

    utente.eloMassimo =
      aggiornamenti.eloMassimo;

    modificato = true;
  } else {
    utente.eloMassimo =
      Number(
        utente.eloMassimo
      );

    if (
      utente.eloMassimo <
      utente.ratingElo
    ) {
      utente.eloMassimo =
        utente.ratingElo;

      aggiornamenti.eloMassimo =
        utente.ratingElo;

      modificato = true;
    }
  }

  const campiNumericiElo = [
    "partiteClassificate",
    "vittorieClassificate",
    "sconfitteClassificate",
    "pareggiClassificati"
  ];

  for (
    const campo of campiNumericiElo
  ) {
    if (
      utente[campo] === undefined ||
      utente[campo] === null ||
      !Number.isFinite(
        Number(utente[campo])
      )
    ) {
      aggiornamenti[campo] = 0;
      utente[campo] = 0;
      modificato = true;
    } else {
      utente[campo] =
        Number(utente[campo]);
    }
  }

  /* =======================================================
     RIMOZIONE COMPLETA DEI VECCHI CAMPI XP
     ======================================================= */

  const campiDaEliminare = [
    "xp",
    "livello",
    "sogliaAttuale",
    "sogliaProssima",
    "badge",
    "streakVittorieAttuale",
    "streakVittorieMassima",
    "vittoriaPiuVeloceSecondi"
  ];

  for (
    const campo of campiDaEliminare
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        utente,
        campo
      )
    ) {
      aggiornamenti[campo] =
        null;

      delete utente[campo];

      modificato = true;
    }
  }

  if (
    modificato
  ) {
    await db
      .ref(
        "utenti/" +
        uid
      )
      .update(
        aggiornamenti
      );
  }

  return utente;
}

/* =========================================================
   CORS
   ========================================================= */

const ORIGINI_CONSENTITE = [
  "https://solfriniluca1.wixstudio.com",
  "https://solfriniluca1-wixstudio-com.filesusr.com",
  "https://gioco-oca-server.onrender.com"
];

app.use(
  cors({
    origin: function (
      origin,
      callback
    ) {
      if (!origin) {
        return callback(
          null,
          true
        );
      }

      if (
        ORIGINI_CONSENTITE.includes(
          origin
        )
      ) {
        return callback(
          null,
          true
        );
      }

      console.log(
        "CORS bloccato:",
        origin
      );

      callback(
        null,
        false
      );
    },

    credentials: true
  })
);

/* =========================================================
   SICUREZZA HTTP
   ========================================================= */

app.use(
  helmet({
    crossOriginResourcePolicy:
      false,

    contentSecurityPolicy:
      false,

    frameguard:
      false
  })
);

app.use(
  express.json({
    limit:
      "150kb"
  })
);

app.use(
  cookieParser()
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.use(
  passport.initialize()
);

/* =========================================================
   SERVER
   ========================================================= */

const server =
  http.createServer(
    app
  );

const wss =
  new WebSocket.Server({
    server,
    maxPayload:
      100 * 1024
  });

const PORT =
  process.env.PORT ||
  3000;

/* =========================================================
   JWT
   ========================================================= */

const JWT_SECRET =
  process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET mancante: impostala nelle variabili d'ambiente su Render prima di avviare il server."
  );
}

const OPZIONI_COOKIE = {
  httpOnly:
    true,

  secure:
    true,

  sameSite:
    process.env.NODE_ENV ===
    "production"
      ? "none"
      : "lax",

  maxAge:
    30 *
    24 *
    60 *
    60 *
    1000,

  path:
    "/"
};

/* =========================================================
   MULTER
   ========================================================= */

const uploadAvatar =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      fileSize:
        3 *
        1024 *
        1024
    },

    fileFilter:
      (
        req,
        file,
        cb
      ) => {
        const tipiConsentiti = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        if (
          !tipiConsentiti.includes(
            file.mimetype
          )
        ) {
          return cb(
            new Error(
              "Sono consentite solo immagini JPG, PNG o WEBP."
            )
          );
        }

        cb(
          null,
          true
        );
      }
  });

/* =========================================================
   RATE LIMIT
   ========================================================= */

const limiteLogin =
  rateLimit({
    windowMs:
      15 *
      60 *
      1000,

    max:
      10,

    message: {
      errore:
        "Troppi tentativi, riprova tra qualche minuto."
    },

    standardHeaders:
      true,

    legacyHeaders:
      false
  });

const limiteRegistrazione =
  rateLimit({
    windowMs:
      60 *
      60 *
      1000,

    max:
      5,

    message: {
      errore:
        "Troppe registrazioni effettuate da questo indirizzo."
    },

    standardHeaders:
      true,

    legacyHeaders:
      false
  });

const limiteContatti =
  rateLimit({
    windowMs:
      60 *
      60 *
      1000,

    max:
      5,

    message: {
      errore:
        "Hai inviato troppe richieste, riprova più tardi."
    },

    standardHeaders:
      true,

    legacyHeaders:
      false
  });

const limiteMessaggiPrivati =
  rateLimit({
    windowMs:
      60 *
      1000,

    max:
      20,

    message: {
      errore:
        "Stai inviando messaggi troppo velocemente, rallenta un po'."
    },

    standardHeaders:
      true,

    legacyHeaders:
      false
  });

const limiteAmici =
  rateLimit({
    windowMs:
      10 *
      60 *
      1000,

    max:
      30,

    message: {
      errore:
        "Troppe richieste di amicizia in poco tempo, rallenta un po'."
    },

    standardHeaders:
      true,

    legacyHeaders:
      false
  });

const limiteAdmin =
  rateLimit({
    windowMs:
      10 *
      60 *
      1000,

    max:
      100,

    message: {
      errore:
        "Troppe operazioni amministrative in poco tempo."
    },

    standardHeaders:
      true,

    legacyHeaders:
      false
  });

/* =========================================================
   FIREBASE
   ========================================================= */

let db =
  null;

try {
  if (
    !process.env.FIREBASE_SERVICE_ACCOUNT
  ) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT mancante."
    );
  }

  const serviceAccount =
    JSON.parse(
      process.env
        .FIREBASE_SERVICE_ACCOUNT
    );

  admin.initializeApp({
    credential:
      admin.credential.cert(
        serviceAccount
      ),

    databaseURL:
      "https://giochi-societa-e8add-default-rtdb.europe-west1.firebasedatabase.app"
  });

  db =
    admin.database();

  console.log(
    "Firebase Admin inizializzato correttamente."
  );
} catch (
  erroreFirebase
) {
  console.error(
    "ATTENZIONE: Firebase Admin NON inizializzato:",
    erroreFirebase.message
  );
}

/* =========================================================
   FIREBASE PARTITE
   ========================================================= */

function preparaGiocatoriPerFirebase(
  giocatori
) {
  const risultato =
    {};

  for (
    const uid in
    giocatori || {}
  ) {
    const g =
      giocatori[
        uid
      ];

    risultato[
      uid
    ] = {
      nome:
        g.nome,

      avatar:
        g.avatar ||
        null,

      posizione:
        Number(
          g.posizione ||
          0
        ),

      turniSaltati:
        Number(
          g.turniSaltati ||
          0
        ),

      tentativiAutomaticiConsecutivi:
        Number(
          g.tentativiAutomaticiConsecutivi ||
          0
        )
    };
  }

  return risultato;
}

async function salvaPartita(
  partita
) {
  if (
    !db ||
    !partita
  ) {
    return;
  }

  await db
    .ref(
      "partite/" +
      partita.id
    )
    .set({
      id:
        partita.id,

      stanza:
        partita.stanza,

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

      classificata:
        partita.classificata !==
        false,

      maxGiocatori:
        partita.maxGiocatori,

      chatAttiva:
        partita.chatAttiva !==
        false,

      fase:
        partita.fase ||
        "attesa_giocatori",

      giocatori:
        preparaGiocatoriPerFirebase(
          partita.giocatori
        ),

      ordineGiocatori:
        partita.ordineGiocatori ||
        [],

      partecipantiOriginali:
        partita.partecipantiOriginali ||
        [],

      abbandonati:
        partita.abbandonati ||
        {},

      turnoAttuale:
        Number(
          partita.turnoAttuale ||
          0
        ),

      iniziata:
        partita.iniziata ===
        true,

      iniziataIl:
        partita.iniziataIl ||
        null,

      statoTurno:
        partita.statoTurno ||
        "attesa",

      tiriEffettuatiNelTurno:
        Number(
          partita.tiriEffettuatiNelTurno ||
          0
        ),

      tiriConsentitiNelTurno:
        Number(
          partita.tiriConsentitiNelTurno ||
          1
        ),

      tempoInizioTurno:
        partita.tempoInizioTurno ||
        null,

      scadenzaTurno:
        partita.scadenzaTurno ||
        null,

      punteggiOrdineIniziale:
        partita.punteggiOrdineIniziale ||
        null,

      conclusioneEseguita:
        partita.conclusioneEseguita ===
        true,

      aggiornataIl:
        Date.now()
    });
}

async function caricaPartite() {
  if (!db) {
    return {};
  }

  const snap =
    await db
      .ref(
        "partite"
      )
      .once(
        "value"
      );

  return (
    snap.val() ||
    {}
  );
}

async function aggiornaStatoPartita(
  partitaId,
  dati
) {
  if (
    !db ||
    !partitaId
  ) {
    return;
  }

  await db
    .ref(
      "partite/" +
      partitaId
    )
    .update({
      ...dati,

      aggiornataIl:
        Date.now()
    });
}

async function rimuoviPartita(
  nomeStanza,
  partitaId
) {
  if (
    stanze[nomeStanza]
  ) {
    const partita =
      stanze[
        nomeStanza
      ].partite[
        partitaId
      ];

    if (
      partita
    ) {
      fermaTimerTurno(
        partita
      );

      delete stanze[
        nomeStanza
      ].partite[
        partitaId
      ];
    }
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
    } catch (
      errore
    ) {
      console.error(
        "Errore rimozione partita da Firebase:",
        errore.message
      );
    }
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
      expiresIn:
        "30d"
    }
  );
}

function verificaToken(
  token
) {
  if (
    !token
  ) {
    return null;
  }

  try {
    return jwt.verify(
      token,
      JWT_SECRET
    );
  } catch {
    return null;
  }
}

function estraiTokenHeader(
  req
) {
  if (
    req.cookies &&
    req.cookies.token
  ) {
    return req.cookies.token;
  }

  const header =
    req.headers.authorization ||
    "";

  const parti =
    header.split(" ");

  if (
    parti.length ===
      2 &&
    /^Bearer$/i.test(
      parti[0]
    )
  ) {
    return parti[1];
  }

  return null;
}

function estraiTokenDaCookieHeader(
  cookieHeaderGrezzo
) {
  if (
    !cookieHeaderGrezzo
  ) {
    return null;
  }

  const parti =
    cookieHeaderGrezzo
      .split(";")
      .map(
        p =>
          p.trim()
      );

  for (
    const parte of
      parti
  ) {
    const idx =
      parte.indexOf(
        "="
      );

    if (
      idx ===
      -1
    ) {
      continue;
    }

    if (
      parte.substring(
        0,
        idx
      ) ===
      "token"
    ) {
      return decodeURIComponent(
        parte.substring(
          idx + 1
        )
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
      estraiTokenHeader(
        req
      )
    );

  if (!dati) {
    return res.status(
      401
    ).json({
      errore:
        "Devi effettuare il login."
    });
  }

  req.utente =
    dati;

  next();
}

async function richiediAdmin(
  req,
  res,
  next
) {
  const dati =
    verificaToken(
      estraiTokenHeader(
        req
      )
    );

  if (!dati) {
    return res.status(
      401
    ).json({
      errore:
        "Devi effettuare il login."
    });
  }

  if (
    dati.ruolo !==
    "admin"
  ) {
    return res.status(
      403
    ).json({
      errore:
        "Accesso riservato agli amministratori."
    });
  }

  req.utenteAdmin =
    dati;

  next();
}

/* =========================================================
   UTENTI
   ========================================================= */

async function trovaUtentePerEmail(
  emailLower
) {
  const snap =
    await db
      .ref("utenti")
      .orderByChild(
        "emailLower"
      )
      .equalTo(
        emailLower
      )
      .once(
        "value"
      );

  if (
    !snap.exists()
  ) {
    return null;
  }

  const val =
    snap.val();

  const uid =
    Object.keys(
      val
    )[0];

  return {
    uid,
    ...val[
      uid
    ]
  };
}

async function trovaUtentePerGoogleId(
  googleId
) {
  if (
    !db ||
    !googleId
  ) {
    return null;
  }

  const snap =
    await db
      .ref(
        "utenti"
      )
      .orderByChild(
        "googleId"
      )
      .equalTo(
        googleId
      )
      .once(
        "value"
      );

  if (
    !snap.exists()
  ) {
    return null;
  }

  const val =
    snap.val();

  const uid =
    Object.keys(
      val
    )[0];

  return {
    uid,
    ...val[
      uid
    ]
  };
}

async function trovaUtentePerNickname(
  nicknameLower
) {
  const snap =
    await db
      .ref(
        "utenti"
      )
      .orderByChild(
        "nicknameLower"
      )
      .equalTo(
        nicknameLower
      )
      .once(
        "value"
      );

  if (
    !snap.exists()
  ) {
    return null;
  }

  const val =
    snap.val();

  const uid =
    Object.keys(
      val
    )[0];

  return {
    uid,
    ...val[
      uid
    ]
  };
}

/* =========================================================
   AMICIZIA
   ========================================================= */

async function statoAmicizia(
  mioUid,
  altroUid
) {
  if (
    mioUid ===
    altroUid
  ) {
    return "se_stesso";
  }

  const [
    snapAmici,
    snapInviata,
    snapRicevuta
  ] =
    await Promise.all([
      db
        .ref(
          `utenti/${mioUid}/amici/${altroUid}`
        )
        .once(
          "value"
        ),

      db
        .ref(
          `utenti/${mioUid}/richiesteInviate/${altroUid}`
        )
        .once(
          "value"
        ),

      db
        .ref(
          `utenti/${mioUid}/richiesteRicevute/${altroUid}`
        )
        .once(
          "value"
        )
    ]);

  if (
    snapAmici.exists()
  ) {
    return "amici";
  }

  if (
    snapInviata.exists()
  ) {
    return "richiesta_inviata";
  }

  if (
    snapRicevuta.exists()
  ) {
    return "richiesta_ricevuta";
  }

  return "nessuno";
}

async function verificaAmicizia(
  uidA,
  uidB
) {
  if (
    !db ||
    !uidA ||
    !uidB
  ) {
    return false;
  }

  if (
    uidA ===
    uidB
  ) {
    return true;
  }

  const snap =
    await db
      .ref(
        `utenti/${uidA}/amici/${uidB}`
      )
      .once(
        "value"
      );

  return (
    snap.exists() &&
    snap.val() ===
      true
  );
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
      nome ||
        "",
      15
    )
      .replace(
        /[^a-zA-Z0-9_ ]/g,
        ""
      )
      .trim();

  if (!base) {
    base =
      "Google";
  }

  if (
    base.length <
    5
  ) {
    const parteEmail =
      String(
        email ||
        ""
      )
        .split(
          "@"
        )[0]
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

  if (
    base.length <
    5
  ) {
    base =
      "GoogleUser";
  }

  return base.substring(
    0,
    15
  );
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
    !(
      await trovaUtentePerNickname(
        base.toLowerCase()
      )
    )
  ) {
    return base;
  }

  for (
    let i = 1;
    i <= 999;
    i++
  ) {
    const suffisso =
      String(
        i
      );

    const massimoBase =
      15 -
      suffisso.length;

    const candidato =
      base.substring(
        0,
        massimoBase
      ) +
      suffisso;

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
      .slice(
        -8
      )
  );
}

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET;

const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL;

if (
  !GOOGLE_CLIENT_ID
) {
  console.warn(
    "GOOGLE_CLIENT_ID non configurato su Render."
  );
}

if (
  !GOOGLE_CLIENT_SECRET
) {
  console.warn(
    "GOOGLE_CLIENT_SECRET non configurato su Render."
  );
}

if (
  !GOOGLE_CALLBACK_URL
) {
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
            profile
              .emails?.[0]
              ?.value
              ?.trim()
              .toLowerCase();

          const emailVerificata =
            profile
              .emails?.[0]
              ?.verified;

          if (
            !googleId
          ) {
            return done(
              new Error(
                "Google non ha restituito un ID valido."
              )
            );
          }

          if (
            !email
          ) {
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

          if (
            !utente
          ) {
            utente =
              await trovaUtentePerEmail(
                email
              );
          }

          if (
            utente
          ) {
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

            await migraUtenteElo(
              utente.uid,
              utente
            );

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
            db.ref(
              "utenti"
            ).push();

          const uid =
            nuovoRef.key;

          await nuovoRef.set({
            email:
              email,

            emailLower:
              email,

            nickname:
              nickname,

            nicknameLower:
              nickname.toLowerCase(),

            passwordHash:
              null,

            googleId:
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

            avvisi:
              [],

            notifiche:
              {},

            partiteVinte:
              0,

            partiteGiocate:
              0,

            ratingElo:
              ELO_INIZIALE,

            eloMassimo:
              ELO_INIZIALE,

            partiteClassificate:
              0,

            vittorieClassificate:
              0,

            sconfitteClassificate:
              0,

            pareggiClassificati:
              0,

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
        } catch (
          errore
        ) {
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
      session:
        false,

      failureRedirect:
        "https://solfriniluca1.wixstudio.com/accedi?errore=google"
    }
  ),

  async (
    req,
    res
  ) => {
    try {
      const utente =
        req.user;

      if (
        !utente ||
        !utente.uid
      ) {
        return res.redirect(
          "https://solfriniluca1.wixstudio.com/accedi?errore=google"
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

      return res.redirect(
        "https://solfriniluca1.wixstudio.com/giochisocieta"
      );
    } catch (
      errore
    ) {
      console.error(
        "Errore callback Google:",
        errore
      );

      return res.redirect(
        "https://solfriniluca1.wixstudio.com/accedi?errore=google"
      );
    }
  }
);

/* =========================================================
   REGISTRAZIONE
   ========================================================= */

app.post(
  "/api/registrati",
  limiteRegistrazione,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio account non disponibile al momento."
      });
    }

    try {
      const {
        email,
        nickname,
        password
      } =
        req.body;

      if (
        !email ||
        !nickname ||
        !password
      ) {
        return res.status(
          400
        ).json({
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
        return res.status(
          400
        ).json({
          errore:
            "Il nickname deve contenere da 5 a 15 caratteri."
        });
      }

      if (
        !/^[a-zA-Z0-9_ ]+$/.test(
          nicknamePulito
        )
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Il nickname contiene caratteri non consentiti."
        });
      }

      if (
        password.length <
          8 ||
        password.length >
          100
      ) {
        return res.status(
          400
        ).json({
          errore:
            "La password deve avere tra 8 e 100 caratteri."
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
        return res.status(
          400
        ).json({
          errore:
            "Inserisci un indirizzo email valido."
        });
      }

      if (
        await trovaUtentePerEmail(
          emailPulita
        )
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Questa email è già registrata."
        });
      }

      const nicknameLower =
        nicknamePulito.toLowerCase();

      if (
        await trovaUtentePerNickname(
          nicknameLower
        )
      ) {
        return res.status(
          400
        ).json({
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
        db.ref(
          "utenti"
        ).push();

      const uid =
        nuovoRef.key;

      await nuovoRef.set({
        email:
          emailPulita,

        emailLower:
          emailPulita,

        nickname:
          nicknamePulito,

        nicknameLower:
          nicknameLower,

        passwordHash:
          passwordHash,

        googleId:
          null,

        providerGoogle:
          false,

        avatar:
          null,

        ruolo:
          "utente",

        stato:
          "attivo",

        sospesoFino:
          null,

        avvisi:
          [],

        notifiche:
          {},

        partiteVinte:
          0,

        partiteGiocate:
          0,

        ratingElo:
          ELO_INIZIALE,

        eloMassimo:
          ELO_INIZIALE,

        partiteClassificate:
          0,

        vittorieClassificate:
          0,

        sconfitteClassificate:
          0,

        pareggiClassificati:
          0,

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
          "utente",

        ratingElo:
          ELO_INIZIALE
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore registrazione:",
        errore
      );

      return res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

/* =========================================================
   LOGIN
   ========================================================= */

app.post(
  "/api/login",
  limiteLogin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio account non disponibile al momento."
      });
    }

    try {
      const {
        email,
        password
      } =
        req.body;

      if (
        !email ||
        !password
      ) {
        return res.status(
          400
        ).json({
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

      if (
        !utente
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Email o password errati."
        });
      }

      if (
        !utente.passwordHash
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Questo account è stato creato con Google. Usa 'Accedi con Google'."
        });
      }

      const passwordCorretta =
        await bcrypt.compare(
          password,
          utente.passwordHash
        );

      if (
        !passwordCorretta
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Email o password errati."
        });
      }

      if (
        utente.stato ===
        "bannato"
      ) {
        return res.status(
          403
        ).json({
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
          return res.status(
            403
          ).json({
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

        utente.stato =
          "attivo";
      }

      await migraUtenteElo(
        utente.uid,
        utente
      );

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
          "utente",

        ratingElo:
          Number(
            utente.ratingElo ||
            ELO_INIZIALE
          )
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore login:",
        errore
      );

      return res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

/* =========================================================
   LOGOUT
   ========================================================= */

app.post(
  "/api/logout",
  (
    req,
    res
  ) => {
    res.clearCookie(
      "token",
      OPZIONI_COOKIE
    );

    res.json({
      ok:
        true
    });
  }
);

/* =========================================================
   ME
   ========================================================= */

app.get(
  "/api/me",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
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
            .once(
              "value"
            )
        ).val();

      if (
        !utente
      ) {
        return res.status(
          404
        ).json({
          errore:
            "Utente non trovato."
        });
      }

      await migraUtenteElo(
        req.utente.uid,
        utente
      );

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

      const partiteClassificate =
        Number(
          utente.partiteClassificate ||
          0
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
          vinte,

        partiteGiocate:
          giocate,

        winRate:
          giocate > 0
            ? Math.round(
                (
                  vinte /
                  giocate
                ) *
                100
              )
            : 0,

        creatoIl:
          utente.creatoIl ||
          null,

        ultimoAccesso:
          utente.ultimoAccesso ||
          null,

        ratingElo:
          Number(
            utente.ratingElo ||
            ELO_INIZIALE
          ),

        eloMassimo:
          Number(
            utente.eloMassimo ||
            ELO_INIZIALE
          ),

        partiteClassificate:
          partiteClassificate,

        vittorieClassificate:
          Number(
            utente.vittorieClassificate ||
            0
          ),

        sconfitteClassificate:
          Number(
            utente.sconfitteClassificate ||
            0
          ),

        pareggiClassificati:
          Number(
            utente.pareggiClassificati ||
            0
          ),

        ratingProvvisorio:
          partiteClassificate <
          PARTITE_PROVVISORIE_ELO
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore /api/me:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* =========================================================
   MODIFICA NICKNAME
   ========================================================= */

app.post(
  "/api/modifica-nickname",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        nickname
      } =
        req.body;

      if (
        !nickname ||
        !String(
          nickname
        ).trim()
      ) {
        return res.status(
          400
        ).json({
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
        return res.status(
          400
        ).json({
          errore:
            "Il nickname deve contenere da 5 a 15 caratteri."
        });
      }

      if (
        !/^[a-zA-Z0-9_ ]+$/.test(
          nuovoNickname
        )
      ) {
        return res.status(
          400
        ).json({
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
        return res.status(
          400
        ).json({
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

      const nuovoToken =
        creaToken(
          req.utente.uid,
          nuovoNickname,
          req.utente.ruolo
        );

      res.cookie(
        "token",
        nuovoToken,
        OPZIONI_COOKIE
      );

      res.json({
        nickname:
          nuovoNickname
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore modifica nickname:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

/* =========================================================
   AVATAR
   ========================================================= */

app.post(
  "/api/carica-avatar",
  richiediAuth,
  uploadAvatar.single(
    "avatar"
  ),
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      if (
        !req.file
      ) {
        return res.status(
          400
        ).json({
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

      res.json({
        avatar:
          dataUri
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore caricamento avatar:",
        errore
      );

      res.status(
        400
      ).json({
        errore:
          errore.message ||
          "Errore durante il caricamento."
      });
    }
  }
);

/* =========================================================
   CLASSIFICA ELO
   ========================================================= */

app.get(
  "/api/top-giocatori",
  async (
    req,
    res
  ) => {
    try {
      if (!db) {
        return res.json({
          giocatori:
            []
        });
      }

      const utenti =
        (
          await db
            .ref(
              "utenti"
            )
            .once(
              "value"
            )
        ).val() ||
        {};

      const top =
        Object.entries(
          utenti
        )
          .map(
            ([
              uid,
              u
            ]) => ({
              uid,

              nickname:
                u.nickname ||
                "Sconosciuto",

              ratingElo:
                Number(
                  u.ratingElo ||
                  ELO_INIZIALE
                ),

              eloMassimo:
                Number(
                  u.eloMassimo ||
                  ELO_INIZIALE
                ),

              partiteClassificate:
                Number(
                  u.partiteClassificate ||
                  0
                ),

              vittorieClassificate:
                Number(
                  u.vittorieClassificate ||
                  0
                ),

              sconfitteClassificate:
                Number(
                  u.sconfitteClassificate ||
                  0
                ),

              pareggiClassificati:
                Number(
                  u.pareggiClassificati ||
                  0
                )
            })
          )
          .filter(
            g =>
              g.partiteClassificate >
              0
          )
          .sort(
            (
              a,
              b
            ) => {
              if (
                b.ratingElo !==
                a.ratingElo
              ) {
                return (
                  b.ratingElo -
                  a.ratingElo
                );
              }

              if (
                b.partiteClassificate !==
                a.partiteClassificate
              ) {
                return (
                  b.partiteClassificate -
                  a.partiteClassificate
                );
              }

              return a.nickname.localeCompare(
                b.nickname,
                "it"
              );
            }
          )
          .slice(
            0,
            100
          );

      res.json({
        giocatori:
          top
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore classifica ELO:",
        errore
      );

      res.status(
        500
      ).json({
        giocatori:
          []
      });
    }
  }
);

/* =========================================================
   STORICO ELO
   ========================================================= */

app.get(
  "/api/storico-elo",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const limite =
        Math.min(
          100,
          Math.max(
            1,
            parseInt(
              req.query.limite,
              10
            ) ||
            30
          )
        );

      const snap =
        await db
          .ref(
            "storicoElo/" +
            req.utente.uid
          )
          .orderByChild(
            "data"
          )
          .limitToLast(
            limite
          )
          .once(
            "value"
          );

      const dati =
        snap.val() ||
        {};

      const storico =
        Object.entries(
          dati
        )
          .map(
            ([
              id,
              valore
            ]) => ({
              id,
              ...valore
            })
          )
          .sort(
            (
              a,
              b
            ) =>
              Number(
                b.data ||
                0
              ) -
              Number(
                a.data ||
                0
              )
          );

      res.json({
        storico
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore storico ELO:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
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
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile al momento."
      });
    }

    try {
      const {
        categoria,
        messaggio
      } =
        req.body;

      let {
        nickname,
        email
      } =
        req.body;

      if (
        !messaggio ||
        !String(
          messaggio
        ).trim()
      ) {
        return res.status(
          400
        ).json({
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
          estraiTokenHeader(
            req
          )
        );

      let uidMittente =
        null;

      if (
        datiToken
      ) {
        uidMittente =
          datiToken.uid;

        const utenteDb =
          (
            await db
              .ref(
                "utenti/" +
                datiToken.uid
              )
              .once(
                "value"
              )
          ).val();

        if (
          utenteDb
        ) {
          nickname =
            utenteDb.nickname;

          email =
            utenteDb.email;
        }
      }

      if (
        !nickname ||
        !String(
          nickname
        ).trim() ||
        !email ||
        !String(
          email
        ).trim()
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Nickname ed email sono obbligatori."
        });
      }

      await db
        .ref(
          "contatti"
        )
        .push()
        .set({
          nickname:
            nickname.trim(),

          email:
            email.trim(),

          categoria:
            pulisciTesto(
              categoria ||
              "Altro",
              40
            ),

          messaggio:
            messaggioPulito,

          uidMittente,

          letto:
            false,

          data:
            Date.now()
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore contatti:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore durante l'invio, riprova."
      });
    }
  }
);

/* =========================================================
   PROFILO PUBBLICO
   ========================================================= */

app.get(
  "/api/profilo-pubblico/:nickname",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
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

      if (
        !utente
      ) {
        return res.status(
          404
        ).json({
          errore:
            "Utente non trovato."
        });
      }

      await migraUtenteElo(
        utente.uid,
        utente
      );

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

      const partiteClassificate =
        Number(
          utente.partiteClassificate ||
          0
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
                (
                  vinte /
                  giocate
                ) *
                100
              )
            : 0,

        ratingElo:
          Number(
            utente.ratingElo ||
            ELO_INIZIALE
          ),

        eloMassimo:
          Number(
            utente.eloMassimo ||
            ELO_INIZIALE
          ),

        partiteClassificate:
          partiteClassificate,

        vittorieClassificate:
          Number(
            utente.vittorieClassificate ||
            0
          ),

        sconfitteClassificate:
          Number(
            utente.sconfitteClassificate ||
            0
          ),

        pareggiClassificati:
          Number(
            utente.pareggiClassificati ||
            0
          ),

        ratingProvvisorio:
          partiteClassificate <
          PARTITE_PROVVISORIE_ELO,

        statoAmicizia:
          await statoAmicizia(
            req.utente.uid,
            utente.uid
          )
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore profilo pubblico:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* =========================================================
   STORICO PARTITE
   ========================================================= */

app.get(
  "/api/storico",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      let uidFiltro =
        req.utente.uid;

      let nicknameFiltro =
        req.utente.nickname;

      if (
        req.query.nickname
      ) {
        const u =
          await trovaUtentePerNickname(
            pulisciTesto(
              req.query.nickname,
              20
            ).toLowerCase()
          );

        if (
          !u
        ) {
          return res.status(
            404
          ).json({
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
            .orderByChild(
              "data"
            )
            .limitToLast(
              300
            )
            .once(
              "value"
            )
        ).val() ||
        {};

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
            (
              a,
              b
            ) =>
              Number(
                b.data ||
                0
              ) -
              Number(
                a.data ||
                0
              )
          )
          .slice(
            0,
            50
          );

      res.json({
        uid:
          uidFiltro,

        nickname:
          nicknameFiltro,

        partite
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore storico partite:",
        errore
      );

      res.status(
        500
      ).json({
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
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const mioUid =
        req.utente.uid;

      const altroUid =
        req.params.altroUid;

      if (
        !altroUid ||
        altroUid ===
        mioUid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Conversazione non valida."
        });
      }

      const destinatarioEsiste =
        await db
          .ref(
            "utenti/" +
            altroUid
          )
          .once(
            "value"
          );

      if (
        !destinatarioEsiste.exists()
      ) {
        return res.status(
          404
        ).json({
          errore:
            "Utente non trovato."
        });
      }

      const idConv =
        idConversazione(
          mioUid,
          altroUid
        );

      const messaggi =
        (
          await db
            .ref(
              "messaggiPrivati/" +
              idConv
            )
            .once(
              "value"
            )
        ).val() ||
        {};

      const lista =
        Object.entries(
          messaggi
        )
          .map(
            ([
              id,
              m
            ]) => ({
              id,
              ...m
            })
          )
          .sort(
            (
              a,
              b
            ) =>
              Number(
                a.data ||
                0
              ) -
              Number(
                b.data ||
                0
              )
          );

      const amici =
        await verificaAmicizia(
          mioUid,
          altroUid
        );

      if (
        !amici
      ) {
        const esisteMessaggioDaAltro =
          lista.some(
            m =>
              m.daUid ===
                altroUid &&
              m.aUid ===
                mioUid
          );

        if (
          esisteMessaggioDaAltro
        ) {
          return res.json({
            messaggi:
              [],

            bloccata:
              true,

            richiestaAmicizia:
              true,

            altroUid,

            messaggio:
              "Questa persona ti ha inviato un messaggio. Per leggerlo devi prima diventare suo amico."
          });
        }
      }

      const aggiornamenti =
        {};

      Object.entries(
        messaggi
      ).forEach(
        ([
          id,
          m
        ]) => {
          if (
            m.aUid ===
              mioUid &&
            !m.letto
          ) {
            aggiornamenti[
              id +
              "/letto"
            ] =
              true;
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
        messaggi:
          lista,

        bloccata:
          false,

        richiestaAmicizia:
          false,

        altroUid
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore caricamento messaggi privati:",
        errore
      );

      res.status(
        500
      ).json({
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
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        destinatarioUid,
        testo
      } =
        req.body;

      if (
        !destinatarioUid ||
        !testo ||
        !String(
          testo
        ).trim()
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        destinatarioUid ===
        req.utente.uid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Non puoi scrivere a te stesso."
        });
      }

      const testoPulito =
        pulisciTesto(
          testo,
          500
        );

      if (
        !testoPulito
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Messaggio vuoto."
        });
      }

      const [
        mittenteSnap,
        destinatarioSnap
      ] =
        await Promise.all([
          db
            .ref(
              "utenti/" +
              req.utente.uid
            )
            .once(
              "value"
            ),

          db
            .ref(
              "utenti/" +
              destinatarioUid
            )
            .once(
              "value"
            )
        ]);

      const mittente =
        mittenteSnap.val();

      const destinatario =
        destinatarioSnap.val();

      if (
        !mittente ||
        !destinatario
      ) {
        return res.status(
          404
        ).json({
          errore:
            "Utente non trovato."
        });
      }

      const sonoAmici =
        await verificaAmicizia(
          req.utente.uid,
          destinatarioUid
        );

      const idConv =
        idConversazione(
          req.utente.uid,
          destinatarioUid
        );

      const ora =
        Date.now();

      const nuovoRef =
        db
          .ref(
            "messaggiPrivati/" +
            idConv
          )
          .push();

      const messaggio =
        {
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
            ora,

          letto:
            false,

          richiestaAmicizia:
            !sonoAmici
        };

      await nuovoRef.set(
        messaggio
      );

      if (
        !sonoAmici
      ) {
        await db
          .ref(
            "utenti/" +
            destinatarioUid +
            "/notifiche"
          )
          .push({
            tipo:
              "messaggioPrivato",

            testo:
              `${mittente.nickname} ti ha inviato un messaggio. Diventate amici per leggerlo.`,

            data:
              ora,

            letta:
              false,

            daUid:
              req.utente.uid,

            daNome:
              mittente.nickname,

            conversazioneUid:
              req.utente.uid
          });
      }

      res.json({
        ok:
          true,

        messaggio: {
          id:
            nuovoRef.key,

          ...messaggio
        },

        richiestaAmicizia:
          !sonoAmici
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore invio messaggio privato:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore durante l'invio, riprova."
      });
    }
  }
);

app.get(
  "/api/conversazioni",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
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
        ).val() ||
        {};

      const mioUid =
        req.utente.uid;

      const conversazioni =
        {};

      for (
        const [
          idConv,
          messaggi
        ] of Object.entries(
          tutte
        )
      ) {
        if (
          !idConv
            .split(
              "_"
            )
            .includes(
              mioUid
            )
        ) {
          continue;
        }

        const lista =
          Object.values(
            messaggi ||
            {}
          );

        if (
          !lista.length
        ) {
          continue;
        }

        lista.sort(
          (
            a,
            b
          ) =>
            Number(
              b.data ||
              0
            ) -
            Number(
              a.data ||
              0
            )
        );

        const ultimo =
          lista[0];

        const altroUid =
          ultimo.daUid ===
          mioUid
            ? ultimo.aUid
            : ultimo.daUid;

        const altroNome =
          ultimo.daUid ===
          mioUid
            ? ultimo.aNome
            : ultimo.daNome;

        const amici =
          await verificaAmicizia(
            mioUid,
            altroUid
          );

        const haMessaggiRicevuti =
          lista.some(
            m =>
              m.aUid ===
              mioUid
          );

        const bloccata =
          !amici &&
          haMessaggiRicevuti;

        const ultimoTesto =
          bloccata
            ? "Ti ha inviato un messaggio"
            : (
                ultimo.testo ||
                ""
              );

        const nonLetti =
          lista.filter(
            m =>
              m.aUid ===
                mioUid &&
              !m.letto
          ).length;

        conversazioni[
          altroUid
        ] = {
          altroUid,

          altroNome,

          ultimoTesto,

          ultimaData:
            ultimo.data,

          nonLetti,

          bloccata,

          richiestaAmicizia:
            bloccata
        };
      }

      res.json({
        conversazioni:
          Object.values(
            conversazioni
          ).sort(
            (
              a,
              b
            ) =>
              Number(
                b.ultimaData ||
                0
              ) -
              Number(
                a.ultimaData ||
                0
              )
          )
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore caricamento conversazioni:",
        errore
      );

      res.status(
        500
      ).json({
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
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        destinatarioUid
      } =
        req.body;

      if (
        !destinatarioUid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        destinatarioUid ===
        req.utente.uid
      ) {
        return res.status(
          400
        ).json({
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
            .once(
              "value"
            )
        ).val();

      if (
        !destinatario
      ) {
        return res.status(
          404
        ).json({
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
        return res.status(
          400
        ).json({
          errore:
            "Siete già amici."
        });
      }

      if (
        stato ===
        "richiesta_inviata"
      ) {
        return res.json({
          ok:
            true
        });
      }

      if (
        stato ===
        "richiesta_ricevuta"
      ) {
        return res.status(
          400
        ).json({
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

          letta:
            false,

          daUid:
            req.utente.uid,

          daNome:
            mioNickname
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore richiesta amicizia:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

app.post(
  "/api/amici/accetta-messaggio",
  limiteAmici,
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        altroUid
      } =
        req.body;

      if (
        !altroUid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Dati mancanti."
        });
      }

      const mioUid =
        req.utente.uid;

      if (
        altroUid ===
        mioUid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Operazione non valida."
        });
      }

      const [
        mioSnap,
        altroSnap
      ] =
        await Promise.all([
          db
            .ref(
              "utenti/" +
              mioUid
            )
            .once(
              "value"
            ),

          db
            .ref(
              "utenti/" +
              altroUid
            )
            .once(
              "value"
            )
        ]);

      const mioUtente =
        mioSnap.val();

      const altroUtente =
        altroSnap.val();

      if (
        !mioUtente ||
        !altroUtente
      ) {
        return res.status(
          404
        ).json({
          errore:
            "Utente non trovato."
        });
      }

      const idConv =
        idConversazione(
          mioUid,
          altroUid
        );

      const messaggi =
        (
          await db
            .ref(
              "messaggiPrivati/" +
              idConv
            )
            .once(
              "value"
            )
        ).val() ||
        {};

      const esisteMessaggioRicevuto =
        Object.values(
          messaggi
        ).some(
          m =>
            m &&
            m.daUid ===
            altroUid &&
            m.aUid ===
            mioUid
        );

      if (
        !esisteMessaggioRicevuto
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Non esiste nessun messaggio da questo utente."
        });
      }

      const giaAmici =
        await verificaAmicizia(
          mioUid,
          altroUid
        );

      if (
        !giaAmici
      ) {
        const ora =
          Date.now();

        await db
          .ref()
          .update({
            [`utenti/${mioUid}/richiesteRicevute/${altroUid}`]:
              null,

            [`utenti/${mioUid}/richiesteInviate/${altroUid}`]:
              null,

            [`utenti/${altroUid}/richiesteRicevute/${mioUid}`]:
              null,

            [`utenti/${altroUid}/richiesteInviate/${mioUid}`]:
              null,

            [`utenti/${mioUid}/amici/${altroUid}`]:
              true,

            [`utenti/${altroUid}/amici/${mioUid}`]:
              true
          });

        await db
          .ref(
            "utenti/" +
            altroUid +
            "/notifiche"
          )
          .push({
            tipo:
              "amiciziaAccettata",

            testo:
              `${mioUtente.nickname} è ora tuo amico`,

            data:
              ora,

            letta:
              false,

            daUid:
              mioUid,

            daNome:
              mioUtente.nickname
          });
      }

      res.json({
        ok:
          true,

        amici:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore accettazione amicizia da messaggio:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore durante l'accettazione."
      });
    }
  }
);

app.post(
  "/api/amici/accetta",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        daUid
      } =
        req.body;

      if (
        !daUid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Dati mancanti."
        });
      }

      const richiesta =
        await db
          .ref(
            `utenti/${req.utente.uid}/richiesteRicevute/${daUid}`
          )
          .once(
            "value"
          );

      if (
        !richiesta.exists()
      ) {
        return res.status(
          400
        ).json({
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

          letta:
            false
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore accettazione amicizia:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

app.post(
  "/api/amici/rifiuta",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        daUid
      } =
        req.body;

      if (
        !daUid
      ) {
        return res.status(
          400
        ).json({
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
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore rifiuto richiesta:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

app.post(
  "/api/amici/rimuovi",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const {
        altroUid
      } =
        req.body;

      if (
        !altroUid
      ) {
        return res.status(
          400
        ).json({
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
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore rimozione amicizia:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server, riprova."
      });
    }
  }
);

app.get(
  "/api/amici",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
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
              .once(
                "value"
              )
          ).val() ||
          {}
        );

      const amici =
        await Promise.all(
          uids.map(
            async (
              uidAmico
            ) => {
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

              if (
                !u
              ) {
                return null;
              }

              await migraUtenteElo(
                uidAmico,
                u
              );

              return {
                uid:
                  uidAmico,

                nickname:
                  u.nickname,

                avatar:
                  u.avatar ||
                  null,

                ratingElo:
                  Number(
                    u.ratingElo ||
                    ELO_INIZIALE
                  )
              };
            }
          )
        );

      res.json({
        amici:
          amici.filter(
            Boolean
          )
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore caricamento amici:",
        errore
      );

      res.status(
        500
      ).json({
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
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
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
              .once(
                "value"
              )
          ).val() ||
          {}
        )
          .map(
            ([
              id,
              n
            ]) => ({
              id,
              ...n
            })
          )
          .sort(
            (
              a,
              b
            ) =>
              Number(
                b.data ||
                0
              ) -
              Number(
                a.data ||
                0
              )
          )
          .slice(
            0,
            30
          );

      res.json({
        notifiche:
          lista,

        nonLette:
          lista.filter(
            n =>
              !n.letta
          ).length
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore notifiche:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/notifiche/segna-lette",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const ref =
        db.ref(
          "utenti/" +
          req.utente.uid +
          "/notifiche"
        );

      const tutte =
        (
          await ref
            .once(
              "value"
            )
        ).val() ||
        {};

      const aggiornamenti =
        {};

      Object.keys(
        tutte
      ).forEach(
        id => {
          if (
            !tutte[
              id
            ].letta
          ) {
            aggiornamenti[
              id +
              "/letta"
            ] =
              true;
          }
        }
      );

      if (
        Object.keys(
          aggiornamenti
        ).length
      ) {
        await ref.update(
          aggiornamenti
        );
      }

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore notifiche lette:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* =========================================================
   AVVISI SITO
   ========================================================= */

app.get(
  "/api/avvisi",
  richiediAuth,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Servizio non disponibile."
      });
    }

    try {
      const dati =
        (
          await db
            .ref(
              "avvisiSito"
            )
            .once(
              "value"
            )
        ).val() ||
        {};

      const avvisi =
        Object.entries(
          dati
        )
          .map(
            ([
              id,
              avviso
            ]) => ({
              id,

              titolo:
                avviso.titolo ||
                "Avviso",

              messaggio:
                avviso.messaggio ||
                "",

              tipo:
                avviso.tipo ||
                "Informazione",

              data:
                avviso.data ||
                null,

              pubblicatoDa:
                avviso.pubblicatoDa ||
                "Staff"
            })
          )
          .sort(
            (
              a,
              b
            ) =>
              Number(
                b.data ||
                0
              ) -
              Number(
                a.data ||
                0
              )
          );

      res.json({
        avvisi
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore caricamento avvisi:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/avvisi",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const {
        titolo,
        messaggio,
        tipo
      } =
        req.body;

      const titoloPulito =
        pulisciTesto(
          titolo,
          120
        );

      const messaggioPulito =
        pulisciTesto(
          messaggio,
          2000
        );

      const tipoPulito =
        pulisciTesto(
          tipo ||
          "Informazione",
          40
        );

      if (
        !titoloPulito
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Inserisci un titolo."
        });
      }

      if (
        !messaggioPulito
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Inserisci il testo dell'avviso."
        });
      }

      const ora =
        Date.now();

      const nuovoRef =
        db
          .ref(
            "avvisiSito"
          )
          .push();

      const avviso =
        {
          titolo:
            titoloPulito,

          messaggio:
            messaggioPulito,

          tipo:
            tipoPulito,

          data:
            ora,

          pubblicatoDa:
            req.utenteAdmin
              .nickname ||
            "Amministratore"
        };

      await nuovoRef.set(
        avviso
      );

      const utentiSnap =
        await db
          .ref(
            "utenti"
          )
          .once(
            "value"
          );

      const utenti =
        utentiSnap.val() ||
        {};

      const aggiornamenti =
        {};

      for (
        const uid of
          Object.keys(
            utenti
          )
      ) {
        const key =
          db
            .ref()
            .push()
            .key;

        aggiornamenti[
          `utenti/${uid}/notifiche/${key}`
        ] = {
          tipo:
            "avvisoSito",

          titolo:
            titoloPulito,

          testo:
            messaggioPulito,

          categoria:
            tipoPulito,

          data:
            ora,

          letta:
            false,

          avvisoId:
            nuovoRef.key
        };
      }

      if (
        Object.keys(
          aggiornamenti
        ).length
      ) {
        await db
          .ref()
          .update(
            aggiornamenti
          );
      }

      res.json({
        ok:
          true,

        avviso: {
          id:
            nuovoRef.key,

          ...avviso
        }
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore pubblicazione avviso:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore durante la pubblicazione dell'avviso."
      });
    }
  }
);

app.delete(
  "/api/admin/avvisi/:id",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const id =
        String(
          req.params.id ||
          ""
        ).trim();

      if (
        !id
      ) {
        return res.status(
          400
        ).json({
          errore:
            "ID avviso non valido."
        });
      }

      const ref =
        db.ref(
          "avvisiSito/" +
          id
        );

      const snap =
        await ref.once(
          "value"
        );

      if (
        !snap.exists()
      ) {
        return res.status(
          404
        ).json({
          errore:
            "Avviso non trovato."
        });
      }

      await ref.remove();

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore eliminazione avviso:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore durante l'eliminazione."
      });
    }
  }
);

/* =========================================================
   ADMIN UTENTI
   ========================================================= */

app.get(
  "/api/admin/utenti",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const val =
        (
          await db
            .ref(
              "utenti"
            )
            .once(
              "value"
            )
        ).val() ||
        {};

      const utenti =
        Object.keys(
          val
        ).map(
          uid => ({
            uid,

            email:
              val[
                uid
              ].email,

            nickname:
              val[
                uid
              ].nickname,

            stato:
              val[
                uid
              ].stato,

            sospesoFino:
              val[
                uid
              ].sospesoFino ||
              null,

            avvisi:
              val[
                uid
              ].avvisi ||
              [],

            ruolo:
              val[
                uid
              ].ruolo ||
              "utente",

            ratingElo:
              Number(
                val[
                  uid
                ].ratingElo ||
                ELO_INIZIALE
              ),

            eloMassimo:
              Number(
                val[
                  uid
                ].eloMassimo ||
                ELO_INIZIALE
              ),

            partiteClassificate:
              Number(
                val[
                  uid
                ].partiteClassificate ||
                0
              )
          })
        );

      res.json({
        utenti
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore admin utenti:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/avviso",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const {
        uid,
        motivo
      } =
        req.body;

      if (
        !uid ||
        !motivo
      ) {
        return res.status(
          400
        ).json({
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
        (
          await ref
            .once(
              "value"
            )
        ).val() ||
        [];

      avvisiAttuali.push({
        data:
          Date.now(),

        motivo:
          pulisciTesto(
            motivo,
            500
          ),

        adminUid:
          req.utenteAdmin.uid
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

          letta:
            false
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore avviso admin:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/sospendi",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const {
        uid,
        giorni,
        motivo
      } =
        req.body;

      if (
        !uid ||
        !giorni
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        uid ===
        req.utenteAdmin.uid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Non puoi sospendere il tuo stesso account."
        });
      }

      const giorniNumero =
        Number(
          giorni
        );

      if (
        !Number.isInteger(
          giorniNumero
        ) ||
        giorniNumero <
          1 ||
        giorniNumero >
          3650
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Il numero di giorni non è valido."
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
            (
              giorniNumero *
              24 *
              60 *
              60 *
              1000
            ),

          motivoSospensione:
            pulisciTesto(
              motivo ||
              "",
              500
            ),

          ultimoAdminModeratore:
            req.utenteAdmin.uid,

          ultimoAggiornamentoModerazione:
            Date.now()
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore sospensione:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/rimuovi-sospensione",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const {
        uid
      } =
        req.body;

      if (
        !uid
      ) {
        return res.status(
          400
        ).json({
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
            null,

          ultimoAdminModeratore:
            req.utenteAdmin.uid,

          ultimoAggiornamentoModerazione:
            Date.now()
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore rimozione sospensione:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/banna",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const {
        uid,
        motivo
      } =
        req.body;

      if (
        !uid
      ) {
        return res.status(
          400
        ).json({
          errore:
            "Dati mancanti."
        });
      }

      if (
        uid ===
        req.utenteAdmin.uid
      ) {
        return res.status(
          400
        ).json({
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
              motivo ||
              "",
              500
            ),

          ultimoAdminModeratore:
            req.utenteAdmin.uid,

          ultimoAggiornamentoModerazione:
            Date.now()
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore ban:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

app.post(
  "/api/admin/riattiva",
  limiteAdmin,
  richiediAdmin,
  async (
    req,
    res
  ) => {
    if (!db) {
      return res.status(
        500
      ).json({
        errore:
          "Database non disponibile."
      });
    }

    try {
      const {
        uid
      } =
        req.body;

      if (
        !uid
      ) {
        return res.status(
          400
        ).json({
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
            null,

          ultimoAdminModeratore:
            req.utenteAdmin.uid,

          ultimoAggiornamentoModerazione:
            Date.now()
        });

      res.json({
        ok:
          true
      });
    } catch (
      errore
    ) {
      console.error(
        "Errore riattivazione:",
        errore
      );

      res.status(
        500
      ).json({
        errore:
          "Errore del server."
      });
    }
  }
);

/* =========================================================
   DADI RANDOM.ORG
   ========================================================= */

function tiraDadoRandomOrg() {
  return new Promise(
    resolve => {
      const url =
        "https://www.random.org/integers/?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";

      let conclusa =
        false;

      function completa(
        risultato
      ) {
        if (
          conclusa
        ) {
          return;
        }

        conclusa =
          true;

        resolve(
          risultato
        );
      }

      const richiesta =
        https.get(
          url,
          {
            timeout:
              1500
          },

          res => {
            let dati =
              "";

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
                      .split(
                        /\s+/
                      )
                      .map(
                        n =>
                          parseInt(
                            n,
                            10
                          )
                      )
                      .filter(
                        n =>
                          Number.isInteger(
                            n
                          ) &&
                          n >=
                            1 &&
                          n <=
                            6
                      );

                  completa(
                    numeri.length ===
                      2
                      ? {
                          dado1:
                            numeri[
                              0
                            ],

                          dado2:
                            numeri[
                              1
                            ]
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
          completa(
            null
          );
        }
      );

      richiesta.on(
        "error",
        () =>
          completa(
            null
          )
      );
    }
  );
}

async function lanciaDueDadiSicuri() {
  const risultato =
    await tiraDadoRandomOrg();

  if (
    risultato
  ) {
    return resultadoSeguro(
      risultato
    );
  }

  console.warn(
    "random.org non ha risposto: uso il ripiego locale per questo tiro."
  );

  return {
    dado1:
      Math.floor(
        Math.random() *
        6
      ) + 1,

    dado2:
      Math.floor(
        Math.random() *
        6
      ) + 1
  };
}

function resultadoSeguro(
  risultato
) {
  if (
    risultato &&
    Number.isInteger(
      risultato.dado1
    ) &&
    Number.isInteger(
      risultato.dado2
    )
  ) {
    return risultato;
  }

  return null;
}

/* =========================================================
   LOGICA GIOCO
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
  42:
    38,

  50:
    1,

  58:
    1
};

const CASELLA_TIRA_ANCORA =
  6;

const CASELLA_VITTORIA =
  63;

let stanze = {
  BAR: {
    giocatoriOnline:
      {},

    partite:
      {}
  },

  PUB: {
    giocatoriOnline:
      {},

    partite:
      {}
  },

  DISCOPUB: {
    giocatoriOnline:
      {},

    partite:
      {}
  },

  SERATE: {
    giocatoriOnline:
      {},

    partite:
      {}
  }
};

/* =========================================================
   CONNESSIONI
   ========================================================= */

let contatoreId =
  0;

const socketsPerId =
  {};

/* =========================================================
   HEARTBEAT
   ========================================================= */

const HEARTBEAT_MS =
  15000;

const DURATA_ANIMAZIONE_TIRO_MS =
  1200;

const TOLLERANZA_MOSSA_MS =
  2000;

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
          } catch {
            try {
              socket.terminate();
            } catch {}
          }
        }
      );
    },
    HEARTBEAT_MS
  );

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
    userAgent ||
    "";

  if (
    /iPad/i.test(
      ua
    ) ||
    (
      /Android/i.test(
        ua
      ) &&
      !/Mobile/i.test(
        ua
      )
    )
  ) {
    return "tablet";
  }

  if (
    /iPhone|iPod/i.test(
      ua
    ) ||
    (
      /Android/i.test(
        ua
      ) &&
      /Mobile/i.test(
        ua
      )
    )
  ) {
    return "cellulare";
  }

  return "computer";
}

/* =========================================================
   TROVA PARTITA
   ========================================================= */

function trovaPartita(
  partitaId
) {
  for (
    const nomeStanza in
      stanze
  ) {
    if (
      stanze[
        nomeStanza
      ].partite[
        partitaId
      ]
    ) {
      return {
        partita:
          stanze[
            nomeStanza
          ].partite[
            partitaId
          ],

        nomeStanza
      };
    }
  }

  return null;
}

function trovaPartitaAttivaPerUid(
  uid
) {
  for (
    const nomeStanza in
      stanze
  ) {
    for (
      const pid in
        stanze[
          nomeStanza
        ].partite
    ) {
      const p =
        stanze[
          nomeStanza
        ].partite[
          pid
        ];

      if (
        p.giocatori &&
        p.giocatori[
          uid
        ]
      ) {
        if (
          p.fase ===
            "attesa_giocatori" ||
          p.fase ===
            "determinazione_ordine" ||
          p.fase ===
            "in_corso"
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
  }

  return null;
}

/* =========================================================
   PRESENZA PARTITA
   ========================================================= */

function calcolaUidInPartita(
  nomeStanza
) {
  const uidInPartita =
    new Set();

  if (
    !stanze[
      nomeStanza
    ]
  ) {
    return uidInPartita;
  }

  Object.values(
    stanze[
      nomeStanza
    ].partite
  ).forEach(
    p => {
      if (
        p.fase ===
          "in_corso" ||
        p.fase ===
          "terminata"
      ) {
        Object.keys(
          p.giocatori ||
          {}
        ).forEach(
          uid =>
            uidInPartita.add(
              uid
            )
        );
      }
    }
  );

  return uidInPartita;
}

function costruisciStatoGiocatori(
  partita
) {
  return (
    partita.ordineGiocatori ||
    []
  )
    .map(
      id => {
        const g =
          partita.giocatori[
            id
          ];

        if (
          !g
        ) {
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
            Number(
              g.posizione ||
              0
            )
        };
      }
    )
    .filter(
      Boolean
    );
}

function inviaAllaStanza(
  nomeStanza,
  messaggio
) {
  if (
    !stanze[
      nomeStanza
    ]
  ) {
    return;
  }

  Object.keys(
    stanze[
      nomeStanza
    ].giocatoriOnline
  ).forEach(
    id => {
      const s =
        socketsPerId[
          id
        ];

      if (
        s &&
        s.readyState ===
          WebSocket.OPEN
      ) {
        try {
          s.send(
            JSON.stringify(
              messaggio
            )
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
    !stanze[
      nomeStanza
    ]
  ) {
    return;
  }

  const lista =
    Object.values(
      stanze[
        nomeStanza
      ].partite
    )
      .map(
        p => ({
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

          classificata:
            p.classificata !==
            false,

          maxGiocatori:
            p.maxGiocatori,

          numGiocatoriAttuali:
            Object.keys(
              p.giocatori ||
              {}
            ).length,

          chatAttiva:
            p.chatAttiva !==
            false,

          /* IMPORTANTE:
             il client può sapere se deve mostrare RIPRENDI */
          iniziata:
            p.iniziata !==
            false,

          giocatori:
            Object.entries(
              p.giocatori ||
              {}
            ).map(
              ([
                uid,
                g
              ]) => ({
                uid,

                nome:
                  g.nome,

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

function rimuoviVecchieConnessioniOnline(
  nomeStanza,
  uid,
  socketIdDaConservare
) {
  if (
    !stanze[
      nomeStanza
    ] ||
    !uid
  ) {
    return;
  }

  for (
    const [
      sid,
      giocatoreOnline
    ] of Object.entries(
      stanze[
        nomeStanza
      ].giocatoriOnline
    )
  ) {
    if (
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

function aggiornaSocketGiocatoreOnline(
  nomeStanza,
  uid,
  socket
) {
  if (
    !stanze[
      nomeStanza
    ] ||
    !uid ||
    !socket
  ) {
    return;
  }

  for (
    const sid in
      stanze[
        nomeStanza
      ].giocatoriOnline
  ) {
    const g =
      stanze[
        nomeStanza
      ].giocatoriOnline[
        sid
      ];

    if (
      g.uid ===
      uid
    ) {
      g.socket =
        socket;
    }
  }
}

function inviaConteggioStanze() {
  const conteggi =
    {};

  const giocatoriPerStanza =
    {};

  for (
    const nome in
      stanze
  ) {
    const valori =
      Object.values(
        stanze[
          nome
        ].giocatoriOnline
      );

    const uidInPartita =
      calcolaUidInPartita(
        nome
      );

    const vistiUid =
      new Map();

    valori.forEach(
      g =>
        vistiUid.set(
          g.uid,
          g
        )
    );

    const valoriUnici =
      Array.from(
        vistiUid.values()
      );

    conteggi[
      nome
    ] =
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
        try {
          client.send(
            messaggio
          );
        } catch {}
      }
    }
  );
}

/* =========================================================
   MOVIMENTO
   ========================================================= */

function calcolaMovimento(
  posizioneAttuale,
  valoreDado
) {
  let percorso =
    [];

  let nuovaPosizione =
    posizioneAttuale +
    valoreDado;

  let messaggi =
    [];

  let turniDaSaltare =
    0;

  let vittoria =
    false;

  let tiraAncora =
    false;

  if (
    nuovaPosizione >
    CASELLA_VITTORIA
  ) {
    for (
      let p =
        posizioneAttuale +
        1;

      p <=
        CASELLA_VITTORIA;

      p++
    ) {
      percorso.push(
        p
      );
    }

    const eccesso =
      nuovaPosizione -
      CASELLA_VITTORIA;

    nuovaPosizione =
      CASELLA_VITTORIA -
      eccesso;

    for (
      let p =
        CASELLA_VITTORIA -
        1;

      p >=
        nuovaPosizione;

      p--
    ) {
      percorso.push(
        p
      );
    }

    messaggi.push(
      "Hai superato il traguardo, rimbalzi indietro!"
    );
  } else {
    for (
      let p =
        posizioneAttuale +
        1;

      p <=
        nuovaPosizione;

      p++
    ) {
      percorso.push(
        p
      );
    }
  }

  if (
    nuovaPosizione ===
    CASELLA_VITTORIA
  ) {
    vittoria =
      true;

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
    tiraAncora =
      true;

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
    turniDaSaltare =
      3;

    messaggi.push(
      "Rimani fermo per 3 turni!"
    );
  }

  if (
    CASELLE_SALTA_UN_TURNO.includes(
      nuovaPosizione
    )
  ) {
    turniDaSaltare =
      1;

    messaggi.push(
      "Salti un turno!"
    );
  }

  if (
    CASELLE_TORNA_A[
      nuovaPosizione
    ] !==
    undefined
  ) {
    const cf =
      CASELLE_TORNA_A[
        nuovaPosizione
      ];

    messaggi.push(
      `Torni alla casella ${cf}!`
    );

    percorso.push(
      cf
    );

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

/* =========================================================
   TURNI
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
    ) &&
    secondi > 0
      ? secondi
      : 30
  ) *
  1000;
}

function fermaTimerTurno(
  partita
) {
  if (
    !partita
  ) {
    return;
  }

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
    ) +
    1;
}

function avviaTimerTurno(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    !partita.iniziata
  ) {
    return;
  }

  fermaTimerTurno(
    partita
  );

  partita.statoTurno =
    "attivo";

  const durata =
    millisecondiMossa(
      partita
    );

  const token =
    partita.tokenTimerTurno;

  partita.tempoInizioTurno =
    Date.now();

  partita.scadenzaTurno =
    partita.tempoInizioTurno +
    durata;

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

        if (
          partita.statoTurno !==
          "attivo"
        ) {
          return;
        }

        partita.statoTurno =
          "scaduto";

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
    !partita.iniziata
  ) {
    return;
  }

  partita.animazioneTiroInCorso =
    false;

  partita.elaborandoTiro =
    false;

  partita.lockTiro =
    false;

  if (
    !partita.statoTurno ||
    partita.statoTurno ===
      "elaborazione" ||
    partita.statoTurno ===
      "animazione"
  ) {
    partita.statoTurno =
      "attivo";
  }

  if (
    !partita.scadenzaTurno
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

  const tempoRimanente =
    partita.scadenzaTurno -
    Date.now();

  const ritardo =
    Math.max(
      0,
      tempoRimanente +
      TOLLERANZA_MOSSA_MS
    );

  partita.timerTurno =
    setTimeout(
      async () => {
        if (
          token !==
          partita.tokenTimerTurno
        ) {
          return;
        }

        if (
          partita.statoTurno !==
          "attivo"
        ) {
          return;
        }

        partita.timerTurno =
          null;

        partita.statoTurno =
          "scaduto";

        await gestisciScadenzaTurno(
          partita,
          nomeStanza
        );
      },

      ritardo
    );
}

function passaAlProssimoTurno(
  partita
) {
  const numeroGiocatori =
    partita.ordineGiocatori.length;

  if (
    numeroGiocatori <=
    1
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

    if (
      !giocatore
    ) {
      continue;
    }

    if (
      Number(
        giocatore.turniSaltati ||
        0
      ) >
      0
    ) {
      giocatore.turniSaltati--;

      continue;
    }

    partita.turnoAttuale =
      indice;

    partita.tiriEffettuatiNelTurno =
      0;

    partita.tiriConsentitiNelTurno =
      1;

    partita.statoTurno =
      "attesa";

    return;
  }

  partita.turnoAttuale =
    indiceDiPartenza;

  partita.tiriEffettuatiNelTurno =
    0;

  partita.tiriConsentitiNelTurno =
    1;

  partita.statoTurno =
    "attesa";
}

/* =========================================================
   LOCK PARTITA
   ========================================================= */

async function conLockPartita(
  partita,
  callback
) {
  if (
    !partita
  ) {
    return false;
  }

  if (
    partita.lockTiro
  ) {
    return false;
  }

  partita.lockTiro =
    true;

  try {
    await callback();

    return true;
  } finally {
    partita.lockTiro =
      false;
  }
}

/* =========================================================
   CLASSIFICA FINALE
   ========================================================= */

function costruisciClassificaFinale(
  partita,
  vincitoreUid
) {
  const partecipanti =
    Array.isArray(
      partita.partecipantiOriginali
    )
      ? partita.partecipantiOriginali
      : [];

  const giocatori =
    partecipanti.map(
      p => {
        const g =
          partita.giocatori[
            p.uid
          ];

        const abbandonato =
          !!(
            partita.abbandonati &&
            partita.abbandonati[
              p.uid
            ]
          );

        let posizioneBoard =
          g
            ? Number(
                g.posizione ||
                0
              )
            : 0;

        if (
          p.uid ===
          vincitoreUid
        ) {
          posizioneBoard =
            CASELLA_VITTORIA;
        }

        return {
          uid:
            p.uid,

          nome:
            p.nome ||
            (
              g
                ? g.nome
                : "Giocatore"
            ),

          posizioneBoard,

          abbandonato
        };
      }
    );

  giocatori.sort(
    (
      a,
      b
    ) => {
      if (
        a.uid ===
        vincitoreUid
      ) {
        return -1;
      }

      if (
        b.uid ===
        vincitoreUid
      ) {
        return 1;
      }

      if (
        a.abbandonato !==
        b.abbandonato
      ) {
        return a.abbandonato
          ? 1
          : -1;
      }

      if (
        b.posizioneBoard !==
        a.posizioneBoard
      ) {
        return (
          b.posizioneBoard -
          a.posizioneBoard
        );
      }

      return 0;
    }
  );

  return giocatori.map(
    (
      giocatore,
      indice
    ) => ({
      ...giocatore,

      posizioneFinale:
        indice +
        1
    })
  );
}

/* =========================================================
   CONCLUSIONE PARTITA / ELO
   ========================================================= */

async function concludiPartita(
  partita,
  vincitoreUid,
  nomeStanza
) {
  if (
    !db ||
    !partita
  ) {
    return null;
  }

  if (
    partita.conclusioneEseguita
  ) {
    return partita.risultatiEloFinali ||
      null;
  }

  partita.conclusioneEseguita =
    true;

  try {
    const classifica =
      costruisciClassificaFinale(
        partita,
        vincitoreUid
      );

    const datiElo =
      [];

    for (
      const partecipante of
        classifica
    ) {
      const snap =
        await db
          .ref(
            "utenti/" +
            partecipante.uid
          )
          .once(
            "value"
          );

      const utente =
        snap.val();

      if (
        !utente
      ) {
        continue;
      }

      await migraUtenteElo(
        partecipante.uid,
        utente
      );

      datiElo.push({
        uid:
          partecipante.uid,

        nome:
          partecipante.nome,

        posizioneFinale:
          partecipante.posizioneFinale,

        posizioneBoard:
          partecipante.posizioneBoard,

        abbandonato:
          partecipante.abbandonato,

        ratingPrima:
          Number(
            utente.ratingElo ||
            ELO_INIZIALE
          ),

        partiteClassificatePrima:
          Number(
            utente.partiteClassificate ||
            0
          )
      });
    }

    let risultatiElo =
      [];

    if (
      partita.classificata !==
      false &&
      datiElo.length >=
      2
    ) {
      risultatiElo =
        calcolaVariazioniElo(
          datiElo
        );
    } else {
      risultatiElo =
        datiElo.map(
          g => ({
            ...g,

            variazioneElo:
              0,

            ratingDopo:
              g.ratingPrima
          })
        );
    }

    const aggiornamenti =
      {};

    const storicoEloOutput =
      [];

    for (
      const risultato of
        risultatiElo
    ) {
      const vinto =
        risultato.uid ===
        vincitoreUid;

      const pareggio =
        classifica.length ===
          2 &&
        classifica[0]
          .posizioneFinale ===
          classifica[1]
            .posizioneFinale;

      const utentePath =
        "utenti/" +
        risultato.uid;

      const partitaGiocataPath =
        `${utentePath}/partiteGiocate`;

      aggiornamenti[
        partitaGiocataPath
      ] =
        admin.database.ServerValue.increment(
          1
        );

      if (
        vinto
      ) {
        aggiornamenti[
          `${utentePath}/partiteVinte`
        ] =
          admin.database.ServerValue.increment(
            1
          );
      }

      if (
        partita.classificata !==
        false
      ) {
        aggiornamenti[
          `${utentePath}/ratingElo`
        ] =
          risultato.ratingDopo;

        aggiornamenti[
          `${utentePath}/eloMassimo`
        ] =
          Math.max(
            risultato.ratingPrima,
            risultato.ratingDopo
          );

        aggiornamenti[
          `${utentePath}/partiteClassificate`
        ] =
          admin.database.ServerValue.increment(
            1
          );

        if (
          vinto
        ) {
          aggiornamenti[
            `${utentePath}/vittorieClassificate`
          ] =
            admin.database.ServerValue.increment(
              1
            );
        } else if (
          pareggio
        ) {
          aggiornamenti[
            `${utentePath}/pareggiClassificati`
          ] =
            admin.database.ServerValue.increment(
              1
            );
        } else {
          aggiornamenti[
            `${utentePath}/sconfitteClassificate`
          ] =
            admin.database.ServerValue.increment(
              1
            );
        }

        const storicoKey =
          db
            .ref()
            .push()
            .key;

        const avversari =
          risultatiElo
            .filter(
              g =>
                g.uid !==
                risultato.uid
            )
            .map(
              g => ({
                uid:
                  g.uid,

                nome:
                  g.nome,

                posizione:
                  g.posizioneFinale
              })
            );

        aggiornamenti[
          `storicoElo/${risultato.uid}/${storicoKey}`
        ] = {
          data:
            Date.now(),

          partitaId:
            partita.id,

          stanza:
            nomeStanza,

          posizione:
            risultato.posizioneFinale,

          partecipanti:
            classifica.length,

          eloPrima:
            risultato.ratingPrima,

          variazioneElo:
            risultato.variazioneElo,

          eloDopo:
            risultato.ratingDopo,

          classificata:
            true,

          avversari
        };
      }

      storicoEloOutput.push({
        uid:
          risultato.uid,

        nome:
          risultato.nome,

        posizione:
          risultato.posizioneFinale,

        eloPrima:
          risultato.ratingPrima,

        variazioneElo:
          partita.classificata !==
          false
            ? risultato.variazioneElo
            : 0,

        eloDopo:
          partita.classificata !==
          false
            ? risultato.ratingDopo
            : risultato.ratingPrima,

        abbandonato:
          risultato.abbandonato
      });
    }

    const durataSecondi =
      partita.iniziataIl
        ? Math.max(
            0,
            Math.round(
              (
                Date.now() -
                partita.iniziataIl
              ) /
              1000
            )
          )
        : null;

    const vincitore =
      classifica.find(
        p =>
          p.uid ===
          vincitoreUid
      );

    const storicoPartita =
      {
        data:
          Date.now(),

        partitaId:
          partita.id,

        stanza:
          nomeStanza,

        vincitoreUid:
          vincitoreUid ||
          null,

        vincitoreNome:
          vincitore
            ? vincitore.nome
            : null,

        durataSecondi,

        classificata:
          partita.classificata !==
          false,

        partecipanti:
          classifica.map(
            p => ({
              uid:
                p.uid,

              nome:
                p.nome,

              posizione:
                p.posizioneFinale,

              posizioneBoard:
                p.posizioneBoard,

              abbandonato:
                p.abbandonato
            })
          ),

        risultatiElo:
          storicoEloOutput
      };

    const storicoPartitaKey =
      db
        .ref(
          "storicoPartite"
        )
        .push()
        .key;

    aggiornamenti[
      `storicoPartite/${storicoPartitaKey}`
    ] =
      storicoPartita;

    aggiornamenti[
      `partite/${partita.id}/conclusioneEseguita`
    ] =
      true;

    aggiornamenti[
      `partite/${partita.id}/fase`
    ] =
      "terminata";

    aggiornamenti[
      `partite/${partita.id}/iniziata`
    ] =
      false;

    await db
      .ref()
      .update(
        aggiornamenti
      );

    partita.risultatiEloFinali =
      storicoEloOutput;

    partita.conclusioneEseguita =
      true;

    return storicoEloOutput;
  } catch (
    errore
  ) {
    partita.conclusioneEseguita =
      false;

    console.error(
      "Errore conclusione partita:",
      errore
    );

    throw errore;
  }
}

/* =========================================================
   TIMER SCADENZA
   ========================================================= */

async function gestisciScadenzaTurno(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    !partita.iniziata
  ) {
    return;
  }

  if (
    partita.statoTurno !==
    "scaduto"
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

  if (
    !giocatore
  ) {
    return;
  }

  giocatore.tentativiAutomaticiConsecutivi =
    Number(
      giocatore.tentativiAutomaticiConsecutivi ||
      0
    ) +
    1;

  if (
    giocatore.tentativiAutomaticiConsecutivi >
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
  return conLockPartita(
    partita,
    async () => {
      if (
        !partita.iniziata
      ) {
        return;
      }

      if (
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

      if (
        partita.statoTurno !==
          "attivo" &&
        !(
          automatico &&
          partita.statoTurno ===
            "scaduto"
        )
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

      if (
        !giocatore
      ) {
        return;
      }

      partita.tiriEffettuatiNelTurno =
        tiriEffettuati +
        1;

      partita.elaborandoTiro =
        true;

      partita.animazioneTiroInCorso =
        true;

      partita.statoTurno =
        "elaborazione";

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
          dado1 +
          dado2;

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

        const statoGiocatori =
          costruisciStatoGiocatori(
            partita
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
          partita.fase =
            "terminata";

          partita.iniziata =
            false;

          partita.statoTurno =
            "attesa";

          fermaTimerTurno(
            partita
          );

          partita.tempoInizioTurno =
            null;

          partita.scadenzaTurno =
            null;

          Object.values(
            partita.giocatori
          ).forEach(
            g => {
              if (
                g.socket &&
                g.socket.readyState ===
                  WebSocket.OPEN
              ) {
                try {
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
                } catch {}
              }
            }
          );

          await concludiPartita(
            partita,
            idGiocatore,
            nomeStanza
          );

          inviaListaPartite(
            nomeStanza
          );

          inviaConteggioStanze();

          return;
        }

        partita.statoTurno =
          "animazione";

        Object.values(
          partita.giocatori
        ).forEach(
          g => {
            if (
              g.socket &&
              g.socket.readyState ===
                WebSocket.OPEN
            ) {
              try {
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
                      false,

                    vincitore:
                      null
                  })
                );
              } catch {}
            }
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

            statoTurno:
              partita.statoTurno,

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

        const durataAnimazioneCompleta =
          DURATA_ANIMAZIONE_TIRO_MS +
          (
            Array.isArray(
              risultato.percorso
            )
              ? risultato.percorso.length *
                220
              : 0
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
                partita
            ) {
              return;
            }

            if (
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

            if (
              partita.statoTurno !==
              "animazione"
            ) {
              return;
            }

            partita.animazioneTiroInCorso =
              false;

            partita.statoTurno =
              "attesa";

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

            Object.values(
              partita.giocatori
            ).forEach(
              g => {
                if (
                  g.socket &&
                  g.socket.readyState ===
                    WebSocket.OPEN
                ) {
                  try {
                    g.socket.send(
                      JSON.stringify({
                        tipo:
                          "statoPartita",

                        giocatori:
                          statoDopoAnimazione,

                        turnoDiId:
                          idTurnoAttuale,

                        punteggiOrdineIniziale:
                          partita
                            .punteggiOrdineIniziale ||
                          null,

                        tempoInizioTurno:
                          partita
                            .tempoInizioTurno,

                        durataMossaMs:
                          millisecondiMossa(
                            partita
                          ),

                        scadenzaTurno:
                          partita
                            .scadenzaTurno,

                        tiriEffettuatiNelTurno:
                          partita
                            .tiriEffettuatiNelTurno,

                        tiriConsentitiNelTurno:
                          partita
                            .tiriConsentitiNelTurno,

                        statoTurno:
                          partita
                            .statoTurno,

                        classificata:
                          partita.classificata !==
                          false,

                        chatAttiva:
                          partita.chatAttiva !==
                          false
                      })
                    );
                  } catch {}
                }
              }
            );

            await aggiornaStatoPartita(
              partita.id,
              {
                turnoAttuale:
                  partita.turnoAttuale,

                iniziata:
                  partita.iniziata,

                statoTurno:
                  partita.statoTurno,

                tiriEffettuatiNelTurno:
                  partita
                    .tiriEffettuatiNelTurno,

                tiriConsentitiNelTurno:
                  partita
                    .tiriConsentitiNelTurno,

                tempoInizioTurno:
                  partita
                    .tempoInizioTurno,

                scadenzaTurno:
                  partita
                    .scadenzaTurno
              }
            );
          },

          durataAnimazioneCompleta
        );
      } catch (
        erroreTiro
      ) {
        console.error(
          "Errore durante il tiro dei dadi:",
          erroreTiro
        );

        partita.tiriEffettuatiNelTurno =
          Math.max(
            0,
            tiriEffettuati
          );

        partita.animazioneTiroInCorso =
          false;

        partita.statoTurno =
          "attivo";

        avviaTimerTurno(
          partita,
          nomeStanza
        );

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
        ).forEach(
          g => {
            if (
              g.socket &&
              g.socket.readyState ===
                WebSocket.OPEN
            ) {
              try {
                g.socket.send(
                  JSON.stringify({
                    tipo:
                      "statoPartita",

                    giocatori:
                      statoGiocatori,

                    turnoDiId:
                      idAttuale,

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

                    statoTurno:
                      "attivo",

                    classificata:
                      partita.classificata !==
                      false,

                    chatAttiva:
                      partita.chatAttiva !==
                      false
                  })
                );
              } catch {}
            }
          }
        );
      } finally {
        partita.elaborandoTiro =
          false;
      }
    }
  );
}

/* =========================================================
   ABBANDONO AUTOMATICO
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

  if (
    !partita.abbandonati
  ) {
    partita.abbandonati =
      {};
  }

  partita.abbandonati[
    idGiocatore
  ] = {
    nome:
      nomeUscente,

    motivo:
      "inattivita",

    data:
      Date.now()
  };

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
    partita.turnoAttuale =
      0;
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
    ).forEach(
      g => {
        if (
          g.socket &&
          g.socket.readyState ===
            WebSocket.OPEN
        ) {
          try {
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
          } catch {}
        }
      }
    );

    partita.fase =
      "terminata";

    partita.iniziata =
      false;

    partita.statoTurno =
      "attesa";

    await concludiPartita(
      partita,
      vincitoreId,
      nomeStanza
    );

    await rimuoviPartita(
      nomeStanza,
      partita.id
    );
  } else {
    const idAttuale =
      partita
        .ordineGiocatori[
        partita.turnoAttuale
      ];

    partita.tiriEffettuatiNelTurno =
      0;

    partita.tiriConsentitiNelTurno =
      1;

    partita.animazioneTiroInCorso =
      false;

    partita.elaborandoTiro =
      false;

    partita.statoTurno =
      "attesa";

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
    ).forEach(
      g => {
        if (
          g.socket &&
          g.socket.readyState ===
            WebSocket.OPEN
        ) {
          try {
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
                  ),

                scadenzaTurno:
                  partita.scadenzaTurno,

                statoTurno:
                  partita.statoTurno
              })
            );
          } catch {}
        }
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

        abbandonati:
          partita.abbandonati,

        turnoAttuale:
          partita.turnoAttuale,

        tiriEffettuatiNelTurno:
          0,

        tiriConsentitiNelTurno:
          1,

        statoTurno:
          partita.statoTurno,

        tempoInizioTurno:
          partita.tempoInizioTurno,

        scadenzaTurno:
          partita.scadenzaTurno
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
          Number(
            risultati[
              uid
            ]
          )
      })
    );

  coppie.sort(
    (
      a,
      b
    ) =>
      b.punteggio -
      a.punteggio
  );

  for (
    let i = 0;
    i < coppie.length;
    i++
  ) {
    let j =
      i +
      1;

    while (
      j <
        coppie.length &&
      coppie[
        j
      ].punteggio ===
        coppie[
          i
        ].punteggio
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
              c =>
                c.uid
            )
      };
    }

    i =
      j -
      1;
  }

  return {
    ordineFinale:
      coppie.map(
        c =>
          c.uid
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
        u2 !==
        uid
    );

  partita.codaDeterminazione =
    (
      partita.codaDeterminazione ||
      []
    ).filter(
      u2 =>
        u2 !==
        uid
    );

  if (
    partita.risultatiDeterminazione
  ) {
    delete partita.risultatiDeterminazione[
      uid
    ];
  }

  if (
    partita.gruppoSpareggioAttuale
  ) {
    partita.gruppoSpareggioAttuale =
      partita.gruppoSpareggioAttuale.filter(
        u2 =>
          u2 !==
          uid
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
    ).map(
      uid => ({
        uid,

        nome:
          partita.giocatori[
            uid
          ]
            ? partidaNome(
                partita,
                uid
              )
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
      })
    );

  const messaggio =
    JSON.stringify({
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

      durataMossaMs:
        millisecondiMossa(
          partita
        )
    });

  Object.values(
    partita.giocatori
  ).forEach(
    g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        try {
          g.socket.send(
            messaggio
          );
        } catch {}
      }
    }
  );
}

function partidaNome(
  partita,
  uid
) {
  return partita
    .giocatori[
      uid
    ].nome;
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

  partita.timerTurno =
    setTimeout(
      () => {
        gestisciScadenzaDeterminazione(
          partita,
          nomeStanza
        ).catch(
          errore =>
            console.error(
              "Errore scadenza determinazione:",
              errore
            )
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
    partita.fase !==
    "determinazione_ordine"
  ) {
    return;
  }

  const uid =
    partita
      .turnoInCorsoDeterminazione;

  if (
    !uid
  ) {
    return;
  }

  const giocatore =
    partita.giocatori[
      uid
    ];

  if (
    !giocatore
  ) {
    return;
  }

  giocatore.tentativiAutomaticiConsecutivi =
    (
      giocatore.tentativiAutomaticiConsecutivi ||
      0
    ) +
    1;

  if (
    jogadorLimite(
      giocatore
    )
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

function jogadorLimite(
  giocatore
) {
  return (
    Number(
      giocatore
        .tentativiAutomaticiConsecutivi ||
      0
    ) >
    3
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
    partita.elaborandoTiro
  ) {
    return;
  }

  if (
    partita.turnoInCorsoDeterminazione !==
    uid
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
      dado1 +
      dado2;

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
    ).forEach(
      g => {
        if (
          g.socket &&
          g.socket.readyState ===
            WebSocket.OPEN
        ) {
          try {
            g.socket.send(
              messaggio
            );
          } catch {}
        }
      }
    );

    setTimeout(
      () => {
        avanzaDeterminazione(
          partita,
          nomeStanza
        ).catch(
          errore =>
            console.error(
              "Errore avanzamento determinazione:",
              errore
            )
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
      ...partita.ordineDeterminazione
    ];

  partita.turnoInCorsoDeterminazione =
    null;

  partita.gruppoSpareggioAttuale =
    null;

  avanzaDeterminazione(
    partita,
    nomeStanza
  ).catch(
    errore =>
      console.error(
        "Errore avvio determinazione:",
        errore
      )
  );
}

async function avanzaDeterminazione(
  partita,
  nomeStanza
) {
  if (
    !partita ||
    partita.fase !==
      "determinazione_ordine"
  ) {
    return;
  }

  if (
    partita.codaDeterminazione.length ===
    0
  ) {
    const esito =
      calcolaOrdineDaiRisultati(
        partita.risultatiDeterminazione,
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
          partita.giocatori[
            uid
          ].nome
      );

    const punteggiOrdineFinale =
      {};

    esito.ordineFinale.forEach(
      uid => {
        punteggiOrdineFinale[
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
    ).forEach(
      g => {
        if (
          g.socket &&
          g.socket.readyState ===
            WebSocket.OPEN
        ) {
          try {
            g.socket.send(
              messaggioOrdine
            );
          } catch {}
        }
      }
    );

    setTimeout(
      () => {
        completaDeterminazione(
          partita,
          nomeStanza,
          esito.ordineFinale
        ).catch(
          errore =>
            console.error(
              "Errore completamento determinazione:",
              errore
            )
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

  if (
    !partita.abbandonati
  ) {
    partita.abbandonati =
      {};
  }

  partita.abbandonati[
    uid
  ] = {
    nome:
      nomeUscente,

    motivo:
      "inattivita_determinazione",

    data:
      Date.now()
  };

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

      abbandonati:
        partita.abbandonati,

      fase:
        partita.fase
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
  if (
    !ordineFinale ||
    !ordineFinale.length
  ) {
    return;
  }

  partita.ordineGiocatori =
    ordineFinale;

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

  partita.animazioneTiroInCorso =
    false;

  partita.tiriEffettuatiNelTurno =
    0;

  partita.tiriConsentitiNelTurno =
    1;

  partita.statoTurno =
    "attesa";

  const punteggiPerNome =
    {};

  ordineFinale.forEach(
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

  const primoUid =
    ordineFinale[0];

  const primoGiocatore =
    partita.giocatori[
      primoUid
    ];

  const statoGiocatori =
    costruisciStatoGiocatori(
      partita
    );

  const idPrimoTurno =
    partita.ordineGiocatori[
      partita.turnoAttuale
    ];

  avviaTimerTurno(
    partita,
    nomeStanza
  );

  Object.values(
    partita.giocatori
  ).forEach(
    g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        try {
          g.socket.send(
            JSON.stringify({
              tipo:
                "determinazioneCompletata",

              ordineGiocatori:
                ordineFinale.map(
                  id =>
                    partita.giocatori[
                      id
                    ].nome
                ),

              punteggiOrdineIniziale:
                punteggiPerNome,

              primoMovimento:
                {
                  idGiocatore:
                    primoUid,

                  nomeGiocatore:
                    primoGiocatore.nome,

                  valoreDado:
                    0,

                  percorso:
                    [],

                  messaggi: [
                    "Ordine deciso!",

                    primoGiocatore.nome +
                      " inizia la partita: tira i dadi!"
                  ]
                },

              giocatori:
                statoGiocatori,

              turnoDiId:
                idPrimoTurno,

              tempoInizioTurno:
                partita.tempoInizioTurno,

              durataMossaMs:
                millisecondiMossa(
                  partita
                ),

              scadenzaTurno:
                partita.scadenzaTurno,

              vittoria:
                false,

              vincitore:
                null
            })
          );
        } catch {}
      }
    }
  );

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
      nomeStanza
  });

  Object.values(
    partita.giocatori
  ).forEach(
    g => {
      if (
        g.socket &&
        g.socket.readyState ===
          WebSocket.OPEN
      ) {
        try {
          g.socket.send(
            JSON.stringify({
              tipo:
                "partitaAvviata",

              partitaId:
                partita.id
            })
          );
        } catch {}
      }
    }
  );

  inviaListaPartite(
    nomeStanza
  );

  inviaConteggioStanze();
}

/* =========================================================
   USCITA DA PARTITA IN ATTESA
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

  if (
    !giocatoreUscente
  ) {
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
        id !==
        uid
    );

  partita.partecipantiOriginali =
    (
      partita.partecipantiOriginali ||
      []
    ).filter(
      p =>
        p.uid !==
        uid
    );

  partita.turnoAttuale =
    0;

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

  if (
    eraCreatore
  ) {
    const nuovoCreatoreUid =
      partita
        .ordineGiocatori[
        0
      ];

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

      partecipantiOriginali:
        partita.partecipantiOriginali,

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

      uid:

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

/* =========================================================
   RIPRISTINO PARTITE
   ========================================================= */

async function ripristinaPartiteDaFirebase() {
  const partiteFirebase =
    await caricaPartite();

  for (
    const id in
      partiteFirebase
  ) {
    const p =
      partiteFirebase[
        id
      ];

    if (
      !stanze[
        p.stanza
      ]
    ) {
      continue;
    }

    const giocatori =
      p.giocatori ||
      {};

    const partecipantiOriginali =
      Array.isArray(
        p.partecipantiOriginali
      )
        ? p.partecipantiOriginali
        : Object.entries(
            giocatori
          ).map(
            ([
              uid,
              g
            ]) => ({
              uid,

              nome:
                g.nome ||
                "Giocatore"
            })
          );

    stanze[
      p.stanza
    ].partite[
      id
    ] = {
      ...p,

      maxGiocatori:
        p.maxGiocatori ||
        (
          Object.keys(
            giocatori
          ).length ||
          2
        ),

      chatAttiva:
        p.chatAttiva !==
        false,

      classificata:
        p.classificata !==
        false,

      giocatori:
        giocatori,

      ordineGiocatori:
        p.ordineGiocatori ||
        [],

      partecipantiOriginali,

      abbandonati:
        p.abbandonati ||
        {},

      turnoAttuale:
        Number(
          p.turnoAttuale ||
          0
        ),

      iniziata:
        p.iniziata ===
        true,

      iniziataIl:
        p.iniziataIl ||
        null,

      statoTurno:
        p.statoTurno ||
        (
          p.iniziata
            ? "attivo"
            : "attesa"
        ),

      tiriEffettuatiNelTurno:
        Number(
          p.tiriEffettuatiNelTurno ||
          0
        ),

      tiriConsentitiNelTurno:
        Number(
          p.tiriConsentitiNelTurno ||
          1
        ),

      tempoInizioTurno:
        p.tempoInizioTurno ||
        null,

      scadenzaTurno:
        p.scadenzaTurno ||
        null,

      elaborandoTiro:
        false,

      animazioneTiroInCorso:
        false,

      invitati:
        {},

      timerTurno:
        null,

      tokenTimerTurno:
        0,

      lockTiro:
        false,

      punteggiOrdineIniziale:
        p.punteggiOrdineIniziale ||
        null,

      coppieAudioApprovate:
        new Set(),

      fase:
        p.fase ||
        (
          p.iniziata ===
          true
            ? "in_corso"
            : "attesa_giocatori"
        ),

      conclusioneEseguita:
        p.conclusioneEseguita ===
        true
    };

    const partitaRipristinata =
      stanze[
        p.stanza
      ].partite[
        id
      ];

    for (
      const uid in
        partitaRipristinata.giocatori
    ) {
      partitaRipristinata.giocatori[
        uid
      ].socket =
        null;
    }

    if (
      partitaRipristinata.fase ===
      "terminata"
    ) {
      partitaRipristinata.iniziata =
        false;

      partitaRipristinata.statoTurno =
        "attesa";

      continue;
    }

    if (
      partitaRipristinata.iniziata
    ) {
      partitaRipristinata.fase =
        "in_corso";

      if (
        !partitaRipristinata.statoTurno ||
        partitaRipristinata.statoTurno ===
          "elaborazione" ||
        partitaRipristinata.statoTurno ===
          "animazione"
      ) {
        partitaRipristinata.statoTurno =
          "attivo";
      }

      ripristinaTimerTurno(
        partitaRipristinata,
        p.stanza
      );
    } else if (
      partitaRipristinata.fase ===
      "determinazione_ordine"
    ) {
      iniziaFaseDeterminazione(
        partitaRipristinata,
        p.stanza
      );
    } else if (
      Object.keys(
        partitaRipristinata.giocatori
      ).length ===
      partitaRipristinata.maxGiocatori
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
   WEBSOCKET
   ========================================================= */

wss.on(
  "connection",
  (
    socket,
    request
  ) => {
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

    socket.on(
      "message",
      async message => {
        try {
          let dati;

          try {
            dati =
              JSON.parse(
                message.toString()
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

          /* =================================================
             CONTEGGIO
             ================================================= */

          if (
            dati.tipo ===
            "richiediConteggio"
          ) {
            inviaConteggioStanze();

            return;
          }

          /* =================================================
             AUDIO / WEBRTC
             ================================================= */

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
            if (
              !uid
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
              return;
            }

            const {
              partita
            } =
              trovato;

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
              partita.coppieAudioApprovate &&
              partita.coppieAudioApprovate.has(
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

          /* =================================================
             ENTRA LOBBY
             ================================================= */

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

            if (
              !uid
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "sessioneScaduta"
                })
              );

              return;
            }

            if (
              !dati.stanza ||
              !stanze[
                dati.stanza
              ]
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

            const utenteDb =
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

            if (
              !utenteDb
            ) {
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

            await migraUtenteElo(
              uid,
              utenteDb
            );

            stanzaAttuale =
              dati.stanza;

            nickname =
              utenteDb.nickname;

            mioAvatar =
              utenteDb.avatar ||
              null;

            rimuoviVecchieConnessioniOnline(
              stanzaAttuale,
              uid,
              socketId
            );

            stanze[
              stanzaAttuale
            ].giocatoriOnline[
              socketId
            ] = {
              uid,

              nickname,

              avatar:
                mioAvatar,

              tipoDispositivo,

              socket
            };

            for (
              const partita of
                Object.values(
                  stanze[
                    stanzaAttuale
                  ].partite
                )
            ) {
              if (
                partita.giocatori &&
                partita.giocatori[
                  uid
                ]
              ) {
                partita.giocatori[
                  uid
                ].socket =
                  socket;
              }
            }

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
                    ].giocatoriOnline
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

                partitaAttiva:
                  trovaPartitaAttivaPerUid(
                    uid
                  )
              })
            );

            return;
          }

          /* =================================================
             RIPRENDI
             ================================================= */

          if (
            dati.tipo ===
            "riprendiPartita"
          ) {
            if (
              !uid
            ) {
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

            if (
              !trovato
            ) {
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
            } =
              trovato;

            if (
              partita.fase ===
              "terminata"
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",

                  messaggio:
                    "Questa partita è già terminata."
                })
              );

              return;
            }

            const mioGiocatore =
              partita.giocatori[
                uid
              ];

            if (
              !mioGiocatore
            ) {
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

            if (
              db
            ) {
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

                if (
                  u
                ) {
                  mioGiocatore.avatar =
                    u.avatar ||
                    null;
                }
              } catch {}
            }

            stanzaAttuale =
              nomeStanza;

            mioGiocatore.socket =
              socket;

            nickname =
              mioGiocatore.nome;

            mioAvatar =
              mioGiocatore.avatar ||
              null;

            rimuoviVecchieConnessioniOnline(
              nomeStanza,
              uid,
              socketId
            );

            stanze[
              nomeStanza
            ].giocatoriOnline[
              socketId
            ] = {
              uid,

              nickname,

              avatar:
                mioAvatar,

              tipoDispositivo,

              socket
            };

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
                      partita.ordineDeterminazione ||
                      []
                    ).map(
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
                    null,

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
                    null,

                  durataMossaMs:
                    millisecondiMossa(
                      partita
                    ),

                  scadenzaTurno:
                    partita
                      .scadenzaTurno ||
                    null,

                  tiriEffettuatiNelTurno:
                    Number(
                      partita.tiriEffettuatiNelTurno ||
                      0
                    ),

                  tiriConsentitiNelTurno:
                    Number(
                      partita.tiriConsentitiNelTurno ||
                      1
                    ),

                  statoTurno:
                    partita.statoTurno ||
                    "attivo",

                  chatAttiva:
                    partita.chatAttiva !==
                    false
                })
              );
            }

            return;
          }

          /* =================================================
             CREA PARTITA
             ================================================= */

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

            if (
              trovaPartitaAttivaPerUid(
                uid
              )
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",

                  messaggio:
                    "Sei già in una partita attiva."
                })
              );

              return;
            }

            const esistePartita =
              Object.values(
                stanze[
                  stanzaAttuale
                ].partite
              ).some(
                p =>
                  p.creatoDa ===
                  uid &&
                  p.fase !==
                  "terminata"
              );

            if (
              esistePartita
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

            const classificata =
              dati.classificata !==
              false;

            const partita = {
              id:
                partitaId,

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

              classificata:
                classificata,

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

              partecipantiOriginali:
                [
                  {
                    uid,

                    nome:
                      nickname
                  }
                ],

              abbandonati:
                {},

              ordineGiocatori:
                [
                  uid
                ],

              turnoAttuale:
                0,

              iniziata:
                false,

              elaborandoTiro:
                false,

              animazioneTiroInCorso:
                false,

              estadoTurno:
                "attesa",

              statoTurno:
                "attesa",

              tiriEffettuatiNelTurno:
                0,

              tiriConsentitiNelTurno:
                1,

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

              tokenTimerTurno:
                0,

              tempoInizioTurno:
                null,

              scadenzaTurno:
                null,

              punteggiOrdineIniziale:
                null,

              lockTiro:
                false,

              coppieAudioApprovate:
                new Set(),

              conclusioneEseguita:
                false
            };

            stanze[
              stanzaAttuale
            ].partite[
              partitaId
            ] =
              partita;

            await salvaPartita({
              ...partita,

              stanza:
                stanzaAttuale
            });

            inviaListaPartite(
              stanzaAttuale
            );

            inviaConteggioStanze();

            return;
          }

          /* =================================================
             ENTRA PARTITA
             ================================================= */

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

            if (
              !partita
            ) {
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
                    "Questa partita è già iniziata."
                })
              );

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
              return;
            }

            if (
              trovaPartitaAttivaPerUid(
                uid
              )
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",

                  messaggio:
                    "Sei già in una partita attiva."
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

            partita.partecipantiOriginali.push(
              {
                uid,

                nome:
                  nickname
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

                partecipantiOriginali:
                  partita.partecipantiOriginali
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

          /* =================================================
             INVITO
             ================================================= */

          if (
            dati.tipo ===
            "invitaPartita"
          ) {
            if (
              !uid
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
              return;
            }

            const {
              partita,
              nomeStanza
            } =
              trovato;

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
            ] =
              true;

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

            if (
              db
            ) {
              await db
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

                  letta:
                    false,

                  daUid:
                    uid,

                  daNome:
                    nickname,

                  stanza:
                    nomeStanza,

                  partitaId:
                    partita.id
                });
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

          /* =================================================
             RISPOSTA INVITO
             ================================================= */

          if (
            dati.tipo ===
            "rispostaInvito"
          ) {
            if (
              !uid
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
              return;
            }

            const {
              partita,
              nomeStanza
            } =
              trovato;

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

            partita.partecipantiOriginali.push(
              {
                uid,

                nome:
                  nickname
              }
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
                  partita.ordineGiocatori,

                partecipantiOriginali:
                  partita.partecipantiOriginali
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

          /* =================================================
             ELIMINA PARTITA
             ================================================= */

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
                  stanze[
                    stanzaAttuale
                  ].partite[
                    pid
                  ].fase ===
                    "attesa_giocatori"
              );

            if (
              !idDaEliminare
            ) {
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

          /* =================================================
             CHAT
             ================================================= */

          if (
            dati.tipo ===
            "chat"
          ) {
            if (
              !stanzaAttuale ||
              !uid
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
              !testo
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

          /* =================================================
             CHAT PARTITA
             ================================================= */

          if (
            dati.tipo ===
            "chatPartita"
          ) {
            if (
              !uid
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
              !testo
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
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

            if (
              !mittente
            ) {
              return;
            }

            Object.values(
              partita.giocatori
            ).forEach(
              g => {
                if (
                  g.socket &&
                  g.socket.readyState ===
                    WebSocket.OPEN
                ) {
                  try {
                    g.socket.send(
                      JSON.stringify({
                        tipo:
                          "chatPartita",

                        nome:
                          mittente.nome,

                        testo
                      })
                    );
                  } catch {}
                }
              }
            );

            return;
          }

          /* =================================================
             DETERMINAZIONE
             ================================================= */

          if (
            dati.tipo ===
            "tiraDeterminazione"
          ) {
            if (
              !uid
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
              return;
            }

            const {
              partita,
              nomeStanza
            } =
              trovato;

            if (
              partita.fase !==
              "determinazione_ordine"
            ) {
              return;
            }

            if (
              partita.turnoInCorsoDeterminazione !==
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
              partita.giocatori[
                uid
              ].tentativiAutomaticiConsecutivi =
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

          /* =================================================
             TIRO DADI
             ================================================= */

          if (
            dati.tipo ===
            "tiraDadi"
          ) {
            if (
              !uid
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
              return;
            }

            const {
              partita,
              nomeStanza
            } =
              trovato;

            if (
              partita.fase !==
              "in_corso"
            ) {
              return;
            }

            const idGiocatoreDiTurno =
              partita
                .ordineGiocatori[
                partita.turnoAttuale
              ];

            if (
              idGiocatoreDiTurno !==
              uid
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
              partita.statoTurno !==
              "attivo"
            ) {
              socket.send(
                JSON.stringify({
                  tipo:
                    "errore",

                  messaggio:
                    "Il turno non è disponibile in questo momento."
                })
              );

              return;
            }

            if (
              partita.scadenzaTurno &&
              Date.now() >=
                partita.scadenzaTurno +
                TOLLERANZA_MOSSA_MS
            ) {
              partita.statoTurno =
                "scaduto";

              await gestisciScadenzaTurno(
                partita,
                nomeStanza
              );

              return;
            }

            if (
              partita.giocatori[
                uid
              ]
            ) {
              partita.giocatori[
                uid
              ].tentativiAutomaticiConsecutivi =
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

          /* =================================================
             ABBANDONA
             ================================================= */

          if (
            dati.tipo ===
            "abbandonaPartita"
          ) {
            if (
              !uid
            ) {
              return;
            }

            const trovato =
              trovaPartita(
                dati.partitaId
              );

            if (
              !trovato
            ) {
              return;
            }

            const {
              partita,
              nomeStanza
            } =
              trovato;

            if (
              !partita.giocatori[
                uid
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
                uid
              );

              return;
            }

            if (
              partita.fase ===
              "determinazione_ordine"
            ) {
              const eraIlSuoTurno =
                partita
                  .turnoInCorsoDeterminazione ===
                uid;

              fermaTimerTurno(
                partita
              );

              if (
                !partita.abbandonati
              ) {
                partita.abbandonati =
                  {};
              }

              partita.abbandonati[
                uid
              ] = {
                nome:
                  partita.giocatori[
                    uid
                  ].nome,

                motivo:
                  "abbandono_determinazione",

                data:
                  Date.now()
              };

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
              } else {
                if (
                  eraIlSuoTurno
                ) {
                  partita.turnoInCorsoDeterminazione =
                    null;
                }

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

            if (
              partita.fase ===
              "terminata"
            ) {
              delete partita.giocatori[
                uid
              ];

              partita.ordineGiocatori =
                (
                  partita.ordineGiocatori ||
                  []
                ).filter(
                  id =>
                    id !==
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
              } else {
                await aggiornaStatoPartita(
                  partita.id,
                  {
                    giocatori:
                      preparaGiocatoriPerFirebase(
                        partita.giocatori
                      ),

                    ordineGiocatori:
                      partita.ordineGiocatori,

                    fase:
                      "terminata",

                    iniziata:
                      false,

                    statoTurno:
                      "attesa",

                    tempoInizioTurno:
                      null,

                    scadenzaTurno:
                      null
                  }
                );
              }

              inviaListaPartite(
                nomeStanza
              );

              inviaConteggioStanze();

              return;
            }

            /* =================================================
               PARTITA IN CORSO
               ================================================= */

            const eraLuiIlGiocatoreAttivo =
              partita
                .ordineGiocatori[
                partita.turnoAttuale
              ] ===
              uid;

            const idGiocatoreAttivoPrima =
              eraLuiIlGiocatoreAttivo
                ? null
                : partita
                    .ordineGiocatori[
                    partita.turnoAttuale
                  ];

            const nomeUscente =
              partita.giocatori[
                uid
              ].nome;

            const elencoPartecipantiOriginali =
              Array.isArray(
                partita.partecipantiOriginali
              )
                ? partita.partecipantiOriginali.map(
                    p => ({
                      ...p
                    })
                  )
                : partita.ordineGiocatori.map(
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

            if (
              !partita.abbandonati
            ) {
              partita.abbandonati =
                {};
            }

            partita.abbandonati[
              uid
            ] = {
              nome:
                nomeUscente,

              motivo:
                "abbandono",

              data:
                Date.now()
            };

            delete partita.giocatori[
              uid
            ];

            partita.ordineGiocatori =
              partita.ordineGiocatori.filter(
                id =>
                  id !==
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

              return;
            }

            if (
              !eraLuiIlGiocatoreAttivo
            ) {
              const nuovoIndice =
                partita
                  .ordineGiocatori
                  .indexOf(
                    idGiocatoreAttivoPrima
                  );

              partita.turnoAttuale =
                nuovoIndice >=
                0
                  ? nuovoIndice
                  : 0;
            } else if (
              partita.turnoAttuale >=
              partita.ordineGiocatori.length
            ) {
              partita.turnoAttuale =
                0;
            }

            if (
              restanti.length ===
              1
            ) {
              const vincitoreId =
                restanti[
                  0
                ];

              const vincitoreNome =
                partita.giocatori[
                  vincitoreId
                ].nome;

              fermaTimerTurno(
                partita
              );

              partita.fase =
                "terminata";

              partita.iniziata =
                false;

              partita.statoTurno =
                "attesa";

              const statoGiocatori =
                costruisciStatoGiocatori(
                  partita
                );

              Object.values(
                partita.giocatori
              ).forEach(
                g => {
                  if (
                    g.socket &&
                    g.socket.readyState ===
                      WebSocket.OPEN
                  ) {
                    try {
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
                    } catch {}
                  }
                }
              );

              await concludiPartita(
                partita,
                vincitoreId,
                nomeStanza
              );

              await aggiornaStatoPartita(
                partita.id,
                {
                  fase:
                    "terminata",

                  iniziata:
                    false,

                  statoTurno:
                    "attesa",

                  giocatori:
                    preparaGiocatoriPerFirebase(
                      partita.giocatori
                    ),

                  ordineGiocatori:
                    partita.ordineGiocatori,

                  abbandonati:
                    partita.abbandonati
                }
              );

              inviaListaPartite(
                nomeStanza
              );

              inviaConteggioStanze();

              return;
            }

            if (
              eraLuiIlGiocatoreAttivo
            ) {
              partita.tiriEffettuatiNelTurno =
                0;

              partita.tiriConsentitiNelTurno =
                1;

              partita.animazioneTiroInCorso =
                false;

              partita.elaborandoTiro =
                false;

              partita.statoTurno =
                "attesa";

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
            ).forEach(
              g => {
                if (
                  g.socket &&
                  g.socket.readyState ===
                    WebSocket.OPEN
                ) {
                  try {
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
                          partita
                            .tempoInizioTurno ||
                          null,

                        scadenzaTurno:
                          partita
                            .scadenzaTurno ||
                          null,

                        durataMossaMs:
                          millisecondiMossa(
                            partita
                          ),

                        tiriEffettuatiNelTurno:
                          partita
                            .tiriEffettuatiNelTurno,

                        tiriConsentitiNelTurno:
                          partita
                            .tiriConsentitiNelTurno
                      })
                    );
                  } catch {}
                }
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

                partecipantiOriginali:
                  partita.partecipantiOriginali,

                abbandonati:
                  partita.abbandonati,

                turnoAttuale:
                  partita.turnoAttuale,

                tiriEffettuatiNelTurno:
                  partita
                    .tiriEffettuatiNelTurno,

                tiriConsentitiNelTurno:
                  partita
                    .tiriConsentitiNelTurno,

                statoTurno:
                  partita.statoTurno,

                tempoInizioTurno:
                  partita
                    .tempoInizioTurno ||
                  null,

                scadenzaTurno:
                  partita
                    .scadenzaTurno ||
                  null,

                iniziata:
                  partita.iniziata
              }
            );

            inviaListaPartite(
              nomeStanza
            );

            inviaConteggioStanze();

            return;
          }
        } catch (
          erroreInterno
        ) {
          console.error(
            "Errore nella gestione di un messaggio:",
            erroreInterno
          );
        }
      }
    );

    /* =====================================================
       CHIUSURA SOCKET
       ===================================================== */

    socket.on(
      "close",
      async () => {
        try {
          delete socketsPerId[
            socketId
          ];

          if (
            stanzaAttuale &&
            stanze[
              stanzaAttuale
            ]
          ) {
            const connessioneOnline =
              stanze[
                stanzaAttuale
              ].giocatoriOnline[
                socketId
              ];

            if (
              connessioneOnline
            ) {
              delete stanze[
                stanzaAttuale
              ].giocatoriOnline[
                socketId
              ];

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
                      ].giocatoriOnline
                    ).length
                }
              );
            }
          }

          if (
            !stanzaAttuale ||
            !stanze[
              stanzaAttuale
            ] ||
            !uid
          ) {
            return;
          }

          const partite =
            stanze[
              stanzaAttuale
            ].partite;

          for (
            const pid in
              partite
          ) {
            const partita =
              partite[
                pid
              ];

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

            if (
              !giocatore
            ) {
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
              stanzaAttuale,
              uid
            );
          }

          inviaListaPartite(
            stanzaAttuale
          );

          inviaConteggioStanze();
        } catch (
          erroreInterno
        ) {
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
   HEALTH CHECK
   ========================================================= */

app.get(
  "/health",
  async (
    req,
    res
  ) => {
    res.json({
      ok:
        true,

      server:
        "online",

      database:
        !!db,

      eloIniziale:
        ELO_INIZIALE,

      timestamp:
        Date.now()
    });
  }
);

/* =========================================================
   MIGRAZIONE ELO ALL'AVVIO
   ========================================================= */

async function migraTuttiGliUtentiElo() {
  if (!db) {
    return;
  }

  try {
    const snap =
      await db
        .ref(
          "utenti"
        )
        .once(
          "value"
        );

    const utenti =
      snap.val() ||
      {};

    let migrati =
      0;

    for (
      const uid of
        Object.keys(
          utenti
        )
    ) {
      const prima =
        JSON.stringify(
          utenti[
            uid
          ]
        );

      await migraUtenteElo(
        uid,
        utenti[
          uid
        ]
      );

      const dopo =
        JSON.stringify(
          utenti[
            uid
          ]
        );

      if (
        prima !==
        dopo
      ) {
        migrati++;
      }
    }

    console.log(
      "Migrazione ELO completata. Account controllati:",
      Object.keys(
        utenti
      ).length,
      "Account aggiornati:",
      migrati
    );
  } catch (
    errore
  ) {
    console.error(
      "Errore migrazione ELO:",
      errore
    );
  }
}

/* =========================================================
   GESTORE ERRORI
   ========================================================= */

app.use(
  (
    errore,
    req,
    res,
    next
  ) => {
    console.error(
      "Errore Express:",
      errore
    );

    if (
      errore &&
      errore.name ===
      "MulterError"
    ) {
      return res.status(
        400
      ).json({
        errore:
          errore.message ||
          "Errore caricamento file."
      });
    }

    return res.status(
      500
    ).json({
      errore:
        errore &&
        errore.message
          ? errore.message
          : "Errore interno del server."
    });
  }
);

/* =========================================================
   AVVIO
   ========================================================= */

server.listen(
  PORT,
  async () => {
    console.log(
      "Server avviato sulla porta " +
      PORT
    );

    console.log(
      "Sistema ELO attivo."
    );

    console.log(
      "ELO iniziale:",
      ELO_INIZIALE
    );

    console.log(
      "K nuovo:",
      ELO_K_NUOVO
    );

    console.log(
      "K intermedio:",
      ELO_K_INTERMEDIO
    );

    console.log(
      "K esperto:",
      ELO_K_ESPERTO
    );

    try {
      await migraTuttiGliUtentiElo();

      await ripristinaPartiteDaFirebase();
    } catch (
      errore
    ) {
      console.error(
        "Errore inizializzazione server:",
        errore
      );
    }
  }
);

/* =========================================================
   CHIUSURA PROCESSO
   ========================================================= */

async function chiudiServer(
  segnale
) {
  console.log(
    `Ricevuto ${segnale}: chiusura server...`
  );

  try {
    wss.clients.forEach(
      socket => {
        try {
          socket.close(
            1001,
            "Server in chiusura"
          );
        } catch {}
      }
    );

    server.close(
      () => {
        console.log(
          "Server HTTP chiuso."
        );

        process.exit(
          0
        );
      }
    );

    setTimeout(
      () => {
        process.exit(
          0
        );
      },
      10000
    );
  } catch (
    errore
  ) {
    console.error(
      "Errore chiusura server:",
      errore
    );

    process.exit(
      1
    );
  }
}

process.on(
  "SIGTERM",
  () =>
    chiudiServer(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    chiudiServer(
      "SIGINT"
    )
);

process.on(
  "unhandledRejection",
  errore => {
    console.error(
      "UNHANDLED REJECTION:",
      errore
    );
  }
);

process.on(
  "uncaughtException",
  errore => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      errore
    );
  }
);
