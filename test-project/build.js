const fs = require('fs');
const path = require('path');

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  fs.rmSync(distPath, { recursive: true, force: true });
}
fs.mkdirSync(distPath);
fs.writeFileSync(path.join(distPath, 'index.html'), new Date().toString());
