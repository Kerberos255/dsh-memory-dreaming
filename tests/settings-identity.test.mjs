import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=relative=>fs.readFileSync(new URL(relative,import.meta.url),'utf8');

test('Dream uses Channel Core as the sole visible owner authority',()=>{
 const pages=JSON.parse(read('../tools/settings/pages.json'));
 const fields=pages['dsh-memory-dreaming'].fields;
 assert(!fields.some(field=>field.key==='ownerIdentityId'));
 assert(!read('../client.js').includes('"key":"ownerIdentityId"'),'built page must hide the redundant control');
 const sample=JSON.parse(read('../config.example.json'));
 assert.equal(sample.ownerIdentityId,'owner','fresh installs must not silently disable owner verification');
 assert(!read('../README.md').includes('在「Dream 与长期记忆 → 跨会话召回」的 `ownerIdentityId` 输入'));
});

test('archive provenance survives DM rebind without granting channel memory access',()=>{
 const src=read('../source-boundary.js');
 assert(src.includes("'archived_dm_sessions'"),'historic channels must stay marked as channel sources');
 assert(src.includes('ownerChannelAuthorized(ctx,sessionId,config)'));
 assert(src.includes('trustedMemorySession'));
});
