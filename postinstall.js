const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'node_modules/sense-js-sdk/dist/index.js');
if (fs.existsSync(filePath)) {
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/dayjs\/plugin\/([a-zA-Z]+)(?!\.js)/g, 'dayjs/plugin/$1.js');
  content = content.replace(/lodash\/([a-zA-Z]+)(?!\.js)/g, 'lodash/$1.js');
  fs.writeFileSync(filePath, content);
  console.log('Postinstall: Patched sense-js-sdk ESM subpath imports successfully.');
}
