const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'node_modules/sense-js-sdk/dist/index.js');
if (fs.existsSync(filePath)) {
  let content = fs.readFileSync(filePath, 'utf8');
  // Revert previous double-suffix if any
  content = content.replace(/\.js\.js/g, '.js');
  // Match dayjs plugin imports that don't end in .js
  content = content.replace(/['"](dayjs\/plugin\/[^'"]+?)(?<!\.js)['"]/g, (match, p1) => {
    if (!p1.endsWith('.js')) {
      return `'${p1}.js'`;
    }
    return match;
  });
  // Match lodash imports that don't end in .js
  content = content.replace(/['"](lodash\/[^'"]+?)(?<!\.js)['"]/g, (match, p1) => {
    if (!p1.endsWith('.js')) {
      return `'${p1}.js'`;
    }
    return match;
  });
  fs.writeFileSync(filePath, content);
  console.log('Postinstall: Robustly patched sense-js-sdk ESM subpath imports successfully.');
}
