let socket;

let tipoPartita = "pubblica";


// CAMBIO TIPO PARTITA

function tipo(tipo){

    tipoPartita = tipo;

}



// COLLEGAMENTO SERVER

socket = new WebSocket(
    "ws://localhost:3000"
);



socket.onopen = ()=>{


    console.log(
        "Connesso alla lobby"
    );


    // Entrata stanza

    socket.send(JSON.stringify({

        tipo:"entraLobby",

        stanza:"PUB",

        nome:"Giocatore"

    }));


};




// RICEZIONE DATI SERVER


socket.onmessage = (msg)=>{


    let dati =
    JSON.parse(msg.data);



    // PARTITE DISPONIBILI

    if(dati.tipo==="listaPartite"){


        mostraPartite(
            dati.partite
        );


    }



    // CHAT


    if(dati.tipo==="chat"){


        aggiungiMessaggio(
            dati.nome,
            dati.testo
        );


    }



    // UTENTI ONLINE


    if(dati.tipo==="online"){


        document.getElementById(
            "online"
        ).innerHTML =
        dati.numero;


    }



};







// CREAZIONE PARTITA


function creaPartita(){


    let tempo =
    document.getElementById(
        "tempo"
    ).value;



    let punti =
    document.getElementById(
        "punti"
    ).value;




    socket.send(JSON.stringify({


        tipo:"creaPartita",


        tempo:tempo,


        punti:punti,


        modalita:
        tipoPartita



    }));



}






// VISUALIZZA PARTITE


function mostraPartite(lista){


    let html="";



    if(lista.length===0){


        html=
        "<p>Nessuna partita disponibile</p>";


    }



    lista.forEach(
    partita=>{


        html += `


        <div class="partita">


        🎲 ${partita.creatore}


        <br>


        ${partita.modalita==="privata"?
        "🔒 Privata":
        "🔓 Pubblica"}



        <br>


        ⏱ ${partita.tempo} secondi


        <br>


        🏆 ${partita.punti} punti


        <br><br>


        <button onclick="entraPartita('${partita.id}')">

        Entra

        </button>


        </div>


        `;



    });



    document.getElementById(
        "partite"
    ).innerHTML=html;



}







// ENTRA PARTITA


function entraPartita(id){


    socket.send(JSON.stringify({


        tipo:"entraPartita",


        id:id


    }));


}







// CHAT


function inviaChat(){


    let testo =
    document.getElementById(
        "messaggio"
    ).value;



    if(testo==="")
    return;



    socket.send(JSON.stringify({


        tipo:"chat",


        testo:testo


    }));



    document.getElementById(
        "messaggio"
    ).value="";



}






function aggiungiMessaggio(nome,testo){



    let chat =
    document.getElementById(
        "chat"
    );



    chat.innerHTML += `

    <div class="messaggio">

    <b>${nome}</b>:
    ${testo}

    </div>


    `;



    chat.scrollTop =
    chat.scrollHeight;


}