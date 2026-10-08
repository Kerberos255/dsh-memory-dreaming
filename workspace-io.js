import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest=value=>createHash('sha256').update(value).digest('hex');
export const absent=error=>['ENOENT','ENOTDIR'].includes(error?.code);
export function inside(root,target){const relative=path.relative(root,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
export function safePath(root,relative){
 if(typeof relative!=='string'||!relative||relative.includes('\0')||relative.includes('\\')||relative.includes(':')||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('文件路径须为包内相对路径');
 const target=path.resolve(root,relative);if(!inside(root,target))throw new Error('文件超出目标目录');
 for(let current=target;inside(root,current);current=path.dirname(current)){
  try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('此操作不支持符号链接或目录联接');}catch(error){if(!absent(error))throw error;}
  if(current===root)break;
 }
 const parent=fs.realpathSync(root);if(!inside(parent,target))throw new Error('目标根目录发生变化');return target;
}
export function readBounded(filename,maxBytes=1048576){
 let fd;try{if(fs.lstatSync(filename).isSymbolicLink())throw new Error('此操作不支持符号链接');fd=fs.openSync(filename,'r');const info=fs.fstatSync(fd);if(!info.isFile()||info.size>maxBytes)throw new Error('文件过大或不是普通文件');const bytes=fs.readFileSync(fd);if(bytes.length>maxBytes||bytes.includes(0))throw new Error('文件过大或不是文本');return bytes.toString('utf8');}catch(error){if(absent(error))return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function writeCAS(filename,text,expected=null,maxBytes=1048576){
 if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw new Error('文件内容超过限制');
 fs.mkdirSync(path.dirname(filename),{recursive:true});
 const lock=filename+'.dsh-lock';let fd;
 try{fd=fs.openSync(lock,'wx');}catch(error){if(error.code==='EEXIST')throw new Error('文件正在写入，请稍后重试');throw error;}
 const temp=filename+'.'+randomUUID()+'.tmp';
 try{
  const current=readBounded(filename,maxBytes);if((current===null?null:digest(current))!==expected)throw new Error('文件已在外部修改，请重新读取后确认');
  fs.writeFileSync(temp,text,{flag:'wx',mode:0o600});
  // Recheck after staging, before the atomic rename.
  const latest=readBounded(filename,maxBytes);if((latest===null?null:digest(latest))!==expected)throw new Error('文件已在外部修改，请重新读取后确认');
  fs.renameSync(temp,filename);return digest(text);
 }finally{fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(error){if(!absent(error))throw error;}fs.unlinkSync(lock);}
}
export async function workspace(ctx,value,signal){
 signal?.throwIfAborted();const supplied=value?.workspace?.trim();
 const resolved=supplied||((await ctx.workspaceController.initializeDefault(signal)).workspace.path);
 const root=fs.realpathSync(resolved);if(!fs.statSync(root).isDirectory())throw new Error('工作区不是目录');return root;
}
export function projectRoot(cwd){let current=cwd;while(true){if(fs.existsSync(path.join(current,'.git')))return current;const parent=path.dirname(current);if(parent===current)return cwd;current=parent;}}
export function scopeId(cwd,preset='agent'){return digest(JSON.stringify([fs.realpathSync(cwd).toLocaleLowerCase('en-US'),preset]));}
export function ownedDirectory(root,relative){
 const real=fs.realpathSync(root);let current=real;
 for(const part of relative.split('/')){if(!part||part==='.'||part==='..'||part.includes('\\')||part.includes(':'))throw new Error('无效目录');const target=path.join(current,part);try{fs.mkdirSync(target);}catch(error){if(error.code!=='EEXIST')throw error;}const info=fs.lstatSync(target);if(!info.isDirectory()||info.isSymbolicLink()||!inside(real,fs.realpathSync(target)))throw new Error('目标目录含符号链接或不是目录');current=target;}
 return current;
}
