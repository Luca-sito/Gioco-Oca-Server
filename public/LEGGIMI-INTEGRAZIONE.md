# Forza 4 — Istruzioni di integrazione

Questi file sono completamente separati dal resto del sito (Gioco dell'Oca,
Briscola, ecc.): non condividono cartelle, variabili né eventi WebSocket con
gli altri giochi. Bastano 3-4 righe nel tuo `server.js` per collegarli.

## File inclusi

```
forza4-server.js              → modulo server, da mettere accanto al tuo server.js
public/forza4/index.html      → pagina del gioco
public/forza4/style.css       → stile del tabellone
public/forza4/game.js         → logica client
```

## Passi

1. **Copia i file** mantenendo questa struttura:
   - `forza4-server.js` nella root del progetto (dove hai già `server.js`)
   - la cartella `public/forza4/` dentro la tua cartella `public/` esistente

2. **Verifica di avere il pacchetto `ws`** (lo stesso già usato per gli altri
   giochi). Se non fosse già nel `package.json`:
   ```
   npm install ws
   ```

3. **Nel tuo `server.js`**, aggiungi in cima:
   ```js
   const { attaccaForza4 } = require('./forza4-server');
   ```

   Poi, subito dopo aver creato il server HTTP (la riga dove fai qualcosa
   come `const server = http.createServer(app)` oppure dove tieni il
   riferimento restituito da `app.listen(...)`), aggiungi:
   ```js
   attaccaForza4(server);
   ```

   Il modulo si aggancia con un proprio "path" dedicato (`/forza4-ws`) per
   l'upgrade a WebSocket, quindi **non tocca in nessun modo** il codice o gli
   eventi WebSocket già usati dal Gioco dell'Oca — anche se quel gioco usa
   la stessa istanza del server HTTP, non ci sono conflitti.

4. **Servire i file statici**: se il tuo `server.js` fa già qualcosa come
   `app.use(express.static('public'))`, non devi fare nient'altro: la pagina
   sarà raggiungibile su `/forza4/index.html` (o `/forza4/`, se hai
   `index: true`/comportamento di default di `express.static`).

   Se invece servi le cartelle una per una, aggiungi:
   ```js
   app.use('/forza4', express.static(path.join(__dirname, 'public/forza4')));
   ```

5. **Collegalo dal menu/sito Wix** come fai già per gli altri giochi (stesso
   pattern di iframe/link che usi per Gioco dell'Oca e Briscola), puntando
   alla URL `/forza4/` del tuo dominio su Render.

## Come funziona il gioco

- Chi clicca "Crea una stanza" riceve un codice a 5 caratteri e diventa il
  giocatore **rosso**; chi entra con quel codice diventa il **giallo**.
- Il turno inizia sempre dal rosso.
- Il tabellone è 7 colonne × 6 righe, identico a quello reale. Si clicca una
  colonna (o la riga di anteprima sopra al tabellone) per far cadere il
  gettone: la fisica della caduta è animata via CSS.
- Vittoria rilevata per 4 in fila in orizzontale, verticale o diagonale
  (in entrambe le direzioni); le 4 celle vincenti lampeggiano.
- Se un giocatore si disconnette, l'altro vede un avviso; se si riconnette
  entro breve tempo (stesso `giocatoreId` salvato in `localStorage`), riprende
  il proprio posto nella stessa partita.
- "Nuova partita" resetta il tabellone nella stessa stanza, senza dover
  generare un nuovo codice.

## Personalizzazioni facili

- **Colori/font**: tutto lo stile passa dalle variabili CSS in cima a
  `style.css` (`:root { ... }`).
- **Path del WebSocket**: se `/forza4-ws` dovesse mai collidere con qualcos'altro,
  cambialo passando un secondo argomento: `attaccaForza4(server, '/altro-path')`
  — e aggiorna la stessa stringa in `game.js`, dentro `urlWebSocket()`.
