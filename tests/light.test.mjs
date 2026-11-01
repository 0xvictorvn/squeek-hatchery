import {test} from 'node:test';import assert from 'node:assert/strict';import {freshSession,develop,seedPattern,lampGeometry,palette,metadata,patternPreview,creature} from '../src/incubation.js';
test('lamp moves vertically and aims along ellipse surface normal at all heights',()=>{let previous=-Infinity;for(let p=-100;p<=100;p+=5){const g=lampGeometry(p);assert.ok(g.sourceY>previous);previous=g.sourceY;const x=g.targetX-200,y=g.targetY-185;const tx=-94*y/130,ty=130*x/94;const dot=(g.sourceX-g.targetX)*tx+(g.sourceY-g.targetY)*ty;assert.ok(Math.abs(dot)<1e-7);assert.ok(g.sourceY>=0&&g.sourceY<390);}});
test('longer illumination deepens only the illuminated coat and moving lamp retains it',()=>{const s=freshSession();s.lampPosition=-75;develop(s,2,120,180);const p=s.paint.find(p=>p.y===130);const initial=p.dose;develop(s,5,120,180);assert.ok(p.dose>initial);const held=structuredClone(p);s.lampPosition=85;develop(s,10,120,290);assert.deepEqual(p,held);});
test('patterns derive deterministically from actual work; no new work means no pattern progress',()=>{const s=freshSession();seedPattern(s,{counterEpoch:'A',cumulativeWorkUnits:'1001'});assert.equal(s.patternType,'stars');develop(s,5,120,180);assert.ok(s.paint.every(p=>p.pattern===0));develop(s,5,120,180,20n);assert.ok(s.paint.some(p=>p.pattern>0));assert.equal(s.patternType,'stars');assert.deepEqual(s.patternSource,{counterEpoch:'A',cumulativeWorkUnits:'1001',bucket:'20',workStep:'50'});});
test('rainbow appears only in real distance passages and only coats exposed locations',()=>{assert.equal(palette(0,'2026-11-02').rainbow,false);const color=palette(500000,'2026-11-02');assert.equal(color.rainbow,true);assert.equal(palette(520000,'2026-11-02').rainbow,false);const s=freshSession();s.lampPosition=85;develop(s,15,120,color,20n);assert.ok(s.paint.some(p=>p.rainbow>.5));assert.equal(s.paint[0].rainbow,0);assert.match(metadata(s,'Rainbow').image,/^data:image\/svg\+xml;base64,/);});

test('50-work buckets keep layout stable and expose rare patterns and precise boundaries',()=>{
 const a=freshSession(),b=freshSession();
 seedPattern(a,{counterEpoch:'A',cumulativeWorkUnits:'1000'});seedPattern(b,{counterEpoch:'A',cumulativeWorkUnits:'1199'});
 assert.equal(a.patternType,'stars');assert.equal(a.patternSeed,b.patternSeed);
 assert.equal(patternPreview('1199').remaining,'1');assert.equal(patternPreview('1200').type,'spots');
 assert.equal(patternPreview('2000').type,'swirls');assert.equal(patternPreview('2200').type,'stripes');
 assert.equal(patternPreview('9007199254740993499').remaining,'1');assert.equal(patternPreview('999').next,'stars');assert.equal(patternPreview('1000').remaining,'200');assert.equal(patternPreview('1099').seed,patternPreview('1000').seed);assert.equal(patternPreview('1999').next,'swirls');
 a.lampPosition=50;develop(a,10,120,180,200n);assert.equal(a.patternType,'stars');
 assert.match(creature(a),/<polygon/);
 seedPattern(b,{counterEpoch:'A',cumulativeWorkUnits:'2000'});b.lampPosition=50;develop(b,10,120,180,100n);assert.match(creature(b),/stroke-width="3"/);
});
test('5m colors and distinct 5m rare passages retain local pearl exposure',()=>{
 const date='2026-11-02';assert.equal(palette(4999,date).segment,0);assert.equal(palette(5000,date).segment,1);
 assert.equal(palette(249999,date).pearl,false);assert.equal(palette(250000,date).pearl,true);assert.equal(palette(255000,date).pearl,false);
 assert.equal(palette(500000,date).rainbow,true);assert.equal(palette(505000,date).rainbow,false);assert.equal(palette(750000,date).pearl,true);
 const s=freshSession();s.lampPosition=-75;develop(s,10,120,palette(250000,date));const before=structuredClone(s.paint[2]);
 assert.ok(before.pearl>.5);s.lampPosition=85;develop(s,10,120,palette(0,date));assert.deepEqual(s.paint[2],before);
 assert.ok(metadata(s,'Pearl').attributes.find(a=>a.trait_type==='Pearl coat').value);
});
