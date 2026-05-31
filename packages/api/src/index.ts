import { start } from './server.js';

start().catch((err) => {
  console.error('Failed to start API server:', err);
  process.exit(1);
});
