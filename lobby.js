let socket;

let tipoPartita="pubblica";


const parametri =
new URLSearchParams(
window.location.search
);


const stanza =
parametri.get("stanza") || "BAR";



document.getElementById("nomeStanza").innerHTML =
"🏠 "+stanza;



let nomeGiocatore =
localStorage.getItem("nickname");


if(!nomeGiocatore){

nomeGiocatore =
prompt(
"Come vuoi essere chiamato?",
"Giocatore"
);


localStorage.setItem(
"nickname",
nomeGiocatore
);

}




socket = new WebSocket(
location.origin.replace("http","ws")
);



socket.onopen=()=>{


console.log("Connesso");


socket.send(JSON.stringify({

tipo:"entraLobby",

stanza:stanza,

nome:nomeGiocatore

}));



};





socket.onmessage=(msg)=>{


let dati =
JSON.parse(msg.data);



if(dati.tipo==="online"){


document.getElementById("online").innerHTML =
dati.numero;


}



if(dati.tipo==="chat"){


aggiungiMessaggio(
dati.nome,
dati.testo
);


}



};







function tipo(t){

tipoPartita=t;

}




function creaPartita(){


socket.send(JSON.stringify({

tipo:"creaPartita",

tempo:
document.getElementById("tempo").value,


punti:
document.getElementById("punti").value,


modalita:
tipoPartita


}));


}





function inviaChat(){


let testo =
document.getElementById("messaggio").value;


if(testo==="") return;



socket.send(JSON.stringify({

tipo:"chat",

testo:testo


}));


document.getElementById("messaggio").value="";


}





function aggiungiMessaggio(nome,testo){


let chat =
document.getElementById("chat");


chat.innerHTML +=
`
<div>
<b>${nome}</b>: ${testo}
</div>
`;


chat.scrollTop =
chat.scrollHeight;


}