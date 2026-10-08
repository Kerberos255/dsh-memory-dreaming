/** Persistent audit metadata for confirmed facts, kept in the same SQLite database.
 * MEMORY.md is still the publication source of truth; this table is not a second fact store.
 */
export function initLifecycle(db){
  db.exec(`CREATE TABLE IF NOT EXISTS memory_fact_versions(
    scope TEXT NOT NULL, id TEXT NOT NULL, topic TEXT NOT NULL,
    valid_from INTEGER NOT NULL, valid_until INTEGER,
    reviewed_at INTEGER NOT NULL, supersedes TEXT NOT NULL DEFAULT '[]',
    superseded_by TEXT, reason TEXT,
    PRIMARY KEY(scope,id)
  );
  CREATE INDEX IF NOT EXISTS memory_versions_topic ON memory_fact_versions(scope,topic);`);
}
export function versionOf(db,scope,row){
  const version=db.prepare('SELECT * FROM memory_fact_versions WHERE scope=? AND id=?').get(scope,row.id);
  if(!version)return {validFrom:row.confirmed??row.created,validUntil:null,reviewedAt:row.confirmed??row.created,supersedes:[],supersededBy:null,reason:null};
  return {validFrom:version.valid_from,validUntil:version.valid_until,reviewedAt:version.reviewed_at,
    supersedes:JSON.parse(version.supersedes),supersededBy:version.superseded_by,reason:version.reason};
}
export function publishVersion(db,scope,row,replaced=[],now=Date.now()){
  const previous=db.prepare('SELECT * FROM memory_fact_versions WHERE scope=? AND id=?').get(scope,row.id);
  const supersedes=[...new Set([...(previous ? JSON.parse(previous.supersedes) : []),...replaced.map(item=>item.id)])];
  db.prepare(`INSERT INTO memory_fact_versions(scope,id,topic,valid_from,valid_until,reviewed_at,supersedes,superseded_by,reason)
    VALUES(?,?,?,?,NULL,?,?,NULL,NULL)
    ON CONFLICT(scope,id) DO UPDATE SET valid_until=NULL,reviewed_at=excluded.reviewed_at,
      supersedes=excluded.supersedes,superseded_by=NULL,reason=NULL`)
    .run(scope,row.id,row.topic,previous?.valid_from??now,now,JSON.stringify(supersedes));
  for(const old of replaced){
    db.prepare(`INSERT INTO memory_fact_versions(scope,id,topic,valid_from,valid_until,reviewed_at,supersedes,superseded_by,reason)
      VALUES(?,?,?,?,?,?,'[]',?,'superseded')
      ON CONFLICT(scope,id) DO UPDATE SET valid_until=excluded.valid_until,
        superseded_by=excluded.superseded_by,reason='superseded'`)
      .run(scope,old.id,old.topic,old.confirmed??old.created??now,now,old.confirmed??now,row.id);
  }
}
export function forgetVersion(db,scope,id,now=Date.now()){
  db.prepare("UPDATE memory_fact_versions SET valid_until=?,reason='forgotten' WHERE scope=? AND id=? AND valid_until IS NULL").run(now,scope,id);
}
export function reviewStatus(version,days,now=Date.now()){
  return {...version,reviewDue:version.validUntil===null && now-version.reviewedAt>=days*86400000};
}
export function memoryTopics(facts,{maxTopics=30,maxEntries=3}={}){
  const groups=new Map();
  for(const fact of facts){
    const topic=String(fact.topic||'其他').slice(0,128);
    let group=groups.get(topic);
    if(!group)groups.set(topic,group={topic,count:0,examples:[],latest:0});
    group.count++;
    group.latest=Math.max(group.latest,fact.confirmed??0);
    if(group.examples.length<maxEntries)group.examples.push({id:fact.id,text:String(fact.text).slice(0,160)});
  }
  return [...groups.values()].sort((a,b)=>b.latest-a.latest).slice(0,maxTopics);
}
