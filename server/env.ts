import { config } from 'dotenv';
import { join } from 'node:path';

config({ path: process.env.CFACTORY_ENV_FILE ?? join(process.cwd(), '.env.local'), quiet: true });
