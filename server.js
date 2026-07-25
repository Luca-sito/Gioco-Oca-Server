const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const cookieParser = require("cookie-parser");


const app = express();


app.use(cors({
  origin: true,
  credentials: true
}));

app.use(cookieParser());

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));



const server = http.createServer(app);


const PORT = process.env.PORT || 3000;


const JWT_SECRET = process.env.JWT_SECRET || "cambia-questo-secret";



let db = null;



try {

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );


  admin.initializeApp({

    credential: admin.credential.cert(serviceAccount),

    databaseURL:
    "https://giochi-societa-e8add-default-rtdb.europe-west1.firebasedatabase.app"

  });


  db = admin.database();


  console.log("Firebase Admin inizializzato correttamente.");

} catch (e) {

  console.error(
    "Firebase Admin NON inizializzato:",
    e.message
  );

}



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

    return jwt.verify(
      token,
      JWT_SECRET
    );

  } catch(e) {

    return null;

  }

}



function estraiTokenHeader(req) {


  if (req.cookies && req.cookies.token) {

    return req.cookies.token;

  }



  const header =
    req.headers.authorization || "";



  const parti =
    header.split(" ");



  if (parti.length === 2) {

    return parti[1];

  }



  return null;

}



function estraiCookieToken(cookieHeader) {


  if (!cookieHeader) {

    return null;

  }



  const trovato =
    cookieHeader
    .split(";")
    .find(c =>
      c.trim().startsWith("token=")
    );



  if (!trovato) {

    return null;

  }



  return decodeURIComponent(
    trovato.split("=")[1]
  );

}



async function richiediAuth(req,res,next) {


  const dati =
    verificaToken(
      estraiTokenHeader(req)
    );



  if (!dati) {

    return res.status(401).json({
      errore:"Devi effettuare il login."
    });

  }



  req.utente = dati;


  next();

}



async function richiediAdmin(req,res,next) {


  const dati =
    verificaToken(
      estraiTokenHeader(req)
    );



  if (!dati) {

    return res.status(401).json({
      errore:"Devi effettuare il login."
    });

  }



  if (dati.ruolo !== "admin") {

    return res.status(403).json({
      errore:"Accesso riservato agli amministratori."
    });

  }



  req.utenteAdmin = dati;


  next();

}

async function trovaUtentePerEmail(emailLower){

  const snap =
    await db.ref("utenti")
    .orderByChild("emailLower")
    .equalTo(emailLower)
    .once("value");


  if(!snap.exists()) return null;


  const val = snap.val();

  const uid = Object.keys(val)[0];


  return {
    uid,
    ...val[uid]
  };

}



async function trovaUtentePerNickname(nicknameLower){

  const snap =
    await db.ref("utenti")
    .orderByChild("nicknameLower")
    .equalTo(nicknameLower)
    .once("value");


  if(!snap.exists()) return null;


  const val = snap.val();

  const uid = Object.keys(val)[0];


  return {
    uid,
    ...val[uid]
  };

}




app.post("/api/registrati", async(req,res)=>{


  if(!db){

    return res.status(500).json({
      errore:"Database non disponibile."
    });

  }



  try{


    const {
      email,
      nickname,
      password
    } = req.body;



    if(!email || !nickname || !password){

      return res.status(400).json({
        errore:"Compila tutti i campi."
      });

    }



    if(password.length < 6){

      return res.status(400).json({
        errore:"La password deve avere almeno 6 caratteri."
      });

    }



    const emailLower =
      email.trim().toLowerCase();



    const nicknamePulito =
      nickname.trim();



    const nicknameLower =
      nicknamePulito.toLowerCase();



    if(await trovaUtentePerEmail(emailLower)){

      return res.status(400).json({
        errore:"Email già registrata."
      });

    }



    if(await trovaUtentePerNickname(nicknameLower)){

      return res.status(400).json({
        errore:"Nickname già utilizzato."
      });

    }



    const passwordHash =
      await bcrypt.hash(password,10);



    const ref =
      db.ref("utenti").push();



    const uid =
      ref.key;



    const nuovoUtente = {

      email:email.trim(),

      emailLower,

      nickname:nicknamePulito,

      nicknameLower,

      passwordHash,

      ruolo:"utente",

      stato:"attivo",

      sospesoFino:null,

      partiteVinte:0,

      partiteGiocate:0,

      puntiTotali:0,

      avvisi:[],

      creatoIl:Date.now()

    };



    await ref.set(nuovoUtente);



    const token =
      creaToken(
        uid,
        nicknamePulito,
        "utente"
      );



    res.cookie(
      "token",
      token,
      {
        httpOnly:true,
        secure:true,
        sameSite:"none",
        maxAge:
        30*24*60*60*1000
      }
    );



    res.json({

      nickname:nicknamePulito,

      ruolo:"utente"

    });



  }catch(e){


    console.error(e);


    res.status(500).json({

      errore:"Errore del server."

    });


  }


});






app.post("/api/login",async(req,res)=>{


  if(!db){

    return res.status(500).json({
      errore:"Database non disponibile."
    });

  }



  try{


    const {
      email,
      password
    } = req.body;



    if(!email || !password){

      return res.status(400).json({
        errore:"Inserisci email e password."
      });

    }



    const utente =
      await trovaUtentePerEmail(
        email.trim().toLowerCase()
      );



    if(!utente){

      return res.status(400).json({
        errore:"Email o password errati."
      });

    }



    const passwordOk =
      await bcrypt.compare(
        password,
        utente.passwordHash
      );



    if(!passwordOk){

      return res.status(400).json({
        errore:"Email o password errati."
      });

    }



    if(utente.stato==="bannato"){

      return res.status(403).json({
        errore:"Account bannato."
      });

    }



    if(
      utente.stato==="sospeso" &&
      utente.sospesoFino &&
      utente.sospesoFino>Date.now()
    ){

      return res.status(403).json({
        errore:
        "Account sospeso."
      });

    }



    const token =
      creaToken(
        utente.uid,
        utente.nickname,
        utente.ruolo || "utente"
      );



    res.cookie(
      "token",
      token,
      {
        httpOnly:true,
        secure:true,
        sameSite:"none",
        maxAge:
        30*24*60*60*1000
      }
    );



    res.json({

      nickname:utente.nickname,

      ruolo:utente.ruolo || "utente"

    });



  }catch(e){

    console.error(e);


    res.status(500).json({
      errore:"Errore del server."
    });

  }


});






app.get("/api/verifica-sessione",richiediAuth,(req,res)=>{


  res.json({

    loggato:true,

    nickname:req.utente.nickname,

    ruolo:req.utente.ruolo

  });


});






app.get("/api/me",richiediAuth,async(req,res)=>{


  try{


    const snap =
      await db.ref(
        "utenti/"+req.utente.uid
      )
      .once("value");



    const utente =
      snap.val();



    if(!utente){

      return res.status(404).json({
        errore:"Utente non trovato."
      });

    }



    res.json({

      nickname:utente.nickname,

      email:utente.email,

      ruolo:utente.ruolo,

      stato:utente.stato,

      partiteVinte:
      utente.partiteVinte || 0,

      partiteGiocate:
      utente.partiteGiocate || 0

    });



  }catch(e){

    res.status(500).json({
      errore:"Errore server."
    });

  }


});

app.post("/api/modifica-nickname", richiediAuth, async(req,res)=>{


  if(!db){

    return res.status(500).json({
      errore:"Database non disponibile."
    });

  }



  try{


    const nuovoNickname =
      req.body.nickname?.trim();



    if(!nuovoNickname){

      return res.status(400).json({
        errore:"Inserisci un nickname."
      });

    }



    if(nuovoNickname.length < 3){

      return res.status(400).json({
        errore:"Il nickname deve avere almeno 3 caratteri."
      });

    }



    const nicknameLower =
      nuovoNickname.toLowerCase();



    const esistente =
      await trovaUtentePerNickname(
        nicknameLower
      );



    if(
      esistente &&
      esistente.uid !== req.utente.uid
    ){

      return res.status(400).json({
        errore:"Nickname già utilizzato."
      });

    }



    await db.ref(
      "utenti/"+req.utente.uid
    )
    .update({

      nickname:nuovoNickname,

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

      {

        httpOnly:true,

        secure:true,

        sameSite:"none",

        maxAge:
        30*24*60*60*1000

      }

    );



    res.json({

      ok:true,

      nickname:nuovoNickname

    });



  }catch(e){

    console.error(e);


    res.status(500).json({
      errore:"Errore durante la modifica."
    });

  }


});







app.post("/api/contatti",async(req,res)=>{


  if(!db){

    return res.status(500).json({
      errore:"Database non disponibile."
    });

  }



  try{


    let {

      nickname,

      email,

      categoria,

      messaggio

    } = req.body;



    if(!messaggio || !messaggio.trim()){

      return res.status(400).json({
        errore:"Inserisci un messaggio."
      });

    }



    const datiToken =
      verificaToken(
        estraiTokenHeader(req)
      );



    let uidMittente = null;



    if(datiToken){


      uidMittente =
        datiToken.uid;



      const snap =
        await db.ref(
          "utenti/"+uidMittente
        )
        .once("value");



      const utente =
        snap.val();



      if(utente){

        nickname =
          utente.nickname;


        email =
          utente.email;

      }

    }



    if(!nickname || !email){

      return res.status(400).json({
        errore:"Nickname ed email obbligatori."
      });

    }




    const nuovo =
      db.ref("contatti").push();



    await nuovo.set({

      nickname:nickname.trim(),

      email:email.trim(),

      categoria:
      categoria || "Altro",

      messaggio:
      messaggio.trim(),

      uidMittente,

      letto:false,

      data:Date.now()

    });



    res.json({

      ok:true,

      messaggio:
      "Richiesta inviata correttamente."

    });



  }catch(e){

    console.error(e);


    res.status(500).json({
      errore:"Errore durante il salvataggio."
    });

  }


});







app.get("/api/top-giocatori",async(req,res)=>{


  try{


    if(!db){

      return res.json({
        giocatori:[]
      });

    }



    const snap =
      await db.ref("utenti")
      .once("value");



    const utenti =
      snap.val() || {};



    const classifica =
      Object.values(utenti)

      .map(u=>({

        nickname:
        u.nickname || "Sconosciuto",

        vinte:
        u.partiteVinte || 0,

        giocate:
        u.partiteGiocate || 0

      }))

      .sort((a,b)=>{

        if(b.vinte !== a.vinte){

          return b.vinte-a.vinte;

        }

        return b.giocate-a.giocate;

      })

      .slice(0,10);



    res.json({

      giocatori:classifica

    });



  }catch(e){

    console.error(e);


    res.status(500).json({
      giocatori:[]
    });

  }


});







app.get("/api/admin/utenti",richiediAdmin,async(req,res)=>{


  try{


    const snap =
      await db.ref("utenti")
      .once("value");



    const utenti =
      snap.val() || {};



    const lista =
      Object.keys(utenti)
      .map(uid=>({

        uid,

        email:
        utenti[uid].email,

        nickname:
        utenti[uid].nickname,

        ruolo:
        utenti[uid].ruolo || "utente",

        stato:
        utenti[uid].stato || "attivo",

        sospesoFino:
        utenti[uid].sospesoFino || null,

        avvisi:
        utenti[uid].avvisi || []

      }));



    res.json({

      utenti:lista

    });



  }catch(e){

    res.status(500).json({
      errore:"Errore server."
    });

  }


});







app.post("/api/admin/avviso",richiediAdmin,async(req,res)=>{


  const {
    uid,
    motivo
  } = req.body;



  if(!uid || !motivo){

    return res.status(400).json({
      errore:"Dati mancanti."
    });

  }



  const ref =
    db.ref(
      "utenti/"+uid+"/avvisi"
    );



  const snap =
    await ref.once("value");



  const avvisi =
    snap.val() || [];



  avvisi.push({

    data:Date.now(),

    motivo

  });



  await ref.set(avvisi);



  res.json({
    ok:true
  });


});

app.post("/api/admin/sospendi",richiediAdmin,async(req,res)=>{


  const {
    uid,
    giorni,
    motivo
  } = req.body;



  if(!uid || !giorni){

    return res.status(400).json({
      errore:"Dati mancanti."
    });

  }



  const sospesoFino =
    Date.now() +
    (
      parseInt(giorni) *
      24 *
      60 *
      60 *
      1000
    );



  await db.ref(
    "utenti/"+uid
  )
  .update({

    stato:"sospeso",

    sospesoFino,

    motivoSospensione:
    motivo || ""

  });



  res.json({
    ok:true
  });


});






app.post("/api/admin/rimuovi-sospensione",richiediAdmin,async(req,res)=>{


  const {uid}=req.body;



  if(!uid){

    return res.status(400).json({
      errore:"Dati mancanti."
    });

  }



  await db.ref(
    "utenti/"+uid
  )
  .update({

    stato:"attivo",

    sospesoFino:null

  });



  res.json({
    ok:true
  });


});






app.post("/api/admin/banna",richiediAdmin,async(req,res)=>{


  const {
    uid,
    motivo
  }=req.body;



  if(!uid){

    return res.status(400).json({
      errore:"Dati mancanti."
    });

  }



  await db.ref(
    "utenti/"+uid
  )
  .update({

    stato:"bannato",

    motivoBan:
    motivo || ""

  });



  res.json({
    ok:true
  });


});






app.post("/api/admin/riattiva",richiediAdmin,async(req,res)=>{


  const {uid}=req.body;



  if(!uid){

    return res.status(400).json({
      errore:"Dati mancanti."
    });

  }



  await db.ref(
    "utenti/"+uid
  )
  .update({

    stato:"attivo",

    sospesoFino:null

  });



  res.json({
    ok:true
  });


});







function preparaGiocatoriPerFirebase(giocatori){


  const risultato={};



  for(const uid in giocatori){


    risultato[uid]={

      nome:
      giocatori[uid].nome,

      posizione:
      giocatori[uid].posizione,

      turniSaltati:
      giocatori[uid].turniSaltati || 0

    };


  }



  return risultato;


}






async function salvaPartita(partita){


  if(!db)return;



  await db.ref(
    "partite/"+partita.id
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

    codicePrivato:
    partita.codicePrivato || null,

    maxGiocatori:
    partita.maxGiocatori,

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

    aggiornataIl:
    Date.now()

  });


}







async function caricaPartite(){


  if(!db)return {};



  const snap =
    await db.ref("partite")
    .once("value");



  return snap.val() || {};


}







async function aggiornaStatoPartita(id,dati){


  if(!db)return;



  await db.ref(
    "partite/"+id
  )
  .update({

    ...dati,

    aggiornataIl:
    Date.now()

  });


}







async function rimuoviPartita(nomeStanza,id){


  if(stanze[nomeStanza]){

    delete stanze[nomeStanza].partite[id];

  }



  if(db){

    await db.ref(
      "partite/"+id
    )
    .remove();

  }


}







async function aggiornaStatistichePartitaConclusa(partita,vincitoreUid){


  if(!db)return;



  try{


    const aggiornamenti={};



    partita.ordineGiocatori
    .forEach(id=>{


      aggiornamenti[
        "utenti/"+id+"/partiteGiocate"
      ] =
      admin.database.ServerValue.increment(1);


    });



    if(vincitoreUid){


      aggiornamenti[
        "utenti/"+vincitoreUid+"/partiteVinte"
      ] =
      admin.database.ServerValue.increment(1);


    }



    await db.ref()
    .update(aggiornamenti);



  }catch(e){


    console.error(
      "Errore statistiche:",
      e.message
    );


  }


}

// ===============================
// FUNZIONI AUTENTICAZIONE JWT
// ===============================

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

    return jwt.verify(
      token,
      JWT_SECRET
    );

  } catch (e) {

    return null;

  }

}


// Recupera token dal cookie HttpOnly
function estraiTokenHeader(req) {

  if (req.cookies && req.cookies.token) {

    return req.cookies.token;

  }


  const header = req.headers.authorization || "";

  const parti = header.split(" ");


  if (parti.length === 2 && parti[0] === "Bearer") {

    return parti[1];

  }


  return null;

}


// Recupera token dal cookie del WebSocket
function estraiCookieToken(cookieHeader) {

  if (!cookieHeader) return null;


  const cookie = cookieHeader
    .split(";")
    .find(c => c.trim().startsWith("token="));


  if (!cookie) return null;


  return decodeURIComponent(
    cookie.split("=")[1]
  );

}



// ===============================
// MIDDLEWARE AUTENTICAZIONE
// ===============================


async function richiediAuth(req, res, next) {

  const token = estraiTokenHeader(req);

  const dati = verificaToken(token);


  if (!dati) {

    return res.status(401).json({
      errore: "Devi effettuare il login."
    });

  }


  req.utente = dati;


  next();

}



async function richiediAdmin(req, res, next) {


  const token = estraiTokenHeader(req);

  const dati = verificaToken(token);



  if (!dati) {

    return res.status(401).json({
      errore: "Devi effettuare il login."
    });

  }



  if (dati.ruolo !== "admin") {

    return res.status(403).json({
      errore: "Accesso riservato agli amministratori."
    });

  }



  req.utenteAdmin = dati;


  next();

}

// ===============================
// FUNZIONI RICERCA UTENTI FIREBASE
// ===============================


async function trovaUtentePerEmail(emailLower) {

  if (!db) return null;


  const snap = await db
    .ref("utenti")
    .orderByChild("emailLower")
    .equalTo(emailLower)
    .once("value");


  if (!snap.exists()) return null;


  const dati = snap.val();

  const uid = Object.keys(dati)[0];


  return {
    uid,
    ...dati[uid]
  };

}



async function trovaUtentePerNickname(nicknameLower) {

  if (!db) return null;


  const snap = await db
    .ref("utenti")
    .orderByChild("nicknameLower")
    .equalTo(nicknameLower)
    .once("value");


  if (!snap.exists()) return null;


  const dati = snap.val();

  const uid = Object.keys(dati)[0];


  return {
    uid,
    ...dati[uid]
  };

}



// ===============================
// REGISTRAZIONE UTENTE
// ===============================


app.post("/api/registrati", async (req, res) => {


  if (!db) {

    return res.status(500).json({
      errore: "Servizio account non disponibile."
    });

  }



  try {


    const {
      email,
      nickname,
      password
    } = req.body;



    if (!email || !nickname || !password) {

      return res.status(400).json({
        errore: "Compila tutti i campi."
      });

    }



    if (password.length < 6) {

      return res.status(400).json({
        errore: "La password deve avere almeno 6 caratteri."
      });

    }



    const emailPulita = email.trim();

    const nicknamePulito = nickname.trim();



    const emailLower = emailPulita.toLowerCase();

    const nicknameLower = nicknamePulito.toLowerCase();




    if (await trovaUtentePerEmail(emailLower)) {

      return res.status(400).json({
        errore: "Questa email è già registrata."
      });

    }




    if (await trovaUtentePerNickname(nicknameLower)) {

      return res.status(400).json({
        errore: "Questo nickname è già utilizzato."
      });

    }





    const passwordHash = await bcrypt.hash(
      password,
      10
    );



    const nuovoUtente = db
      .ref("utenti")
      .push();



    const uid = nuovoUtente.key;



    await nuovoUtente.set({

      email: emailPulita,

      emailLower,

      nickname: nicknamePulito,

      nicknameLower,

      passwordHash,

      ruolo: "utente",

      stato: "attivo",

      sospesoFino: null,

      partiteVinte: 0,

      partiteGiocate: 0,

      puntiTotali: 0,

      avvisi: [],

      creatoIl: Date.now()

    });




    const token = creaToken(

      uid,

      nicknamePulito,

      "utente"

    );




    res.cookie(
      "token",
      token,
      {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 30 * 24 * 60 * 60 * 1000
      }
    );





    res.json({

      nickname: nicknamePulito,

      ruolo: "utente"

    });




  } catch (errore) {


    console.error(
      "Errore registrazione:",
      errore
    );


    res.status(500).json({

      errore: "Errore del server."

    });


  }


});

// ===============================
// LOGIN UTENTE
// ===============================


app.post("/api/login", async (req, res) => {


  if (!db) {

    return res.status(500).json({

      errore: "Servizio account non disponibile."

    });

  }



  try {


    const {
      email,
      password
    } = req.body;




    if (!email || !password) {

      return res.status(400).json({

        errore: "Inserisci email e password."

      });

    }





    const emailLower = email
      .trim()
      .toLowerCase();




    const utente = await trovaUtentePerEmail(
      emailLower
    );




    if (!utente) {

      return res.status(400).json({

        errore: "Email o password errati."

      });

    }





    const passwordCorretta = await bcrypt.compare(

      password,

      utente.passwordHash

    );





    if (!passwordCorretta) {

      return res.status(400).json({

        errore: "Email o password errati."

      });

    }





    if (utente.stato === "bannato") {

      return res.status(403).json({

        errore: "Account bannato."

      });

    }





    if (

      utente.stato === "sospeso" &&

      utente.sospesoFino &&

      utente.sospesoFino > Date.now()

    ) {


      const data = new Date(
        utente.sospesoFino
      ).toLocaleString("it-IT");



      return res.status(403).json({

        errore:
          "Account sospeso fino al " + data

      });


    }





    if (utente.stato === "sospeso") {

      await db
        .ref("utenti/" + utente.uid)
        .update({

          stato: "attivo",

          sospesoFino: null

        });


    }






    const token = creaToken(

      utente.uid,

      utente.nickname,

      utente.ruolo || "utente"

    );






    res.cookie(

      "token",

      token,

      {

        httpOnly: true,

        secure: true,

        sameSite: "none",

        maxAge:
          30 * 24 * 60 * 60 * 1000

      }

    );







    res.json({

      nickname: utente.nickname,

      ruolo: utente.ruolo || "utente"

    });






  } catch (errore) {


    console.error(

      "Errore login:",

      errore

    );



    res.status(500).json({

      errore: "Errore del server."

    });


  }


});



// ===============================
// VERIFICA SESSIONE
// ===============================


app.get(
  "/api/verifica-sessione",
  richiediAuth,
  (req,res)=>{


    res.json({

      loggato: true,

      nickname: req.utente.nickname,

      ruolo: req.utente.ruolo

    });


  }
);


// ===============================
// PROFILO UTENTE
// ===============================


app.get(
  "/api/me",
  richiediAuth,
  async (req, res) => {


    if (!db) {

      return res.status(500).json({

        errore: "Database non disponibile."

      });

    }



    try {


      const snap = await db
        .ref("utenti/" + req.utente.uid)
        .once("value");



      const utente = snap.val();



      if (!utente) {

        return res.status(404).json({

          errore: "Utente non trovato."

        });

      }





      res.json({

        nickname: utente.nickname,

        email: utente.email,

        ruolo: utente.ruolo || "utente",

        stato: utente.stato || "attivo",

        sospesoFino: utente.sospesoFino || null,

        avvisi: utente.avvisi || [],

        partiteVinte: utente.partiteVinte || 0,

        partiteGiocate: utente.partiteGiocate || 0,

        puntiTotali: utente.puntiTotali || 0

      });




    } catch (errore) {


      console.error(

        "Errore profilo:",

        errore

      );



      res.status(500).json({

        errore: "Errore del server."

      });


    }


  }

);




// ===============================
// MODIFICA NICKNAME
// ===============================


app.post(
  "/api/modifica-nickname",
  richiediAuth,
  async (req,res)=>{


    if (!db) {

      return res.status(500).json({

        errore: "Database non disponibile."

      });

    }




    try {


      const nuovoNickname =
        req.body.nickname?.trim();




      if (!nuovoNickname) {

        return res.status(400).json({

          errore: "Inserisci un nickname."

        });

      }




      if (nuovoNickname.length < 3) {

        return res.status(400).json({

          errore:
          "Il nickname deve avere almeno 3 caratteri."

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
        esistente.uid !== req.utente.uid
      ) {


        return res.status(400).json({

          errore:
          "Questo nickname è già utilizzato."

        });


      }





      await db
        .ref("utenti/" + req.utente.uid)
        .update({

          nickname: nuovoNickname,

          nicknameLower

        });







      const nuovoToken = creaToken(

        req.utente.uid,

        nuovoNickname,

        req.utente.ruolo

      );






      res.cookie(

        "token",

        nuovoToken,

        {

          httpOnly: true,

          secure: true,

          sameSite: "none",

          maxAge:
          30 * 24 * 60 * 60 * 1000

        }

      );






      res.json({

        ok: true,

        nickname: nuovoNickname

      });





    } catch (errore) {


      console.error(

        "Errore modifica nickname:",

        errore

      );



      res.status(500).json({

        errore:
        "Errore durante la modifica."

      });


    }



  }

);

// ===============================
// API CONTATTI
// ===============================


app.post(
  "/api/contatti",
  async (req, res) => {


    if (!db) {

      return res.status(500).json({

        errore: "Firebase non disponibile."

      });

    }



    try {


      let {

        nickname,

        email,

        categoria,

        messaggio

      } = req.body;





      if (!messaggio || !messaggio.trim()) {


        return res.status(400).json({

          errore:
          "Scrivi un messaggio prima di inviare."

        });


      }






      const datiToken = verificaToken(

        estraiTokenHeader(req)

      );





      let uidMittente = null;





      if (datiToken) {


        uidMittente = datiToken.uid;



        const snap = await db

          .ref("utenti/" + datiToken.uid)

          .once("value");



        const utente = snap.val();




        if (utente) {


          nickname = utente.nickname;

          email = utente.email;


        }


      }







      if (!nickname || !email) {


        return res.status(400).json({

          errore:
          "Nickname ed email obbligatori."

        });


      }






      const nuovoContatto = db

        .ref("contatti")

        .push();







      await nuovoContatto.set({

        nickname: nickname.trim(),

        email: email.trim(),

        categoria:
          categoria || "Altro",

        messaggio:
          messaggio.trim(),

        uidMittente,

        letto: false,

        data: Date.now()

      });







      res.json({

        ok: true,

        messaggio:
        "Richiesta inviata correttamente."

      });






    } catch (errore) {


      console.error(

        "Errore contatti:",

        errore

      );



      res.status(500).json({

        errore:
        "Errore durante il salvataggio."

      });


    }



  }

);





// ===============================
// CLASSIFICA GIOCATORI
// ===============================


app.get(
  "/api/top-giocatori",
  async (req,res)=>{


    try {


      if (!db) {


        return res.json({

          giocatori: []

        });


      }






      const snap = await db

        .ref("utenti")

        .once("value");





      const utenti = snap.val() || {};






      const classifica = Object

        .values(utenti)

        .map(u => ({


          nickname:
          u.nickname || "Sconosciuto",


          vinte:
          u.partiteVinte || 0,


          giocate:
          u.partiteGiocate || 0,


          punti:
          u.puntiTotali || 0


        }))



        .sort((a,b)=>{


          if (b.vinte !== a.vinte) {

            return b.vinte - a.vinte;

          }


          return b.punti - a.punti;


        })



        .slice(0,10);







      res.json({

        giocatori: classifica

      });







    } catch (errore) {


      console.error(

        "Errore classifica:",

        errore

      );



      res.status(500).json({

        giocatori: []

      });


    }


  }

);

// ===============================
// API AMMINISTRATORE
// ===============================


// Lista utenti
app.get(
  "/api/admin/utenti",
  richiediAdmin,
  async (req,res)=>{


    if (!db) {

      return res.status(500).json({

        errore:
        "Database non disponibile."

      });

    }



    try {


      const snap = await db

        .ref("utenti")

        .once("value");



      const utenti = snap.val() || {};



      const lista = Object.keys(utenti).map(uid => ({


        uid,


        email:
        utenti[uid].email,


        nickname:
        utenti[uid].nickname,


        ruolo:
        utenti[uid].ruolo || "utente",


        stato:
        utenti[uid].stato || "attivo",


        sospesoFino:
        utenti[uid].sospesoFino || null,


        avvisi:
        utenti[uid].avvisi || []


      }));





      res.json({

        utenti: lista

      });





    } catch(e) {


      console.error(

        "Errore lista utenti:",

        e

      );


      res.status(500).json({

        errore:
        "Errore server."

      });


    }


  }

);





// Aggiungi avviso
app.post(
  "/api/admin/avviso",
  richiediAdmin,
  async(req,res)=>{


    try {


      const {
        uid,
        motivo
      } = req.body;



      if (!uid || !motivo) {

        return res.status(400).json({

          errore:
          "Dati mancanti."

        });

      }




      const ref = db

        .ref("utenti/" + uid + "/avvisi");




      const snap = await ref.once("value");



      const avvisi =
        snap.val() || [];




      avvisi.push({

        data: Date.now(),

        motivo

      });





      await ref.set(avvisi);




      res.json({

        ok:true

      });




    } catch(e) {


      console.error(e);


      res.status(500).json({

        errore:
        "Errore server."

      });


    }


  }

);





// Sospendi utente
app.post(
  "/api/admin/sospendi",
  richiediAdmin,
  async(req,res)=>{


    try {


      const {
        uid,
        giorni,
        motivo
      } = req.body;




      if (!uid || !giorni) {


        return res.status(400).json({

          errore:
          "Dati mancanti."

        });


      }





      const sospesoFino =
        Date.now() +
        (
          parseInt(giorni) *
          24 *
          60 *
          60 *
          1000
        );





      await db

        .ref("utenti/" + uid)

        .update({


          stato:"sospeso",


          sospesoFino,


          motivoSospensione:
          motivo || ""


        });





      res.json({

        ok:true

      });




    } catch(e) {


      console.error(e);


      res.status(500).json({

        errore:
        "Errore server."

      });


    }


  }

);





// Rimuovi sospensione
app.post(
  "/api/admin/rimuovi-sospensione",
  richiediAdmin,
  async(req,res)=>{


    const {
      uid
    } = req.body;



    if (!uid) {

      return res.status(400).json({

        errore:
        "Dati mancanti."

      });

    }





    await db

      .ref("utenti/" + uid)

      .update({

        stato:"attivo",

        sospesoFino:null

      });





    res.json({

      ok:true

    });


  }

);





// Banna utente
app.post(
  "/api/admin/banna",
  richiediAdmin,
  async(req,res)=>{


    const {
      uid,
      motivo
    } = req.body;




    if (!uid) {

      return res.status(400).json({

        errore:
        "Dati mancanti."

      });

    }





    await db

      .ref("utenti/" + uid)

      .update({

        stato:"bannato",

        motivoBan:
        motivo || ""

      });





    res.json({

      ok:true

    });


  }

);





// Riattiva utente
app.post(
  "/api/admin/riattiva",
  richiediAdmin,
  async(req,res)=>{


    const {
      uid
    } = req.body;




    if (!uid) {

      return res.status(400).json({

        errore:
        "Dati mancanti."

      });

    }





    await db

      .ref("utenti/" + uid)

      .update({

        stato:"attivo",

        sospesoFino:null

      });





    res.json({

      ok:true

    });


  }

);

// ===============================
// FUNZIONI SALVATAGGIO PARTITE FIREBASE
// ===============================


function preparaGiocatoriPerFirebase(giocatori) {

  const risultato = {};


  for (const uid in giocatori) {


    risultato[uid] = {

      nome:
      giocatori[uid].nome,


      posizione:
      giocatori[uid].posizione || 0,


      turniSaltati:
      giocatori[uid].turniSaltati || 0

    };

  }


  return risultato;

}





async function salvaPartita(partita) {


  if (!db) return;



  try {


    await db

      .ref("partite/" + partita.id)

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


        codicePrivato:
        partita.codicePrivato || null,


        maxGiocatori:
        partita.maxGiocatori,


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


        aggiornataIl:
        Date.now()


      });



  } catch(e) {


    console.error(
      "Errore salvataggio partita:",
      e.message
    );


  }


}







async function caricaPartite() {


  if (!db) return {};



  try {


    const snap = await db

      .ref("partite")

      .once("value");



    return snap.val() || {};



  } catch(e) {


    console.error(
      "Errore caricamento partite:",
      e.message
    );


    return {};

  }


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

      aggiornataIl:
      Date.now()

    });


}







async function rimuoviPartita(
  nomeStanza,
  partitaId
) {


  if (
    stanze[nomeStanza] &&
    stanze[nomeStanza].partite[partitaId]
  ) {


    delete stanze[nomeStanza]
      .partite[partitaId];


  }




  if (db) {


    try {


      await db

        .ref("partite/" + partitaId)

        .remove();



    } catch(e) {


      console.error(
        "Errore rimozione partita:",
        e.message
      );


    }


  }


}







async function aggiornaStatistichePartitaConclusa(
  partita,
  vincitoreUid
) {


  if (!db) return;



  try {


    const aggiornamenti = {};



    partita.ordineGiocatori
      .forEach(uid => {


        aggiornamenti[
          "utenti/" +
          uid +
          "/partiteGiocate"
        ] =
        admin.database.ServerValue.increment(1);


      });





    if (vincitoreUid) {


      aggiornamenti[
        "utenti/" +
        vincitoreUid +
        "/partiteVinte"
      ] =
      admin.database.ServerValue.increment(1);


    }





    await db

      .ref()

      .update(aggiornamenti);



  } catch(e) {


    console.error(
      "Errore statistiche:",
      e.message
    );


  }


}

// ===============================
// CONFIGURAZIONE GIOCO DELL'OCA
// ===============================


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




// ===============================
// STANZE ONLINE
// ===============================


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





let contatoreId = 0;


const socketsPerId = {};





// ===============================
// RIPRISTINO PARTITE DA FIREBASE
// ===============================


async function ripristinaPartiteDaFirebase() {


  const partiteFirebase =
    await caricaPartite();




  for (const id in partiteFirebase) {


    const p =
      partiteFirebase[id];



    if (!stanze[p.stanza]) continue;





    stanze[p.stanza].partite[id] = {


      ...p,


      codicePrivato:
      p.codicePrivato || null,


      maxGiocatori:
      p.maxGiocatori || 2,



      giocatori:
      p.giocatori || {},



      ordineGiocatori:
      p.ordineGiocatori || [],



      turnoAttuale:
      p.turnoAttuale || 0,



      iniziata:
      p.iniziata || false,



      elaborandoTiro:
      false


    };


  }




  console.log(

    "Partite ripristinate da Firebase:",

    Object.keys(partiteFirebase).length

  );


}

// ===============================
// FUNZIONI MOVIMENTO GIOCO
// ===============================


function calcolaMovimento(
  posizioneAttuale,
  valoreDado
) {


  let percorso = [];

  let nuovaPosizione =
    posizioneAttuale + valoreDado;


  let messaggi = [];

  let turniDaSaltare = 0;

  let vittoria = false;

  let tiraAncora = false;




  // Superamento casella 63 con rimbalzo

  if (nuovaPosizione > CASELLA_VITTORIA) {


    for (
      let p = posizioneAttuale + 1;
      p <= CASELLA_VITTORIA;
      p++
    ) {

      percorso.push(p);

    }



    const eccesso =
      nuovaPosizione - CASELLA_VITTORIA;



    nuovaPosizione =
      CASELLA_VITTORIA - eccesso;




    for (
      let p = CASELLA_VITTORIA - 1;
      p >= nuovaPosizione;
      p--
    ) {

      percorso.push(p);

    }



    messaggi.push(
      "Hai superato il traguardo, torni indietro!"
    );



  } else {



    for (
      let p = posizioneAttuale + 1;
      p <= nuovaPosizione;
      p++
    ) {

      percorso.push(p);

    }


  }






  // Vittoria


  if (nuovaPosizione === CASELLA_VITTORIA) {


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






  // Casella 6 tira ancora


  if (
    nuovaPosizione === CASELLA_TIRA_ANCORA
  ) {


    tiraAncora = true;


    messaggi.push(
      "Sei sulla casella speciale! Tira ancora."
    );


  }







  // Avanza ancora


  if (
    CASELLE_AVANZA_ANCORA.includes(
      nuovaPosizione
    )
  ) {


    messaggi.push(
      "Avanzi ancora dello stesso numero!"
    );



    const risultato =
      calcolaMovimento(
        nuovaPosizione,
        valoreDado
      );



    return {


      nuovaPosizione:
      risultato.nuovaPosizione,


      percorso:
      percorso.concat(
        risultato.percorso
      ),



      messaggi:
      messaggi.concat(
        risultato.messaggi
      ),



      turniDaSaltare:
      risultato.turniDaSaltare,



      vittoria:
      risultato.vittoria,



      tiraAncora:
      risultato.tiraAncora



    };


  }








  // Penalità turni


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






  // Torna indietro


  if (
    CASELLE_TORNA_A[nuovaPosizione] !== undefined
  ) {


    const destinazione =
      CASELLE_TORNA_A[nuovaPosizione];



    messaggi.push(
      "Torni alla casella " + destinazione
    );



    percorso.push(destinazione);



    nuovaPosizione =
      destinazione;


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





// ===============================
// DADI TRAMITE RANDOM.ORG
// ===============================


function tiraDadoRandomOrg() {

  return new Promise((resolve) => {


    const url =
      "https://www.random.org/integers/?num=2&min=1&max=6&col=1&base=10&format=plain&rnd=new";



    const richiesta = https.get(
      url,
      {
        timeout: 4000
      },
      (res) => {


        let dati = "";



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
                .map(n => parseInt(n.trim(), 10))
                .filter(
                  n =>
                  !isNaN(n) &&
                  n >= 1 &&
                  n <= 6
                );



              if (numeri.length === 2) {


                resolve({

                  dado1: numeri[0],

                  dado2: numeri[1]

                });


              } else {


                resolve(null);


              }



            } catch(e) {


              resolve(null);


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



  });


}






async function lanciaDueDadiSicuri() {


  const risultato =
    await tiraDadoRandomOrg();



  if (risultato) {


    return risultato;


  }




  // Backup se random.org non risponde


  return {


    dado1:
      Math.floor(Math.random() * 6) + 1,


    dado2:
      Math.floor(Math.random() * 6) + 1


  };


}

// ===============================
// ORDINE INIZIALE GIOCATORI
// ===============================


function determinaOrdineIniziale(idsGiocatori) {


  let risultati = idsGiocatori.map(id => ({


    id,


    punteggio:
      Math.floor(Math.random() * 11) + 2


  }));





  risultati.sort(
    (a, b) =>
      b.punteggio - a.punteggio
  );





  let ordineFinale = [];

  let i = 0;





  while (i < risultati.length) {


    let gruppoPari = [

      risultati[i]

    ];



    let j = i + 1;




    while (

      j < risultati.length &&

      risultati[j].punteggio === risultati[i].punteggio

    ) {


      gruppoPari.push(
        risultati[j]
      );


      j++;


    }






    if (gruppoPari.length > 1) {



      ordineFinale =
        ordineFinale.concat(

          determinaOrdineIniziale(

            gruppoPari.map(
              g => g.id
            )

          )

        );



    } else {



      ordineFinale.push(

        gruppoPari[0].id

      );


    }




    i = j;



  }





  return ordineFinale;


}







// ===============================
// AVVIO AUTOMATICO PARTITA
// ===============================


async function avviaPartitaAutomaticamente(
  partita
) {



  const idsGiocatori =
    Object.keys(
      partita.giocatori
    );





  const ordine =
    determinaOrdineIniziale(
      idsGiocatori
    );





  partita.ordineGiocatori =
    ordine;



  partita.turnoAttuale = 0;


  partita.iniziata = true;


  partita.elaborandoTiro = false;







  const nomi = ordine.map(
    id =>
    partita.giocatori[id].nome
  );







  Object.values(
    partita.giocatori
  ).forEach(
    giocatore => {



      if (
        giocatore.socket &&
        giocatore.socket.readyState === WebSocket.OPEN
      ) {



        giocatore.socket.send(

          JSON.stringify({

            tipo:
            "partitaAvviata",



            partitaId:
            partita.id,



            ordineGiocatori:
            nomi,



            turnoDiId:
            partita.ordineGiocatori[0]


          })

        );


      }



    }
  );







  await salvaPartita({

    ...partita,

    stanza:
    partita.stanza


  });



}







// ===============================
// CAMBIO TURNO
// ===============================


function passaAlProssimoTurno(
  partita
) {


  let tentativi = 0;




  do {



    partita.turnoAttuale =

      (
        partita.turnoAttuale + 1
      )

      %

      partita.ordineGiocatori.length;






    const idProssimo =

      partita.ordineGiocatori[
        partita.turnoAttuale
      ];





    const giocatore =

      partita.giocatori[
        idProssimo
      ];






    if (
      giocatore.turniSaltati > 0
    ) {



      giocatore.turniSaltati--;



      tentativi++;



    } else {



      break;



    }





  }

  while (

    tentativi <
    partita.ordineGiocatori.length

  );



}






// ===============================
// CERCA PARTITA
// ===============================


function trovaPartita(
  partitaId
) {



  for (
    const nomeStanza in stanze
  ) {



    if (
      stanze[nomeStanza]
      .partite[partitaId]
    ) {



      return {


        partita:

        stanze[nomeStanza]
        .partite[partitaId],



        nomeStanza


      };


    }


  }




  return null;


}

// ===============================
// CALCOLO MOVIMENTO PEDINA
// ===============================

function calcolaMovimento(
  posizioneAttuale,
  valoreDado
){

  let percorso = [];

  let nuovaPosizione =
    posizioneAttuale + valoreDado;


  let messaggi = [];

  let turniDaSaltare = 0;

  let vittoria = false;

  let tiraAncora = false;



  if (nuovaPosizione > CASELLA_VITTORIA) {


    for(
      let p = posizioneAttuale + 1;
      p <= CASELLA_VITTORIA;
      p++
    ){

      percorso.push(p);

    }


    const eccesso =
      nuovaPosizione - CASELLA_VITTORIA;


    nuovaPosizione =
      CASELLA_VITTORIA - eccesso;



    for(
      let p = CASELLA_VITTORIA - 1;
      p >= nuovaPosizione;
      p--
    ){

      percorso.push(p);

    }


    messaggi.push(
      "Hai superato il traguardo, torni indietro!"
    );

  }

  else {


    for(
      let p = posizioneAttuale + 1;
      p <= nuovaPosizione;
      p++
    ){

      percorso.push(p);

    }

  }



  if(nuovaPosizione === CASELLA_VITTORIA){

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



  if(nuovaPosizione === CASELLA_TIRA_ANCORA){

    tiraAncora = true;

    messaggi.push(
      "Sei sulla casella ponte! Tira ancora."
    );

  }



  if(
    CASELLE_AVANZA_ANCORA
    .includes(nuovaPosizione)
  ){

    messaggi.push(
      "Avanzi ancora dello stesso numero!"
    );


    const risultato =
      calcolaMovimento(
        nuovaPosizione,
        valoreDado
      );


    return {

      nuovaPosizione:
        risultato.nuovaPosizione,

      percorso:
        percorso.concat(risultato.percorso),

      messaggi:
        messaggi.concat(risultato.messaggi),

      turniDaSaltare:
        risultato.turniDaSaltare,

      vittoria:
        risultato.vittoria,

      tiraAncora:
        risultato.tiraAncora

    };

  }



  if(
    CASELLE_SALTA_TRE_TURNI
    .includes(nuovaPosizione)
  ){

    turniDaSaltare = 3;

    messaggi.push(
      "Salti 3 turni!"
    );

  }



  if(
    CASELLE_SALTA_UN_TURNO
    .includes(nuovaPosizione)
  ){

    turniDaSaltare = 1;

    messaggi.push(
      "Salti un turno!"
    );

  }



  if(
    CASELLE_TORNA_A[nuovaPosizione]
    !== undefined
  ){

    const destinazione =
      CASELLE_TORNA_A[nuovaPosizione];


    messaggi.push(
      "Torni alla casella " + destinazione
    );


    percorso.push(destinazione);

    nuovaPosizione =
      destinazione;

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

// ===============================
// FUNZIONI GESTIONE TURNI E PARTITE
// ===============================


function passaAlProssimoTurno(partita){

  let tentativi = 0;


  do {


    partita.turnoAttuale =
      (partita.turnoAttuale + 1)
      %
      partita.ordineGiocatori.length;



    const idProssimo =
      partita.ordineGiocatori[
        partita.turnoAttuale
      ];



    const giocatore =
      partita.giocatori[idProssimo];



    if(
      giocatore
      &&
      giocatore.turniSaltati > 0
    ){

      giocatore.turniSaltati--;

      tentativi++;

    }

    else {

      break;

    }


  }
  while(
    tentativi <
    partita.ordineGiocatori.length
  );

}




function trovaPartita(partitaId){


  for(
    const nomeStanza in stanze
  ){


    if(
      stanze[nomeStanza]
      .partite[partitaId]
    ){


      return {

        partita:
          stanze[nomeStanza]
          .partite[partitaId],


        nomeStanza

      };


    }


  }


  return null;

}




function inviaAllaStanza(
  nomeStanza,
  messaggio
){


  if(
    !stanze[nomeStanza]
  ){

    return;

  }



  Object.keys(
    stanze[nomeStanza]
    .giocatoriOnline
  )
  .forEach(id=>{


    const socket =
      socketsPerId[id];



    if(
      socket
      &&
      socket.readyState
      ===
      WebSocket.OPEN
    ){


      socket.send(
        JSON.stringify(messaggio)
      );


    }


  });


}





function inviaListaPartite(nomeStanza){


  if(
    !stanze[nomeStanza]
  ){

    return;

  }



  const lista =

    Object.values(
      stanze[nomeStanza].partite
    )

    .map(p=>({

      id:
        p.id,


      creatore:
        p.creatore,


      tempo:
        p.tempo,


      punti:
        p.punti,


      modalita:
        p.modalita,


      maxGiocatori:
        p.maxGiocatori,


      numGiocatoriAttuali:
        Object.keys(
          p.giocatori
        ).length

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




function inviaConteggioStanze(){


  const conteggi = {};

  const giocatoriPerStanza = {};



  for(
    const nome in stanze
  ){


    const giocatori =

      Object.values(
        stanze[nome]
        .giocatoriOnline
      );



    conteggi[nome] =
      giocatori.length;



    giocatoriPerStanza[nome] =
      giocatori;


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
    client=>{


      if(
        client.readyState
        ===
        WebSocket.OPEN
      ){

        client.send(
          messaggio
        );

      }


    }
  );


}




// ===============================
// HEARTBEAT WEBSOCKET
// evita connessioni morte
// ===============================


const HEARTBEAT_MS = 15000;


const heartbeatInterval =
  setInterval(()=>{


    wss.clients.forEach(
      socket=>{


        if(
          socket.isAlive === false
        ){

          return socket.terminate();

        }



        socket.isAlive = false;

        socket.ping();


      }
    );


  }, HEARTBEAT_MS);




wss.on(
  "close",
  ()=>{

    clearInterval(
      heartbeatInterval
    );

  }
);

// ===============================
// CONNESSIONE WEBSOCKET
// AUTENTICAZIONE TRAMITE COOKIE HTTPONLY
// ===============================


wss.on(
  "connection",
  (socket, request)=>{


    // recupera il token dal cookie inviato automaticamente dal browser

    const cookieToken =
      estraiCookieDaHeader(
        request.headers.cookie
      );



    socket.isAlive = true;


    socket.on(
      "pong",
      ()=>{

        socket.isAlive = true;

      }
    );



    const socketId =
      "s" + (contatoreId++);



    socketsPerId[socketId] =
      socket;



    let stanzaAttuale = null;

    let nickname = null;

    let uid = null;




    socket.on(
      "message",
      async(message)=>{


        try{


          let dati;


          try{

            dati =
              JSON.parse(message);

          }
          catch(e){

            return;

          }




          // ===============================
          // RICHIESTA CONTEGGIO STANZE
          // ===============================


          if(
            dati.tipo === "richiediConteggio"
          ){

            inviaConteggioStanze();

            return;

          }




          // ===============================
          // ENTRA NELLA LOBBY
          // ===============================


          if(
            dati.tipo === "entraLobby"
          ){



            if(!db){

              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Servizio account non disponibile."

                })
              );

              return;

            }




            const datiToken =
              verificaToken(
                cookieToken
              );



            if(!datiToken){


              socket.send(
                JSON.stringify({

                  tipo:
                    "sessioneScaduta"

                })
              );


              return;

            }




            const snap =
              await db
              .ref(
                "utenti/" + datiToken.uid
              )
              .once("value");



            const utenteDb =
              snap.val();




            if(!utenteDb){


              socket.send(
                JSON.stringify({

                  tipo:
                    "sessioneScaduta"

                })
              );


              return;

            }





            if(
              utenteDb.stato === "bannato"
            ){


              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Account bannato."

                })
              );


              return;

            }





            if(
              utenteDb.stato === "sospeso"

              &&

              utenteDb.sospesoFino

              &&

              utenteDb.sospesoFino > Date.now()

            ){


              const dataFine =
                new Date(
                  utenteDb.sospesoFino
                )
                .toLocaleString("it-IT");



              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Account sospeso fino al "
                    +
                    dataFine

                })
              );


              return;


            }





            if(!dati.stanza){

              return;

            }





            stanzaAttuale =
              dati.stanza;



            uid =
              datiToken.uid;



            nickname =
              utenteDb.nickname;




            if(
              !stanze[stanzaAttuale]
            ){

              stanze[stanzaAttuale] = {

                giocatoriOnline:{},

                partite:{}

              };

            }





            stanze[stanzaAttuale]
            .giocatoriOnline[socketId]
            =
            nickname;




            inviaConteggioStanze();



            inviaAllaStanza(

              stanzaAttuale,

              {

                tipo:
                  "online",

                numero:
                  Object.keys(
                    stanze[stanzaAttuale]
                    .giocatoriOnline
                  ).length

              }

            );



            inviaListaPartite(
              stanzaAttuale
            );



            return;

          }

// ===============================
// CONTINUA WEBSOCKET
// RIPRESA PARTITA
// ===============================


          if(
            dati.tipo === "riprendiPartita"
          ){


            const datiToken =
              verificaToken(
                cookieToken
              );



            if(!datiToken){


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



            if(!trovato){


              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Partita non trovata."

                })
              );


              return;

            }





            const partita =
              trovato.partita;



            stanzaAttuale =
              trovato.nomeStanza;



            uid =
              datiToken.uid;



            nickname =
              datiToken.nickname;




            const giocatore =
              partita.giocatori[uid];



            if(!giocatore){


              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Non fai parte di questa partita."

                })
              );


              return;

            }




            giocatore.socket =
              socket;




            const statoGiocatori =

              partita.ordineGiocatori
              .map(id=>({

                id,

                nome:
                  partita.giocatori[id].nome,

                posizione:
                  partita.giocatori[id].posizione

              }));




            socket.send(

              JSON.stringify({

                tipo:
                  "statoPartita",


                giocatori:
                  statoGiocatori,


                turnoDiId:
                  partita
                  .ordineGiocatori[
                    partita.turnoAttuale
                  ]

              })

            );



            return;

          }




// ===============================
// CREAZIONE PARTITA
// ===============================


          if(
            dati.tipo === "creaPartita"
          ){



            if(
              !stanzaAttuale
              ||
              !uid
            ){

              return;

            }




            const giaCreata =

              Object.values(
                stanze[stanzaAttuale]
                .partite
              )
              .some(
                p =>
                  p.creatoDa === uid
              );



            if(giaCreata){


              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Hai già una partita attiva."

                })
              );


              return;

            }




            const partitaId =

              "p"
              +
              Date.now()
              +
              Math.floor(
                Math.random()*1000
              );




            const nuovaPartita = {


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



              codicePrivato:

                dati.modalita === "privata"

                ?

                dati.codicePrivato

                :

                null,



              maxGiocatori:

                parseInt(
                  dati.maxGiocatori
                )
                ||
                2,



              giocatori:{


                [uid]:{


                  nome:
                    nickname,


                  posizione:
                    0,


                  socket:
                    socket,


                  turniSaltati:
                    0


                }

              },



              ordineGiocatori:
                [uid],



              turnoAttuale:
                0,



              iniziata:
                false,



              elaborandoTiro:
                false


            };




            stanze[stanzaAttuale]
            .partite[partitaId]
            =
            nuovaPartita;




            await salvaPartita({

              ...nuovaPartita,

              stanza:
                stanzaAttuale

            });




            inviaListaPartite(
              stanzaAttuale
            );



            return;

          }

// ===============================
// ENTRA IN UNA PARTITA ESISTENTE
// ===============================


          if(
            dati.tipo === "entraPartita"
          ){


            if(
              !stanzaAttuale
              ||
              !uid
            ){

              return;

            }




            const partita =

              stanze[stanzaAttuale]
              .partite[dati.id];



            if(!partita){

              return;

            }




            if(
              partita.giocatori[uid]
            ){

              return;

            }




            if(
              Object.keys(
                partita.giocatori
              ).length
              >=
              partita.maxGiocatori
            ){

              return;

            }




            if(
              partita.modalita === "privata"

              &&

              dati.codicePrivato
              !==
              partita.codicePrivato

            ){


              socket.send(
                JSON.stringify({

                  tipo:"errore",

                  messaggio:
                    "Codice partita non corretto."

                })
              );


              return;

            }




            partita.giocatori[uid] = {


              nome:
                nickname,


              posizione:
                0,


              socket:
                socket,


              turniSaltati:
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
                  partita.ordineGiocatori

              }

            );




            inviaListaPartite(
              stanzaAttuale
            );





            if(

              Object.keys(
                partita.giocatori
              ).length

              ===

              partita.maxGiocatori

            ){


              await avviaPartitaAutomaticamente(
                partita
              );


            }



            return;

          }





// ===============================
// ELIMINA PARTITA CREATA
// ===============================


          if(
            dati.tipo === "eliminaPartita"
          ){



            if(
              !stanzaAttuale
              ||
              !uid
            ){

              return;

            }




            const partite =

              stanze[stanzaAttuale]
              .partite;



            const idDaEliminare =

              Object.keys(partite)
              .find(

                id =>
                  partite[id].creatoDa
                  ===
                  uid

              );




            if(!idDaEliminare){


              socket.send(
                JSON.stringify({

                  tipo:"errore",

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



            return;

          }

// ===============================
// CHAT LOBBY
// ===============================


          if(
            dati.tipo === "chat"
          ){


            if(
              !stanzaAttuale
            ){

              return;

            }




            inviaAllaStanza(

              stanzaAttuale,

              {

                tipo:
                  "chat",


                nome:
                  nickname,


                testo:
                  dati.testo

              }

            );



            return;

          }





// ===============================
// CHAT DURANTE LA PARTITA
// ===============================


          if(
            dati.tipo === "chatPartita"
          ){



            if(
              !uid
            ){

              return;

            }





            const trovato =

              trovaPartita(
                dati.partitaId
              );



            if(!trovato){

              return;

            }





            const partita =
              trovato.partita;



            const mittente =
              partita.giocatori[uid];




            if(!mittente){

              return;

            }





            Object.values(
              partita.giocatori
            )
            .forEach(g=>{


              if(

                g.socket

                &&

                g.socket.readyState
                ===
                WebSocket.OPEN

              ){


                g.socket.send(

                  JSON.stringify({

                    tipo:
                      "chatPartita",


                    nome:
                      mittente.nome,


                    testo:
                      dati.testo

                  })

                );


              }


            });



            return;

          }





// ===============================
// TIRO DEI DADI
// random.org
// ===============================


          if(
            dati.tipo === "tiraDadi"
          ){



            if(
              !uid
            ){

              return;

            }





            const trovato =

              trovaPartita(
                dati.partitaId
              );



            if(!trovato){

              return;

            }




            const partita =
              trovato.partita;



            const nomeStanzaPartita =
              trovato.nomeStanza;




            const idDiTurno =

              partita
              .ordineGiocatori[
                partita.turnoAttuale
              ];




            if(
              idDiTurno !== uid
            ){


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




            if(
              partita.elaborandoTiro
            ){

              return;

            }




            partita.elaborandoTiro =
              true;




            try{


              const risultatoDadi =

                await lanciaDueDadiSicuri();




              const dado1 =
                risultatoDadi.dado1;


              const dado2 =
                risultatoDadi.dado2;



              const valoreDado =
                dado1 + dado2;




              const giocatore =
                partita.giocatori[uid];




              const movimento =

                calcolaMovimento(

                  giocatore.posizione,

                  valoreDado

                );




              giocatore.posizione =

                movimento.nuovaPosizione;





              if(
                movimento.turniDaSaltare > 0
              ){

                giocatore.turniSaltati =

                  movimento.turniDaSaltare;

              }





              if(

                !movimento.tiraAncora

                &&

                !movimento.vittoria

              ){

                passaAlProssimoTurno(
                  partita
                );

              }





              const statoGiocatori =

                partita.ordineGiocatori
                .map(id=>({


                  id,


                  nome:
                    partita.giocatori[id].nome,


                  posizione:
                    partita.giocatori[id].posizione


                }));





              const prossimoTurno =

                partita
                .ordineGiocatori[
                  partita.turnoAttuale
                ];




              Object.values(
                partita.giocatori
              )
              .forEach(g=>{


                if(

                  g.socket

                  &&

                  g.socket.readyState
                  ===
                  WebSocket.OPEN

                ){


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
                        movimento.percorso,



                      idGiocatoreCheHaTirato:
                        uid,



                      messaggi:
                        movimento.messaggi,



                      turnoDiId:
                        prossimoTurno,



                      vittoria:
                        movimento.vittoria,



                      vincitore:

                        movimento.vittoria

                        ?

                        giocatore.nome

                        :

                        null


                    })

                  );


                }


              });



              if(
                movimento.vittoria
              ){


                await aggiornaStatistichePartitaConclusa(

                  partita,

                  uid

                );



                await rimuoviPartita(

                  nomeStanzaPartita,

                  partita.id

                );



                inviaListaPartite(
                  nomeStanzaPartita
                );


              }

              else {


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
                      partita.iniziata

                  }

                );


              }



            }

            finally {


              partita.elaborandoTiro =
                false;


            }



            return;

          }

// ===============================
// ABBANDONA PARTITA
// ===============================


          if(
            dati.tipo === "abbandonaPartita"
          ){



            if(
              !uid
            ){

              return;

            }




            const trovato =

              trovaPartita(
                dati.partitaId
              );



            if(!trovato){

              return;

            }




            const partita =
              trovato.partita;



            const nomeStanza =
              trovato.nomeStanza;




            if(
              !partita.giocatori[uid]
            ){

              return;

            }




            const nomeUscente =

              partita.giocatori[uid]
              .nome;




            delete partita.giocatori[uid];



            partita.ordineGiocatori =

              partita.ordineGiocatori
              .filter(
                id =>
                  id !== uid
              );




            const giocatoriRimasti =

              Object.keys(
                partita.giocatori
              );





            // nessun giocatore rimasto

            if(
              giocatoriRimasti.length === 0
            ){


              await rimuoviPartita(

                nomeStanza,

                partita.id

              );


              inviaListaPartite(
                nomeStanza
              );


              return;

            }





            if(

              partita.turnoAttuale

              >=

              partita.ordineGiocatori.length

            ){

              partita.turnoAttuale = 0;

            }





            // se rimane un solo giocatore dopo l'inizio

            if(

              giocatoriRimasti.length === 1

              &&

              partita.iniziata

            ){



              const vincitoreId =
                giocatoriRimasti[0];



              const vincitoreNome =

                partita.giocatori[vincitoreId]
                .nome;





              const statoGiocatori =

                partita.ordineGiocatori
                .map(id=>({


                  id,


                  nome:
                    partita.giocatori[id].nome,


                  posizione:
                    partita.giocatori[id].posizione


                }));





              Object.values(
                partita.giocatori
              )
              .forEach(g=>{


                if(

                  g.socket

                  &&

                  g.socket.readyState
                  ===
                  WebSocket.OPEN

                ){


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


                      messaggi:[

                        nomeUscente
                        +
                        " ha abbandonato la partita."

                      ]

                    })

                  );


                }


              });




              await aggiornaStatistichePartitaConclusa(

                partita,

                vincitoreId

              );



              await rimuoviPartita(

                nomeStanza,

                partita.id

              );


            }

            else {



              const turnoAttuale =

                partita
                .ordineGiocatori[
                  partita.turnoAttuale
                ];




              const statoGiocatori =

                partita.ordineGiocatori
                .map(id=>({


                  id,


                  nome:
                    partita.giocatori[id].nome,


                  posizione:
                    partita.giocatori[id].posizione


                }));




              Object.values(
                partita.giocatori
              )
              .forEach(g=>{


                if(

                  g.socket

                  &&

                  g.socket.readyState
                  ===
                  WebSocket.OPEN

                ){


                  g.socket.send(

                    JSON.stringify({

                      tipo:
                        "statoPartita",


                      giocatori:
                        statoGiocatori,


                      turnoDiId:
                        turnoAttuale,


                      messaggi:[

                        nomeUscente
                        +
                        " ha abbandonato la partita."

                      ]

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


            return;

          }






// ===============================
// FINE CONNESSIONE WEBSOCKET
// ===============================


        }

        catch(erroreInterno){


          console.error(

            "Errore gestione messaggio WebSocket:",

            erroreInterno

          );


        }


      }

    );


// ===============================
// CHIUSURA WEBSOCKET
// PULIZIA CONNESSIONE
// ===============================


    socket.on(
      "close",
      ()=>{


        try{


          delete socketsPerId[socketId];



          if(
            !stanzaAttuale
            ||
            !stanze[stanzaAttuale]
          ){

            return;

          }





          delete stanze[stanzaAttuale]
          .giocatoriOnline[socketId];





          inviaConteggioStanze();



          inviaAllaStanza(

            stanzaAttuale,

            {

              tipo:
                "online",


              numero:

                Object.keys(

                  stanze[stanzaAttuale]
                  .giocatoriOnline

                ).length


            }

          );





          const partite =

            stanze[stanzaAttuale]
            .partite;





          for(
            const pid in partite
          ){



            const partita =
              partite[pid];




            // se un giocatore esce prima dell'inizio
            // viene rimosso dalla partita


            if(

              uid

              &&

              partita.giocatori[uid]

              &&

              !partita.iniziata

            ){



              delete partita.giocatori[uid];



              partita.ordineGiocatori =

                partita.ordineGiocatori
                .filter(
                  id =>
                    id !== uid
                );





              if(

                Object.keys(
                  partita.giocatori
                ).length === 0

              ){


                delete partite[pid];


              }


            }


          }




          inviaListaPartite(
            stanzaAttuale
          );



        }

        catch(e){


          console.error(

            "Errore chiusura WebSocket:",

            e.message

          );


        }


      }

    );



  }

);




// ===============================
// AVVIO SERVER
// ===============================


server.listen(

  PORT,

  async()=>{


    console.log(

      "Server avviato sulla porta "
      +
      PORT

    );



    await ripristinaPartiteDaFirebase();



  }

);
