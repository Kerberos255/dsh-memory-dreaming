import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DAILY = /^20\d\d-\d\d-\d\d\.md$/;
const WEEKLY = /^(20\d\d-\d\d-\d\d)_(20\d\d-\d\d-\d\d)\.md$/;
const MAX_BYTES = 256 * 1024;
const DAY_MS = 86400000;
const digest = data => createHash('sha256').update(data).digest('hex');

function directoryWithin(cwd, relative, create=false) {
  const root=fs.realpathSync(cwd),parts=relative.split('/');
  let full=root;
  for(const part of parts) {
    if(!/^[\w.-]+$/.test(part)||part==='.'||part==='..')throw new Error('无效归档目录');
    full=path.join(full,part);
    if(!fs.existsSync(full)) {
      if(!create)return null;
      fs.mkdirSync(full);
    }
    const st=fs.lstatSync(full);
    if(!st.isDirectory()||st.isSymbolicLink())throw new Error('归档目录存在符号链接或不是目录');
  }
  return full;
}
function olderThan(name, now, days) {
  const m=name.match(WEEKLY);
  const date=m?m[2]:name.slice(0,10);
  const parsed=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date)return false;
  // Use the END of the referenced date as the cutoff, not the file mtime.
  return parsed+DAY_MS <= now-days*DAY_MS;
}
export class HistoryArchive {
  constructor({now=()=>Date.now()}={}) {this.now=now;}
  plan(cwd,{days=365}={}) {
    if(!Number.isSafeInteger(days)||days<30||days>3650)throw new Error('归档天数须在 30–3650 天之间');
    const entries=[],now=this.now();
    for(const [kind,folder,pattern] of [['daily','memory',DAILY],['weekly','memory/weekly',WEEKLY]]) {
      const base=directoryWithin(cwd,folder);
      if(!base)continue;
      for(const entry of fs.readdirSync(base,{withFileTypes:true})) {
        if(!entry.isFile()||!pattern.test(entry.name)||!olderThan(entry.name,now,days))continue;
        const source=path.join(base,entry.name),st=fs.lstatSync(source);
        if(st.isSymbolicLink()||!st.isFile()||st.size>MAX_BYTES||now-st.mtimeMs<DAY_MS)continue;
        const year=entry.name.slice(0,4);
        const relative='memory/history/'+kind+'/'+year+'/'+entry.name;
        const parent=directoryWithin(cwd,'memory/history/'+kind+'/'+year);
        const dest=parent&&path.join(parent,entry.name);
        let state='ready';
        if(dest&&fs.existsSync(dest)){
          const ds=fs.lstatSync(dest);
          if(ds.isSymbolicLink()||!ds.isFile())state='conflict';
          else state=st.size===ds.size&&digest(fs.readFileSync(source))===digest(fs.readFileSync(dest))?'exists':'conflict';
        }
        entries.push({kind,source:folder+'/'+entry.name,destination:relative,state});
      }
    }
    return {days,eligible:entries.filter(e=>e.state==='ready').length,alreadyArchived:entries.filter(e=>e.state==='exists').length,conflicts:entries.filter(e=>e.state==='conflict').length,entries:entries.slice(0,5000)};
  }
  preserveDaily(cwd,day,body,expectedDigest) {
    if(!DAILY.test(day+'.md')||typeof body!=='string'||Buffer.byteLength(body)>MAX_BYTES||digest(body)!==expectedDigest)throw new Error('每日记忆归档校验失败');
    const destination='memory/history/daily/'+day.slice(0,4);
    const dir=directoryWithin(cwd,destination,true),target=path.join(dir,day+'.md');
    if(fs.existsSync(target)) {
      const st=fs.lstatSync(target);
      if(st.isSymbolicLink()||!st.isFile()||digest(fs.readFileSync(target))!==expectedDigest)throw new Error('永久日记归档目标冲突');
      return {stored:true,existing:true};
    }
    try {
      fs.writeFileSync(target,body,{flag:'wx'});
      if(digest(fs.readFileSync(target))!==expectedDigest)throw new Error('永久日记归档写入校验失败');
    }catch(error){
      if(error.code==='EEXIST')throw new Error('永久日记归档目标冲突');
      throw error;
    }
    return {stored:true,existing:false};
  }
  snapshot(cwd,{days=365}={}) {
    const plan=this.plan(cwd,{days});
    const output={...plan,copied:0,skipped:plan.alreadyArchived,errors:[]};
    for(const item of plan.entries.filter(e=>e.state==='ready')) {
      const source=directoryWithin(cwd,path.posix.dirname(item.source));
      const filename=path.posix.basename(item.source);
      const st=fs.lstatSync(path.join(source,filename));
      if(st.isSymbolicLink()||!st.isFile()||st.size>MAX_BYTES)continue;
      const destDir=directoryWithin(cwd,path.posix.dirname(item.destination),true);
      const target=path.join(destDir,filename);
      try {
        fs.copyFileSync(path.join(source,filename),target,fs.constants.COPYFILE_EXCL);
        const copy=fs.statSync(target);
        if(copy.size!==st.size||digest(fs.readFileSync(target))!==digest(fs.readFileSync(path.join(source,filename))))throw new Error('归档校验失败');
        output.copied++;
      } catch(error){
        output.errors.push({file:item.source,reason:error.code==='EEXIST'?'目标文件已存在，跳过':'无法安全生成归档快照'});
      }
    }
    return output;
  }
}
