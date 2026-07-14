
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const fs = require("fs");

console.log("Cartella server:", __dirname);
console.log("Contenuto:", fs.readdirSync(__dirname));

app.use(express.static("public"));

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server: server
});

server.listen(process.env.PORT || 3000, () => {
    console.log("Server online");
});

let giocatori = [];

let partite = [];



wss.on("connection",(socket)=>{


console.log("Nuovo giocatore");



socket.on("message",(msg)=>{


let dati = JSON.parse(msg);



if(dati.tipo==="entraLobby"){


socket.nome=dati.nome;
socket.stanza=dati.stanza;



giocatori.push(socket);



aggiornaOnline();


}



if(dati.tipo==="chat"){


inviaAStanza({

tipo:"chat",
nome:socket.nome,
testo:dati.testo

},socket.stanza);



}



if(dati.tipo==="creaPartita"){


let partita={

id:Date.now(),

creatore:socket.nome,

stanza:socket.stanza,

giocatori:[
socket.nome
],

massimoGiocatori:
dati.massimoGiocatori,

tempo:
dati.tempo

};



partite.push(partita);



inviaPartite(socket.stanza);


}



});





socket.on("close",()=>{


giocatori =
giocatori.filter(
g=>g!==socket
);



aggiornaOnline();


});



});





function aggiornaOnline(){


let lista=giocatori.map(
g=>g.nome
);



giocatori.forEach(g=>{


g.send(JSON.stringify({

tipo:"aggiornamento",

numero:lista.length,

giocatori:lista

}));

});


}





function inviaPartite(stanza){


let lista =
partite.filter(
p=>p.stanza===stanza
);



giocatori.forEach(g=>{


if(g.stanza===stanza){


g.send(JSON.stringify({

tipo:"listaPartite",

partite:lista

}));


}


});


}




function inviaAStanza(msg,stanza){


giocatori.forEach(g=>{


if(g.stanza===stanza){


g.send(JSON.stringify(msg));


}


});


}





