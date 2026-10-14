// Failure matrix before implementation:
// 1. Encryption notices create inbound/outgoing chat rows and AI webhooks.
// 2. Empty unknown notices do the same; valid text/media must remain deliverable.
// 3. Optional getContact() never settles and blocks a normal text indefinitely.
// 4. Enrichment timeout must not dispatch a message twice after late resolution.
require('ts-node/register/transpile-only');
const {EventEmitter}=require('node:events');
const {createServer}=require('node:http');
const assert=require('node:assert/strict');
const {registerWwebjsMessageEvents}=require('../../src/engine/adapters/wwebjs-message-events');
const fs=require('node:fs');
(async()=>{
 const delivered=[];const server=createServer((req,res)=>{let s='';req.on('data',x=>s+=x);req.on('end',()=>{delivered.push(JSON.parse(s));res.end('ok')})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const pending=[];const client=new EventEmitter();let contacts=0;
 const dispatch=m=>pending.push(fetch(`http://127.0.0.1:${server.address().port}/webhook`,{method:'POST',body:JSON.stringify({type:m.type,body:m.body,hasMedia:!!m.media,fromMe:m.fromMe})}));
 const host={logger:{error(){},warn(){},log(){}},getCallbacks:()=>({onMessage:dispatch,onMessageCreate:dispatch}),capInboundMediaFor:async()=>({mimetype:'image/png',data:'synthetic'})};
 registerWwebjsMessageEvents(client,host);
 const base={id:{_serialized:'false_fixture@lid_synthetic'},from:'fixture@lid',to:'business@c.us',body:'',type:'e2e_notification',timestamp:1,fromMe:false,hasMedia:false,hasQuotedMsg:false,getContact:async()=>{contacts++;return null}};
 try{
 for(let i=0;i<7;i++)client.emit('message',{...base});client.emit('message_create',{...base,fromMe:true});
 client.emit('message',{...base,type:'unrecognized'});
 await new Promise(r=>setTimeout(r,50));await Promise.all(pending);
 assert.equal(delivered.length,0,'system notices must not become customer webhooks');assert.equal(contacts,0,'system notices must not request contact enrichment');
 client.emit('message',{...base,type:'chat',body:'Synthetic normal text'});
 client.emit('message',{...base,type:'image',hasMedia:true});
 await new Promise(r=>setTimeout(r,50));await Promise.all(pending);
 assert.equal(delivered.length,2);assert.ok(delivered.some(x=>x.body==='Synthetic normal text'));assert.ok(delivered.some(x=>x.hasMedia));
 let finish;client.emit('message',{...base,type:'chat',body:'Synthetic stalled contact',getContact:()=>new Promise(r=>finish=r)});
 await new Promise(r=>setTimeout(r,2200));await Promise.all(pending);
 assert.equal(delivered.length,3,'optional contact lookup must not block text delivery');
 finish({name:'Synthetic contact'});await new Promise(r=>setTimeout(r,50));await Promise.all(pending);assert.equal(delivered.length,3,'late lookup must not duplicate dispatch');
 fs.mkdirSync('artifacts/inbound-regression',{recursive:true});fs.writeFileSync('artifacts/inbound-regression/result.json',JSON.stringify({passed:true,checks:['system inbound/outgoing blocked','empty unknown blocked','text delivered','media delivered','stalled contact bounded','late result no duplicate']},null,2));console.log('PASS 6 inbound checks using real handler and HTTP sink');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
