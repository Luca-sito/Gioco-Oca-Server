// Salva questo file come: public/token-novita.js
// (cartella "Public & Backend" > "Public" nell'editor Velo)
//
// Unico punto di lettura/scrittura del JWT condiviso lato Wix.
// Sia masterPage.js sia le pagine (es. Home) devono usare SOLO queste
// due funzioni: niente altri accessi diretti a session.getItem/setItem
// sparsi nel codice, per evitare che si creino due sistemi paralleli.

import { session } from 'wix-storage';

const CHIAVE_TOKEN = 'giochiSocietaAuthToken';

/**
 * Restituisce il JWT attualmente salvato per l'account loggato su Wix,
 * oppure null se non c'è nessun token (utente non loggato / non ancora
 * arrivato dal flusso di autenticazione).
 */
export function leggiTokenSalvato() {
  try {
    const token = session.getItem(CHIAVE_TOKEN);
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Salva/aggiorna il JWT nella sessione condivisa Wix.
 * Va chiamata dal masterPage ogni volta che un token nuovo o aggiornato
 * diventa disponibile (login, redirect OAuth, refresh, ecc.).
 */
export function salvaToken(token) {
  try {
    if (typeof token === 'string' && token.trim()) {
      session.setItem(CHIAVE_TOKEN, token.trim());
    }
  } catch (e) {
    // Sessione non disponibile: nessuna azione, il chiamante gestirà
    // il caso "nessun token" come già previsto.
  }
}

/**
 * Rimuove il token salvato (da chiamare al logout).
 */
export function cancellaToken() {
  try {
    session.removeItem(CHIAVE_TOKEN);
  } catch (e) {}
}
