import {isDeepStrictEqual} from 'node:util';
/** Compare JSON wire values, ignoring object field order and omitted optional fields.
 * Array order, scalar types and null remain significant.
 */
export function sameJsonValue(a:unknown,b:unknown){
  const normalize=(value:unknown)=>{const text=JSON.stringify(value);return text===undefined?undefined:JSON.parse(text);};
  return isDeepStrictEqual(normalize(a),normalize(b));
}
