'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Writes through a temp file and a rename, so a crash never leaves a half-written file. */
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
