let socket;

const parametri = new URLSearchParams(
    window.location.search
);

const stanza = parametri.get("stanza") || "BAR";

let nomeGiocatore = "Mario";


socket = new WebSocket(
    "wss://gioco-oca-server.onrender.com"

);
socket.onopen = ()=>{

    console.log("Connesso al server");

    socket.send(JSON.stringify({

        tipo:"entraLobby",

        nome:nomeGiocatore,

        stanza:stanza

    }));

};

let nomeGiocatore = "Giocatore";


// =============================
// LEGGE STANZA URL
// =============================

let parametri = new URLSearchParams(
    window.location.search
);


let stanza =
parametri.get("stanza") || "BAR";


console.log(
    "STANZA:",
    stanza
);



// =============================
// MOSTRA STANZA
// =============================

let nomeStanza =
document.getElementById("nomeStanza");


if(nomeStanza){

    nomeStanza.innerHTML =
    "Stanza " + stanza;

}



// =============================
// CONNESSIONE SERVER
// =============================

let socket = new WebSocket(
location.origin.replace("http","ws")
);



socket.onopen = ()=>{


socket.send(JSON.stringify({

tipo:"entraLobby",

nome:nomeGiocatore,

stanza:stanza

}));


};




// =============================
// ENTRA LOBBY
// =============================

function entraLobby(){


    socket.send(JSON.stringify({

        tipo:"entraLobby",

        nome:nomeGiocatore,

        stanza:stanza

    }));



}



// =============================
// RICEZIONE SERVER
// =============================

socket.onmessage = (evento)=>{


    let dati =
    JSON.parse(
        evento.data
    );


    console.log(
        "SERVER:",
        dati
    );



    // -------------------------
    // GIOCATORI PRESENTI
    // -------------------------


    if(dati.tipo==="aggiornamento"){


        let presenti =
        document.getElementById(
            "presenti"
        );


        if(presenti){

            presenti.innerHTML =
            dati.numero +
            " giocatori";

        }



        let elenco="";


        dati.giocatori.forEach(g=>{


            elenco +=

            "🎮 "
            +
            g.nome
            +
            "<br>";



        });



        let top =
        document.getElementById(
            "top"
        );


        if(top){

            top.innerHTML =
            elenco;

        }


    }





    // -------------------------
    // LISTA PARTITE
    // -------------------------


    if(dati.tipo==="listaPartite"){



        let box =
        document.getElementById(
            "listaPartite"
        );


        if(!box)
        return;



        if(
        dati.partite.length===0
        ){


            box.innerHTML =
            "Nessuna partita aperta.";



        }else{


            let html="";


            dati.partite.forEach(p=>{


                html +=

                `
                <div class="partita">

                🎲
                <b>${p.creatore}</b>

                <br>

                👥
                ${p.giocatori.length}
                /
                ${p.massimoGiocatori}

                <br>

                ⏱
                ${p.tempo} secondi

                </div>
                `;



            });



            box.innerHTML =
            html;


        }



    }





    // -------------------------
    // CHAT
    // -------------------------


    if(dati.tipo==="chat"){


        let chat =
        document.getElementById(
            "chat"
        );


        if(chat){


            chat.innerHTML +=

            `
            <p>
            <b>${dati.nome}</b>:
            ${dati.testo}
            </p>
            `;


            chat.scrollTop =
            chat.scrollHeight;


        }


    }



};





// =============================
// CHAT
// =============================

function inviaChat(){


    let campo =
    document.getElementById(
        "messaggio"
    );


    if(!campo.value)
    return;



    socket.send(JSON.stringify({

        tipo:"chat",

        testo:
        campo.value


    }));



    campo.value="";



}






// =============================
// POPUP CREAZIONE
// =============================

function apriCreazione(){


    let p =
    document.getElementById(
        "pannelloCreazione"
    );


    if(p){

        p.style.display =
        "block";

    }



}



function chiudiCreazione(){


    let p =
    document.getElementById(
        "pannelloCreazione"
    );


    if(p){

        p.style.display =
        "none";

    }


}





// =============================
// CREA PARTITA COMPLETA
// =============================


function creaPartitaConOpzioni(){


    let dati = {

        tipo:"creaPartita",

        massimoGiocatori:
        Number(
        document.getElementById("maxGiocatori").value
        ),

        gettoni:
        document.getElementById("gettoni").value==="true",

        privata:
        document.getElementById("privata").value==="true",

        chat:
        document.getElementById("chatPartita").value==="true",

        tempo:
        Number(
        document.getElementById("tempo").value
        )

    };


    console.log(
        "DATI PARTITA INVIATI",
        dati
    );


    socket.send(
        JSON.stringify(dati)
    );


    chiudiCreazione();


}



    console.log(
        "CREO:",
        dati
    );



    socket.send(
        JSON.stringify(dati)
    );



    chiudiCreazione();



}





// =============================
// ENTRA PARTITA
// =============================

function entraPartita(idPartita){

    socket.send(JSON.stringify({

        tipo:"entraPartita",

        partitaId:idPartita

    }));

}






socket.onerror = ()=>{


console.log(
"Errore WebSocket"
);


};



socket.onclose = ()=>{


console.log(
"Server chiuso"
);


};
const parametri = new URLSearchParams(
    window.location.search
);

const stanza =
parametri.get("stanza") || "BAR";


document.getElementById("nomeStanza").textContent =
"🏠 " + stanza;