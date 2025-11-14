require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { sequelize } = require('./models');
const routes = require('./routes');
const initSockets = require('./sockets/socket');
const { seedThemes } = require('./utils/seedThemes');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve simple public files (test pages)
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', routes);

app.get('/', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// Make io accessible to routes via app.locals
app.locals.io = io;

initSockets(io);

const PORT = process.env.PORT || 4000;

// Test database connection first
async function startServer() {
  try {
    console.log('Testing database connection...');
    await sequelize.authenticate();
    console.log('Database connection established successfully.');
    
    console.log('Syncing database models...');
    await sequelize.sync();
    console.log('Database models synced successfully.');
    
    // Seed themes and words
    // console.log('Seeding themes...');
    // await seedThemes();
    console.log('Themes seeded successfully.');
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Server listening on 0.0.0.0:${PORT} (accessible from emulators via 10.0.2.2:${PORT})`);
      console.log(`Database: ${process.env.DB_NAME || 'inkbattles'}`);
      console.log(`Host: ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || 3306}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    console.error('Full error:', err);
    
    // Retry after 5 seconds
    console.log('Retrying in 5 seconds...');
    setTimeout(startServer, 5000);
  }
}

startServer();
