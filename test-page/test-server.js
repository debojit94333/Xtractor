// Minimal local HTTP test server
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const filePath = path.join(__dirname, 'test.html');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/test.html') {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading test.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Xtractor Test Sandbox running at http://localhost:${PORT}/`);
  console.log('Open Chrome, navigate to the URL, and test the extension!');
});
