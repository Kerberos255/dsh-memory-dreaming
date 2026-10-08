import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Persistent fail-closed channel-source lookup independent of active Cordis services.
 * Never treat workspace / Agent preset equality as proof of a user's identity.
 */
export function channelSessionIds(ctx){
  // Reuse Channel Core's live SQLite connection when available. Keep lookups
  // fresh on every call so a revoked identity cannot survive in a stale cache.
  const live=ctx.get?.('channelCore')?.store?.db;
  const filename=ctx.dshHomePath?.('channel-core','state.sqlite');
  if(!live&&(!filename||!fs.existsSync(filename)))return new Set();
  const db=live??new DatabaseSync(filename,{readOnly:true});
  try{
    const sessions=new Set();
    // Channel Core keeps verified ownership for rotated, archived DMs.
    // Preserve their channel provenance even when a future receipt cleanup removes older rows.
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    for(const table of ['bindings','receipts','archived_dm_sessions']){
      if(!tables.has(table))continue;
      for(const row of db.prepare('SELECT session_id FROM '+table).all())sessions.add(row.session_id);
    }
    return sessions;
  }finally{if(!live)db.close();}
}
export function publicMemorySourceAllowed(sessionId,channelIds,header){
  return !channelIds.has(sessionId)&&header?.origin!=='discord'&&header?.origin!=='feishu'
    &&header?.origin!=='channel';
}

/** Read-only permission check against Channel Core's explicit verified identity.
 * A shared workspace or allow-all bot configuration is never sufficient.
 */
export function ownerChannelAuthorized(ctx,sessionId,config){
  if(!config?.ownerIdentityId||!sessionId)return false;
  try{return ctx.get?.('channelCore')?.trustedMemorySession?.(sessionId,config.ownerIdentityId)===true;}
  catch{return false;}
}
