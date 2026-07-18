// =====================================================
// GIOCO DELL'OCA ONLINE
// SERVER.JS COMPLETO
// =====================================================


// =====================
// IMPORT
// =====================

const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const admin = require("firebase-admin");



// =====================
// SERVER
// =====================

const app = express();

app.use(cors());

app.use(express.json());

app.use(
    express.static(
        path.join(__dirname,"public")
    )
);


const server = http.createServer(app);


const wss = new WebSocket.Server({
    server
});


const PORT = process.env.PORT || 3000;



// =====================
// CONFIG
// =====================

const JWT_SECRET =
process.env.JWT_SECRET ||
"cambia-secret";



let connessioniAttive = 0;

const MAX_CONNESSIONI = 1000;



// =====================
// FIREBASE ADMIN
// =====================

let db = null;


try {


const serviceAccount =
JSON.parse(
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
"Firebase collegato"
);



}catch(error){


console.log(
"Firebase non disponibile:",
error.message
);


}



// =====================
// VARIABILI GLOBALI
// =====================


const utentiSocket = {};

let contatoreSocket = 0;



const stanze = {


BAR:{
    giocatoriOnline:{},
    partite:{}
},


PUB:{
    giocatoriOnline:{},
    partite:{}
},


DISCOPUB:{
    giocatoriOnline:{},
    partite:{}
},


SERATE:{
    giocatoriOnline:{},
    partite:{}
}


};

// =====================================================
// FUNZIONI FIREBASE UTENTI
// =====================================================


async function trovaUtenteEmail(email){


    if(!db)
        return null;



    const snap =
    await db
    .ref("utenti")
    .orderByChild("emailLower")
    .equalTo(email)
    .once("value");



    if(!snap.exists())
        return null;



    const dati =
    snap.val();



    const uid =
    Object.keys(dati)[0];



    return {

        uid,

        ...dati[uid]

    };


}





async function trovaUtenteNickname(nickname){


    if(!db)
        return null;



    const snap =
    await db
    .ref("utenti")
    .orderByChild("nicknameLower")
    .equalTo(nickname)
    .once("value");



    if(!snap.exists())
        return null;



    const dati =
    snap.val();



    const uid =
    Object.keys(dati)[0];



    return {

        uid,

        ...dati[uid]

    };


}




// =====================================================
// TOKEN JWT
// =====================================================


function creaToken(
uid,
nickname,
ruolo
){


    return jwt.sign(

        {

            uid,

            nickname,

            ruolo

        },

        JWT_SECRET,

        {

            expiresIn:"30d"

        }

    );


}




function verificaToken(token){


    if(!token)
        return null;



    try{


        return jwt.verify(
            token,
            JWT_SECRET
        );


    }catch(error){


        return null;


    }


}





// =====================================================
// SALVATAGGIO UTENTI
// =====================================================


async function salvaUtente(
uid,
dati
){


    if(!db)
        return;



    await db
    .ref(
        "utenti/" + uid
    )
    .update(dati);


}

// =====================================================
// REGISTRAZIONE ACCOUNT
// =====================================================


app.post(
"/api/registrati",
async(req,res)=>{


try{


if(!db){

return res.status(500).json({

errore:
"Database non disponibile"

});

}



const {

email,

nickname,

password

}=req.body;




if(
!email ||
!nickname ||
!password
){


return res.status(400).json({

errore:
"Compila tutti i campi"

});


}




if(password.length < 6){


return res.status(400).json({

errore:
"La password deve avere almeno 6 caratteri"

});


}





const emailPulita =
email
.trim()
.toLowerCase();



const nicknamePulito =
nickname
.trim();



const nicknameLower =
nicknamePulito
.toLowerCase();






if(
await trovaUtenteEmail(
emailPulita
)
){


return res.status(400).json({

errore:
"Email già registrata"

});


}





if(
await trovaUtenteNickname(
nicknameLower
)
){


return res.status(400).json({

errore:
"Nickname già utilizzato"

});


}





const passwordHash =
await bcrypt.hash(
password,
10
);





const nuovo =
db
.ref("utenti")
.push();




const uid =
nuovo.key;





await nuovo.set({

email:
emailPulita,


emailLower:
emailPulita,


nickname:
nicknamePulito,


nicknameLower:
nicknameLower,


passwordHash,


ruolo:
"utente",


stato:
"attivo",


partiteGiocate:
0,


partiteVinte:
0,


puntiTotali:
0,


creatoIl:
Date.now()


});







const token =
creaToken(

uid,

nicknamePulito,

"utente"

);






res.json({

token,

nickname:
nicknamePulito

});






}catch(error){


console.error(error);



res.status(500).json({

errore:
"Errore server"

});


}



});

// =====================================================
// LOGIN ACCOUNT
// =====================================================


app.post(
"/api/login",
async(req,res)=>{


try{


if(!db){

return res.status(500).json({

errore:
"Database non disponibile"

});

}




const {

email,

password

}=req.body;





if(
!email ||
!password
){


return res.status(400).json({

errore:
"Inserisci email e password"

});


}





const utente =
await trovaUtenteEmail(
email
.trim()
.toLowerCase()
);





if(!utente){


return res.status(400).json({

errore:
"Email o password errati"

});


}







const passwordCorretta =
await bcrypt.compare(

password,

utente.passwordHash

);







if(!passwordCorretta){


return res.status(400).json({

errore:
"Email o password errati"

});


}






if(
utente.stato === "bannato"
){


return res.status(403).json({

errore:
"Account bannato"

});


}





if(
utente.stato === "sospeso" &&
utente.sospesoFino &&
utente.sospesoFino > Date.now()
){


return res.status(403).json({

errore:
"Account sospeso"

});


}






const token =
creaToken(

utente.uid,

utente.nickname,

utente.ruolo || "utente"

);







res.json({

token,

nickname:
utente.nickname,

ruolo:
utente.ruolo || "utente"

});






}catch(error){


console.error(error);



res.status(500).json({

errore:
"Errore server"

});


}



});





// =====================================================
// CLASSIFICA GIOCATORI
// =====================================================


app.get(
"/api/classifica",
async(req,res)=>{


try{


if(!db){

return res.json({

giocatori:[]

});

}




const snap =
await db
.ref("utenti")
.once("value");



const utenti =
snap.val() || {};





const classifica =

Object.values(utenti)

.map(u=>({


nickname:
u.nickname || "Giocatore",


vinte:
u.partiteVinte || 0,


giocate:
u.partiteGiocate || 0,


punti:
u.puntiTotali || 0


}))


.sort((a,b)=>{


if(
b.punti !== a.punti
)
return b.punti-a.punti;


return b.vinte-a.vinte;


})


.slice(0,10);






res.json({

giocatori:
classifica

});





}catch(error){


console.error(error);



res.status(500).json({

giocatori:[]

});


}



});

// =====================================================
// FUNZIONI COMUNICAZIONE STANZE
// =====================================================


function inviaAllaStanza(
nomeStanza,
messaggio
){


if(!stanze[nomeStanza])
return;



const testo =
JSON.stringify(messaggio);




Object.keys(
stanze[nomeStanza].giocatoriOnline
)
.forEach(id=>{


const socket =
utentiSocket[id];



if(
socket &&
socket.readyState === WebSocket.OPEN
){


socket.send(testo);


}



});


}






function aggiornaConteggioStanze(){



const conteggio = {};




Object.keys(stanze)
.forEach(nome=>{


conteggio[nome] =

Object.keys(
stanze[nome].giocatoriOnline
)
.length;



});





wss.clients.forEach(socket=>{


if(
socket.readyState === WebSocket.OPEN
){


socket.send(
JSON.stringify({

tipo:
"aggiornamentoStanze",


stanze:
conteggio


})
);



}


});


}







function generaIdPartita(){


return (

"p" +

Date.now() +

Math.floor(
Math.random()*1000
)

);


}






// =====================================================
// SISTEMA PARTITE
// =====================================================



function preparaGiocatoriFirebase(
giocatori
){


const risultato = {};



Object.keys(giocatori)
.forEach(id=>{


risultato[id]={


uid:
giocatori[id].uid,


nickname:
giocatori[id].nickname,


posizione:
giocatori[id].posizione || 0



};


});



return risultato;


}






async function salvaPartitaFirebase(
partita,
nomeStanza
){


if(!db)
return;



await db
.ref(
"partite/" + partita.id
)
.set({


id:
partita.id,


stanza:
nomeStanza,


creatore:
partita.creatore,


creatoreUid:
partita.creatoreUid,


maxGiocatori:
partita.maxGiocatori,


giocatori:
preparaGiocatoriFirebase(
partita.giocatori
),


ordineGiocatori:
partita.ordineGiocatori || [],


turnoAttuale:
partita.turnoAttuale || 0,


iniziata:
partita.iniziata,


creataIl:
Date.now()


});



}






function inviaListaPartite(
nomeStanza
){


if(!stanze[nomeStanza])
return;



const lista =

Object.values(
stanze[nomeStanza].partite
)

.map(p=>({


id:
p.id,


creatore:
p.creatore,


giocatori:
Object.keys(
p.giocatori
).length,


massimo:
p.maxGiocatori,


iniziata:
p.iniziata


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

// =====================================================
// CREA PARTITA
// =====================================================


async function creaPartita(
socket,
dati,
stanzaAttuale,
utente
){



if(
!stanzaAttuale ||
!utente
)
return;





const id =
generaIdPartita();






const partita = {


id,


creatore:
utente.nickname,


creatoreUid:
utente.uid,



maxGiocatori:

parseInt(
dati.maxGiocatori
) || 4,



privata:
dati.privata || false,



codice:

dati.codice || null,



giocatori:{},



ordineGiocatori:[],


turnoAttuale:0,


iniziata:false



};






partita.giocatori[
utente.uid
]={


uid:
utente.uid,


nickname:
utente.nickname,


posizione:0,


turniSaltati:0



};





partita.ordineGiocatori.push(
utente.uid
);







stanze[stanzaAttuale]
.partite[id]
=
partita;







await salvaPartitaFirebase(

partita,

stanzaAttuale

);







socket.send(
JSON.stringify({

tipo:
"partitaCreata",


id:



id


})
);







inviaListaPartite(
stanzaAttuale
);



}








// =====================================================
// ENTRA PARTITA
// =====================================================


async function entraPartita(
socket,
dati,
stanzaAttuale,
utente
){



if(
!stanzaAttuale ||
!utente
)
return;





const partita =

stanze[stanzaAttuale]
.partite[dati.id];






if(!partita){


socket.send(
JSON.stringify({

tipo:
"errore",

messaggio:
"Partita inesistente"

})
);


return;


}







if(
partita.iniziata
){


socket.send(
JSON.stringify({

tipo:
"errore",

messaggio:
"Partita già iniziata"

})
);


return;


}






if(
Object.keys(
partita.giocatori
).length
>=
partita.maxGiocatori
){


socket.send(
JSON.stringify({

tipo:
"errore",

messaggio:
"Partita piena"

})
);



return;


}







if(
partita.privata &&
partita.codice !== dati.codice
){


socket.send(
JSON.stringify({

tipo:
"errore",

messaggio:
"Codice errato"

})
);



return;


}







if(
partita.giocatori[utente.uid]
){


return;


}







partita.giocatori[
utente.uid
]={


uid:
utente.uid,


nickname:
utente.nickname,


posizione:0,


turniSaltati:0



};






partita.ordineGiocatori.push(
utente.uid
);







await salvaPartitaFirebase(

partita,

stanzaAttuale

);







Object.values(
partita.giocatori
)
.forEach(g=>{


if(
g.uid === utente.uid
)
return;



const altroSocket =
Object.values(utentiSocket)
.find(
s=>s === socket
);



});







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


avviaPartita(
partita,
stanzaAttuale
);


}



}

// =====================================================
// AVVIO PARTITA E GESTIONE TURNI
// =====================================================


function avviaPartita(
partita,
nomeStanza
){



partita.iniziata = true;


partita.turnoAttuale = 0;




partita.ordineGiocatori =

Object.keys(
partita.giocatori
);





const messaggio = {


tipo:
"partitaIniziata",


partitaId:
partita.id,


giocatori:

partita.ordineGiocatori.map(id=>({


uid:id,


nickname:
partita.giocatori[id].nickname,


posizione:
partita.giocatori[id].posizione



})),


turno:

partita.ordineGiocatori[0]


};







Object.values(
partita.giocatori
)
.forEach(g=>{


const socket =

Object.values(
utentiSocket
)
.find(
s =>
s === g.socket
);



if(
socket &&
socket.readyState === WebSocket.OPEN
){


socket.send(
JSON.stringify(messaggio)
);


}


});






salvaPartitaFirebase(

partita,

nomeStanza

);



}








function passaTurno(
partita
){



partita.turnoAttuale++;





if(

partita.turnoAttuale >=

partita.ordineGiocatori.length

){


partita.turnoAttuale = 0;


}





return partita.ordineGiocatori[
partita.turnoAttuale
];



}








// =====================================================
// MOVIMENTO PEDINA
// =====================================================



const CASELLA_VITTORIA = 63;



function calcolaPercorso(
posizione,
passi
){



const percorso = [];



let nuovaPosizione =
posizione;





for(
let i = 0;
i < passi;
i++
){



nuovaPosizione++;




if(
nuovaPosizione >
CASELLA_VITTORIA
){


nuovaPosizione =
CASELLA_VITTORIA;


}



percorso.push(
nuovaPosizione
);



}





return {


posizioneFinale:
nuovaPosizione,


percorso


};


}






// =====================================================
// INVIO MOVIMENTO A TUTTI I GIOCATORI
// =====================================================



function inviaMovimentoPedina(
partita,
uid,
percorso
){



const messaggio = {


tipo:
"muoviPedina",


uid,


percorso



};






Object.values(
partita.giocatori
)
.forEach(g=>{


if(
g.socket &&
g.socket.readyState === WebSocket.OPEN
){


g.socket.send(
JSON.stringify(messaggio)
);



}



});



}

// =====================================================
// SISTEMA DADI RANDOM.ORG
// =====================================================


function generaDadoLocale(){


return Math.floor(
Math.random()*6
)+1;


}






function tiraDadoRandomOrg(){



return new Promise((resolve)=>{



const url =

"https://www.random.org/integers/?num=1&min=1&max=6&col=1&base=10&format=plain&rnd=new";





const richiesta =

https.get(
url,
(res)=>{



let dati = "";




res.on(
"data",
(chunk)=>{


dati += chunk;


});






res.on(
"end",
()=>{


const numero =

parseInt(
dati.trim()
);





if(
numero >= 1 &&
numero <= 6
){


resolve(numero);


}else{


resolve(
generaDadoLocale()
);


}



});



}

);






richiesta.on(
"error",
()=>{


resolve(
generaDadoLocale()
);


});






richiesta.setTimeout(
4000,
()=>{


richiesta.destroy();


resolve(
generaDadoLocale()
);


});




});



}








async function tiraDueDadi(){



const dado1 =

await tiraDadoRandomOrg();




const dado2 =

await tiraDadoRandomOrg();






return {


dado1,


dado2,


totale:
dado1+dado2


};



}







// =====================================================
// EFFETTO MOVIMENTO CASELLA PER CASELLA
// =====================================================



async function muoviGiocatore(
partita,
uid,
valoreDado,
nomeStanza
){



const giocatore =

partita.giocatori[uid];





if(!giocatore)
return;






const risultato =

calcolaPercorso(

giocatore.posizione,

valoreDado

);






giocatore.posizione =

risultato.posizioneFinale;







inviaMovimentoPedina(

partita,

uid,

risultato.percorso

);






await salvaPartitaFirebase(

partita,

nomeStanza

);





}






// =====================================================
// AGGIORNAMENTO STATISTICHE
// =====================================================



async function aggiornaStatistiche(
uid,
vincitore=false
){



if(!db)
return;






const aggiornamento = {};



aggiornamento[

"utenti/" +
uid +
"/partiteGiocate"

] =

admin.database.ServerValue.increment(1);






if(vincitore){



aggiornamento[

"utenti/" +
uid +
"/partiteVinte"

] =

admin.database.ServerValue.increment(1);



}







await db
.ref()
.update(
aggiornamento
);



}

// =====================================================
// BLOCCO 9
// SISTEMA DADI + MOVIMENTO PEDINE
// =====================================================


const CASELLA_FINE = 63;


const CASELLE_AVANZA = [
    9,
    18,
    27,
    36,
    45,
    54
];


const CASELLE_STOP_3 = [
    19,
    31
];


const CASELLA_STOP_1 = 52;


const RITORNI = {

    42:38,

    50:1,

    58:1

};





function generaDado(){

    return Math.floor(
        Math.random()*6
    )+1;

}





function calcolaPercorso(
posizione,
numero
){


    let percorso=[];


    let nuova =
    posizione + numero;



    if(
        nuova > CASELLA_FINE
    ){


        for(
            let i=posizione+1;
            i<=CASELLA_FINE;
            i++
        ){

            percorso.push(i);

        }



        let eccesso =
        nuova - CASELLA_FINE;



        nuova =
        CASELLA_FINE - eccesso;



        for(
            let i=CASELLA_FINE-1;
            i>=nuova;
            i--
        ){

            percorso.push(i);

        }


    }else{


        for(
            let i=posizione+1;
            i<=nuova;
            i++
        ){

            percorso.push(i);

        }


    }





    let messaggi=[];


    let turnoSaltato=0;


    let tiraAncora=false;


    let vittoria=false;






    if(
        nuova === CASELLA_FINE
    ){

        vittoria=true;

        messaggi.push(
            "Hai raggiunto il traguardo!"
        );


        return {

            nuova,

            percorso,

            messaggi,

            turnoSaltato,

            tiraAncora,

            vittoria

        };

    }







    if(
        CASELLE_AVANZA.includes(nuova)
    ){


        messaggi.push(
            "Avanzi ancora!"
        );


        const extra =
        calcolaPercorso(
            nuova,
            numero
        );


        percorso =
        percorso.concat(
            extra.percorso
        );


        nuova =
        extra.nuova;


    }






    if(
        CASELLE_STOP_3.includes(nuova)
    ){


        turnoSaltato=3;


        messaggi.push(
            "Salti 3 turni!"
        );


    }






    if(
        nuova===CASELLA_STOP_1
    ){


        turnoSaltato=1;


        messaggi.push(
            "Salti un turno!"
        );


    }







    if(
        RITORNI[nuova]
    ){


        messaggi.push(
            "Torni indietro!"
        );


        nuova =
        RITORNI[nuova];


        percorso.push(nuova);


    }






    if(
        nuova===6
    ){

        tiraAncora=true;


        messaggi.push(
            "Tiri ancora!"
        );


    }





    return {


        nuova,


        percorso,


        messaggi,


        turnoSaltato,


        tiraAncora,


        vittoria


    };


}

// =====================================================
// BLOCCO 10
// WEBSOCKET GIOCO - DADO, MOVIMENTO E TURNI
// =====================================================


function passaTurno(partita){


    partita.turno =
    (partita.turno + 1)
    %
    partita.ordineGiocatori.length;



}





function inviaStatoPartita(partita){


    const stato =
    partita.ordineGiocatori.map(id=>{


        const g =
        partita.giocatori[id];


        return {

            uid:id,

            nickname:
            g.nickname,

            posizione:
            g.posizione

        };


    });




    Object.values(
        partita.giocatori
    )
    .forEach(g=>{


        if(
            g.socket &&
            g.socket.readyState === WebSocket.OPEN
        ){


            g.socket.send(
                JSON.stringify({

                    tipo:
                    "aggiornamentoPartita",


                    giocatori:
                    stato,


                    turno:
                    partita.ordineGiocatori[
                        partita.turno
                    ]

                })
            );


        }


    });


}









// =====================================================
// TIRA DADO
// =====================================================


async function gestisciTiroDado(
socket,
dati,
utente
){


    const partita =
    stanze[dati.stanza]
    ?.partite[dati.partitaId];



    if(!partita)
        return;




    const giocatore =
    partita.giocatori[
        utente.uid
    ];



    if(!giocatore)
        return;






    const turno =
    partita.ordineGiocatori[
        partita.turno
    ];



    if(
        turno !== utente.uid
    ){


        socket.send(
            JSON.stringify({

                tipo:"errore",

                messaggio:
                "Non è il tuo turno"

            })
        );


        return;

    }







    const dado1 =
    Math.floor(
        Math.random()*6
    )+1;



    const dado2 =
    Math.floor(
        Math.random()*6
    )+1;




    const totale =
    dado1+dado2;







    const movimento =
    calcolaPercorso(
        giocatore.posizione,
        totale
    );






    giocatore.posizione =
    movimento.nuova;






    inviaAllaPartita(
        partita,
        {

            tipo:
            "animazionePedina",


            uid:
            utente.uid,


            percorso:
            movimento.percorso,


            dado1,

            dado2,


            totale,


            messaggi:
            movimento.messaggi


        }
    );







    if(
        movimento.vittoria
    ){


        partita.iniziata=false;


        inviaAllaPartita(
            partita,
            {

                tipo:
                "vittoria",


                vincitore:
                giocatore.nickname


            }
        );


        return;

    }







    if(
        !movimento.tiraAncora
    ){


        passaTurno(
            partita
        );


    }







    inviaStatoPartita(
        partita
    );


}









function inviaAllaPartita(
partita,
messaggio
){



    Object.values(
        partita.giocatori
    )
    .forEach(g=>{


        if(
            g.socket &&
            g.socket.readyState === WebSocket.OPEN
        ){


            g.socket.send(
                JSON.stringify(messaggio)
            );


        }


    });


}









// =====================================================
// AVVIO SERVER
// =====================================================


server.listen(
PORT,
()=>{


console.log(
"Server Gioco dell'Oca avviato sulla porta "
+
PORT
);


});
