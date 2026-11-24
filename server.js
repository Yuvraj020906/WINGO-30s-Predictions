require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.WINGO_HISTORY_URL || 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'wingo-store.json');
const GAME = process.env.WINGO_GAME || 'WinGo_30S';
const ROUND_MS = 30000;
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function emptyDB(){ return {version:2, results:[], predictions:[], settings:{payouts:{number:9,bigSmall:2,color:2,green:2,red:2,violet:4}, feeRate:0}, timing:{phaseMs:null,samples:0,updatedAt:null}, updatedAt:null}; }
function loadDB(){ try { const x=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); const base=emptyDB(); return {...base,...x,settings:{...base.settings,...(x.settings||{}),payouts:{...base.settings.payouts,...(x.settings?.payouts||{})}}}; } catch { return emptyDB(); } }
let db=loadDB();
// Backfill the retroactive flag for predictions verified before this check existed, so historical
// accuracy figures are not inflated by records created at or after the draw.
(function backfillRetroactive(){const drawTime={};db.results.forEach(r=>{drawTime[r.period]=Number(r.time);});db.predictions.forEach(p=>{if(p.actual===null||p.retroactive!==undefined)return;const d=drawTime[p.issue],m=Date.parse(p.predictionTime);p.retroactive=Number.isFinite(d)&&Number.isFinite(m)&&m>=d;});})();
// Records written before commitments existed cannot be proven unmodified. Hashing them now would
// produce a digest that says nothing about their original content, so they are marked and kept out
// of headline accuracy instead of being quietly upgraded to "verified".
function migrateLegacyCommitments(){
 let changed=false;
 db.predictions.forEach(p=>{
  if(p.commitment)return;
  p.commitmentOrigin='backfilled';
  p.prevHash=lastCommitment();
  p.commitment=commitmentFor(p);
  p.commitmentNote='Hash generated when tamper-evidence was introduced, after this record was created. It proves the record has not changed since then, not that the forecast preceded the draw.';
  changed=true;
 });
 if(changed)saveDB();
}
// /api/analysis is CPU-heavy (chronological calibration); memoise per data version so the
// 10s dashboard poll does not recompute it. Key changes only when a new draw is stored.
let analysisCache={key:null,value:null};
// models() runs 600 walk-forward iterations plus seven temperature fits (~1-3s). Both the
// prediction created for each new round and /api/analysis need the identical result, and it was
// being computed twice per draw. Stored result rows are immutable (de-duplicated by period and
// sorted chronologically), so length + first + last period identifies the dataset exactly.
// Note this deliberately ignores db.updatedAt, which is still stale while reconcile() runs.
let modelsCache={key:null,value:null};
function modelsKey(rows){const f=rows[0]?.period||'';const l=rows.at(-1)?.period||'';return `${rows.length}|${f}|${l}`;}
function modelsFor(rows){const key=modelsKey(rows);if(modelsCache.key!==key)modelsCache={key,value:models(rows)};return modelsCache.value;}
// Rollover observation state for the round-clock phase estimate.
let lastTopPeriod=null,lastHistoryPollAt=0,lastRolloverBracket=null;
function analysisCacheKey(){const last=db.results.at(-1);return `${db.results.length}|${last?last.period:''}|${db.updatedAt||''}`;}
function saveDB(){ fs.mkdirSync(path.dirname(DB_FILE),{recursive:true}); const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(db,null,2)); fs.renameSync(tmp,DB_FILE); }
function colorsFor(n){ if(n===0)return ['red','violet']; if(n===5)return ['green','violet']; return n%2===0?['red']:['green']; }
// The provider returns no per-row timestamp: every row in a batch carries the same `serviceTime`.
// Stamping rows with it makes 10 consecutive 30s draws share one time, which corrupts any
// before/after-the-draw comparison. The issue number encodes the draw moment exactly:
//   YYYYMMDD | 10005 (game constant) | 4-digit round index within the day
// Returns null when the period does not match this shape, so callers can fall back.
function drawTimeFor(period){
 const s=String(period);
 if(!/^\d{17}$/.test(s))return null;
 const day=s.slice(0,8),mid=s.slice(8,13),idx=Number(s.slice(13));
 if(mid!=='10005'||!Number.isInteger(idx)||idx<0)return null;
 const y=+day.slice(0,4),mo=+day.slice(4,6),d=+day.slice(6,8);
 if(mo<1||mo>12||d<1||d>31)return null;
 const midnight=Date.UTC(y,mo-1,d);
 if(!Number.isFinite(midnight))return null;
 // Reject impossible calendar dates (e.g. 20260231) rather than silently rolling them forward.
 const back=new Date(midnight);
 if(back.getUTCMonth()!==mo-1||back.getUTCDate()!==d)return null;
 return midnight+idx*ROUND_MS;
}
function normalize(row,index,serviceTime){
 if(!row||typeof row!=='object')return null;
 const issue=row.issueNumber??row.period??row.issue;
 // Number('') === 0 and Number(null) === 0, so a missing/blank `number` would otherwise be
 // stored as a verified "0" that never happened. Reject the raw value before coercing.
 if(row.number==null||String(row.number).trim()==='')return null;
 const digit=Number(row.number);
 if(issue==null||String(issue).trim()===''||!Number.isInteger(digit)||digit<0||digit>9)return null;
 const colors=Array.isArray(row.color)?row.color.map(String):String(row.color||'').split(',');
 const cleanColors=[...new Set(colors.map(x=>x.trim().toLowerCase()).filter(x=>['red','green','violet'].includes(x)))];
 const derived=colorsFor(digit);
 const explicit=row.time||row.openTime||row.drawTime;
 const hasExplicit=Number.isFinite(Number(explicit))&&Number(explicit)>0;
 const drawTime=hasExplicit?Number(explicit):drawTimeFor(issue,serviceTime);
 // timeExplicit marks a provider-supplied draw timestamp, so the legacy backfill below never
 // overwrites an authoritative time with the derived one.
 return {period:String(issue),digit,type:digit>=5?'Big':'Small',colors:cleanColors.length?cleanColors:derived,time:drawTime??serviceTime??null,timeDerived:drawTime!=null&&!hasExplicit,timeExplicit:hasExplicit,sourceIndex:index,verified:true};
}
function sortChronological(rows){ return rows.sort((a,b)=>{ const pa=String(a.period),pb=String(b.period); if(/^\d+$/.test(pa)&&/^\d+$/.test(pb)){ const x=BigInt(pa),y=BigInt(pb); return x<y?-1:x>y?1:0; } return pa.localeCompare(pb,undefined,{numeric:true}); });}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0;}
function variance(a){if(a.length<2)return 0;const m=mean(a);return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1);}
function entropy(p){return -p.reduce((s,x)=>s+(x>0?x*Math.log2(x):0),0);}
function dist(rows,alpha=0){const c=Array(10).fill(alpha);rows.forEach(r=>c[r.digit]++);const z=c.reduce((a,b)=>a+b,0)||1;return c.map(x=>x/z);}
function colorDist(rows){const c={Red:0,Green:0,Violet:0};rows.forEach(r=>{(r.colors||colorsFor(r.digit)).forEach(x=>{const k=x[0].toUpperCase()+x.slice(1);if(k in c)c[k]++;});});const z=rows.length||1;return Object.fromEntries(Object.entries(c).map(([k,v])=>[k,v/z]));}
function logLoss(p,y){return -Math.log(Math.max(1e-12,p[y]));}
function brier(p,y){return p.reduce((s,v,i)=>s+(v-(i===y?1:0))**2,0);}
function binomialTailApprox(z){ // two-sided normal approximation for chi-square statistic
 const p=Math.max(0,Math.min(1,Math.exp(-0.5*z)*Math.sqrt(2/Math.PI)/(Math.sqrt(z)+1e-9)));return Math.min(1,p*2);
}
function chiSquare(rows){const n=rows.length;if(n<20)return {statistic:null,pValue:null,df:9,note:'At least 20 observations recommended'};const e=n/10,c=Array(10).fill(0);rows.forEach(r=>c[r.digit]++);const stat=c.reduce((s,o)=>s+(o-e)**2/e,0);return {statistic:+stat.toFixed(4),pValue:+regularizedGammaQ(4.5,stat/2).toFixed(5),df:9,expectedPerNumber:e};}
function runsTest(values){if(values.length<10)return {z:null,runs:null,n:values.length};let runs=1;for(let i=1;i<values.length;i++)if(values[i]!==values[i-1])runs++;const n1=values.filter(Boolean).length,n2=values.length-n1;if(!n1||!n2)return {z:null,runs,n:values.length};const mu=1+2*n1*n2/(n1+n2),v=(2*n1*n2*(2*n1*n2-n1-n2))/(((n1+n2)**2)*(n1+n2-1));return {z:+((runs-mu)/Math.sqrt(v||1)).toFixed(4),runs,n:values.length};}
function autocorrelation(values,lag=1){if(values.length<=lag+2)return null;const m=mean(values),den=values.reduce((s,x)=>s+(x-m)**2,0);if(!den)return 0;let num=0;for(let i=lag;i<values.length;i++)num+=(values[i]-m)*(values[i-lag]-m);return +(num/den).toFixed(4);}
function transitions(rows){const m=Array.from({length:10},()=>Array(10).fill(0));for(let i=1;i<rows.length;i++)m[rows[i-1].digit][rows[i].digit]++;return m.map(row=>{const s=row.reduce((a,b)=>a+b,0);return row.map(x=>s?x/s:0);});}
function streak(rows,key){if(!rows.length)return {current:0,value:null};const val=key(rows[rows.length-1]),v=val;let n=0;for(let i=rows.length-1;i>=0&&key(rows[i])===v;i--)n++;return {current:n,value:v};}
function metrics(rows){const nums=rows.map(r=>r.digit),f=Array(10).fill(0);nums.forEach(x=>f[x]++);const windows={};[10,20,50,100,200,500].forEach(w=>{const a=rows.slice(-w);windows[w]={n:a.length,counts:Array(10).fill(0),probabilities:dist(a)};a.forEach(r=>windows[w].counts[r.digit]++);});const p=dist(rows);const n=rows.length;const chi=chiSquare(rows);const intervals=p.map((ph,i)=>{const z=1.96,den=1+z*z/Math.max(1,n),center=(ph+z*z/(2*Math.max(1,n)))/den,half=z*Math.sqrt((ph*(1-ph)+z*z/(4*Math.max(1,n)))/Math.max(1,n))/den;return {number:i,lower:Math.max(0,center-half),upper:Math.min(1,center+half)};});const halves=rows.length>=40?[rows.slice(0,Math.floor(n/2)),rows.slice(Math.floor(n/2))]:null;const drift=halves?halves[0].length&&halves[1].length?0.5*p.reduce((s,_,i)=>s+Math.abs(dist(halves[0])[i]-dist(halves[1])[i]),0):null:null;const geometricWait= p.map((q,i)=>({number:i,expectedWait:q?1/q:null,probabilityNotSeenNext10:q?Math.pow(1-q,10):1}));return {sampleSize:n,frequencies:f,probabilities:p,confidenceIntervals95:intervals,geometricWait,binomialBigSmall:{trials:n,observedBig:nums.filter(x=>x>=5).length,p0:0.5},multinomialCounts:f,distributionDriftTotalVariation:drift,windows,mean:+mean(nums).toFixed(4),variance:+variance(nums).toFixed(4),standardDeviation:+Math.sqrt(variance(nums)).toFixed(4),entropy:+entropy(p).toFixed(4),maxEntropy:Math.log2(10),chiSquare:chi,runs:runsTest(nums.map(x=>x>=5)),autocorrelation:{digitLag1:autocorrelation(nums,1),digitLag2:autocorrelation(nums,2),bigSmallLag1:autocorrelation(nums.map(x=>x>=5?1:0),1)},transitions:transitions(rows),bigSmall:{big:nums.filter(x=>x>=5).length,small:nums.filter(x=>x<5).length},colors:colorDist(rows),streaks:{number:streak(rows,r=>r.digit),bigSmall:streak(rows,r=>r.digit>=5?'Big':'Small'),color:streak(rows,r=>(r.colors||colorsFor(r.digit)).join('/'))},zScores:f.map(x=>n?+( (x-n/10)/Math.sqrt(n*.1*.9)).toFixed(3):0)};}
function models(rows){
 const n=rows.length, uniform=Array(10).fill(.1), recent=rows.slice(-Math.min(100,n)), freq=dist(rows,0), bayes=dist(rows,1), ew=Array(10).fill(0);recent.slice().reverse().forEach((r,i)=>ew[r.digit]+=Math.exp(-i/30));const ewSum=ew.reduce((a,b)=>a+b,0)||1;const ewP=ew.map(x=>x/ewSum);
 const last=rows.at(-1)?.digit;const trans=Array(10).fill(0);let tN=0;if(last!=null){for(let i=1;i<rows.length;i++)if(rows[i-1].digit===last){trans[rows[i].digit]++;tN++;}}const transP=trans.map(x=>(x+1)/(tN+10));
 const markov=transP;const patternCounts=Array(10).fill(0);let patternN=0;if(n>=3){const suffix=rows.slice(-2).map(r=>r.digit).join(',');for(let i=2;i<n;i++)if(rows[i-2].digit+','+rows[i-1].digit===suffix){patternCounts[rows[i].digit]++;patternN++;}}const pattern=patternCounts.map(x=>(x+1)/(patternN+10));
 // Walk-forward log-loss validation of the component models; scores are not independent evidence.
 const losses={frequency:[],bayesian:[],ewma:[],markov:[],pattern:[]};
 for(let i=Math.max(30,n-600);i<n;i++){const train=rows.slice(0,i),actual=rows[i].digit;const fp=dist(train),bp=dist(train,1),er=Array(10).fill(0);train.slice(-100).slice().reverse().forEach((r,j)=>er[r.digit]+=Math.exp(-j/30));const es=er.reduce((a,b)=>a+b,0)||1;const ep=er.map(x=>x/es);const ld=train.at(-1)?.digit;const tc=Array(10).fill(0);let tn=0;for(let j=1;j<train.length;j++)if(train[j-1].digit===ld){tc[train[j].digit]++;tn++;}const mp=tc.map(x=>(x+1)/(tn+10));const pc=Array(10).fill(0);let pn=0;if(train.length>=3){const sfx=train.slice(-2).map(r=>r.digit).join(',');for(let j=2;j<train.length;j++)if(train[j-2].digit+','+train[j-1].digit===sfx){pc[train[j].digit]++;pn++;}}const pp=pc.map(x=>(x+1)/(pn+10));losses.frequency.push(logLoss(fp,actual));losses.bayesian.push(logLoss(bp,actual));losses.ewma.push(logLoss(ep,actual));losses.markov.push(logLoss(mp,actual));losses.pattern.push(logLoss(pp,actual));}
 const avg=x=>x.length?mean(x):Math.log(10);const scores={frequency:avg(losses.frequency),bayesian:avg(losses.bayesian),ewma:avg(losses.ewma),markov:avg(losses.markov),pattern:avg(losses.pattern)};
 // Softmax inverse-loss weights; minimum data gate prevents unstable short-sample weighting.
 const names=['frequency','bayesian','ewma','markov'];const weights={};if(losses.frequency.length>=30){const raw=names.map(k=>Math.exp(-Math.min(10,scores[k])));const z=raw.reduce((a,b)=>a+b,0);names.forEach((k,i)=>weights[k]=raw[i]/z);}else names.forEach(k=>weights[k]=.25);
 const components={frequency:freq,bayesian:bayes,markov,ewma:ewP,pattern,random:uniform};const calibration=calibrationDiagnostics(rows);const temperatureFor=k=>calibration.models[k]?.status==='EVALUATED'?calibration.models[k].temperature:1;for(const k of Object.keys(components)){const ck=k==='ewma'?'ewma':k==='transition'?'markov':k;components[k]=softmaxTemperature(components[k],temperatureFor(ck));}const ensemble=Array(10).fill(0);names.forEach(k=>ensemble.forEach((_,i)=>ensemble[i]+=weights[k]*components[k][i]));const calibratedEnsemble=softmaxTemperature(ensemble,temperatureFor('ensemble'));
 const ranked=a=>a.map((probability,digit)=>({digit,probability})).sort((a,b)=>b.probability-a.probability);
 const result={sampleSize:n,weights,validation:{walkForwardCases:losses.frequency.length,meanLogLoss:scores,baselineLogLoss:Math.log(10)},models:{}};
 Object.entries(components).forEach(([name,p])=>{const r=ranked(p)[0];result.models[name]={name,predictedNumber:r.digit,probabilities:p,bigSmall:{Big:p.slice(5).reduce((a,b)=>a+b,0),Small:p.slice(0,5).reduce((a,b)=>a+b,0)},colors:colorProb(p),confidence:r.probability,sampleSize:n};});
 result.ensemble={name:'Walk-forward validation ensemble',predictedNumber:ranked(calibratedEnsemble)[0].digit,probabilities:calibratedEnsemble,bigSmall:{Big:calibratedEnsemble.slice(5).reduce((a,b)=>a+b,0),Small:calibratedEnsemble.slice(0,5).reduce((a,b)=>a+b,0)},colors:colorProb(calibratedEnsemble),confidence:Math.max(...calibratedEnsemble),sampleSize:n};result.calibration=calibration;result.multipleTesting=multipleTesting(rows);
 result.edge=(n>=100&&scores.bayesian<Math.log(10)-.02&&scores.bayesian<Math.min(scores.frequency,scores.ewma,scores.markov))?'POTENTIAL SIGNAL — requires independent confirmation':'NO RELIABLE EDGE DETECTED';
 return result;
}
function colorProb(p){let red=0,green=0,violet=0;p.forEach((x,n)=>{if(n===0){red+=x;violet+=x;}else if(n===5){green+=x;violet+=x;}else if(n%2===0)red+=x;else green+=x;});return {Red:red,Green:green,Violet:violet};}
function softmaxTemperature(p,t){const q=p.map(x=>Math.pow(Math.max(x,1e-15),1/t)),z=q.reduce((a,b)=>a+b,0);return q.map(x=>x/z);}
function normalCdf(x){const a=Math.abs(x),t=1/(1+0.2316419*a),d=0.3989422804014327*Math.exp(-a*a/2),v=1-d*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return x>=0?v:1-v;}
function regularizedGammaQ(a,x){if(x<0||a<=0)return null;if(x===0)return 1;const gln=(()=>{const c=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];let z=a-1,y=z+7.5,s=0.99999999999980993;for(let i=0;i<c.length;i++)s+=c[i]/(z+i+1);return 0.5*Math.log(2*Math.PI)+(z+0.5)*Math.log(y)-y+Math.log(s);})();
 if(x<a+1){let ap=a,sum=1/a,del=sum;for(let n=1;n<500;n++){ap++;del*=x/ap;sum+=del;if(Math.abs(del)<Math.abs(sum)*1e-14)break;}return Math.max(0,Math.min(1,1-sum*Math.exp(-x+a*Math.log(x)-gln)));}
 let b=x+1-a,c=1e300,d=1/Math.max(b,1e-300),h=d;for(let i=1;i<500;i++){const an=-i*(i-a);b+=2;d=an*d+b;if(Math.abs(d)<1e-300)d=1e-300;c=b+an/c;if(Math.abs(c)<1e-300)c=1e-300;d=1/d;const delta=d*c;h*=delta;if(Math.abs(delta-1)<1e-14)break;}return Math.max(0,Math.min(1,Math.exp(-x+a*Math.log(x)-gln)*h));}
function holmAdjust(tests){const valid=tests.filter(x=>Number.isFinite(x.pValue)).sort((a,b)=>a.pValue-b.pValue),m=valid.length;let running=0;valid.forEach((x,i)=>{const adjusted=Math.min(1,(m-i)*x.pValue);running=Math.max(running,adjusted);x.pAdjusted=+running.toFixed(8);x.significant05=x.pAdjusted<.05;});tests.filter(x=>!Number.isFinite(x.pValue)).forEach(x=>{x.pAdjusted=null;x.significant05=false;});return tests;}
function forecastComponents(rows){const n=rows.length,uniform=Array(10).fill(.1),freq=dist(rows),bayes=dist(rows,1),ew=Array(10).fill(0);rows.slice(-100).slice().reverse().forEach((r,i)=>ew[r.digit]+=Math.exp(-i/30));const ez=ew.reduce((a,b)=>a+b,0)||1;const ewma=ew.map(x=>x/ez);const last=rows.at(-1)?.digit,tc=Array(10).fill(0);let tn=0;for(let i=1;i<n;i++)if(rows[i-1].digit===last){tc[rows[i].digit]++;tn++;}const markov=tc.map(x=>(x+1)/(tn+10));const pc=Array(10).fill(0);let pn=0;if(n>=2){const suffix=rows.slice(-2).map(r=>r.digit).join(',');for(let i=2;i<n;i++)if(rows[i-2].digit+','+rows[i-1].digit===suffix){pc[rows[i].digit]++;pn++;}}const pattern=pc.map(x=>(x+1)/(pn+10));return {frequency:freq,bayesian:bayes,ewma,markov,pattern,random:uniform,ensemble:freq.map((_,i)=>(freq[i]+bayes[i]+ewma[i]+markov[i]+pattern[i])/5)};}
// Temperature is fitted by scanning t on a fixed grid. The original implementation re-applied
// softmaxTemperature to every record for every candidate t, which is 10 Math.pow() calls per record
// per candidate (~700k pow calls for a 360-record fit). Taking the log once per record and using
// exp(log(p)/t) gives the identical loss (softmax temperature is monotone in log p) in ~4x less CPU,
// which matters because this runs on the request/poll thread.
function fitTemperature(records){
 if(records.length<30)return {temperature:1,fitN:records.length,reason:'Need at least 30 chronological calibration forecasts'};
 if(records.every(r=>Math.max(...r.p)-Math.min(...r.p)<1e-12))return {temperature:1,loss:mean(records.map(r=>logLoss(r.p,r.y))),fitN:records.length,boundaryOptimum:false};
 const n=records.length,logs=new Float64Array(n*10),ys=new Int32Array(n);
 for(let i=0;i<n;i++){const p=records[i].p,o=i*10;ys[i]=records[i].y;for(let d=0;d<10;d++)logs[o+d]=Math.log(Math.max(p[d],1e-15));}
 const lossAt=t=>{const inv=1/t;let total=0;for(let i=0;i<n;i++){const o=i*10;let z=0;for(let d=0;d<10;d++)z+=Math.exp(logs[o+d]*inv);total+=Math.log(z)-logs[o+ys[i]]*inv;}return total/n;};
 let best={temperature:1,loss:Infinity};
 for(let t=.25;t<=20.0001;t+=.1){const loss=lossAt(t);if(loss<best.loss)best={temperature:+t.toFixed(2),loss};}
 return {...best,fitN:records.length,boundaryOptimum:best.temperature<=.25||best.temperature>=19.95};
}
function calibrationSummary(records,temp){
 if(!records.length)return {n:0,logLoss:null,brier:null,ece:null,mce:null,bins:[],classwiseECE:null};
 const scored=records.map(r=>({p:softmaxTemperature(r.p,temp),y:r.y}));
 const bins=Array.from({length:10},(_,i)=>({bin:`${i/10}-${(i+1)/10}`,count:0,meanConfidence:0,accuracy:0}));
 scored.forEach(({p,y})=>{const confidence=Math.max(...p),idx=Math.min(9,Math.floor(confidence*10)),b=bins[idx];b.count++;b.meanConfidence+=confidence;b.accuracy+=p.indexOf(confidence)===y?1:0;});
 let ece=0,mce=0;
 bins.forEach(b=>{if(b.count){b.meanConfidence/=b.count;b.accuracy/=b.count;const gap=Math.abs(b.meanConfidence-b.accuracy);ece+=b.count/records.length*gap;mce=Math.max(mce,gap);}});
 // Class-wise ECE used to scan `scored` once per (class, bin) pair -- 100 full passes per call -- and
 // calibrationDiagnostics runs 14 of these per models(), so the filters alone dominated the round.
 // Bucket every record into all 10 class bins in a single pass, then aggregate the bins.
 const N=records.length;
 // counts[j][k] / confSum[j][k] / truthSum[j][k] for class k, bin j
 const counts=Array.from({length:10},()=>new Float64Array(10));
 const confSum=Array.from({length:10},()=>new Float64Array(10));
 const truthSum=Array.from({length:10},()=>new Float64Array(10));
 for(let i=0;i<N;i++){
  const {p,y}=scored[i];
  for(let k=0;k<10;k++){
   const j=Math.min(9,Math.floor(p[k]*10));
   counts[j][k]++;confSum[j][k]+=p[k];
   if(y===k)truthSum[j][k]++;
  }
 }
 const classwise=Array.from({length:10},(_,k)=>{
  let e=0;
  for(let j=0;j<10;j++){
   const c=counts[j][k];
   if(c)e+=c/N*Math.abs(confSum[j][k]/c-truthSum[j][k]/c);
  }
  return e;
 });
 return {n:records.length,logLoss:+mean(scored.map(x=>logLoss(x.p,x.y))).toFixed(6),brier:+mean(scored.map(x=>brier(x.p,x.y))).toFixed(6),ece:+ece.toFixed(6),mce:+mce.toFixed(6),classwiseECE:+mean(classwise).toFixed(6),bins};
}
function calibrationDiagnostics(rows){
 const oof=[],prior={frequency:[],bayesian:[],ewma:[],markov:[]};
 // Running per-component log-loss totals. The ensemble weights need mean(prior[k]), and `prior[k]`
 // grows by exactly one record per iteration — recomputing that mean with prior[k].map(...) each
 // time rescanned the whole accumulated window, making this loop O(n^2). The incremental sum below
 // adds the same values in the same order as reduce() did, so the result is bit-identical.
 const lossSum={frequency:0,bayesian:0,ewma:0,markov:0},lossCount={frequency:0,bayesian:0,ewma:0,markov:0};
 const startAt=Math.max(30,rows.length-600);
 for(let i=startAt;i<rows.length;i++){const train=rows.slice(0,i),forecast=forecastComponents(train),y=rows[i].digit,keys=Object.keys(prior),w={};if(prior.frequency.length>=30){const raw=keys.map(k=>Math.exp(-Math.min(10,lossSum[k]/lossCount[k]))),sum=raw.reduce((a,b)=>a+b,0);keys.forEach((k,j)=>w[k]=raw[j]/sum);}else keys.forEach(k=>w[k]=.25);forecast.ensemble=Array(10).fill(0);keys.forEach(k=>forecast.ensemble.forEach((_,d)=>forecast.ensemble[d]+=w[k]*forecast[k][d]));for(const [name,p] of Object.entries(forecast)){const rec={name,p,y,index:i};oof.push(rec);if(prior[name]){prior[name].push({p,y});lossSum[name]+=logLoss(p,y);lossCount[name]++;}}}const names=['frequency','bayesian','ewma','markov','pattern','random','ensemble'],out={method:'Multiclass temperature scaling on chronological out-of-fold forecasts',minimumFit:30,models:{}};for(const name of names){const a=oof.filter(x=>x.name===name),split=Math.floor(a.length*.6),fit=a.slice(0,split),test=a.slice(split),fitTemp=fitTemperature(fit),temp=fitTemp.temperature;out.models[name]={temperature:temp,fit:fitTemp,evaluation:calibrationSummary(test,temp),uncalibrated:calibrationSummary(test,1),status:fit.length<30||test.length<20?'INSUFFICIENT OUT-OF-SAMPLE DATA':fitTemp.boundaryOptimum?'TEMPERATURE OPTIMUM AT SEARCH BOUNDARY — NOT APPLIED':'EVALUATED'};}out.forecasts=oof.length;out.note='Calibration fit uses the first 60% of chronological out-of-fold forecasts; reported evaluation uses the later 40%. The ensemble calibration forecasts use weights learned only from earlier walk-forward log-loss. Current probabilities are temperature-adjusted only when sufficient fit data exists.';return out;}
function multipleTesting(rows){const tests=[],n=rows.length,counts=Array(10).fill(0);rows.forEach(r=>counts[r.digit]++);if(n>=50){const expected=n/10,stat=counts.reduce((s,c)=>s+(c-expected)**2/expected,0);tests.push({id:'digit_uniformity_chi_square',family:'global',statistic:+stat.toFixed(5),df:9,pValue:regularizedGammaQ(4.5,stat/2),method:'Pearson chi-square goodness-of-fit'});for(let k=0;k<10;k++){const ph=1/10,se=Math.sqrt(ph*(1-ph)/n),z=(counts[k]/n-ph)/se;tests.push({id:`digit_${k}_deviation`,family:'digit-wise',statistic:+z.toFixed(5),pValue:Math.min(1,2*(1-normalCdf(Math.abs(z)))),method:'Two-sided normal approximation to binomial proportion'});}}
 const bs=rows.map(r=>r.digit>=5);if(n>=30){const rt=runsTest(bs);if(rt.z!==null)tests.push({id:'big_small_runs',family:'serial-dependence',statistic:rt.z,pValue:Math.min(1,2*(1-normalCdf(Math.abs(rt.z)))),method:'Wald-Wolfowitz runs test'});}
 if(n>=100){const nums=rows.map(r=>r.digit);for(let lag=1;lag<=10;lag++){const rho=autocorrelation(nums,lag);if(rho!==null){const z=rho*Math.sqrt(n);tests.push({id:`digit_autocorrelation_lag_${lag}`,family:'serial-dependence',statistic:+z.toFixed(5),pValue:Math.min(1,2*(1-normalCdf(Math.abs(z)))),method:'Approximate two-sided normal test; exploratory'});}}}
 const adjusted=holmAdjust(tests);return {method:'Holm-Bonferroni family-wise error correction',alpha:.05,tests:adjusted,numberOfTests:adjusted.length,significantAfterCorrection:adjusted.filter(x=>x.significant05).map(x=>x.id),warning:'Adjusted significance is not proof of predictability. Tests are exploratory; sparse transition/pattern searches require preregistration or independent confirmation.'};}
function nextIssue(period){
 const s=String(period);
 // WinGo issues encode UTC date + game id + a zero-based round index. The index
 // resets at midnight, so adding one to the whole string creates an invalid issue
 // (and a prediction that can never be reconciled) after round 2879.
 if(/^\d{17}$/.test(s)&&s.slice(8,13)==='10005'){
  const index=Number(s.slice(13));
  const drawTime=drawTimeFor(s);
  if(drawTime==null||index>2879)return null;
  if(index<2879)return `${s.slice(0,13)}${String(index+1).padStart(4,'0')}`;
  const nextDay=new Date(drawTime+ROUND_MS);
  const date=`${nextDay.getUTCFullYear()}${String(nextDay.getUTCMonth()+1).padStart(2,'0')}${String(nextDay.getUTCDate()).padStart(2,'0')}`;
  return `${date}${s.slice(8,13)}0000`;
 }
 return /^\d+$/.test(s)?String(BigInt(s)+1n):null;
}
// ---- Tamper-evident prediction commitments ------------------------------------------------
// Each prediction is hashed at creation from its own content plus a random nonce, and chained to
// the previous commitment. Editing any stored field later makes recomputation disagree with the
// stored digest, and editing a digest breaks the chain for every later entry.
const GENESIS='GENESIS';
function sha256Hex(s){return crypto.createHash('sha256').update(s,'utf8').digest('hex');}
function canonicalPayload(p){return JSON.stringify({issue:String(p.issue),predictionTime:p.predictionTime,predictedNumber:Number(p.predictedNumber),predictedBigSmall:String(p.predictedBigSmall),predictedColor:String(p.predictedColor),probabilities:(p.probabilities||[]).map(x=>Number(Number(x).toFixed(10))),model:String(p.model),sampleSize:Number(p.sampleSize)});}
function commitmentFor(p){return sha256Hex(canonicalPayload(p)+'|nonce:'+String(p.nonce||''));}
function lastCommitment(){const prev=[...db.predictions].reverse().find(p=>p.commitment);return prev?prev.commitment:GENESIS;}
// One writer per store. Two servers polling the same file would each append predictions and
// interleave whole-file rewrites, which silently destroys committed entries and the accuracy
// history that depends on them. Refuse to start rather than race.
const LOCK_FILE=DB_FILE+'.lock';
(function acquireStoreLock(){
 let holder=null;
 try{ holder=Number(fs.readFileSync(LOCK_FILE,'utf8').trim()); }catch{}
 if(Number.isInteger(holder)&&holder>0&&holder!==process.pid){
  let alive=false;
  try{ process.kill(holder,0); alive=true; }catch(e){ alive=e.code==='EPERM'; }
  if(alive){
   console.error(`[fatal] Another server (pid ${holder}) already owns this store:\n  ${DB_FILE}\nStop that process first, or point DB_FILE at a different path.\nRefusing to start so two writers cannot corrupt the prediction ledger.`);
   process.exit(1);
  }
 }
 fs.mkdirSync(path.dirname(LOCK_FILE),{recursive:true});
 fs.writeFileSync(LOCK_FILE,String(process.pid));
 const release=()=>{ try{ if(Number(fs.readFileSync(LOCK_FILE,'utf8').trim())===process.pid)fs.unlinkSync(LOCK_FILE); }catch{} };
 process.on('exit',release);
 for(const sig of ['SIGINT','SIGTERM','SIGHUP']){ try{ process.on(sig,()=>{release();process.exit(0);}); }catch{} }
})();
migrateLegacyCommitments();
function verifyPrediction(p){
 const expected=commitmentFor(p);
 const contentOk=expected===p.commitment;
 const idx=db.predictions.findIndex(x=>x.id===p.id);
 const prevRec=idx>0?db.predictions.slice(0,idx).reverse().find(x=>x.commitment):null;
 const chainOk=(p.prevHash||GENESIS)===(prevRec?prevRec.commitment:GENESIS);
 return {id:p.id,issue:p.issue,algorithm:'SHA-256',committed:p.commitment||null,recomputed:expected,contentIntact:contentOk,chainIntact:chainOk,chainNote:chainOk?'Matches the preceding ledger entry':'Does not match the preceding ledger entry — ledger was edited or reordered',verifiedAt:new Date().toISOString(),disclosure:'A matching digest shows the record has not been altered since it was written to this local store. It does not by itself prove the forecast preceded the draw, and a custodian who rewrites both the record and its digest can produce a consistent ledger. Publish the digests to an external timestamping service for independent proof.'};
}
// Builds the record in one step so the stored nonce is exactly the nonce that was hashed.
function createPrediction(rows){
 const m=modelsFor(rows),issue=nextIssue(rows.at(-1)?.period||'');
 if(!issue)return null;
 const rec={id:crypto.randomUUID(),issue,predictionTime:new Date().toISOString(),predictedNumber:m.ensemble.predictedNumber,predictedColor:Object.entries(m.ensemble.colors).sort((a,b)=>b[1]-a[1])[0][0],predictedBigSmall:m.ensemble.bigSmall.Big>=m.ensemble.bigSmall.Small?'Big':'Small',probabilities:m.ensemble.probabilities,model:'Walk-forward validation ensemble',confidence:m.ensemble.confidence,sampleSize:rows.length,edge:m.edge,actual:null,verifiedAt:null,nonce:crypto.randomBytes(16).toString('hex'),prevHash:lastCommitment()};
 rec.commitment=commitmentFor(rec);
 return rec;
}
// ---- Round clock --------------------------------------------------------------------------
// The provider publishes each 30s round at a fixed offset inside the 30s epoch. A rollover is only
// ever observed as an interval [lastPollAt, polledAt], so the publish moment is known only to within
// that bracket. We accept only tight brackets and take the median, because an HTTP cache in front of
// the provider can delay visibility by seconds and a mean would inherit that lag.
const DEFAULT_PHASE_MS=27500;
const MAX_BRACKET_MS=2500;
const PHASE_SAMPLES_KEPT=15;
let lastProviderAt=0;
function learnPhase(midpointMs,bracketMs){
 if(!Number.isFinite(midpointMs)||!Number.isFinite(bracketMs)||bracketMs>MAX_BRACKET_MS)return false;
 const t=db.timing||(db.timing={phaseMs:null,samples:0,updatedAt:null,samplesMs:[]});
 const sample=((Math.round(midpointMs)%ROUND_MS)+ROUND_MS)%ROUND_MS;
 const pool=Array.isArray(t.samplesMs)?t.samplesMs:[];
 pool.push(sample);
 while(pool.length>PHASE_SAMPLES_KEPT)pool.shift();
 t.samplesMs=pool;
 const sorted=[...pool].sort((a,b)=>a-b);
 const mid=Math.floor(sorted.length/2);
 // Unwrap the circular median: samples straddling 0 must not average into the middle of the round.
 const median=sorted.length%2?sorted[mid]:(()=>{
  let a=sorted[mid-1],b=sorted[mid];
  if(b-a>ROUND_MS/2)b+=ROUND_MS;
  return ((a+b)/2)%ROUND_MS;
 })();
 t.phaseMs=median;
 t.samples=pool.length;
 t.updatedAt=new Date().toISOString();
 return true;
}
function roundClock(now=Date.now()){
 const phase=Number.isFinite(db.timing?.phaseMs)?db.timing.phaseMs:DEFAULT_PHASE_MS;
 const mod=((now%ROUND_MS)+ROUND_MS)%ROUND_MS;
 let msToNext=mod<phase?phase-mod:ROUND_MS-mod+phase;
 msToNext=Math.max(0,Math.round(msToNext));
 const elapsedMs=ROUND_MS-msToNext;
 return {roundMs:ROUND_MS,phaseMs:Math.round(phase),phaseSamples:db.timing?.samples||0,phaseCalibrated:!!(db.timing?.samples>=5),msToNext,secondsToNext:Math.ceil(msToNext/1000),elapsedMs,elapsedFraction:elapsedMs/ROUND_MS,nextDrawAt:now+msToNext};
}
function reconcile(rows){
 for(const result of rows){const open=db.predictions.find(p=>p.issue===result.period&&p.actual===null);if(open){open.actual=result.digit;open.actualColor=(result.colors||colorsFor(result.digit)).join('/');open.actualBigSmall=result.type;open.correctNumber=open.predictedNumber===result.digit;open.correctColor=(result.colors||colorsFor(result.digit)).includes(open.predictedColor.toLowerCase());open.correctBigSmall=open.predictedBigSmall===result.type;open.verifiedAt=new Date().toISOString();
  // A prediction recorded at or after the draw time cannot be a genuine forecast; flag it so it is
  // excluded from accuracy instead of silently inflating the hit rate.
  const drawMs=Number(result.time);const madeMs=Date.parse(open.predictionTime);open.retroactive=Number.isFinite(drawMs)&&Number.isFinite(madeMs)&&madeMs>=drawMs;}}
 // A prediction whose round fell inside a collection gap can never be reconciled: the provider only
 // ever serves the 10 newest rows, so once an issue scrolls out of that window it is gone for good.
 // Mark those as abandoned instead of leaving them pending forever, which would overstate how many
 // forecasts are still open and quietly depress the verified count.
 const newest=rows.at(-1);if(newest){const newestTime=Number(newest.time);
  if(Number.isFinite(newestTime))for(const p of db.predictions){
   if(p.actual!==null||p.abandoned)continue;
   const drawMs=drawTimeFor(p.issue);
   if(drawMs==null)continue;
   // Older than the newest stored result and still unresolved => unrecoverable.
   if(drawMs<newestTime-ROUND_MS){p.abandoned=true;p.abandonedAt=new Date().toISOString();p.abandonedReason='Round fell inside a collection gap. The provider serves only the 10 newest issues, so this result is no longer retrievable. It is excluded from accuracy rather than guessed.';}
  }
 }
 const latest=rows.at(-1);if(!latest)return;const next=nextIssue(latest.period);if(!next)return;if(rows.some(r=>r.period===next))return;if(!db.predictions.some(p=>p.issue===next)){const pred=createPrediction(rows);if(pred&&pred.issue===next)db.predictions.push(pred);}
}
async function fetchProviderOnce(polledAt) {
  const url = new URL(API_URL);
  url.searchParams.set('ts', String(polledAt));

  const upstream = await fetch(url, {
   headers: {
 Accept: 'application/json, text/plain, */*',
  'Cache-Control': 'no-cache',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://draw.ar-lottery01.com/',
  'Origin': 'https://draw.ar-lottery01.com'
},
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });

  const bodyText = await upstream.text();

  // Temporary diagnostic logging
  console.log('[PROVIDER DEBUG]', {
    status: upstream.status,
    contentType: upstream.headers.get('content-type'),
    bodyPreview: bodyText.slice(0, 1000)
  });

  let data;

  try {
    data = JSON.parse(bodyText);
  } catch {
    const e = new Error('History API returned non-JSON content');
    e.detail = bodyText.slice(0, 300);
    e.statusCode = 502;
    e.retryable = false;
    throw e;
  }

  if (!upstream.ok) {
    const e = new Error(`History API HTTP ${upstream.status}`);
    e.statusCode = 502;
    e.retryable = upstream.status >= 500 || upstream.status === 429;
    throw e;
  }

  if (data.code !== 0 || !Array.isArray(data.data?.list)) {
    const e = new Error('Unexpected history response schema');
    e.statusCode = 502;
    e.retryable = false;
    throw e;
  }

  return data;
}
// The provider serves only the 10 newest issues (a ~5 minute window) and ignores every pagination
// parameter tried, so a failed poll is not just a missed refresh — it can permanently lose a draw.
// Retry inside the same second-ish window instead of waiting for the next tick.
const PROVIDER_ATTEMPTS=3;
async function fetchProvider(polledAt){
 let lastErr=null;
 for(let attempt=1;attempt<=PROVIDER_ATTEMPTS;attempt++){
  try{return await fetchProviderOnce(Date.now());}
  catch(err){
   lastErr=err;
   if(err.retryable===false||attempt===PROVIDER_ATTEMPTS)break;
   await new Promise(r=>setTimeout(r,150*attempt));
  }
 }
 throw lastErr;
}
// Gaps are a fact about coverage, not a bug to hide. They are recorded once, with the exact issue
// range and when they were noticed, so the accuracy denominator can be explained years later.
//
// Gap detection runs on derived draw times, not on issue numbers. Issue numbers restart at round 0
// each day (YYYYMMDD|10005|idx), so an overnight outage looks like a huge positive jump in the
// numeric period and would be silently skipped by a plain difference test. Times have no such
// discontinuity.
function recordGaps(){
 const gaps=[];
 const rows=db.results;
 for(let i=1;i<rows.length;i++){
  const t1=Number(rows[i-1].time),t2=Number(rows[i].time);
  if(!Number.isFinite(t1)||!Number.isFinite(t2))continue;
  const delta=t2-t1;
  if(delta<=ROUND_MS)continue;
  const missing=Math.round(delta/ROUND_MS)-1;
  // Cap the per-gap report: a multi-day outage is one gap, not thousands of entries.
  if(missing<1||missing>100000)continue;
  gaps.push({after:rows[i-1].period,before:rows[i].period,missing,from:new Date(t1).toISOString(),to:new Date(t2).toISOString()});
 }
 db.gaps=gaps;
 return gaps;
}
let consecutivePollFailures=0,lastSuccessfulPollAt=null,lastSaveAt=0;
async function refreshHistory(){
 const polledAt=Date.now();
 const data=await fetchProvider(polledAt);
 const incoming=data.data.list.map((r,i)=>normalize(r,i,data.serviceTime)).filter(Boolean);
 const latestKnown=db.results.at(-1)?.period||null;
 const map=new Map(db.results.map(r=>[r.period,r]));
 let added=0;
 incoming.forEach(r=>{if(!map.has(r.period)){map.set(r.period,r);added++;}});
 // Backfill draw times on rows stored before the period-derived clock existed, so historical
 // before/after-the-draw comparisons use the same basis as new rows.
 map.forEach((r,k)=>{if(r.timeDerived!==true&&!r.timeExplicit){const t=drawTimeFor(k);if(t!=null){r.time=t;r.timeDerived=true;}}});
 db.results=sortChronological([...map.values()]).slice(-5000);
 // Rollover detection: a new top issue appeared since the previous poll. The publish moment lies
 // inside [previous poll, this poll], so only the bracket width is known — pass it along.
 const top=incoming[0]?.period||null;
 if(top&&lastTopPeriod&&top!==lastTopPeriod&&lastHistoryPollAt){
  const bracket=polledAt-lastHistoryPollAt;
  learnPhase((lastHistoryPollAt+polledAt)/2,bracket);
  lastRolloverBracket=bracket;
 }
 if(top)lastTopPeriod=top;
 const hadNew=!!top&&top!==latestKnown;
 db.lastPollAt=new Date(polledAt).toISOString();
 lastHistoryPollAt=polledAt;
 lastSuccessfulPollAt=db.lastPollAt;
 consecutivePollFailures=0;
 let dirty=added>0;
 if(hadNew||added>0){
  const before=db.predictions.length;
  reconcile(db.results);
  if(db.predictions.length!==before)dirty=true;
  // Abandon flags write to existing records, so treat any unresolved-but-old row as a change.
  if(db.predictions.some(p=>p.abandoned&&!p.abandonedPersisted)){db.predictions.forEach(p=>{if(p.abandoned)p.abandonedPersisted=true;});dirty=true;}
  db.updatedAt=new Date().toISOString();
 }
 const gaps=recordGaps();
 if(gaps.length!==(db.lastGapCount||0)){db.lastGapCount=gaps.length;dirty=true;}
 // Heartbeat throttled: lastPollAt is nice to persist but rewriting a ~0.5MB store every 2.2s
 // is pointless disk churn. Write on real change, or once a minute for liveness.
 if(dirty||polledAt-lastSaveAt>60000){saveDB();lastSaveAt=polledAt;}
 return {polledAt,incoming,hadNew:hadNew||added>0,added,latestKnown,gaps};
}
app.get('/api/history',async(_req,res)=>{
 try{
  // Share the poller's single-flight path so a manual refresh cannot run concurrently with a
  // scheduled one and interleave two merges into the same ledger.
  const out=await pollOnce();
  res.json({ok:true,game:GAME,count:db.results.length,added:out?out.added:0,fetchedAt:new Date().toISOString(),gaps:out&&out.gaps?out.gaps:recordGaps(),clock:roundClock(),results:db.results.slice(-500).reverse()});
 }catch(err){res.status(err.statusCode||502).json({ok:false,error:err.name==='TimeoutError'?'History request timed out':err.message,detail:err.detail,hint:'Check network access and the configured provider endpoint.'});}
});
// Server-side polling keeps the ledger current (and keeps the phase estimate learning) even when
// no browser tab is open. Without it, predictions are only created on a page refresh.
//
// The interval is deliberately shorter than MAX_BRACKET_MS so that every observed rollover yields a
// usable bracket. An earlier version tried to aim polls at the predicted boundary, but that created
// a feedback loop — a low phase estimate moved the polls earlier, which then measured an even lower
// phase. A plain interval has no such loop and self-corrects.
// Math.max() propagates NaN, so `POLL_MS=abc` used to yield NaN. setInterval(fn, NaN) coerces to a
// 1ms timer: the poller became a busy loop instead of a 2.2s cadence. And a value like 1e9 passed the
// floor untouched, leaving one poll every 11 days — long enough that every draw rolls out of the
// provider's 10-issue window and is lost permanently. Validate finiteness first, then clamp to the
// documented range: the interval must stay under MAX_BRACKET_MS so each rollover still yields a
// usable bracket, and under ~2500ms so no issue is missed (see .env.example).
function envMs(name,fallback,lo,hi){
 const raw=process.env[name];
 const parsed=Number(raw);
 if(raw===undefined||raw.trim()==='')return fallback;
 if(!Number.isFinite(parsed)){
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a number; using ${fallback}ms.`);
  return fallback;
 }
 const clamped=Math.min(hi,Math.max(lo,Math.floor(parsed)));
 if(clamped!==parsed){
  const why=Math.floor(parsed)!==parsed&&clamped===Math.floor(parsed)?'is not a whole number of ms':`is outside ${lo}-${hi}ms`;
  console.warn(`[config] ${name}=${raw} ${why}; using ${clamped}ms.`);
 }
 return clamped;
}
const POLL_MS=envMs('POLL_MS',2200,2000,2500);
// When the provider is failing there is no point hammering it every 2.2s; back off to 15s. The
// retry inside fetchProvider() already covers transient blips, so reaching this means a real outage.
const POLL_BACKOFF_MS=envMs('POLL_BACKOFF_MS',15000,5000,600000);
let pollTimer=null,lastPollError=null,pollerStartedAt=null,pollDelay=POLL_MS;
// A poll can outlast the interval: fetchProvider retries up to 3 times with a 12s timeout each, so
// a bad network can keep one refresh in flight for tens of seconds. setInterval does not wait for an
// async callback, so the next tick used to start a second refresh on the same mutable `db` — the two
// would interleave their result merges and their saveDB() writes.
//
// Single-flight: at most one refresh runs at a time. A caller that arrives while one is in flight
// gets that same promise, so concurrent /api/history requests and poller ticks share one fetch
// instead of racing. `runRefresh` holds the actual work so errors still reach an HTTP caller.
let refreshInFlight=null;
function runRefresh(){
 if(refreshInFlight)return refreshInFlight;
 refreshInFlight=refreshHistory().finally(()=>{refreshInFlight=null;});
 return refreshInFlight;
}
async function pollOnce(){
 try{
  const out=await runRefresh();
  lastPollError=null;consecutivePollFailures=0;
  if(pollDelay!==POLL_MS){pollDelay=POLL_MS;schedulePoll();}
  return out;
 }catch(err){
  consecutivePollFailures++;
  lastPollError={at:new Date().toISOString(),message:err.name==='TimeoutError'?'History request timed out':err.message,consecutiveFailures:consecutivePollFailures};
  if(consecutivePollFailures>=3&&pollDelay!==POLL_BACKOFF_MS){pollDelay=POLL_BACKOFF_MS;schedulePoll();}
  throw err;
 }
}
function schedulePoll(){
 if(pollTimer)clearInterval(pollTimer);
 // pollOnce reports failure by throwing (so /api/history can answer 502); the timer has nobody to
 // throw at, and an unhandled rejection would take the process down mid-round.
 pollTimer=setInterval(()=>{pollOnce().catch(()=>{});},pollDelay);
 if(pollTimer.unref)pollTimer.unref();
}
function startPoller(){
 if(pollTimer)return;
 pollerStartedAt=new Date().toISOString();
 // pollOnce rejects on failure so a caller can report it; at start-up there is no caller, and an
 // unhandled rejection terminates the process (previously this call could not reject).
 pollOnce().catch(()=>{});
 schedulePoll();
}
app.get('/api/analysis',(_req,res)=>{const rows=db.results;const key=analysisCacheKey();if(analysisCache.key!==key){analysisCache={key,value:{metrics:metrics(rows),models:modelsFor(rows)}};}res.json({ok:true,...analysisCache.value,latest:rows.at(-1)||null,nextIssue:nextIssue(rows.at(-1)?.period||'')});});
// The ledger is append-only and never pruned (2880 rounds/day), so serialising all of it is not
// viable long term: at ~930 bytes per record a year of predictions is ~900MB in one response. Ship
// the newest page by default and report the true total so callers can page through. `offset` counts
// back from the newest record, because the ledger's useful end is the recent one.
const PREDICTIONS_PAGE_MAX=1000;
app.get('/api/predictions',(req,res)=>{
 const all=db.predictions;
 const requestedLimit=Number(req.query.limit);
 const limit=Number.isFinite(requestedLimit)&&requestedLimit>=1?Math.min(PREDICTIONS_PAGE_MAX,Math.floor(requestedLimit)):200;
 const requestedOffset=Number(req.query.offset);
 const offset=Number.isFinite(requestedOffset)&&requestedOffset>=0?Math.floor(requestedOffset):0;
 // reverse() once on a copy so `offset` indexes newest-first, matching the previous ordering.
 const newestFirst=all.slice().reverse();
 const page=newestFirst.slice(offset,offset+limit);
 res.json({ok:true,predictions:page,
  pagination:{total:all.length,limit,offset,returned:page.length,hasMore:offset+page.length<all.length,newestFirst:true,
   note:'offset counts back from the newest prediction. limit defaults to 200 and is capped at 1000.'},
  summary:predictionSummary(all)});
});
// The README, the eligibility comments and the dashboard all refer to /api/predictions/summary as
// the authoritative breakdown of what was counted and what was excluded. It has to exist as a route,
// otherwise the documented audit path returns 404 and the claim cannot be checked.
app.get('/api/predictions/summary',(_req,res)=>res.json({ok:true,summary:predictionSummary(db.predictions),eligibility:eligibilityBreakdown(),markets:accuracyReport().markets}));
// ---- One eligibility rule, used by every accuracy surface --------------------------------
// Before this existed, /api/predictions/summary, /api/dashboard accuracy and the result rows each
// applied a slightly different filter (retroactive only, backfilled only, or neither), so the same
// ledger produced up to three different hit rates. Everything now derives from eligiblePrediction().
//
// A prediction counts only when:
//   1. its round actually resolved           (actual !== null)
//   2. it was not abandoned to a data gap     (!abandoned)
//   3. it was recorded before the draw        (!retroactive)
//   4. its commitment is not a backfill       (commitmentOrigin !== 'backfilled')
// Reasons 3 and 4 both mean "we cannot prove this forecast preceded the draw", which is the only
// property that makes a hit rate meaningful. Exclusions are reported, never silently dropped.
function eligiblePrediction(p){
 return p.actual!==null&&!p.abandoned&&!p.retroactive&&p.commitmentOrigin!=='backfilled';
}
function eligibilityBreakdown(){
 const all=db.predictions;
 const resolved=all.filter(p=>p.actual!==null);
 return {
  total:all.length,
  resolved:resolved.length,
  eligible:all.filter(eligiblePrediction).length,
  pending:all.filter(p=>p.actual===null&&!p.abandoned).length,
  abandoned:all.filter(p=>p.abandoned).length,
  excludedRetroactive:all.filter(p=>p.retroactive&&p.actual!==null).length,
  excludedBackfilledCommitment:resolved.filter(p=>p.commitmentOrigin==='backfilled').length,
 };
}
function predictionSummary(a){const v=a.filter(eligiblePrediction);const b=eligibilityBreakdown();const rate=k=>v.length?v.filter(x=>x[k]).length/v.length:null;return {total:a.length,verified:v.length,pending:b.pending,abandoned:b.abandoned,resolved:b.resolved,retroactiveExcluded:b.excludedRetroactive,excludedLegacyCommitment:b.excludedBackfilledCommitment,eligibility:'Counted only when the round resolved, the prediction was recorded before the draw, and its commitment was not generated after the fact. GET /api/dashboard publishes the per-market breakdown of these exclusions.',numberAccuracy:rate('correctNumber'),colorAccuracy:rate('correctColor'),bigSmallAccuracy:rate('correctBigSmall'),models:[...new Set(a.map(x=>x.model))].map(model=>{const z=v.filter(x=>x.model===model);return {model,total:z.length,correct:z.filter(x=>x.correctNumber).length,accuracy:z.length?z.filter(x=>x.correctNumber).length/z.length:null};}),windows:[10,50,100,500].map(w=>{const z=v.slice(-w);return {window:w,n:z.length,numberAccuracy:z.length?z.filter(x=>x.correctNumber).length/z.length:null};})};}
// ---- Honest accuracy statistics -----------------------------------------------------------
// Baseline for each market is the true chance rate of the pick that was actually made:
//   Big/Small -> 5 of 10 digits = 0.50
//   Red/Green -> 5 of 10 digits = 0.50, Violet -> 2 of 10 digits = 0.20
//   Number    -> 1 of 10 digits = 0.10
// Violet differs, so the colour market uses a Poisson-binomial baseline instead of a flat 50%,
// which would understate the chance rate and manufacture a fake edge.
function chanceFor(market,prediction){
 if(market==='number')return 0.1;
 if(market==='bigSmall')return 0.5;
 const c=String(prediction).toLowerCase();
 if(c==='violet')return 0.2;
 return 0.5;
}
function wilsonInterval(hits,n,z=1.96){
 if(!n)return {lower:null,upper:null};
 const p=hits/n,den=1+z*z/n,center=(p+z*z/(2*n))/den;
 const half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
 return {lower:Math.max(0,center-half),upper:Math.min(1,center+half)};
}
function poissonBinomialTest(hits,chances){
 const n=chances.length;
 if(!n)return {n:0,hits:0,expectedHits:null,observedRate:null,chanceRate:null,z:null,pValue:null};
 const expected=chances.reduce((a,b)=>a+b,0);
 const variance=chances.reduce((a,b)=>a+b*(1-b),0);
 const z=variance>0?(hits-expected)/Math.sqrt(variance):null;
 const pValue=z==null?null:Math.min(1,2*(1-normalCdf(Math.abs(z))));
 return {n,hits,expectedHits:+expected.toFixed(4),observedRate:hits/n,chanceRate:expected/n,z:z==null?null:+z.toFixed(4),pValue:pValue==null?null:+pValue.toFixed(6),variance:+variance.toFixed(4)};
}
function marketStats(resolved,market){
 const eligible=resolved.filter(eligiblePrediction);
 const correctKey=market==='number'?'correctNumber':market==='colour'?'correctColor':'correctBigSmall';
 const predKey=market==='number'?'predictedNumber':market==='colour'?'predictedColor':'predictedBigSmall';
 const scoped=eligible.filter(p=>p[predKey]!==undefined&&p[predKey]!==null);
 const hits=scoped.filter(p=>p[correctKey]===true).length;
 const chances=scoped.map(p=>chanceFor(market,p[predKey]));
 const test=poissonBinomialTest(hits,chances);
 const ci=wilsonInterval(hits,scoped.length);
 let verdict,verdictTone;
 if(scoped.length<30){verdict='Sample too small to judge';verdictTone='muted';}
 else if(test.pValue==null||test.pValue>=.05){verdict='Not distinguishable from chance';verdictTone='muted';}
 else{verdict='Nominally different from chance in this sample — not a confirmed edge';verdictTone='warn';}
 return {market,label:market==='bigSmall'?'Big/Small':market==='colour'?'Colour':'Number',
  n:scoped.length,hits,misses:scoped.length-hits,
  accuracy:scoped.length?hits/scoped.length:null,
  chance:test.chanceRate,ci95:ci,test,verdict,verdictTone,
  excludedLegacy:resolved.filter(p=>p.commitmentOrigin==='backfilled').length,
  note:'Baseline is the true chance rate of the picks actually made, not a flat 50%. The 95% interval is a Wilson score interval. The p-value is a two-sided normal approximation to the Poisson-binomial null (each pick has its own chance rate). Three markets are reported, so a single p below 0.05 is roughly what noise produces when several tests are run.'};
}
function accuracyReport(){
 const resolved=db.predictions.filter(p=>p.actual!==null);
 const b=eligibilityBreakdown();
 return {basis:'One rule everywhere: a prediction counts only if its round resolved, it was recorded before the draw, its commitment was not generated after the fact, and it was not abandoned to a collection gap. The same predicate drives this report, /api/predictions/summary and the dashboard result rows, so the numbers cannot disagree.',
  totalPredictions:db.predictions.length,resolved:resolved.length,eligible:b.eligible,
  pending:b.pending,abandoned:b.abandoned,
  excludedRetroactive:b.excludedRetroactive,
  excludedLegacyCommitment:b.excludedBackfilledCommitment,
  markets:[marketStats(resolved,'bigSmall'),marketStats(resolved,'colour'),marketStats(resolved,'number')]};
}
// ---- Live dashboard payload ---------------------------------------------------------------
function resultRowsFor(market){
 const resolved=db.predictions.filter(eligiblePrediction);
 const predKey=market==='colour'?'predictedColor':market==='number'?'predictedNumber':'predictedBigSmall';
 const correctKey=market==='colour'?'correctColor':market==='number'?'correctNumber':'correctBigSmall';
 return resolved.slice().reverse().map(p=>({
  id:p.id,period:p.issue,digit:p.actual,type:p.actualBigSmall,colors:String(p.actualColor||'').split('/').filter(Boolean),
  prediction:p[predKey],win:p[correctKey]===true,predictionTime:p.predictionTime,verifiedAt:p.verifiedAt,
  commitment:p.commitment,commitmentShort:p.commitment?p.commitment.slice(0,12):null,
  retroactive:!!p.retroactive,legacyCommitment:p.commitmentOrigin==='backfilled'
 }));
}
function lastNWindow(market,limit,includeRows=true){
 const rows=resultRowsFor(market);
 const scoped=rows.slice(0,limit);
 // Current streak in this market, counted from the newest resolved round backwards.
 let streak=0,streakKind=null;
 for(const r of rows){ if(streakKind===null){streakKind=r.win?'win':'loss';streak=1;} else if((r.win?'win':'loss')===streakKind)streak++; else break; }
 const out={requested:limit,available:rows.length,shown:scoped.length,wins:scoped.filter(r=>r.win).length,losses:scoped.filter(r=>!r.win).length,accuracy:scoped.length?scoped.filter(r=>r.win).length/scoped.length:null,streak:{length:streak,kind:streakKind}};
 // Rows dominate the payload. Only the market being displayed needs them; the other two are
 // summarised so the tab percentages still describe the same window.
 if(includeRows)out.rows=scoped;
 return out;
}
app.get('/api/dashboard',(req,res)=>{
 // Coerce before clamping: Math.min/max pass floats straight through, so ?window=0.5 produced
 // slice(0,0.5) — a fractional limit whose row count depends on V8's truncation. Require a real
 // window of at least one row, floor anything fractional, and fall back to the full window
 // otherwise, so a nonsense value can never render an empty "Last N" panel.
 const requestedWindow=Number(req.query.window);
 const limit=Number.isFinite(requestedWindow)&&requestedWindow>=1?Math.min(1000,Math.floor(requestedWindow)):1000;
 const market=req.query.market==='colour'?'colour':req.query.market==='number'?'number':'bigSmall';
 const now=Date.now();
 // The open forecast must exclude abandoned records: an abandoned prediction never resolves, so
 // .filter(actual===null).slice(-1) would keep showing a dead pick as the live "LOCKED IN" one.
 const open=db.predictions.filter(p=>p.actual===null&&!p.abandoned).slice(-1)[0]||null;
 const clock=roundClock(now);
 // Both markets are returned so the tab percentages describe the same window as the list below
 // them, instead of mixing an all-time rate with a "Last N" heading.
 const windows={bigSmall:lastNWindow('bigSmall',limit,market==='bigSmall'),colour:lastNWindow('colour',limit,market==='colour'),number:lastNWindow('number',limit,market==='number')};
 // `window` is kept as an alias of the selected market's window for existing callers. It no longer
 // duplicates the rows: `window` and `windows[market]` are the same object, not two copies.
 res.json({ok:true,serverTime:now,clock:{...clock,lastRolloverBracket,basis:'Estimated from observed publish rollovers. The provider publishes each 30s round at a fixed offset inside the 30s epoch; this is a measured estimate, not a platform-published schedule.'},
  game:GAME,roundSeconds:30,
 // drawAt lets the client stop asserting "LOCKED IN" once the round it describes has drawn, instead
 // of continuing to present a settled round as an open forecast until the next poll lands.
 current:open?{period:open.issue,predictionTime:open.predictionTime,predictedBigSmall:open.predictedBigSmall,predictedColor:open.predictedColor,predictedNumber:open.predictedNumber,confidence:open.confidence,probabilities:open.probabilities,chanceBigSmall:0.5,chanceColor:chanceFor('colour',open.predictedColor),commitment:open.commitment,commitmentShort:open.commitment?open.commitment.slice(0,16):null,noncePresent:!!open.nonce,edge:open.edge,drawAt:drawTimeFor(open.issue)}:null,
 pollError:lastPollError,
 latest:db.results.at(-1)||null,
  window:windows[market],windows,market,
  accuracy:accuracyReport(),
  coverage:coverageReport(),
  ledger:{entries:db.predictions.length,lastCommitment:lastCommitment()},
  stale:!!(db.lastPollAt&&(now-Date.parse(db.lastPollAt))>90000),
  disclaimer:"Simulated game. Outcomes are random and can't be predicted. Not gambling advice."});
});
// Coverage answers a different question from accuracy: how much of the game's timeline is actually
// in this store. The provider's 10-row window means every server outage leaves a permanent hole, so
// the dashboard states the hole rather than presenting a partial dataset as complete.
function coverageReport(){
 const rows=db.results;
 if(!rows.length)return {storedResults:0,gaps:[],missingRounds:0,coverage:null,note:'No results stored yet.'};
 const gaps=db.gaps||recordGaps();
 const missingRounds=gaps.reduce((s,g)=>s+g.missing,0);
 const firstTime=Number(rows[0].time),lastTime=Number(rows.at(-1).time);
 const spanRounds=Number.isFinite(firstTime)&&Number.isFinite(lastTime)?Math.round((lastTime-firstTime)/ROUND_MS)+1:null;
 return {
  storedResults:rows.length,
  firstPeriod:rows[0].period,lastPeriod:rows.at(-1).period,
  spanRounds,
  missingRounds,
  gaps:gaps.slice(-20),
  gapCount:gaps.length,
  coverage:spanRounds?rows.length/spanRounds:null,
  note:'The provider serves only the 10 newest issues and ignores pagination, so rounds drawn while this server was offline cannot be recovered. Missing rounds are counted here and excluded from accuracy, never filled in.'
 };
}
app.get('/api/coverage',(_req,res)=>res.json({ok:true,...coverageReport()}));
app.get('/api/verify/:id',(req,res)=>{
 const p=db.predictions.find(x=>x.id===req.params.id||x.issue===req.params.id);
 if(!p)return res.status(404).json({ok:false,error:'No prediction with that id or issue.'});
 res.json({ok:true,...verifyPrediction(p),commitmentOrigin:p.commitmentOrigin||'unknown',issue:p.issue});
});
app.get('/api/verify',(_req,res)=>{
 const results=db.predictions.filter(p=>p.commitment).map(p=>verifyPrediction(p));
 const broken=results.filter(r=>!r.contentIntact||!r.chainIntact);
 res.json({ok:true,checked:results.length,allIntact:broken.length===0,broken,algorithm:'SHA-256',chain:'Each entry commits to the previous entry\'s digest. Results are excluded from accuracy when their commitment was generated after the draw, because that proves nothing about timing.'});
});

app.get('/api/ml-status',(_req,res)=>{
 // This endpoint exists so the "do the Python models run?" question has a machine-readable answer
 // backed by the last real evaluation, instead of a claim in a README.
 const reportPath=path.join(__dirname,'ml','evaluation-report.json');
 let report=null;
 try{report=JSON.parse(fs.readFileSync(reportPath,'utf8'));}catch{}
 const baseline=Math.log(10);
 // A float difference of 1e-15 is a tie, not a win. Require a real margin before claiming a model
 // beat the uniform baseline, otherwise the table reads as "uniform beats itself".
 const MARGIN=1e-6;
 const rows=report?Object.entries(report.models).map(([name,m])=>{
  const test=m.test||{};
  const ll=test.logLoss??null;
  return {name,testAccuracy:test.accuracy??null,testLogLoss:ll,
   beatsUniform:Number.isFinite(ll)?ll<baseline-MARGIN:null,
   deltaVsUniform:Number.isFinite(ll)?+(ll-baseline).toFixed(6):null,
   cases:test.cases??null};
 }).sort((a,b)=>(a.testLogLoss??Infinity)-(b.testLogLoss??Infinity)):[];
 res.json({ok:true,
  integrated:false,
  decision:'The Python models are an offline evaluation tool. They do not participate in live predictions.',
  reason:'On held-out chronological data every model scored worse than predicting uniform 10% per digit, so deploying one would make the forecast worse while supporting a claim the data does not back.',
  uniformLogLoss:+baseline.toFixed(6),
  evaluatedAt:report?(fs.statSync(reportPath).mtime.toISOString()):null,
  dataset:report?{rows:report.rows,split:report.split,warning:report.warning}:null,
  models:rows,
  livePredictor:{model:'Walk-forward validation ensemble (JavaScript, server-side)',note:'Weights come from walk-forward log-loss; temperature calibration is applied only when the fit sample is sufficient. No edge is claimed.'},
  reproduce:'uv venv ml/.venv && uv pip install --python ml/.venv/Scripts/python.exe numpy scikit-learn && uv run --python ml/.venv/Scripts/python.exe python ml/train.py',
  documentation:'ml/DECISION.md'});
});
app.get('/api/settings',(_req,res)=>res.json({ok:true,settings:db.settings}));
app.post('/api/settings',(req,res)=>{const p=req.body?.payouts,fee=Number(req.body?.feeRate??0);if(!p||!Number.isFinite(fee)||fee<0||fee>1)return res.status(400).json({ok:false,error:'Provide payout multipliers and feeRate between 0 and 1.'});for(const k of ['number','bigSmall','color','green','red','violet'])if(!Number.isFinite(Number(p[k]))||Number(p[k])<0)return res.status(400).json({ok:false,error:`Invalid payout: ${k}`});db.settings={payouts:Object.fromEntries(Object.keys(db.settings.payouts).map(k=>[k,Number(p[k])])),feeRate:fee};saveDB();res.json({ok:true,settings:db.settings});});
app.post('/api/simulate',(req,res)=>{const count=Number(req.body?.rounds||10000),runs=Number(req.body?.runs||1000),stake=Number(req.body?.stake||1),payout=Number(req.body?.payout||9),winProb=Number(req.body?.winProbability??.1);if(![10000,100000,1000000].includes(count)||!Number.isInteger(runs)||runs<1||runs>10000||![stake,payout,winProb].every(Number.isFinite)||stake<=0||payout<0||winProb<0||winProb>1)return res.status(400).json({ok:false,error:'Invalid simulation parameters.'});if(count*runs>20e6)return res.status(400).json({ok:false,error:`Simulation too large: ${count} rounds x ${runs} runs exceeds the 20,000,000 draw-step budget. Reduce rounds or runs.`});const profits=[];let ruin=0,maxLoss=0;for(let r=0;r<runs;r++){let bank=100,loss=0;for(let i=0;i<count;i++){if(Math.random()<winProb){bank+=stake*(payout-1);loss=0;}else{bank-=stake;loss++;maxLoss=Math.max(maxLoss,loss);}if(bank<=0){ruin++;break;}}profits.push(bank-100);}profits.sort((a,b)=>a-b);const at=q=>profits[Math.min(profits.length-1,Math.floor(q*(profits.length-1)))];res.json({ok:true,kind:'SIMULATED — NOT REAL DRAW DATA',roundsPerRun:count,runs,stake,payout,winProbability:winProb,meanProfit:mean(profits),medianProfit:at(.5),p05:at(.05),p95:at(.95),riskOfRuin:ruin/runs,maxConsecutiveLossesObserved:maxLoss,expectedValuePerBet:stake*(winProb*payout-1),sampleProfits:profits.slice(0,Math.min(100,profits.length))});});
app.get('/api/health',(_req,res)=>res.json({ok:true,time:new Date().toISOString(),storedResults:db.results.length,storedPredictions:db.predictions.length,lastPollAt:db.lastPollAt||null,lastSuccessfulPollAt,lastPollError,pollIntervalMs:pollDelay,consecutivePollFailures,provider:{url:API_URL,windowRows:10,note:'Provider ignores pagination; only the 10 newest issues are retrievable per request.'},eligibility:eligibilityBreakdown(),coverage:coverageReport(),clock:roundClock()}));
// Malformed JSON used to fall through to Express's default HTML error page, which prints a stack
// trace with absolute filesystem paths. A bad request from a client is not a server fault, and API
// consumers expect JSON, so answer 400 in JSON and keep internals out of the response.
app.use((err,req,res,next)=>{
 if(!err)return next();
 const status=err.status||err.statusCode||500;
 if(res.headersSent)return next(err);
 if(err.type==='entity.parse.failed')return res.status(400).json({ok:false,error:'Invalid JSON body.'});
 if(err.type==='entity.too.large')return res.status(413).json({ok:false,error:'Request body too large.'});
 console.error('[error]',req.method,req.originalUrl,status,err.message);
 res.status(status).json({ok:false,error:status>=500?'Internal server error.':err.message});
});
app.listen(PORT,()=>{console.log(`Sniptoxic running at http://localhost:${PORT}`);startPoller();});
