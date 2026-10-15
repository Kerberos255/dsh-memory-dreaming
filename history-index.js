import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lexicalScore } from './recall-context.js';
import { bounded } from './vector.js';
import { needsStatusTimeline, statusTimeline } from './status-timeline.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const DAY = /^20\d\d-\d\d-\d\d\.md$/;
const LIMIT_BYTES = 256 * 1024;
const MAX_FILES = 5000;
const MAX_CHUNKS = 25000;
const risky = /(?:sk-[\w-]{12,}|(?:api[ _-]?key|secret|password|access[ _-]?token|bot[ _-]?token|authorization|bearer|cookie|session[ _-]?id|client[ _-]?id|用户名|手机号|身份证|银行卡|邮箱|密码|密钥|私钥|凭证|账号|账户信息)\s*[:=：]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\d[ -]?){12,19})/iu;
function cleanText(raw) {
  return raw.replace(/```[\s\S]*?```/g, item=>item.replace(/[^\r\n]/g,'')).replace(/<!--[\s\S]*?-->/g,item=>item.replace(/[^\r\n]/g,'')).split(/\r?\n/).map(line => line.length>2000||risky.test(line)?'':line).join('\n').trimEnd();
}
function words(value) {
  const result=[];
  for (const run of value.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_.-]{2,}/gu) ?? []) {
    if (/[\p{Script=Han}]/u.test(run)) {
      for(let i=0;i<run.length-1;i++) result.push(run.slice(i,i+2));
    } else result.push(run);
  }
  return [...new Set(result)].slice(0,40000);
}
function tokenize(value){return words(value).join(' ');}
function segments(source, name) {
  const lines = cleanText(source).split('\n'), output=[];
  let title=name, chunk='', begin=1, ordinal=0;
  const flush=()=>{
    const text=chunk.trim();
    if(text.length>=16) output.push({ordinal:ordinal++,title,body:text,line:begin});
    chunk='';
  };
  for(const [i,line] of lines.entries()) {
    if(/^#{1,4}\s+/.test(line)) {flush();title=line.replace(/^#{1,4}\s+/,'').slice(0,140);begin=i+1;}
    const parts=line.length>1200?line.match(/[\s\S]{1,1100}/g)??[]:[line];
    for(const part of parts) {
      if(chunk.length+part.length>1100) {flush();begin=i+1;}
      chunk+=part+'\n';
    }
  }
  flush();
  return output.slice(0,1000);
}
function dateOf(name) {
  const file=path.posix.basename(name);
  if(DAY.test(file))return file.slice(0,10);
  const match=file.match(/20\d\d-\d\d-\d\d/);
  return match?.[0]??file.match(/^20\d\d-(?:0[1-9]|1[0-2])(?=\.md$|--[a-f0-9]{12}\.md$)/)?.[0]??null;
}
export class HistoryIndex {
  constructor(filename, options={}) {
    this.filename=filename;this.db=null;this.stats={scanned:0,updated:0};
    this.clock=options.clock??(()=>Date.now());
  }
  open() {
    if(this.db)return this.db;
    fs.mkdirSync(path.dirname(this.filename),{recursive:true});
    const db=new DatabaseSync(this.filename);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS history_files(scope TEXT NOT NULL, filename TEXT NOT NULL, mtime REAL NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(scope,filename));
        CREATE TABLE IF NOT EXISTS history_chunks(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,filename TEXT NOT NULL,ordinal INTEGER NOT NULL,line INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,vec BLOB,fingerprint TEXT,UNIQUE(scope,filename,ordinal));
        CREATE INDEX IF NOT EXISTS history_chunk_path ON history_chunks(scope,filename);
        CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(terms,tokenize='unicode61');`);
      this.db=db;return db;
    } catch(e){db.close();throw e;}
  }
  discover(cwd) {
    const root=fs.realpathSync(cwd),found=[];
    const specs=[
      {dir:'memory/history/daily',kind:'historical-daily',years:true},
      {dir:'memory/history/weekly',kind:'historical-weekly',years:true},
      {dir:'memory/history/monthly',kind:'historical-monthly',years:true},
      {dir:'memory/history/notes',kind:'historical-notes'},
      {dir:'memory',kind:'current-daily'},
      {dir:'memory/weekly',kind:'current-weekly'}
    ];
    // An imported document may carry a content-hash suffix when a calendar
    // date collides with an existing document. No source-product identity needed.
    const daily=/^20\d\d-\d\d-\d\d(?:--[a-f0-9]{12})?\.md$/;
    const weekly=/^(?:20\d\d-\d\d-\d\d_20\d\d-\d\d-\d\d|weekly-summary-20\d\d[0-9~-]*)(?:--[a-f0-9]{12})?\.md$/;
    const monthly=/^20\d\d-(?:0[1-9]|1[0-2])(?:--[a-f0-9]{12})?\.md$/;
    const note=/^[\p{L}\p{N}][\p{L}\p{N} ._（）()·：，、-]{0,119}\.md$/u;
    const allowed=(name,kind)=>{
      if(kind==='historical-daily')return daily.test(name);
      if(kind==='historical-weekly')return weekly.test(name);
      if(kind==='historical-monthly')return monthly.test(name);
      if(kind==='historical-notes')return note.test(name)&&!/(?:password|token|secret|credential|config|private|accounts?|README|moltbook|凭证|账号|密钥|配置)/iu.test(name);
      return kind==='current-daily'?DAY.test(name):/^20\d\d-\d\d-\d\d_20\d\d-\d\d-\d\d\.md$/.test(name);
    };
    const folder=relative=>{
      let current=root;
      for(const part of relative.split('/')){
        current=path.join(current,part);
        if(!fs.existsSync(current))return null;
        const st=fs.lstatSync(current);
        if(st.isSymbolicLink()||!st.isDirectory())throw new Error('历史索引目录存在符号链接或不是目录');
      }
      return current;
    };
    for(const spec of specs){
      const base=folder(spec.dir);
      if(!base)continue;
      const directories=[spec.dir];
      if(spec.years)for(const entry of fs.readdirSync(base,{withFileTypes:true})){
        if(entry.isDirectory()&&/^20\d\d$/.test(entry.name))directories.push(spec.dir+'/'+entry.name);
      }
      for(const relative of directories){
        const directory=folder(relative);
        const files=fs.readdirSync(directory,{withFileTypes:true});
        if(found.length+files.length>MAX_FILES)throw new Error('历史资料文件数超出安全上限');
        for(const entry of files){
          if(!entry.isFile()||!allowed(entry.name,spec.kind))continue;
          const full=path.join(directory,entry.name),stat=fs.lstatSync(full);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(spec.kind==='historical-monthly'?512*1024:LIMIT_BYTES))continue;
          found.push({name:relative+'/'+entry.name,full,mtime:stat.mtimeMs,bytes:stat.size});
        }
      }
    }
    return found;
  }
  sync(cwd, {incremental=true}={}) {
    const db=this.open(),scope=hash(fs.realpathSync(cwd).toLowerCase()),files=this.discover(cwd);
    const registered=new Map(db.prepare('SELECT filename,mtime,bytes FROM history_files WHERE scope=?').all(scope).map(x=>[x.filename,x]));
    let updated=0;
    for(const file of files){
      const before=registered.get(file.name);
      if(incremental&&before&&before.mtime===file.mtime&&before.bytes===file.bytes)continue;
      const raw=fs.readFileSync(file.full,'utf8'),digest=hash(raw);
      if(before&&db.prepare('SELECT digest FROM history_files WHERE scope=? AND filename=?').get(scope,file.name)?.digest===digest){
        db.prepare('UPDATE history_files SET mtime=?,bytes=? WHERE scope=? AND filename=?').run(file.mtime,file.bytes,scope,file.name);continue;
      }
      const chunks=segments(raw,file.name);
      db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare('DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history_chunks WHERE scope=? AND filename=?)').run(scope,file.name);
        db.prepare('DELETE FROM history_chunks WHERE scope=? AND filename=?').run(scope,file.name);
        const insert=db.prepare('INSERT INTO history_chunks(scope,filename,ordinal,line,title,body,digest) VALUES(?,?,?,?,?,?,?)');
        const fts=db.prepare('INSERT INTO history_fts(rowid,terms) VALUES(?,?)');
        for(const item of chunks){
          const result=insert.run(scope,file.name,item.ordinal,item.line,item.title,item.body,hash(item.body));
          fts.run(result.lastInsertRowid,tokenize(item.title+' '+item.body));
        }
        db.prepare('INSERT OR REPLACE INTO history_files VALUES(?,?,?,?,?)').run(scope,file.name,file.mtime,file.bytes,digest);
        db.exec('COMMIT');updated++;
      }catch(e){db.exec('ROLLBACK');throw e;}
    }
    const active=new Set(files.map(e=>e.name));
    for(const old of registered.keys())if(!active.has(old)){
      db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare('DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history_chunks WHERE scope=? AND filename=?)').run(scope,old);
        db.prepare('DELETE FROM history_chunks WHERE scope=? AND filename=?').run(scope,old);
        db.prepare('DELETE FROM history_files WHERE scope=? AND filename=?').run(scope,old);
        db.exec('COMMIT');updated++;
      }catch(e){db.exec('ROLLBACK');throw e;}
    }
    const count=db.prepare('SELECT COUNT(*) n FROM history_chunks WHERE scope=?').get(scope).n;
    if(count>MAX_CHUNKS)throw new Error('历史索引分块数超出上限');
    this.stats={scanned:files.length,updated,count};
    return this.stats;
  }
  status(cwd) {
    if(!this.db&&!fs.existsSync(this.filename))return {indexed:false,files:0,chunks:0};
    const db=this.open(),scope=hash(fs.realpathSync(cwd).toLowerCase());
    return {indexed:true,files:db.prepare('SELECT COUNT(*) n FROM history_files WHERE scope=?').get(scope).n,chunks:db.prepare('SELECT COUNT(*) n FROM history_chunks WHERE scope=?').get(scope).n};
  }
  async search(cwd,query,{limit=5,maxChars=2000,incremental=true,semantic=true,vectorIndex=null,config={},signal}={}) {
    if(typeof query!=='string'||!query.trim()||query.length>1000)return [];
    signal?.throwIfAborted();
    this.sync(cwd,{incremental});
    const term=words(query).slice(0,16);
    if(!term.length)return [];
    const db=this.open(),scope=hash(fs.realpathSync(cwd).toLowerCase());
    const statement=db.prepare(`SELECT c.id,c.filename,c.line,c.title,c.body,c.digest,c.vec,c.fingerprint,bm25(history_fts) AS relevance FROM history_fts JOIN history_chunks c ON c.id=history_fts.rowid WHERE history_fts MATCH ? AND c.scope=? ORDER BY bm25(history_fts) LIMIT 128`);
    // FTS terms are escaped as quoted tokens, not evaluated as user query syntax.
    const phrase=term.map(x=>'"'+x.replace(/"/g,'""')+'"').join(' OR ');
    const candidates=statement.all(phrase,scope);
    if(!candidates.length)return [];
    const minimum=term.length>=3?2:1;
    const ranked=candidates.filter(row=>{
      const candidateWords=new Set(words(row.title+' '+row.body));
      return term.filter(word=>candidateWords.has(word)).length>=minimum;
    }).map(row=>({...row,score:Math.min(.80,Math.max(.05,lexicalScore(query,{text:row.body,topic:row.title,tags:[]})/12)),semantic:0}));
    if(!ranked.length)return [];
    if(semantic&&vectorIndex&&config.embeddingProvider&&config.embeddingModel) {
      try {
        const {provider,fingerprint}=vectorIndex.selection(config);
        const work=ranked.slice(0,Math.min(16,ranked.length));
        const missing=work.filter(x=>x.fingerprint!==fingerprint||!x.vec);
        const inputs=[query,...missing.map(x=>x.title+'\n'+x.body)];
        const values=await bounded(s=>provider.embed({texts:inputs,model:config.embeddingModel,signal:s}),signal,2500);
        if(Array.isArray(values)&&values.length===inputs.length){
          const normalized=v=>{const a=Float32Array.from(v);const norm=Math.hypot(...a);return norm?a.map(x=>x/norm):a;};
          const needle=normalized(values[0]);if(needle.length) {
            for(let j=0;j<missing.length;j++){
              const v=normalized(values[j+1]);
              if(v.length===needle.length&&v.every(Number.isFinite)){
                const data=Buffer.from(v.buffer,v.byteOffset,v.byteLength);
                db.prepare('UPDATE history_chunks SET vec=?,fingerprint=? WHERE id=? AND digest=?').run(data,fingerprint,missing[j].id,missing[j].digest);
                missing[j].vec=data;missing[j].fingerprint=fingerprint;
              }
            }
            for(const item of work)if(item.vec&&item.fingerprint===fingerprint){
              const v=new Float32Array(item.vec.buffer.slice(item.vec.byteOffset,item.vec.byteOffset+item.vec.byteLength));
              if(v.length!==needle.length)continue;
              let dot=0;for(let i=0;i<v.length;i++)dot+=v[i]*needle[i];
              item.semantic=Math.max(0,dot);
              item.score=Math.min(1,.6*item.score+.4*item.semantic);
            }
          }
        }
      }catch(error){signal?.throwIfAborted();}
    }
    ranked.sort((a,b)=>b.score-a.score||a.filename.localeCompare(b.filename));
    const result=[];let used=0;const perFile=new Map(),seenDigest=new Set();
    for(const row of ranked){
      if(result.length>=limit)break;
      if((perFile.get(row.filename)??0)>=2||seenDigest.has(row.digest))continue;
      const body=row.body.trim().slice(0,380);
      if(!body||used+body.length+80>maxChars)continue;
      result.push({id:'history-'+row.id,text:body,title:row.title,source:{type:'historical-file',path:row.filename,line:row.line,date:dateOf(row.filename),archived:row.filename.startsWith('memory/history/'),reviewed:false},score:Math.round(row.score*1000)/1000});
      perFile.set(row.filename,(perFile.get(row.filename)??0)+1);seenDigest.add(row.digest);
      used+=body.length+80;
    }
    return result;
  }
  /**
   * Date-aware, bounded second retrieval leg. The ordinary semantic ranking
   * is not a reliable way to discover changes after an old "in progress".
   * Never promote a journal entry to a verified current fact.
   */
  timeline(cwd,query,{limit=4,signal}={}){
    if(!needsStatusTimeline(query))return [];
    signal?.throwIfAborted();
    this.sync(cwd,{incremental:true});
    const term=words(query).filter(x=>x.length>=2).slice(0,16);
    if(!term.length)return [];
    const db=this.open(),scope=hash(fs.realpathSync(cwd).toLowerCase());
    const phrase=term.map(x=>'"'+x.replace(/"/g,'""')+'"').join(' OR ');
    const rows=db.prepare(`SELECT c.id,c.filename,c.line,c.title,c.body
      FROM history_fts JOIN history_chunks c ON c.id=history_fts.rowid
      WHERE history_fts MATCH ? AND c.scope=?
      ORDER BY c.filename DESC LIMIT 256`).all(phrase,scope);
    signal?.throwIfAborted();
    return statusTimeline(query,rows,{limit});
  }
  close(){this.db?.close();this.db=null;}
}
