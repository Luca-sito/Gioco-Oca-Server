const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server
});

const PORT = process.env.PORT || 3000;


let stanze = {
    BAR: [],
    PUB: [],
    DISCOPUB: [],
    SERATE: []
};


wss.on("connection", socket => {

    let stanza = null;
    let nome = null;


    socket.on("message", msg => {

        const dati = JSON.parse(msg);


        if(dati.tipo === "entraLobby"){

            stanza = dati.stanza;
            nome = dati.nome;


            if(!stanze[stanza]){
                stanze[stanza] = [];
            }


            stanze[stanza].push({
                nome,
                socket
            });


            aggiornaOnline(stanza);

        }



        if(dati.tipo === "chat"){

            mandaStanza(stanza,{
                tipo:"chat",
                nome,
                testo:dati.testo
            });

        }



        if(dati.tipo === "creaPartita"){

            mandaStanza(stanza,{
                tipo:"listaPartite",
                partite:[]
            });

        }


    });



    socket.on("close",()=>{

        if(stanza){

            stanze[stanza] =
            stanze[stanza].filter(g=>g.socket!==socket);

            aggiornaOnline(stanza);

        }

    });


});




function aggiornaOnline(stanza){

    mandaStanza(stanza,{
        tipo:"online",
        numero:stanze[stanza].length
    });

}



function mandaStanza(stanza,dati){

    if(!stanze[stanza]) return;


    stanze[stanza].forEach(g=>{

        if(g.socket.readyState===WebSocket.OPEN){

            g.socket.send(JSON.stringify(dati));

        }

    });

}




server.listen(PORT,()=>{

console.log(
"Server avviato sulla porta "+PORT
);

});