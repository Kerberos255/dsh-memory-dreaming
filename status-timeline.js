/**
 * Historical activity is not a current fact.  We only surface dated status
 * evidence for an explicit status question with a distinguishable task name.
 * Nothing here alters verified MEMORY.md facts or promotes a diary into one.
 */
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('en-US');
const STOP=/现在|目前|当前|最新|最近|进展|进度|状态|情况|是否|有没有|是不是|还在|怎样|怎么样|如何|到底|已经|完成|做完|做好|了吗|了没|没有|了吗|成功|结束|进行中|已|么|吗|呢|的|还|么|啦|呢|查一下|看看/gu;
const STATUS_QUESTION=/(目前|现在|当前|最新|进度|进展|状态|做完|做好|完成[了没吗]|是否完成|还在|处理完|解决了|修好了|上线了|is it done|progress|status|finished|completed)/iu;
const STATES=[
 ['cancelled',/(?:已(?:经)?(?:放弃|取消|终止)|不再(?:继续|开发)|决定(?:放弃|取消))/u],
 ['reopened',/(?:重新(?:开启|打开|启动|处理)|再次(?:失败|报错)|回归(?:失败|未通过)|又(?:坏了|失败)|重新(?:修复|排查))/u],
 ['incomplete',/(?:尚未(?:完成|解决|修复)|未(?:完成|解决|修复|通过)|还没(?:完成|做好|解决|修复)|仍(?:未完成|在处理|在开发)|待(?:完成|修复|处理|验证)|进行中|正在(?:开发|修复|排查|处理|测试|优化)|尚在(?:进行|开发))/u],
 ['completed',/(?:已(?:经)?(?:完成|解决|修复|合并|上线|发布)|(?:正式)?(?:完成|修复|解决)(?:了|啦|完毕)|(?:完成并|修复并)(?:通过|发布|合并)|验收通过|测试通过并(?:已)?发布)/u],
 ['planned',/(?:计划(?:进行|开展|实施|修复|优化)|准备(?:开发|处理|进行|优化)|下一步(?:处理|优化|修复)|将(?:开展|处理|实现))/u],
];
const CHINESE=/[\p{Script=Han}]+/gu;
const ENGLISH=/[a-z0-9][a-z0-9._-]{2,}/gu;
export function needsStatusTimeline(query){return typeof query==='string'&&STATUS_QUESTION.test(query);}
function anchors(query){
 const cleaned=normalize(query).replace(STOP,' ');
 const latin=[...new Set(cleaned.match(ENGLISH)??[])].filter(x=>!['status','progress','done','finished','completed'].includes(x));
 const chinese=new Set();
 for(const run of cleaned.match(CHINESE)??[]){
  if(run.length===2)chinese.add(run);
  else for(let i=0;i<run.length-1;i++)chinese.add(run.slice(i,i+2));
 }
 return {latin,chinese:[...chinese]};
}
function subjectMatches(sentence,title,queryAnchors){
 const local=normalize(sentence),context=normalize(title+' '+sentence);
 const latin=queryAnchors.latin.filter(x=>context.includes(x));
 const han=queryAnchors.chinese.filter(x=>local.includes(x));
 // A project name alone is not a task.  Require a specific action/component.
 // When there is no English project name, two Chinese bigrams are necessary.
 if(queryAnchors.latin.length && latin.length<Math.min(2,queryAnchors.latin.length))return false;
 if(queryAnchors.chinese.length===0)return queryAnchors.latin.length>=2&&latin.length>=2&&queryAnchors.latin.some(x=>local.includes(x));
 if(queryAnchors.latin.length>0)return han.length>=1;
 return han.length>=Math.min(2,queryAnchors.chinese.length);
}
function classify(line){
 for(const [state,matcher] of STATES)if(matcher.test(line))return state;
 return null;
}
function evidenceDate(filename){
 // A weekly report covers a period; use the last covered date only for
 // ordering, never claim its text describes an event that happened that day.
 const weekly=filename.match(/(20\d\d-\d\d-\d\d)[_~](20\d\d-\d\d-\d\d)/);
 if(weekly)return {date:weekly[2],precision:'week'};
 const daily=filename.match(/(20\d\d-\d\d-\d\d)/);
 return daily?{date:daily[1],precision:'day'}:null;
}
function describeRow(row,queryAnchors){
 const date=evidenceDate(row.filename);
 if(!date)return [];
 const found=[];
 for(const [offset,line] of String(row.body).split(/\r?\n/u).entries()){
  for(const sentence of line.split(/[。；;]/u)){
   const part=sentence.trim().replace(/^[-*\s]+/,'');
   if(part.length<10||part.length>420||!subjectMatches(part,row.title,queryAnchors))continue;
   const kind=classify(part);
   if(!kind)continue;
   found.push({state:kind,date:date.date,precision:date.precision,text:part.slice(0,300),path:row.filename,line:row.line+offset,sourceType:'historical-unverified',id:row.id});
  }
 }
 return found.slice(0,4);
}
export function statusTimeline(query,rows,{limit=4}={}){
 if(!needsStatusTimeline(query))return [];
 const task=anchors(query);
 if(!task.chinese.length&&task.latin.length<2)return []; // A project name alone is too broad.
 const evidence=rows.flatMap(row=>describeRow(row,task));
 evidence.sort((a,b)=>b.date.localeCompare(a.date)
   ||(a.precision==='day'?-1:1)-(b.precision==='day'?-1:1)
   ||a.path.localeCompare(b.path)||a.line-b.line);
 const seen=new Set(),distinct=[];
 for(const item of evidence){
  const key=item.date+'|'+item.state+'|'+item.text;
  if(seen.has(key))continue;seen.add(key);
  distinct.push(item);
  if(distinct.length>=limit)break;
 }
 return distinct;
}
