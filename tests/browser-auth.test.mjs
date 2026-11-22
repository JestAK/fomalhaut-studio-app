import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyBrowserToken} from '../server/browser-auth.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const keys=[{...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256'}];
const claims={iss:'https://oauth.telegram.org',aud:'123',id:111,name:'Test',preferred_username:'test',iat:1000,exp:1600,nonce:'nonce'};
function jwt(c={},h={}){const a=Buffer.from(JSON.stringify({alg:'RS256',kid:'test',...h})).toString('base64url'),b=Buffer.from(JSON.stringify({...claims,...c})).toString('base64url');return a+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(a+'.'+b),privateKey).toString('base64url');}
test('browser identity requires Telegram signature, audience, issuer, expiry and bound nonce',()=>{
 assert.equal(verifyBrowserToken(jwt(),'123','nonce',keys,1001).id,111);
 assert.equal(verifyBrowserToken(jwt({id:'111'}),'123','nonce',keys,1001).id,111);
 for(const c of [{aud:'evil'},{iss:'evil'},{exp:999},{iat:2000},{iat:1},{nonce:'other'},{id:'1e2'},{id:''},{id:null},{id:'9007199254740993'},{id:undefined},{id:'-1'},{id:0}])assert.throws(()=>verifyBrowserToken(jwt(c),'123','nonce',keys,1001));
 for(const h of [{alg:'none'},{alg:'HS256'},{kid:'unknown'}])assert.throws(()=>verifyBrowserToken(jwt({},h),'123','nonce',keys,1001));
 const raw=jwt();assert.throws(()=>verifyBrowserToken(raw.slice(0,-10)+'aaaaaaaaaa','123','nonce',keys,1001));
 assert.throws(()=>verifyBrowserToken(raw,'123','',keys,1001));
});
