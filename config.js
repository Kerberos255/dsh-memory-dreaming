import { defineConfig } from './plugin-settings/remote-config.js';
const integer=(v,a,b)=>Number.isSafeInteger(v)&&v>=a&&v<=b;
export const schema=defineConfig({enabled:true,workspace:'',agentPreset:'agent',timeZone:'Asia/Shanghai',modelProvider:'',model:'',embeddingProvider:'',embeddingModel:'',vectorStore:'sqlite',maxOutputTokens:4096,maxInputTokens:12000,maxSessions:30,maxCandidates:500,minConfidence:0.8,minObservations:2,candidateDays:90,memoryReviewDays:180,autoPromote:false,incremental:true,ownerIdentityId:'owner',recall:true,autoRecall:true,autoRecallMaxItems:3,autoRecallMaxChars:1200,automatic:false,dailyTime:'00:15:00',dreamTime:'04:00:00',weeklyTime:'04:30:00',weeklyDay:1}, {
 workspace:v=>v.length<=4096,agentPreset:v=>/^[a-z0-9-]{1,80}$/.test(v),timeZone:v=>{try{new Intl.DateTimeFormat('en',{timeZone:v}).format();return true;}catch{return false;}},
 modelProvider:(v,c)=>v.length<=256&&!!v.trim()===!!c.model.trim(),model:v=>v.length<=256,
 ownerIdentityId:v=>v===''||/^[a-zA-Z0-9_-]{1,128}$/.test(v),embeddingProvider:(v,c)=>v.length<=128&&!!v.trim()===!!c.embeddingModel.trim(),embeddingModel:v=>v.length<=256,vectorStore:v=>v.length>=1&&v.length<=128,
 maxOutputTokens:v=>integer(v,256,16384),maxInputTokens:v=>integer(v,1000,65536),maxSessions:v=>integer(v,1,100),maxCandidates:v=>integer(v,10,5000),minConfidence:v=>Number.isFinite(v)&&v>=0.5&&v<=1,minObservations:v=>integer(v,1,20),candidateDays:v=>integer(v,7,3650),memoryReviewDays:v=>integer(v,30,3650),autoRecallMaxItems:v=>integer(v,1,5),autoRecallMaxChars:v=>integer(v,200,4000),
 dailyTime:v=>/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v),dreamTime:v=>/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v),weeklyTime:v=>/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(v),weeklyDay:v=>integer(v,1,7),
});
