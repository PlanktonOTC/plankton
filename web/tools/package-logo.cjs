const fs = require('fs');
const path = require('path');
const sharp = require(process.argv[2] || 'sharp');
const dir = path.join(process.cwd(), 'public/assets');
const png = fs.readFileSync(path.join(dir, 'plankton-logo-original.png')).toString('base64');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="664" height="264" viewBox="313 488 664 264"><title>PLANKTON wireframe mark</title><defs><filter id="foreground" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.520833 0.520833 0.520833 0 -0.5625"/></filter></defs><image x="0" y="0" width="1254" height="1254" href="data:image/png;base64,${png}" filter="url(#foreground)"/></svg>`;
fs.writeFileSync(path.join(dir,'plankton-logo.svg'),svg);
sharp(Buffer.from(svg)).png().toFile(path.join(dir,'plankton-logo.png')).then(info=>console.log(info));

