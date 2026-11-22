import {createPublicKey,verify} from 'node:crypto';
let cached,until=0;
export async function telegramKeys(){
 if(cached&&Date.now()<until)return cached;
 const response=await fetch('https://oauth.telegram.org/.well-known/jwks.json',{signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('Telegram keys unavailable');
 const data=await response.json();if(!Array.isArray(data.keys))throw new Error('Invalid Telegram keys');
 cached=data.keys;until=Date.now()+3600000;return cached;
}
export function verifyBrowserToken(raw,clientId,nonce,keys,now=Math.floor(Date.now()/1000)){
 if(typeof raw!=='string'||raw.length>16384)throw new Error('Invalid ID token');
 const parts=raw.split('.');if(parts.length!==3)throw new Error('Invalid JWT');
 const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
 // RS256 is Telegram's default. Never accept algorithm changes from the token.
 if(header.alg!=='RS256'||typeof header.kid!=='string')throw new Error('Unsupported algorithm');
 const jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));
 if(!jwk||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw new Error('Invalid signature');
 const aud=claims.aud;
 if(claims.iss!=='https://oauth.telegram.org'||!(Array.isArray(aud)?aud.includes(String(clientId)):String(aud)===String(clientId))||!Number.isInteger(claims.exp)||claims.exp<=now||!Number.isInteger(claims.iat)||claims.iat>now+30||now-claims.iat>600||claims.nonce!==nonce||!nonce)throw new Error('Invalid claims');
 const telegramId=typeof claims.id==='string'&&/^[1-9][0-9]*$/.test(claims.id)?Number(claims.id):claims.id;
 if(!Number.isSafeInteger(telegramId)||telegramId<1)throw new Error('Missing Telegram identity');
 return {id:telegramId,first_name:String(claims.name||claims.given_name||'Учасник').slice(0,100),username:String(claims.preferred_username||'').slice(0,100)};
}
