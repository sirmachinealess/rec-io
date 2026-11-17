// Prints an HTML page to PDF bytes using a hidden Electron window.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { escapeHtml } = require('./export-format');

async function renderPdf(html, title) {
  const tmp = path.join(app.getPath('temp'), `rec-io-print-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await printer.loadFile(tmp);
    await printer.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    return await printer.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.55, bottom: 0.7, left: 0.6, right: 0.6 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 42px;display:flex;justify-content:space-between;font:7.5px sans-serif;color:#64748B"><span>${escapeHtml(title)} · rec.io</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    printer.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { renderPdf };
