/** Print an OWNER_PASSWORD_HASH for the given password, read from stdin so it stays out of argv.
 * Usage: node scripts/owner-password.mts   (then type the password and press Enter)
 */
import { assertPasswordPolicy, hashPassword, MIN_PASSWORD_LENGTH } from '../packages/infrastructure/auth/password.mts';

let input = '';
for await (const chunk of process.stdin) input += chunk.toString('utf8');
const password = input.replace(/[\r\n]+$/, '');
try {
  assertPasswordPolicy(password);
} catch {
  process.stderr.write(`password rejected: use ${MIN_PASSWORD_LENGTH}-200 characters\n`);
  process.exit(2);
}
process.stdout.write(`${await hashPassword(password)}\n`);
