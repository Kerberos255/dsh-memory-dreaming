/** Pure action selector for the one model-visible memory_search tool. */
export function memoryReadAction(args,{topics,search}){
 const action=args.action??'search';
 if(action==='topics'){
  if(args.query!==undefined||args.limit!==undefined)throw new Error('memory-topics-arguments-invalid');
  return topics();
 }
 if(action!=='search'||typeof args.query!=='string'||!args.query.trim())throw new Error('memory-search-query-required');
 return search(args.query,args.limit??5);
}
