/** Synthetic health-only listener to observe child binding; no platform/database capability. */
import { createServer } from 'node:http';
if (process.env.NODE_ENV !== 'test' || process.env.LOCAL_STACK_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ host: process.env.HOST }));
}).listen(Number(process.env.PORT), process.env.HOST);
