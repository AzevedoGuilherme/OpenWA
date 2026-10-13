'use strict';

/** An Error carrying the HTTP status the dashboard should answer with, plus optional details. */
function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

module.exports = { httpError };
