"use strict";

const { Chess } = require("chess.js");

const COLONNE = "abcdefgh";
const PROMOZIONI = new Set(["q", "r", "b", "n"]);

function coordinate(casella) {
  return { r: 8 - Number(casella[1]), c: COLONNE.indexOf(casella[0]) };
}

function casella(posizione) {
  const { r, c } = posizione || {};
  if (![r, c].every(n => Number.isInteger(n) && n >= 0 && n < 8)) return null;
  return COLONNE[c] + (8 - r);
}

function colore(codice) {
  return codice === "w" ? "bianco" : "nero";
}

function tavola(motore) {
  return motore.board().map(riga => riga.map(pezzo =>
    pezzo ? { tipo: pezzo.type, colore: colore(pezzo.color) } : null
  ));
}

function creaMotore(notazione = []) {
  const motore = new Chess();
  for (const san of notazione) motore.move(san, { strict: true });
  return motore;
}

function serializza(motore, inCorso) {
  if (!motore) return { mosseLegali: [], scacco: false };
  return {
    mosseLegali: inCorso ? motore.moves({ verbose: true }).map(mossa => ({
      da: coordinate(mossa.from),
      a: coordinate(mossa.to),
      ...(mossa.promotion ? { promozione: mossa.promotion } : {})
    })) : [],
    scacco: motore.isCheck()
  };
}

function eseguiMossa(motore, richiesta, uid) {
  const from = casella(richiesta.da);
  const to = casella(richiesta.a);
  const promotion = richiesta.promozione;
  if (!from || !to || (promotion != null && !PROMOZIONI.has(promotion))) return null;

  // Le promozioni devono indicare un pezzo. Evita anche promozioni su mosse normali.
  const legale = motore.moves({ square: from, verbose: true }).some(mossa =>
    mossa.to === to && (mossa.promotion ?? null) === (promotion ?? null)
  );
  if (!legale) return null;

  const mossa = motore.move({ from, to, promotion: promotion ?? undefined });
  const da = coordinate(mossa.from);
  const a = coordinate(mossa.to);
  const movimento = { da, a, tipo: mossa.piece, colore: colore(mossa.color), san: mossa.san, uid, data: Date.now() };
  if (mossa.promotion) movimento.promozione = mossa.promotion;
  if (mossa.captured) movimento.cattura = mossa.isEnPassant() ? { r: da.r, c: a.c } : a;
  if (mossa.isKingsideCastle()) movimento.torre = { da: { r: da.r, c: 7 }, a: { r: da.r, c: 5 } };
  if (mossa.isQueensideCastle()) movimento.torre = { da: { r: da.r, c: 0 }, a: { r: da.r, c: 3 } };
  return movimento;
}

function esito(motore) {
  if (motore.isCheckmate()) {
    const vincitore = colore(motore.turn() === "w" ? "b" : "w");
    return { vincitore, motivo: "Scacco matto." };
  }
  if (motore.isStalemate()) return { motivo: "Patta per stallo." };
  if (motore.isInsufficientMaterial()) return { motivo: "Patta per materiale insufficiente." };
  if (motore.isThreefoldRepetition()) return { motivo: "Patta per triplice ripetizione." };
  if (motore.isDrawByFiftyMoves()) return { motivo: "Patta per la regola delle cinquanta mosse." };
  return null;
}

module.exports = { creaMotore, tavola, colore, serializza, eseguiMossa, esito };
