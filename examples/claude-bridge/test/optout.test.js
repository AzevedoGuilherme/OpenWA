'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOptOutMessage, isReactivationMessage } = require('../lib/optout');

// [message, is an opt-out, is a reactivation]
const cases = [
  ['No me escriban más.', true, false],
  ['BAJA', true, false],
  ['baja por favor', true, false],
  ['Stop!', true, false],
  ['¿Quién te dio mi número?', true, false],
  ['Dejá de escribirme', true, false],
  ['quiero darme de alta', false, false],
  ['alta', false, false],
  ['¿El precio baja si somos menos?', false, false],
  ['quiero dar de baja la reserva', false, false],
  ['Hola', false, false],
  ['Hola, quiero información para unos 15.', false, false],
  ['Quiero retomar mi consulta y recibir mensajes.', false, true],
  ['Quiero volver a recibir mensajes', false, true],
  ['No quiero volver a recibir mensajes', true, false],
  ['pueden escribirme nuevamente', false, true],
];

for (const [text, optOut, reactivation] of cases) {
  test(`opt-out detection: ${JSON.stringify(text)}`, () => {
    assert.equal(isOptOutMessage(text), optOut);
    assert.equal(isReactivationMessage(text), reactivation);
  });
}
