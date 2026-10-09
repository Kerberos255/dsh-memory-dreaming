import test from 'node:test';
import assert from 'node:assert/strict';
import { modelStreamFailureMessage } from '../model-failure.js';

test('surfaces official model failure code and HTTP status without provider error text',()=>{
 const result=modelStreamFailureMessage({code:'ACCOUNT_QUOTA',status:402,message:'[REDACTED] actual private chat'});
 assert.match(result,/额度不足/);
 assert.match(result,/ACCOUNT_QUOTA/);
 assert.match(result,/HTTP 402/);
 assert(!result.includes('SECRET'));
 assert(!result.includes('private chat'));
});
test('explains rate limiting and transport failures without exposing secrets',()=>{
 assert.match(modelStreamFailureMessage({code:'RATE_LIMIT',status:429}),/限流/);
 assert.match(modelStreamFailureMessage({code:'TRANSPORT'}),/网络连接失败/);
 assert.match(modelStreamFailureMessage({code:'CONTEXT_WINDOW_EXCEEDED',status:400}),/上下文容量不足/);
});
test('unrecognized and invalid codes remain safe with helpful status',()=>{
 const m=modelStreamFailureMessage({code:'token:[REDACTED]',status:404,message:'https://private.example.org/token'});
 assert.match(m,/UNKNOWN/);
 assert.match(m,/HTTP 404/);
 assert(!m.includes('private.example.org'));
 assert(!m.includes('token:'));
});
