import test from 'node:test';
import assert from 'node:assert/strict';
import {logRecord} from '../server/logger.mjs';
test('logs retain correlation and code locations without request or exception secrets',()=>{
 const error=new Error('bot123:secret actor@example.org private.wav');
 error.stack='Error: bot123:secret\n at upload (/app/server/index.mjs:200:10)\n at fetch (https://example.org/token-secret)';
 const row=logRecord('error','job.failed',{job_id:'job-1',request_id:'req-1',body:'secret',headers:{authorization:'secret'},filename:'private.wav',duration_ms:42},error);
 assert.equal(row.job_id,'job-1');assert.equal(row.duration_ms,42);
 assert.deepEqual(row.locations,['server/index.mjs:200:10']);
 assert.doesNotMatch(JSON.stringify(row),/secret|private.wav|actor@|authorization/);
});
