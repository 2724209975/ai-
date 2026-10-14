import { Client } from 'pg';
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL_REQUIRED');
const client=new Client({connectionString:process.env.TEST_DATABASE_URL});
await client.connect();try{await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');}finally{await client.end();}
