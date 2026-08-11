const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.disable('x-powered-by');

// Static assets (uploads live under /public/uploads)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const httpServer = http.createServer(app);

const messenger = require('./lib/messenger');
messenger.attach(httpServer, app);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🟢 VChat is live  →  http://localhost:' + PORT);
  console.log('');
});
