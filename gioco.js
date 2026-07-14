let socket;

let nomeGiocatore;



// ENTRATA NELLA STANZA

function entraStanza(stanza){


    nomeGiocatore =
    document.getElementById("nome").value;



    if(nomeGiocatore === ""){

        alert("Inserisci il nome giocatore");

        return;

    }



    socket = new WebSocket(
        "ws://localhost:3001"
    );



    socket.onopen = ()=>{


        socket.send(JSON.stringify({

            tipo:"entra",

            nome:nomeGiocatore,

            stanza:stanza

        }));



        document.getElementById("lobby")
        .style.display="none";



        document.getElementById("gioco")
        .style.display="block";



        document.getElementById("nomeStanza")
        .innerHTML =
        "Stanza: " + stanza;



    };





    // RICEZIONE DATI DAL SERVER

    socket.onmessage = (msg)=>{


        let dati =
        JSON.parse(msg.data);



        if(dati.tipo === "aggiornamento"){


            let html = "";



            dati.giocatori.forEach(
            giocatore => {



                html +=

                "<p>🎮 "
                +
                giocatore.nome
                +
                " - Casella: "
                +
                giocatore.posizione
                +
                "</p>";



            });



            document.getElementById("lista")
            .innerHTML = html;



        }



    };



}




// LANCIO DEL DADO

function dado(){


    socket.send(JSON.stringify({

        tipo:"dado"

    }));


}