/** Request identifiers and coarse route labels shared by every HTTP entry point.
 *
 * A caller-supplied `X-Request-Id` is honoured only when it is a plain token, so a log line can
 * never be forged with content or a credential; route labels replace identifier-shaped path
 * segments, which keeps logs groupable without recording who or which message.
 */
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{8,64}$/;
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{15,}|\w{24,})$/i;
const MAX_ROUTE_LABEL = 96;

export function requestIdOf(request: IncomingMessage): string {
  const raw = request.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

/** The shape of the request, never a caller-supplied identifier or a query string. */
export function routeLabel(url: string | undefined): string {
  let pathname: string;
  try { pathname = new URL(url ?? '/', 'http://localhost').pathname; }
  catch { return '/'; }
  const shaped = pathname.split('/').map(segment => (ID_SEGMENT.test(segment) ? ':id' : segment)).join('/');
  return shaped.length <= MAX_ROUTE_LABEL ? shaped : `${shaped.slice(0, MAX_ROUTE_LABEL - 3)}...`;
}
