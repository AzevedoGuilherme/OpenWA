'use strict';

function normalizeText(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only when the whole message is the word (plus courtesy): "baja" alone opts out, "el precio baja?" does not.
const OPT_OUT_WORDS = new Set(['stop', 'baja', 'borrame', 'sacame', 'quitame']);
const COURTESY = /\s+(por favor|porfa|gracias)$/;
const OPT_OUT_PHRASES = [
  'no me escribas mas',
  'no me escriba mas',
  'no me escriban mas',
  'no quiero recibir mensajes',
  'no quiero recibir mas mensajes',
  'no quiero volver a recibir',
  'deja de escribirme',
  'dejen de escribirme',
  'quien te dio mi numero',
  'quien les dio mi numero',
  'no me contacten',
  'no me contactes',
  'dame de baja',
  'darme de baja',
  'sacame de la lista',
  'borrame de la lista',
  'quitame de la lista',
];
const REACTIVATION_PHRASES = [
  'quiero volver a recibir mensajes',
  'pueden escribirme nuevamente',
  'pueden escribirme de nuevo',
  'pueden volver a escribirme',
  'quiero retomar la consulta',
  'quiero retomar mi consulta',
  'quiero retomar la conversacion',
];

/** True when `phrase` appears as whole words in the normalized text and is not negated ("no quiero..."). */
function containsPhrase(normalized, phrase) {
  const padded = ` ${normalized} `;
  let from = 0;
  for (;;) {
    const at = padded.indexOf(` ${phrase} `, from);
    if (at === -1) return false;
    if (!padded.slice(0, at + 1).endsWith(' no ')) return true;
    from = at + 1;
  }
}

function isOptOutMessage(text) {
  const normalized = normalizeText(text);
  if (OPT_OUT_WORDS.has(normalized.replace(COURTESY, ''))) return true;
  return OPT_OUT_PHRASES.some(phrase => ` ${normalized} `.includes(` ${phrase} `));
}

function isReactivationMessage(text) {
  if (isOptOutMessage(text)) return false;
  const normalized = normalizeText(text);
  return REACTIVATION_PHRASES.some(phrase => containsPhrase(normalized, phrase));
}

module.exports = { normalizeText, isOptOutMessage, isReactivationMessage };
