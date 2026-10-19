import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Conversation } from '../runtime/conversation.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'principal-driver-'));
const codex = path.join(root, 'codex'),
  agy = path.join(root, 'agy');
await writeFile(
  codex,
  `#!${process.execPath}
const {createInterface}=require('node:readline');let turn=0;let timer;
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',l=>{let m=JSON.parse(l);if(m.method==='initialize')emit({id:m.id,result:{}});
else if(m.method==='thread/start'||m.method==='thread/resume')emit({id:m.id,result:{thread:{id:m.params.threadId||'native-thread'}}});
else if(m.method==='turn/start'){turn++;emit({id:m.id,result:{turn:{id:'turn-'+turn}}});emit({method:'item/agentMessage/delta',params:{delta:'partial'}});timer=setTimeout(()=>emit({method:'turn/completed',params:{turn:{status:'completed',items:[{type:'agentMessage',text:m.params.input[0].text}]}}}),30);}
else if(m.method==='turn/steer')emit({id:m.id,result:{turnId:m.params.expectedTurnId}});
else if(m.method==='thread/compact/start'){emit({id:m.id,result:{}});emit({method:'item/completed',params:{item:{type:'contextCompaction'}}});}
else if(m.method==='turn/interrupt'){clearTimeout(timer);emit({id:m.id,result:{}});emit({method:'turn/completed',params:{turn:{status:'interrupted',items:[]}}});}});
`,
);
await writeFile(
  agy,
  `#!${process.execPath}
const {createInterface}=require('node:readline');const args=process.argv;const i=args.indexOf('--conversation');let id=i<0?'agy-native':args[i+1];
if(args[args.indexOf('--effort')+1]!=='medium')process.exit(2);
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');emit({event:'init',conversation_id:id});
createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.message.content==='EOF'){process.exit(1);return;}
process.stdout.write('malformed event\\n');emit({event:'step_update',step_update:{step_type:'agent_response',state:'ACTIVE'}});emit({event:'step_update',step_update:{step_type:'agent_response',state:'ACTIVE'}});emit({event:'step_update',step_update:{step_type:'tool',state:'completed'}});
emit({event:'result',result:{status:'SUCCESS',conversation_id:id,response:m.message.content,usage:{input_tokens:100,total_tokens:120}}});});
`,
);
await chmod(codex, 0o700);
await chmod(agy, 0o700);
const message = { prompt: 'first', timeoutSeconds: 2, outputSchema: { type: 'string' } };
test('Codex repeated turns, native steering, compaction and cold thread resume', async () => {
  const events = [];
  const c = new Conversation(
    'codex',
    (t, d) => events.push({ t, d }),
    () => {},
    { command: codex, cwd: root },
  );
  try {
    await c.open(message);
    const first = c.send(message);
    while (!c.turnId) await new Promise((r) => setTimeout(r, 1));
    assert.equal(
      (await c.steer({ input: 'correction', clientMessageId: 'unique' })).supported,
      true,
    );
    assert.equal((await first).result, 'first');
    assert.equal((await c.send({ ...message, prompt: 'second' })).result, 'second');
    assert.equal((await c.compact()).supported, true);
    assert.ok(events.some((e) => e.t === 'session'));
  } finally {
    await c.shutdown();
  }
  const restored = new Conversation(
    'codex',
    () => {},
    () => {},
    { command: codex, cwd: root },
  );
  try {
    await restored.open({ ...message, resumeSession: 'native-thread' });
    assert.equal(restored.nativeId, 'native-thread');
    assert.equal((await restored.send({ ...message, prompt: 'cold' })).result, 'cold');
  } finally {
    await restored.shutdown();
  }
});
test('Antigravity keeps stdin open across turns and explicitly rejects native steering/compaction', async () => {
  const events = [];
  const c = new Conversation(
    'antigravity',
    (type, data) => events.push({ type, data }),
    () => {},
    { command: agy, cwd: root },
  );
  try {
    await c.open(message);
    assert.equal((await c.send(message)).result, 'first');
    assert.equal((await c.send({ ...message, prompt: 'second' })).result, 'second');
    assert.equal(c.child.exitCode, null);
    assert.equal(events.filter((event) => event.type === 'activity' && event.data.action === 'Preparing response').length, 2, 'Activity is deduplicated within each turn but retained across turns'); 
    assert.equal((await c.steer({ input: 'no' })).supported, false);
    assert.equal((await c.compact()).supported, false);
  } finally {
    await c.shutdown();
  }
});
test('Antigravity premature EOF fails the pending turn and cold resume retains identifier', async () => {
  const c = new Conversation(
    'antigravity',
    () => {},
    () => {},
    { command: agy, cwd: root },
  );
  try {
    await c.open({ ...message, resumeSession: 'agy-restored' });
    assert.equal((await c.send(message)).sessionId, 'agy-restored');
    await assert.rejects(c.send({ ...message, prompt: 'EOF' }), /closed before turn result/);
  } finally {
    await c.shutdown();
  }
});
test.after(async () => await rm(root, { recursive: true, force: true }));
